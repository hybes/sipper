/*
 * sipper-engine: the calling engine of Sipper for Windows.
 *
 * Wraps the pjsua C API (a port of Sipper/SIP/SIPEngine.swift) and talks to the Electron
 * main process through JSON lines: requests on stdin, responses and events on stdout.
 * windows/engine/PROTOCOL.md describes the messages.
 *
 * Every pjsua call runs on the main thread, which also pumps pjsua_handle_events, so
 * PJSIP callbacks arrive on that thread. A second thread only reads stdin. When stdin
 * closes (the app quit or crashed) the engine unregisters, hangs up and exits.
 */

#include <pjsua-lib/pjsua.h>

#include <stdarg.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"

#ifdef _WIN32
#  include <windows.h>
#  include <fcntl.h>
#  include <io.h>
#else
#  include <pthread.h>
#  include <sys/time.h>
#  include <time.h>
#endif

#define ENGINE_CLOCK_RATE 16000
#define MAX_LINE_BYTES (4 * 1024 * 1024)
#define MAX_STUN_SERVERS 8

/* ------------------------------------------------------------------------------------ */
/* Platform: locks, condition variables, threads, time                                   */
/* ------------------------------------------------------------------------------------ */

typedef struct {
#ifdef _WIN32
    CRITICAL_SECTION cs;
    CONDITION_VARIABLE cv;
#else
    pthread_mutex_t mutex;
    pthread_cond_t cond;
#endif
} sync_t;

static void sync_init(sync_t *s) {
#ifdef _WIN32
    InitializeCriticalSection(&s->cs);
    InitializeConditionVariable(&s->cv);
#else
    pthread_mutex_init(&s->mutex, NULL);
    pthread_cond_init(&s->cond, NULL);
#endif
}

static void sync_lock(sync_t *s) {
#ifdef _WIN32
    EnterCriticalSection(&s->cs);
#else
    pthread_mutex_lock(&s->mutex);
#endif
}

static void sync_unlock(sync_t *s) {
#ifdef _WIN32
    LeaveCriticalSection(&s->cs);
#else
    pthread_mutex_unlock(&s->mutex);
#endif
}

static void sync_signal(sync_t *s) {
#ifdef _WIN32
    WakeAllConditionVariable(&s->cv);
#else
    pthread_cond_broadcast(&s->cond);
#endif
}

/* Waits for a signal or `ms` milliseconds. The lock must be held. */
static void sync_wait_ms(sync_t *s, int ms) {
#ifdef _WIN32
    SleepConditionVariableCS(&s->cv, &s->cs, (DWORD)ms);
#else
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    deadline.tv_sec += ms / 1000;
    deadline.tv_nsec += (long)(ms % 1000) * 1000000L;
    if (deadline.tv_nsec >= 1000000000L) {
        deadline.tv_sec += 1;
        deadline.tv_nsec -= 1000000000L;
    }
    pthread_cond_timedwait(&s->cond, &s->mutex, &deadline);
#endif
}

/* Milliseconds since the Unix epoch. */
static double now_ms(void) {
#ifdef _WIN32
    FILETIME ft;
    ULARGE_INTEGER value;
    GetSystemTimeAsFileTime(&ft);
    value.LowPart = ft.dwLowDateTime;
    value.HighPart = ft.dwHighDateTime;
    return (double)((value.QuadPart - 116444736000000000ULL) / 10000ULL);
#else
    struct timeval tv;
    gettimeofday(&tv, NULL);
    return (double)tv.tv_sec * 1000.0 + (double)(tv.tv_usec / 1000);
#endif
}

/* ------------------------------------------------------------------------------------ */
/* Output                                                                                */
/* ------------------------------------------------------------------------------------ */

static sync_t out_sync;

/* Writes one JSON line and frees the object. Safe from any thread. */
static void emit(cJSON *object) {
    char *text = cJSON_PrintUnformatted(object);
    cJSON_Delete(object);
    if (!text) return;
    sync_lock(&out_sync);
    fputs(text, stdout);
    fputc('\n', stdout);
    fflush(stdout);
    sync_unlock(&out_sync);
    cJSON_free(text);
}

static cJSON *event_new(const char *name) {
    cJSON *object = cJSON_CreateObject();
    cJSON_AddStringToObject(object, "event", name);
    return object;
}

/* An app log line ("Sipper: ..."), shown with the PJSIP log in Diagnostics. */
static void app_log(const char *format, ...) {
    char buffer[1024];
    int offset = snprintf(buffer, sizeof buffer, "Sipper: ");
    va_list args;
    va_start(args, format);
    vsnprintf(buffer + offset, sizeof buffer - (size_t)offset, format, args);
    va_end(args);
    cJSON *event = event_new("log");
    cJSON_AddStringToObject(event, "line", buffer);
    emit(event);
}

static const char *pj_message(pj_status_t status, char *buffer, size_t size) {
    pj_str_t text = pj_strerror(status, buffer, size);
    size_t length = (size_t)text.slen;
    if (length >= size) length = size - 1;
    buffer[length] = '\0';
    return buffer;
}

/* ------------------------------------------------------------------------------------ */
/* Request helpers                                                                       */
/* ------------------------------------------------------------------------------------ */

typedef struct {
    cJSON *result;
    char error[768];
    int failed;
} reply_t;

static void fail(reply_t *reply, const char *format, ...) {
    va_list args;
    va_start(args, format);
    vsnprintf(reply->error, sizeof reply->error, format, args);
    va_end(args);
    reply->failed = 1;
}

/* Returns 1 on success; otherwise fills the reply with "<operation> failed: <reason> (<status>)". */
static int check(pj_status_t status, const char *operation, reply_t *reply) {
    char message[256];
    if (status == PJ_SUCCESS) return 1;
    fail(reply, "%s failed: %s (%d)", operation, pj_message(status, message, sizeof message), (int)status);
    return 0;
}

static const char *param_str(const cJSON *params, const char *key, const char *fallback) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(params, key);
    return cJSON_IsString(item) && item->valuestring ? item->valuestring : fallback;
}

static int param_int(const cJSON *params, const char *key, int fallback) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(params, key);
    return cJSON_IsNumber(item) ? item->valueint : fallback;
}

static int param_bool(const cJSON *params, const char *key, int fallback) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(params, key);
    if (cJSON_IsBool(item)) return cJSON_IsTrue(item);
    return fallback;
}

static pj_str_t pjs(const char *text) {
    return pj_str((char *)(text ? text : ""));
}

static void copy_text(char *destination, size_t size, const char *source, size_t length) {
    if (length >= size) length = size - 1;
    memcpy(destination, source, length);
    destination[length] = '\0';
}

/* ------------------------------------------------------------------------------------ */
/* Engine state (main thread only)                                                        */
/* ------------------------------------------------------------------------------------ */

typedef struct {
    int used;
    char id[64];
    pjsua_acc_id acc;
    char *config; /* the account's JSON as last applied, to detect changes */
} account_slot;

typedef enum { DIR_OUTGOING, DIR_INCOMING } call_direction;

typedef struct {
    int used;
    char account_id[64];
    call_direction direction;
    const char *state;
    char remote[512];
    int muted;
    int hold_requested;
    int remote_hold;
    int active_media;
    pjsua_call_media_status media_status;
    pjsua_conf_port_id conf_slot;
    pjsua_recorder_id recorder_id;
    pjsua_conf_port_id recorder_slot;
    double started_at;
    double connected_at;
    double ended_at;
    int last_code;
    char last_text[160];
    int ringback_active;
} call_context;

typedef struct {
    pj_pool_t *pool;
    pjmedia_port *port;
    pjsua_conf_port_id slot;
    int playing;
} ringback_tone;

static int running;
static int null_audio;
static account_slot accounts[PJSUA_MAX_ACC];
static call_context calls[PJSUA_MAX_CALLS];
static char *applied_stun; /* JSON array text of the STUN servers pjsua knows */
static int stun_count;
static ringback_tone ringback = { NULL, NULL, PJSUA_INVALID_ID, 0 };
static char last_transport_error[320];
static double last_transport_error_at;

static account_slot *account_by_id(const char *id) {
    int i;
    if (!id) return NULL;
    for (i = 0; i < PJSUA_MAX_ACC; i++) {
        if (accounts[i].used && strcmp(accounts[i].id, id) == 0) return &accounts[i];
    }
    return NULL;
}

static account_slot *account_by_pj(pjsua_acc_id acc) {
    int i;
    for (i = 0; i < PJSUA_MAX_ACC; i++) {
        if (accounts[i].used && accounts[i].acc == acc) return &accounts[i];
    }
    return NULL;
}

static call_context *call_for(int call_id) {
    if (call_id < 0 || call_id >= PJSUA_MAX_CALLS || !calls[call_id].used) return NULL;
    return &calls[call_id];
}

static call_context *call_begin(pjsua_call_id call_id, const char *account_id, call_direction direction) {
    call_context *call = &calls[call_id];
    memset(call, 0, sizeof *call);
    call->used = 1;
    copy_text(call->account_id, sizeof call->account_id, account_id, strlen(account_id));
    call->direction = direction;
    call->state = direction == DIR_OUTGOING ? "calling" : "incoming";
    call->media_status = PJSUA_CALL_MEDIA_NONE;
    call->conf_slot = PJSUA_INVALID_ID;
    call->recorder_id = PJSUA_INVALID_ID;
    call->recorder_slot = PJSUA_INVALID_ID;
    call->started_at = now_ms();
    return call;
}

static cJSON *call_json(int call_id, const call_context *call) {
    cJSON *object = cJSON_CreateObject();
    cJSON_AddNumberToObject(object, "id", call_id);
    cJSON_AddStringToObject(object, "accountId", call->account_id);
    cJSON_AddStringToObject(object, "direction", call->direction == DIR_INCOMING ? "incoming" : "outgoing");
    cJSON_AddStringToObject(object, "state", call->state);
    cJSON_AddStringToObject(object, "remote", call->remote);
    cJSON_AddBoolToObject(object, "muted", call->muted);
    cJSON_AddBoolToObject(object, "onHold", call->hold_requested || call->media_status == PJSUA_CALL_MEDIA_LOCAL_HOLD);
    cJSON_AddBoolToObject(object, "remoteHold", call->remote_hold);
    cJSON_AddBoolToObject(object, "activeMedia", call->active_media);
    cJSON_AddBoolToObject(object, "recording", call->recorder_id != PJSUA_INVALID_ID);
    cJSON_AddNumberToObject(object, "startedAt", call->started_at);
    if (call->connected_at > 0) cJSON_AddNumberToObject(object, "connectedAt", call->connected_at);
    else cJSON_AddNullToObject(object, "connectedAt");
    if (call->ended_at > 0) cJSON_AddNumberToObject(object, "endedAt", call->ended_at);
    else cJSON_AddNullToObject(object, "endedAt");
    cJSON_AddNumberToObject(object, "lastCode", call->last_code);
    cJSON_AddStringToObject(object, "lastText", call->last_text);
    return object;
}

static void emit_call(const char *event_name, int call_id, const call_context *call) {
    cJSON *event = event_new(event_name);
    cJSON_AddItemToObject(event, "call", call_json(call_id, call));
    emit(event);
}

static void emit_registration(const char *account_id, const char *state, int code, const char *reason, int expires) {
    cJSON *event = event_new("registration");
    cJSON_AddStringToObject(event, "accountId", account_id);
    cJSON_AddStringToObject(event, "state", state);
    cJSON_AddNumberToObject(event, "code", code);
    cJSON_AddStringToObject(event, "reason", reason ? reason : "");
    cJSON_AddNumberToObject(event, "expires", expires);
    emit(event);
}

/* ------------------------------------------------------------------------------------ */
/* Ringback tone                                                                          */
/* ------------------------------------------------------------------------------------ */

/* UK-style ringback (400 + 450 Hz) played into the conference bridge while an outgoing
 * call rings without early media. */
static void ringback_create(void) {
    unsigned samples_per_frame = ENGINE_CLOCK_RATE * 20 / 1000;
    ringback.pool = pjsua_pool_create("sipper-ringback", 1024, 1024);
    if (!ringback.pool) return;
    if (pjmedia_tonegen_create2(ringback.pool, NULL, ENGINE_CLOCK_RATE, 1, samples_per_frame, 16, 0,
                                &ringback.port) != PJ_SUCCESS) {
        pj_pool_release(ringback.pool);
        ringback.pool = NULL;
        ringback.port = NULL;
        return;
    }
    if (pjsua_conf_add_port(ringback.pool, ringback.port, &ringback.slot) != PJ_SUCCESS) {
        pjmedia_port_destroy(ringback.port);
        pj_pool_release(ringback.pool);
        ringback.pool = NULL;
        ringback.port = NULL;
        ringback.slot = PJSUA_INVALID_ID;
    }
}

static void ringback_play(void) {
    pjmedia_tone_desc tones[2];
    if (ringback.playing || !ringback.port) return;
    memset(tones, 0, sizeof tones);
    tones[0].freq1 = 400;
    tones[0].freq2 = 450;
    tones[0].on_msec = 400;
    tones[0].off_msec = 200;
    tones[1].freq1 = 400;
    tones[1].freq2 = 450;
    tones[1].on_msec = 400;
    tones[1].off_msec = 2000;
    if (pjmedia_tonegen_play(ringback.port, 2, tones, PJMEDIA_TONEGEN_LOOP) != PJ_SUCCESS) return;
    pjsua_conf_connect(ringback.slot, 0);
    ringback.playing = 1;
}

static void ringback_silence(void) {
    if (!ringback.playing || !ringback.port) return;
    pjsua_conf_disconnect(ringback.slot, 0);
    pjmedia_tonegen_rewind(ringback.port);
    pjmedia_tonegen_stop(ringback.port);
    ringback.playing = 0;
}

static void ringback_destroy(void) {
    ringback_silence();
    if (ringback.slot != PJSUA_INVALID_ID) pjsua_conf_remove_port(ringback.slot);
    if (ringback.port) pjmedia_port_destroy(ringback.port);
    if (ringback.pool) pj_pool_release(ringback.pool);
    ringback.slot = PJSUA_INVALID_ID;
    ringback.port = NULL;
    ringback.pool = NULL;
}

static void ringback_start_for(call_context *call) {
    if (call->ringback_active || !ringback.port) return;
    ringback_play();
    call->ringback_active = 1;
}

static void ringback_stop_for(call_context *call) {
    int i;
    if (!call->ringback_active) return;
    call->ringback_active = 0;
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        if (calls[i].used && calls[i].ringback_active) return;
    }
    ringback_silence();
}

/* ------------------------------------------------------------------------------------ */
/* Media wiring and recording                                                             */
/* ------------------------------------------------------------------------------------ */

static void apply_media_wiring(call_context *call) {
    pjsua_conf_port_id slot = call->conf_slot;
    if (slot == PJSUA_INVALID_ID) return;
    if (call->active_media) {
        pjsua_conf_connect(slot, 0);
        if (call->muted) pjsua_conf_disconnect(0, slot);
        else pjsua_conf_connect(0, slot);
    } else {
        pjsua_conf_disconnect(slot, 0);
        pjsua_conf_disconnect(0, slot);
    }
    if (call->recorder_slot != PJSUA_INVALID_ID) {
        /* Record both directions mixed: the remote party and (unless muted) the microphone. */
        if (call->active_media) pjsua_conf_connect(slot, call->recorder_slot);
        else pjsua_conf_disconnect(slot, call->recorder_slot);
        if (call->muted || !call->active_media) pjsua_conf_disconnect(0, call->recorder_slot);
        else pjsua_conf_connect(0, call->recorder_slot);
    }
}

static void destroy_recorder(call_context *call) {
    if (call->recorder_id == PJSUA_INVALID_ID) return;
    if (call->recorder_slot != PJSUA_INVALID_ID) {
        if (call->conf_slot != PJSUA_INVALID_ID) pjsua_conf_disconnect(call->conf_slot, call->recorder_slot);
        pjsua_conf_disconnect(0, call->recorder_slot);
    }
    pjsua_recorder_destroy(call->recorder_id);
    call->recorder_id = PJSUA_INVALID_ID;
    call->recorder_slot = PJSUA_INVALID_ID;
}

/* ------------------------------------------------------------------------------------ */
/* PJSIP callbacks                                                                        */
/* ------------------------------------------------------------------------------------ */

static void on_log(int level, const char *data, int length) {
    cJSON *event;
    char *line;
    PJ_UNUSED_ARG(level);
    if (!data || length <= 0) return;
    while (length > 0 && (data[length - 1] == '\n' || data[length - 1] == '\r')) length--;
    line = (char *)malloc((size_t)length + 1);
    if (!line) return;
    memcpy(line, data, (size_t)length);
    line[length] = '\0';
    event = event_new("log");
    cJSON_AddStringToObject(event, "line", line);
    free(line);
    emit(event);
}

static void on_incoming_call(pjsua_acc_id acc_id, pjsua_call_id call_id, pjsip_rx_data *rdata) {
    pjsua_call_info info;
    account_slot *account = account_by_pj(acc_id);
    call_context *call;
    PJ_UNUSED_ARG(rdata);
    if (!account) {
        pjsua_call_hangup(call_id, 480, NULL, NULL);
        return;
    }
    if (pjsua_call_get_info(call_id, &info) != PJ_SUCCESS) {
        pjsua_call_hangup(call_id, 500, NULL, NULL);
        return;
    }
    call = call_begin(call_id, account->id, DIR_INCOMING);
    copy_text(call->remote, sizeof call->remote, info.remote_info.ptr, (size_t)info.remote_info.slen);
    pjsua_call_answer(call_id, 180, NULL, NULL);
    emit_call("incomingCall", call_id, call);
}

static void on_call_state(pjsua_call_id call_id, pjsip_event *e) {
    pjsua_call_info info;
    call_context *call;
    PJ_UNUSED_ARG(e);
    if (call_id < 0 || call_id >= PJSUA_MAX_CALLS) return;
    if (pjsua_call_get_info(call_id, &info) != PJ_SUCCESS) return;

    call = call_for(call_id);
    if (!call) {
        /* Only track calls that are alive; a DISCONNECTED or NULL report for an unknown id
         * (a failed make_call, for example) must not create a phantom call. */
        account_slot *account;
        switch (info.state) {
        case PJSIP_INV_STATE_CALLING:
        case PJSIP_INV_STATE_INCOMING:
        case PJSIP_INV_STATE_EARLY:
        case PJSIP_INV_STATE_CONNECTING:
        case PJSIP_INV_STATE_CONFIRMED:
            break;
        default:
            return;
        }
        account = account_by_pj(info.acc_id);
        if (!account) return;
        call = call_begin(call_id, account->id, info.role == PJSIP_ROLE_UAC ? DIR_OUTGOING : DIR_INCOMING);
        copy_text(call->remote, sizeof call->remote, info.remote_info.ptr, (size_t)info.remote_info.slen);
    }

    call->last_code = (int)info.last_status;
    copy_text(call->last_text, sizeof call->last_text, info.last_status_text.ptr, (size_t)info.last_status_text.slen);

    switch (info.state) {
    case PJSIP_INV_STATE_CALLING:
        call->state = "calling";
        break;
    case PJSIP_INV_STATE_INCOMING:
        call->state = "incoming";
        break;
    case PJSIP_INV_STATE_EARLY:
        if (call->direction == DIR_INCOMING) {
            /* We answered with 180 Ringing; for the user the call is still ringing. */
            call->state = "incoming";
        } else {
            call->state = "early";
            if (!call->active_media) ringback_start_for(call);
        }
        break;
    case PJSIP_INV_STATE_CONNECTING:
        call->state = "connecting";
        ringback_stop_for(call);
        break;
    case PJSIP_INV_STATE_CONFIRMED:
        call->state = "confirmed";
        if (call->connected_at <= 0) call->connected_at = now_ms();
        ringback_stop_for(call);
        break;
    case PJSIP_INV_STATE_DISCONNECTED:
        call->state = "disconnected";
        call->ended_at = now_ms();
        ringback_stop_for(call);
        break;
    default:
        break;
    }

    if (strcmp(call->state, "disconnected") == 0) {
        destroy_recorder(call);
        emit_call("callEnded", call_id, call);
        call->used = 0;
    } else {
        emit_call("callChanged", call_id, call);
    }
}

static void on_call_media_state(pjsua_call_id call_id) {
    pjsua_call_info info;
    call_context *call = call_for(call_id);
    if (!call) return;
    if (pjsua_call_get_info(call_id, &info) != PJ_SUCCESS) return;
    call->media_status = info.media_status;
    call->conf_slot = info.conf_slot;
    call->active_media = info.media_status == PJSUA_CALL_MEDIA_ACTIVE ||
                         info.media_status == PJSUA_CALL_MEDIA_REMOTE_HOLD;
    call->remote_hold = info.media_status == PJSUA_CALL_MEDIA_REMOTE_HOLD;
    if (info.media_status == PJSUA_CALL_MEDIA_LOCAL_HOLD) call->hold_requested = 1;
    else if (info.media_status == PJSUA_CALL_MEDIA_ACTIVE) call->hold_requested = 0;
    if (call->active_media) ringback_stop_for(call);
    apply_media_wiring(call);
    emit_call("callChanged", call_id, call);
}

static void on_reg_state2(pjsua_acc_id acc_id, pjsua_reg_info *info) {
    char reason[512];
    account_slot *account = account_by_pj(acc_id);
    if (!account) return;

    if (info && info->cbparam) {
        struct pjsip_regc_cbparam *param = info->cbparam;
        int code = param->code;
        if (param->status != PJ_SUCCESS) {
            char message[256];
            emit_registration(account->id, "failed", code, pj_message(param->status, message, sizeof message), 0);
        } else if (code >= 300) {
            copy_text(reason, sizeof reason, param->reason.ptr, (size_t)param->reason.slen);
            /* 503 is PJSIP's local failure code; the transport error says why. */
            if (code == 503 && last_transport_error[0] && now_ms() - last_transport_error_at < 30000) {
                size_t used = strlen(reason);
                snprintf(reason + used, sizeof reason - used, " (%s)", last_transport_error);
            }
            emit_registration(account->id, "failed", code, reason, 0);
        } else if (code >= 200) {
            copy_text(reason, sizeof reason, param->reason.ptr, (size_t)param->reason.slen);
            if (info->renew) emit_registration(account->id, "registered", code, reason, (int)param->expiration);
            else emit_registration(account->id, "unregistered", code, reason, 0);
        } else {
            emit_registration(account->id, "registering", code, "", 0);
        }
        return;
    }

    {
        pjsua_acc_info acc_info;
        if (pjsua_acc_get_info(acc_id, &acc_info) == PJ_SUCCESS) {
            int code = (int)acc_info.status;
            copy_text(reason, sizeof reason, acc_info.status_text.ptr, (size_t)acc_info.status_text.slen);
            if (acc_info.has_registration && code == 200 && acc_info.expires > 0) {
                emit_registration(account->id, "registered", code, reason, (int)acc_info.expires);
            } else if (code >= 300) {
                emit_registration(account->id, "failed", code, reason, 0);
            } else {
                emit_registration(account->id, "unregistered", code, reason, 0);
            }
        }
    }
}

static void on_mwi_info(pjsua_acc_id acc_id, pjsua_mwi_info *info) {
    account_slot *account = account_by_pj(acc_id);
    cJSON *event;
    char *body = NULL;
    if (!account) return;
    if (info && info->rdata && info->rdata->msg_info.msg && info->rdata->msg_info.msg->body) {
        pjsip_msg_body *msg_body = info->rdata->msg_info.msg->body;
        if (msg_body->data && msg_body->len > 0) {
            body = (char *)malloc(msg_body->len + 1);
            if (body) {
                memcpy(body, msg_body->data, msg_body->len);
                body[msg_body->len] = '\0';
            }
        }
    }
    event = event_new("voicemail");
    cJSON_AddStringToObject(event, "accountId", account->id);
    cJSON_AddStringToObject(event, "body", body ? body : "");
    free(body);
    emit(event);
}

static void on_call_transfer_status(pjsua_call_id call_id, int code, const pj_str_t *text, pj_bool_t final,
                                    pj_bool_t *p_continue) {
    char status_text[256] = "";
    cJSON *event;
    PJ_UNUSED_ARG(p_continue);
    if (text) copy_text(status_text, sizeof status_text, text->ptr, (size_t)text->slen);
    event = event_new("transferStatus");
    cJSON_AddNumberToObject(event, "callId", call_id);
    cJSON_AddNumberToObject(event, "code", code);
    cJSON_AddStringToObject(event, "text", status_text);
    cJSON_AddBoolToObject(event, "final", final ? 1 : 0);
    emit(event);
}

static void on_transport_state(pjsip_transport *transport, pjsip_transport_state state,
                               const pjsip_transport_state_info *info) {
    if (!transport || !info) return;
    if (state == PJSIP_TP_STATE_DISCONNECTED && info->status != PJ_SUCCESS) {
        char message[256];
        const char *name = transport->type_name ? transport->type_name : "transport";
        snprintf(last_transport_error, sizeof last_transport_error, "%s: %s", name,
                 pj_message(info->status, message, sizeof message));
        last_transport_error_at = now_ms();
        app_log("%s transport disconnected: %s", name, message);
    }
}

/* ------------------------------------------------------------------------------------ */
/* Lifecycle                                                                              */
/* ------------------------------------------------------------------------------------ */

/* PJSIP echo canceller parameters. "default" lets the sound device cancel echo when it can
 * (CoreAudio voice processing on macOS) and otherwise uses PJSIP's default software
 * canceller; the other modes force a specific software canceller. */
static void echo_parameters(const char *mode, int tail_ms, unsigned *tail, unsigned *options) {
    unsigned length = tail_ms > 0 ? (unsigned)tail_ms : 200;
    if (!mode || strcmp(mode, "off") == 0) {
        *tail = 0;
        *options = 0;
    } else if (strcmp(mode, "webrtc") == 0) {
        *tail = length;
        *options = PJMEDIA_ECHO_USE_SW_ECHO | PJMEDIA_ECHO_WEBRTC;
    } else if (strcmp(mode, "speex") == 0) {
        *tail = length;
        *options = PJMEDIA_ECHO_USE_SW_ECHO | PJMEDIA_ECHO_SPEEX;
    } else {
        *tail = length;
        *options = 0;
    }
}

typedef enum { TP_UDP = 0, TP_TCP = 1, TP_TLS = 2 } transport_kind;

static int create_transport(transport_kind kind, int port, int verify_tls, reply_t *reply) {
    static const char *names[] = { "UDP", "TCP", "TLS" };
    pjsua_transport_config config;
    pjsua_transport_id id = PJSUA_INVALID_ID;
    pjsip_transport_type_e type = kind == TP_UDP ? PJSIP_TRANSPORT_UDP
                                : kind == TP_TCP ? PJSIP_TRANSPORT_TCP : PJSIP_TRANSPORT_TLS;
    pj_status_t status;
    char message[256];

    pjsua_transport_config_default(&config);
    config.port = (unsigned)(port > 0 && port <= 65535 ? port : 0);
    if (kind == TP_TLS) config.tls_setting.verify_server = verify_tls ? PJ_TRUE : PJ_FALSE;

    status = pjsua_transport_create(type, &config, &id);
    if (status != PJ_SUCCESS && config.port != 0) {
        app_log("%s port %d unavailable (%s), using a random port", names[kind], port,
                pj_message(status, message, sizeof message));
        config.port = 0;
        status = pjsua_transport_create(type, &config, &id);
    }
    if (status == PJ_SUCCESS) return 1;
    if (kind == TP_UDP) {
        char operation[64];
        snprintf(operation, sizeof operation, "pjsua_transport_create(%s)", names[kind]);
        return check(status, operation, reply);
    }
    /* TCP and TLS are optional: accounts using them fail to register with this reason. */
    app_log("%s transport unavailable: %s", names[kind], pj_message(status, message, sizeof message));
    return 1;
}

static void apply_audio_devices(const char *input, const char *output) {
    pjmedia_aud_dev_info *infos;
    unsigned count = 64, i;
    pjsua_snd_dev_param param;
    pj_status_t status;
    char message[256];

    if (!running || null_audio) return;
    infos = (pjmedia_aud_dev_info *)calloc(count, sizeof *infos);
    if (!infos) return;
    if (pjsua_enum_aud_devs(infos, &count) != PJ_SUCCESS) {
        free(infos);
        return;
    }
    pjsua_snd_dev_param_default(&param);
    param.capture_dev = PJMEDIA_AUD_DEFAULT_CAPTURE_DEV;
    param.playback_dev = PJMEDIA_AUD_DEFAULT_PLAYBACK_DEV;
    for (i = 0; i < count; i++) {
        if (input && *input && strcmp(infos[i].name, input) == 0 && infos[i].input_count > 0) {
            param.capture_dev = (int)i;
        }
        if (output && *output && strcmp(infos[i].name, output) == 0 && infos[i].output_count > 0) {
            param.playback_dev = (int)i;
        }
    }
    free(infos);
    param.mode = PJSUA_SND_DEV_NO_IMMEDIATE_OPEN;
    status = pjsua_set_snd_dev2(&param);
    if (status != PJ_SUCCESS) {
        app_log("selecting audio devices failed: %s", pj_message(status, message, sizeof message));
    }
}

static void apply_codecs(const cJSON *codecs) {
    const cJSON *item;
    int index = 0;
    if (!running || !cJSON_IsArray(codecs)) return;
    cJSON_ArrayForEach(item, codecs) {
        const char *id = param_str(item, "id", NULL);
        int enabled = param_bool(item, "enabled", 1);
        pj_str_t codec_id;
        int priority = 250 - index;
        if (!id) continue;
        codec_id = pjs(id);
        pjsua_codec_set_priority(&codec_id, (pj_uint8_t)(enabled ? (priority < 1 ? 1 : priority) : 0));
        index++;
    }
}

static int engine_start(const cJSON *params, reply_t *reply) {
    pjsua_config config;
    pjsua_logging_config log_config;
    pjsua_media_config media_config;
    const cJSON *stun = cJSON_GetObjectItemCaseSensitive(params, "stunServers");
    const cJSON *ports = cJSON_GetObjectItemCaseSensitive(params, "ports");
    const cJSON *item;
    int level;
    pj_status_t status;

    if (running) return 1;
    if (!check(pjsua_create(), "pjsua_create", reply)) return 0;

    pjsua_config_default(&config);
    config.thread_cnt = 0;
    config.user_agent = pjs(param_str(params, "userAgent", "Sipper"));
    config.stun_ignore_failure = PJ_TRUE;
    config.stun_try_ipv6 = PJ_FALSE;

    stun_count = 0;
    if (cJSON_IsArray(stun)) {
        cJSON_ArrayForEach(item, stun) {
            if (cJSON_IsString(item) && item->valuestring[0] && stun_count < MAX_STUN_SERVERS) {
                config.stun_srv[stun_count++] = pjs(item->valuestring);
            }
        }
    }
    config.stun_srv_cnt = (unsigned)stun_count;
    free(applied_stun);
    applied_stun = stun ? cJSON_PrintUnformatted(stun) : NULL;

    config.cb.on_incoming_call = &on_incoming_call;
    config.cb.on_call_state = &on_call_state;
    config.cb.on_call_media_state = &on_call_media_state;
    config.cb.on_reg_state2 = &on_reg_state2;
    config.cb.on_mwi_info = &on_mwi_info;
    config.cb.on_call_transfer_status = &on_call_transfer_status;
    config.cb.on_transport_state = &on_transport_state;

    pjsua_logging_config_default(&log_config);
    level = param_int(params, "logLevel", 4);
    if (level < 0) level = 0;
    if (level > 6) level = 6;
    log_config.level = (unsigned)level;
    log_config.console_level = (unsigned)level;
    log_config.msg_logging = PJ_TRUE;
    log_config.decor = PJ_LOG_HAS_TIME | PJ_LOG_HAS_MICRO_SEC | PJ_LOG_HAS_SENDER | PJ_LOG_HAS_INDENT;
    log_config.cb = &on_log;

    pjsua_media_config_default(&media_config);
    media_config.clock_rate = ENGINE_CLOCK_RATE;
    media_config.snd_clock_rate = 0;
    echo_parameters(param_str(params, "echoMode", "default"), param_int(params, "echoTail", 200),
                    &media_config.ec_tail_len, &media_config.ec_options);
    media_config.snd_auto_close_time = 1;
    media_config.no_vad = PJ_FALSE;

    /* Keep UDP accounts on UDP even for large INVITEs (RFC 3261 section 18.1.1 would
     * otherwise switch to TCP, which some PBXs do not listen on). */
    pjsip_cfg()->endpt.disable_tcp_switch = PJ_TRUE;

    status = pjsua_init(&config, &log_config, &media_config);
    if (status != PJ_SUCCESS) {
        pjsua_destroy();
        return check(status, "pjsua_init", reply);
    }

    if (!create_transport(TP_UDP, param_int(ports, "udp", 0), 0, reply) ||
        !create_transport(TP_TCP, param_int(ports, "tcp", 0), 0, reply) ||
        !create_transport(TP_TLS, param_int(ports, "tls", 0), param_bool(params, "verifyTls", 1), reply) ||
        !check(pjsua_start(), "pjsua_start", reply)) {
        pjsua_destroy();
        return 0;
    }

    running = 1;
    null_audio = param_bool(params, "nullAudio", 0);
    if (null_audio) {
        pjsua_set_null_snd_dev();
    } else {
        apply_audio_devices(param_str(params, "inputDevice", NULL), param_str(params, "outputDevice", NULL));
    }
    apply_codecs(cJSON_GetObjectItemCaseSensitive(params, "codecs"));
    ringback_create();
    app_log("engine started (pjsip %s)", pj_get_version());
    reply->result = cJSON_CreateObject();
    cJSON_AddStringToObject(reply->result, "pjsip", pj_get_version());
    return 1;
}

static void engine_stop(void) {
    int i;
    if (!running) return;
    running = 0;
    ringback_silence();
    pjsua_call_hangup_all();
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        call_context *call = &calls[i];
        if (!call->used) continue;
        destroy_recorder(call);
        call->state = "disconnected";
        call->ended_at = now_ms();
        call->last_code = 0;
        snprintf(call->last_text, sizeof call->last_text, "Engine stopped");
        emit_call("callEnded", i, call);
        call->used = 0;
    }
    ringback_destroy();
    pjsua_destroy();
    for (i = 0; i < PJSUA_MAX_ACC; i++) {
        free(accounts[i].config);
        memset(&accounts[i], 0, sizeof accounts[i]);
    }
    free(applied_stun);
    applied_stun = NULL;
    stun_count = 0;
    app_log("engine stopped");
}

/* ------------------------------------------------------------------------------------ */
/* Accounts                                                                               */
/* ------------------------------------------------------------------------------------ */

static void fill_account_config(pjsua_acc_config *config, const cJSON *account) {
    const char *srtp = param_str(account, "srtp", "disabled");
    int reg_timeout = param_int(account, "regTimeout", 300);
    int use_stun = param_bool(account, "useStun", 0) && stun_count > 0;

    config->id = pjs(param_str(account, "aor", ""));
    config->reg_uri = pjs(param_str(account, "registrar", ""));
    config->reg_timeout = (unsigned)(reg_timeout < 60 ? 60 : reg_timeout);
    config->reg_retry_interval = 30;
    config->reg_first_retry_interval = 5;
    config->reg_delay_before_refresh = 5;
    config->register_on_acc_add = PJ_TRUE;
    config->mwi_enabled = PJ_TRUE;
    config->publish_enabled = PJ_FALSE;
    config->ka_interval = 15;
    config->allow_via_rewrite = PJ_TRUE;
    config->allow_contact_rewrite = PJ_TRUE;
    config->use_rfc5626 = PJ_TRUE;

    config->cred_count = 1;
    config->cred_info[0].realm = pjs("*");
    config->cred_info[0].scheme = pjs("digest");
    config->cred_info[0].username = pjs(param_str(account, "authUsername", ""));
    config->cred_info[0].data_type = PJSIP_CRED_DATA_PLAIN_PASSWD;
    config->cred_info[0].data = pjs(param_str(account, "password", ""));

    config->proxy_cnt = 1;
    config->proxy[0] = pjs(param_str(account, "proxy", ""));

    if (strcmp(srtp, "mandatory") == 0) config->use_srtp = PJMEDIA_SRTP_MANDATORY;
    else if (strcmp(srtp, "optional") == 0) config->use_srtp = PJMEDIA_SRTP_OPTIONAL;
    else config->use_srtp = PJMEDIA_SRTP_DISABLED;
    config->srtp_secure_signaling = 0;

    config->sip_stun_use = use_stun ? PJSUA_STUN_USE_DEFAULT : PJSUA_STUN_USE_DISABLED;
    config->media_stun_use = use_stun ? PJSUA_STUN_USE_DEFAULT : PJSUA_STUN_USE_DISABLED;
    config->ice_cfg_use = PJSUA_ICE_CONFIG_USE_CUSTOM;
    config->ice_cfg.enable_ice = param_bool(account, "useIce", 0) ? PJ_TRUE : PJ_FALSE;

    config->vid_in_auto_show = PJ_FALSE;
    config->vid_out_auto_transmit = PJ_FALSE;
}

static void add_account(const char *id, const cJSON *account, char *config_text) {
    pjsua_acc_config config;
    pjsua_acc_id acc = PJSUA_INVALID_ID;
    pj_status_t status;
    char message[256];
    int i;

    pjsua_acc_config_default(&config);
    fill_account_config(&config, account);
    status = pjsua_acc_add(&config, PJ_FALSE, &acc);
    if (status != PJ_SUCCESS) {
        pj_message(status, message, sizeof message);
        app_log("adding account %s failed: %s", id, message);
        emit_registration(id, "failed", 0, message, 0);
        free(config_text);
        return;
    }
    for (i = 0; i < PJSUA_MAX_ACC; i++) {
        if (!accounts[i].used) {
            accounts[i].used = 1;
            copy_text(accounts[i].id, sizeof accounts[i].id, id, strlen(id));
            accounts[i].acc = acc;
            accounts[i].config = config_text;
            break;
        }
    }
    emit_registration(id, "registering", 0, "", 0);
}

static void modify_account(account_slot *slot, const cJSON *account, char *config_text) {
    pjsua_acc_config config;
    pj_status_t status;
    char message[256];

    pjsua_acc_config_default(&config);
    fill_account_config(&config, account);
    status = pjsua_acc_modify(slot->acc, &config);
    if (status == PJ_SUCCESS) {
        free(slot->config);
        slot->config = config_text;
        emit_registration(slot->id, "registering", 0, "", 0);
    } else {
        pj_message(status, message, sizeof message);
        app_log("modifying account %s failed: %s", slot->id, message);
        emit_registration(slot->id, "failed", 0, message, 0);
        free(config_text);
    }
}

static void remove_account(account_slot *slot) {
    int i;
    char id[64];
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        if (calls[i].used && strcmp(calls[i].account_id, slot->id) == 0) {
            pjsua_call_hangup(i, 0, NULL, NULL);
        }
    }
    pjsua_acc_del(slot->acc);
    copy_text(id, sizeof id, slot->id, strlen(slot->id));
    free(slot->config);
    memset(slot, 0, sizeof *slot);
    emit_registration(id, "unregistered", 0, "", 0);
}

static void update_stun_servers(const cJSON *stun) {
    pj_str_t servers[MAX_STUN_SERVERS];
    unsigned count = 0;
    const cJSON *item;
    char message[256];

    free(applied_stun);
    applied_stun = cJSON_PrintUnformatted(stun);
    cJSON_ArrayForEach(item, stun) {
        if (cJSON_IsString(item) && item->valuestring[0] && count < MAX_STUN_SERVERS) {
            servers[count++] = pjs(item->valuestring);
        }
    }
    stun_count = (int)count;
    if (count == 0) return;
    {
        pj_status_t status = pjsua_update_stun_servers(count, servers, PJ_FALSE);
        if (status != PJ_SUCCESS) {
            app_log("updating STUN servers failed: %s", pj_message(status, message, sizeof message));
        }
    }
}

static void engine_sync_accounts(const cJSON *params, reply_t *reply) {
    const cJSON *list = cJSON_GetObjectItemCaseSensitive(params, "accounts");
    const cJSON *stun = cJSON_GetObjectItemCaseSensitive(params, "stunServers");
    const cJSON *item;
    int i;

    if (!running) {
        fail(reply, "The SIP engine is not running.");
        return;
    }
    if (!cJSON_IsArray(list)) {
        fail(reply, "syncAccounts needs an accounts array.");
        return;
    }

    for (i = 0; i < PJSUA_MAX_ACC; i++) {
        int wanted = 0;
        if (!accounts[i].used) continue;
        cJSON_ArrayForEach(item, list) {
            const char *id = param_str(item, "id", NULL);
            if (id && strcmp(id, accounts[i].id) == 0) {
                wanted = 1;
                break;
            }
        }
        if (!wanted) remove_account(&accounts[i]);
    }

    if (cJSON_IsArray(stun)) {
        char *text = cJSON_PrintUnformatted(stun);
        if (text && (!applied_stun || strcmp(text, applied_stun) != 0)) update_stun_servers(stun);
        cJSON_free(text);
    }

    cJSON_ArrayForEach(item, list) {
        const char *id = param_str(item, "id", NULL);
        account_slot *slot;
        char *text;
        if (!id || strlen(id) >= sizeof accounts[0].id) continue;
        text = cJSON_PrintUnformatted(item);
        if (!text) continue;
        slot = account_by_id(id);
        if (!slot) add_account(id, item, text);
        else if (!slot->config || strcmp(slot->config, text) != 0) modify_account(slot, item, text);
        else free(text);
    }
}

/* ------------------------------------------------------------------------------------ */
/* Requests                                                                               */
/* ------------------------------------------------------------------------------------ */

static void default_call_setting(pjsua_call_setting *setting) {
    pjsua_call_setting_default(setting);
    setting->aud_cnt = 1;
    setting->vid_cnt = 0;
}

static call_context *require_call(const cJSON *params, const char *key, reply_t *reply) {
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(params, key);
    call_context *call = cJSON_IsNumber(item) ? call_for(item->valueint) : NULL;
    if (!call) fail(reply, "The call no longer exists.");
    return call;
}

static void request_make_call(const cJSON *params, reply_t *reply) {
    const char *uri = param_str(params, "uri", "");
    account_slot *account = account_by_id(param_str(params, "accountId", NULL));
    pjsua_call_setting setting;
    pjsua_call_id call_id = PJSUA_INVALID_ID;
    pj_str_t destination = pjs(uri);
    call_context *call;

    if (!running) {
        fail(reply, "The SIP engine is not running.");
        return;
    }
    if (!account) {
        fail(reply, "The account is not active.");
        return;
    }
    if (pjsua_verify_sip_url(uri) != PJ_SUCCESS && pjsua_verify_url(uri) != PJ_SUCCESS) {
        fail(reply, "\xE2\x80\x9C%s\xE2\x80\x9D is not a valid SIP address.", uri);
        return;
    }
    default_call_setting(&setting);
    if (!check(pjsua_call_make_call(account->acc, &destination, &setting, NULL, NULL, &call_id),
               "pjsua_call_make_call", reply)) {
        return;
    }
    call = call_for(call_id);
    if (!call) {
        if (!pjsua_call_is_active(call_id)) {
            fail(reply, "The call ended before it started.");
            return;
        }
        call = call_begin(call_id, account->id, DIR_OUTGOING);
    }
    copy_text(call->remote, sizeof call->remote, uri, strlen(uri));
    if (strcmp(call->state, "incoming") == 0) call->state = "calling";
    reply->result = call_json(call_id, call);
}

static void request_answer(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    pjsua_call_setting setting;
    int call_id;
    if (!call) return;
    call_id = (int)(call - calls);
    default_call_setting(&setting);
    check(pjsua_call_answer2(call_id, &setting, (unsigned)param_int(params, "code", 200), NULL, NULL),
          "pjsua_call_answer2", reply);
}

static void request_hangup(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    if (!call) return;
    /* Code 0 lets pjsua pick BYE, CANCEL or 603 as appropriate. */
    check(pjsua_call_hangup((pjsua_call_id)(call - calls), (unsigned)param_int(params, "code", 0), NULL, NULL),
          "pjsua_call_hangup", reply);
}

static void request_set_hold(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    int hold = param_bool(params, "hold", 1);
    pjsua_call_id call_id;
    pj_status_t status;
    if (!call) return;
    call_id = (pjsua_call_id)(call - calls);
    call->hold_requested = hold;
    if (hold) {
        status = pjsua_call_set_hold2(call_id, 0, NULL);
    } else {
        pjsua_call_setting setting;
        default_call_setting(&setting);
        setting.flag |= PJSUA_CALL_UNHOLD;
        status = pjsua_call_reinvite2(call_id, &setting, NULL);
    }
    check(status, hold ? "pjsua_call_set_hold2" : "pjsua_call_reinvite2", reply);
    emit_call("callChanged", call_id, call);
}

static void request_set_muted(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    if (!call) return;
    call->muted = param_bool(params, "muted", 1);
    apply_media_wiring(call);
    emit_call("callChanged", (int)(call - calls), call);
}

static void request_send_dtmf(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    pjsua_call_send_dtmf_param param;
    pj_status_t status;
    pjsua_call_id call_id;
    if (!call) return;
    call_id = (pjsua_call_id)(call - calls);
    pjsua_call_send_dtmf_param_default(&param);
    param.method = PJSUA_DTMF_METHOD_RFC2833;
    param.digits = pjs(param_str(params, "digits", ""));
    status = pjsua_call_send_dtmf(call_id, &param);
    if (status != PJ_SUCCESS) {
        param.method = PJSUA_DTMF_METHOD_SIP_INFO;
        status = pjsua_call_send_dtmf(call_id, &param);
    }
    check(status, "pjsua_call_send_dtmf", reply);
}

static void request_transfer(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    const char *uri = param_str(params, "uri", "");
    pj_str_t destination = pjs(uri);
    if (!call) return;
    if (pjsua_verify_sip_url(uri) != PJ_SUCCESS) {
        fail(reply, "\xE2\x80\x9C%s\xE2\x80\x9D is not a valid SIP address.", uri);
        return;
    }
    check(pjsua_call_xfer((pjsua_call_id)(call - calls), &destination, NULL), "pjsua_call_xfer", reply);
}

static void request_attended_transfer(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    call_context *other = call ? require_call(params, "otherCallId", reply) : NULL;
    if (!call || !other) return;
    check(pjsua_call_xfer_replaces((pjsua_call_id)(call - calls), (pjsua_call_id)(other - calls), 0, NULL),
          "pjsua_call_xfer_replaces", reply);
}

static void request_active_calls(reply_t *reply) {
    int i;
    reply->result = cJSON_CreateArray();
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        if (calls[i].used) cJSON_AddItemToArray(reply->result, call_json(i, &calls[i]));
    }
}

static void request_audio_devices(reply_t *reply) {
    pjmedia_aud_dev_info *infos;
    unsigned count = 64, i;
    int in_call = 0;

    reply->result = cJSON_CreateArray();
    if (!running) return;
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        if (calls[i].used) in_call = 1;
    }
    /* Re-scanning drivers while a stream is open is not safe on every backend. */
    if (!in_call) pjmedia_aud_dev_refresh();
    infos = (pjmedia_aud_dev_info *)calloc(count, sizeof *infos);
    if (!infos) return;
    if (pjsua_enum_aud_devs(infos, &count) == PJ_SUCCESS) {
        for (i = 0; i < count; i++) {
            cJSON *device = cJSON_CreateObject();
            cJSON_AddNumberToObject(device, "index", i);
            cJSON_AddStringToObject(device, "name", infos[i].name);
            cJSON_AddNumberToObject(device, "inputs", infos[i].input_count);
            cJSON_AddNumberToObject(device, "outputs", infos[i].output_count);
            cJSON_AddStringToObject(device, "driver", infos[i].driver);
            cJSON_AddItemToArray(reply->result, device);
        }
    }
    free(infos);
}

static void request_codecs(reply_t *reply) {
    pjsua_codec_info infos[64];
    unsigned count = 64, i;
    reply->result = cJSON_CreateArray();
    if (!running) return;
    if (pjsua_enum_codecs(infos, &count) != PJ_SUCCESS) return;
    for (i = 0; i < count; i++) {
        char id[64];
        cJSON *codec = cJSON_CreateObject();
        copy_text(id, sizeof id, infos[i].codec_id.ptr, (size_t)infos[i].codec_id.slen);
        cJSON_AddStringToObject(codec, "id", id);
        cJSON_AddNumberToObject(codec, "priority", infos[i].priority);
        cJSON_AddItemToArray(reply->result, codec);
    }
}

static void request_set_echo(const cJSON *params, reply_t *reply) {
    unsigned tail, options;
    if (!running) return;
    echo_parameters(param_str(params, "mode", "default"), param_int(params, "tail", 200), &tail, &options);
    check(pjsua_set_ec(tail, options), "pjsua_set_ec", reply);
}

static void request_start_recording(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    const char *path = param_str(params, "path", "");
    pj_str_t filename = pjs(path);
    pjsua_recorder_id recorder = PJSUA_INVALID_ID;
    if (!call) return;
    if (call->recorder_id != PJSUA_INVALID_ID) return;
    if (!check(pjsua_recorder_create(&filename, 0, NULL, 0, 0, &recorder), "pjsua_recorder_create", reply)) return;
    call->recorder_id = recorder;
    call->recorder_slot = pjsua_recorder_get_conf_port(recorder);
    apply_media_wiring(call);
    app_log("recording call %d", (int)(call - calls));
    emit_call("callChanged", (int)(call - calls), call);
}

static void request_stop_recording(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    if (!call || call->recorder_id == PJSUA_INVALID_ID) return;
    destroy_recorder(call);
    emit_call("callChanged", (int)(call - calls), call);
}

static void request_set_registration(const cJSON *params, reply_t *reply) {
    const char *id = param_str(params, "accountId", NULL);
    account_slot *account = account_by_id(id);
    int enabled = param_bool(params, "enabled", 1);
    pj_status_t status;
    char message[256];
    if (!account) {
        fail(reply, "The account is not active.");
        return;
    }
    status = pjsua_acc_set_registration(account->acc, enabled ? PJ_TRUE : PJ_FALSE);
    if (status == PJ_SUCCESS) {
        emit_registration(account->id, enabled ? "registering" : "unregistered", 0, "", 0);
    } else {
        emit_registration(account->id, "failed", 0, pj_message(status, message, sizeof message), 0);
    }
}

static int quit_requested;

static void handle_line(const char *line) {
    cJSON *request = cJSON_Parse(line);
    const cJSON *id_item, *params;
    const char *method;
    reply_t reply;
    cJSON *response;

    memset(&reply, 0, sizeof reply);
    if (!request) {
        app_log("ignored a request that is not valid JSON");
        return;
    }
    id_item = cJSON_GetObjectItemCaseSensitive(request, "id");
    method = param_str(request, "method", "");
    params = cJSON_GetObjectItemCaseSensitive(request, "params");

    if (strcmp(method, "start") == 0) engine_start(params, &reply);
    else if (strcmp(method, "stop") == 0) engine_stop();
    else if (strcmp(method, "syncAccounts") == 0) engine_sync_accounts(params, &reply);
    else if (strcmp(method, "setRegistration") == 0) request_set_registration(params, &reply);
    else if (strcmp(method, "reRegisterAll") == 0) {
        int i;
        for (i = 0; i < PJSUA_MAX_ACC; i++) {
            if (accounts[i].used) pjsua_acc_set_registration(accounts[i].acc, PJ_TRUE);
        }
    }
    else if (!running && strcmp(method, "version") != 0 && strcmp(method, "shutdown") != 0 &&
             strcmp(method, "activeCalls") != 0 && strcmp(method, "audioDevices") != 0 &&
             strcmp(method, "codecs") != 0) fail(&reply, "The SIP engine is not running.");
    else if (strcmp(method, "makeCall") == 0) request_make_call(params, &reply);
    else if (strcmp(method, "answer") == 0) request_answer(params, &reply);
    else if (strcmp(method, "hangup") == 0) request_hangup(params, &reply);
    else if (strcmp(method, "hangupAll") == 0) pjsua_call_hangup_all();
    else if (strcmp(method, "setHold") == 0) request_set_hold(params, &reply);
    else if (strcmp(method, "setMuted") == 0) request_set_muted(params, &reply);
    else if (strcmp(method, "sendDtmf") == 0) request_send_dtmf(params, &reply);
    else if (strcmp(method, "transfer") == 0) request_transfer(params, &reply);
    else if (strcmp(method, "attendedTransfer") == 0) request_attended_transfer(params, &reply);
    else if (strcmp(method, "activeCalls") == 0) request_active_calls(&reply);
    else if (strcmp(method, "audioDevices") == 0) request_audio_devices(&reply);
    else if (strcmp(method, "setAudioDevices") == 0)
        apply_audio_devices(param_str(params, "input", NULL), param_str(params, "output", NULL));
    else if (strcmp(method, "codecs") == 0) request_codecs(&reply);
    else if (strcmp(method, "setCodecs") == 0) apply_codecs(cJSON_GetObjectItemCaseSensitive(params, "codecs"));
    else if (strcmp(method, "setEcho") == 0) request_set_echo(params, &reply);
    else if (strcmp(method, "startRecording") == 0) request_start_recording(params, &reply);
    else if (strcmp(method, "stopRecording") == 0) request_stop_recording(params, &reply);
    else if (strcmp(method, "version") == 0) {
        reply.result = cJSON_CreateObject();
        cJSON_AddStringToObject(reply.result, "pjsip", pj_get_version());
    }
    else if (strcmp(method, "shutdown") == 0) {
        engine_stop();
        quit_requested = 1;
    }
    else fail(&reply, "Unknown method \xE2\x80\x9C%s\xE2\x80\x9D.", method);

    if (cJSON_IsNumber(id_item)) {
        response = cJSON_CreateObject();
        cJSON_AddNumberToObject(response, "id", id_item->valuedouble);
        cJSON_AddBoolToObject(response, "ok", !reply.failed);
        if (reply.failed) {
            cJSON_AddStringToObject(response, "error", reply.error);
            cJSON_Delete(reply.result);
        } else if (reply.result) {
            cJSON_AddItemToObject(response, "result", reply.result);
        }
        emit(response);
    } else {
        cJSON_Delete(reply.result);
    }
    cJSON_Delete(request);
}

/* ------------------------------------------------------------------------------------ */
/* Input thread and main loop                                                             */
/* ------------------------------------------------------------------------------------ */

typedef struct line_node {
    char *text;
    struct line_node *next;
} line_node;

static sync_t queue_sync;
static line_node *queue_head;
static line_node *queue_tail;
static int input_closed;

/* Reads one line from stdin. Returns NULL at end of input. Over-long lines are dropped. */
static char *read_line(void) {
    size_t capacity = 8192, length = 0;
    char *buffer = (char *)malloc(capacity);
    int too_long = 0;
    int c = EOF;
    if (!buffer) return NULL;
    while ((c = fgetc(stdin)) != EOF) {
        if (c == '\n') break;
        if (too_long) continue;
        if (length + 1 >= capacity) {
            char *grown;
            if (capacity >= MAX_LINE_BYTES) {
                too_long = 1;
                continue;
            }
            grown = (char *)realloc(buffer, capacity * 2);
            if (!grown) {
                too_long = 1;
                continue;
            }
            buffer = grown;
            capacity *= 2;
        }
        buffer[length++] = (char)c;
    }
    if (c == EOF && length == 0) {
        free(buffer);
        return NULL;
    }
    if (too_long) length = 0;
    buffer[length] = '\0';
    if (length > 0 && buffer[length - 1] == '\r') buffer[length - 1] = '\0';
    return buffer;
}

#ifdef _WIN32
static DWORD WINAPI input_thread(LPVOID unused)
#else
static void *input_thread(void *unused)
#endif
{
    char *line;
    (void)unused;
    while ((line = read_line()) != NULL) {
        line_node *node;
        if (!line[0]) {
            free(line);
            continue;
        }
        node = (line_node *)calloc(1, sizeof *node);
        if (!node) {
            free(line);
            continue;
        }
        node->text = line;
        sync_lock(&queue_sync);
        if (queue_tail) queue_tail->next = node;
        else queue_head = node;
        queue_tail = node;
        sync_signal(&queue_sync);
        sync_unlock(&queue_sync);
    }
    sync_lock(&queue_sync);
    input_closed = 1;
    sync_signal(&queue_sync);
    sync_unlock(&queue_sync);
    return 0;
}

int main(int argc, char **argv) {
    cJSON *hello;

    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
        printf("sipper-engine (pjsip %s)\n", pj_get_version());
        return 0;
    }

#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif

    sync_init(&out_sync);
    sync_init(&queue_sync);

#ifdef _WIN32
    {
        HANDLE thread = CreateThread(NULL, 0, input_thread, NULL, 0, NULL);
        if (!thread) {
            fprintf(stderr, "sipper-engine: could not start the input thread\n");
            return 1;
        }
        CloseHandle(thread);
    }
#else
    {
        pthread_t thread;
        if (pthread_create(&thread, NULL, input_thread, NULL) != 0) {
            fprintf(stderr, "sipper-engine: could not start the input thread\n");
            return 1;
        }
        pthread_detach(thread);
    }
#endif

    hello = event_new("hello");
    cJSON_AddStringToObject(hello, "pjsip", pj_get_version());
    emit(hello);

    while (!quit_requested) {
        line_node *node;
        int closed;

        sync_lock(&queue_sync);
        if (!queue_head && !input_closed && !running) sync_wait_ms(&queue_sync, 200);
        node = queue_head;
        if (node) {
            queue_head = node->next;
            if (!queue_head) queue_tail = NULL;
        }
        closed = input_closed && !queue_head;
        sync_unlock(&queue_sync);

        if (node) {
            handle_line(node->text);
            free(node->text);
            free(node);
            continue;
        }
        if (closed) break;
        if (running) pjsua_handle_events(10);
    }

    engine_stop();
    return 0;
}
