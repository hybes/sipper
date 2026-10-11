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
#  include <iphlpapi.h>
#  include <netioapi.h>
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

static double monotonic_ms(void) {
#ifdef _WIN32
    return (double)GetTickCount64();
#else
    struct timespec value;
    clock_gettime(CLOCK_MONOTONIC, &value);
    return value.tv_sec * 1000.0 + value.tv_nsec / 1000000.0;
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
    int deferred;
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
    char *pending_config; /* defer managed credential changes until existing calls finish */
    double managed_until; /* wall-clock milliseconds; zero means a personal account */
    int gateway;
    int managed_dnd; /* incoming direct calls only; separate from SIP registration settings */
    int retiring;
    double withdrawal_retry_at;
    int registration_deferred;
} account_slot;

typedef enum { DIR_OUTGOING, DIR_INCOMING } call_direction;

typedef struct {
    int used;
    char account_id[64];
    call_direction direction;
    const char *state;
    char remote[512];
    char gateway_call_id[37];
    char caller_name[641];
    char caller_number[641];
    int muted;
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
    int transfer_state; /* 0 idle, 1 REFER source, 2 reserved consultation, 3 closing after success */
    int transfer_peer;
    double transfer_peer_started;
    int transfer_end_pending;
    char transfer_status[96];
    int confirmed_hold;
    int hold_pending;
    int hold_reply_pending;
    int hold_target;
    int hold_sequence;
    int hold_accepted;
    double hold_request_id;
    double hold_deadline;
    char conference_id[64];
    int conference_peer;
    double conference_peer_started;
} call_context;

typedef struct {
    pj_pool_t *pool;
    pjmedia_port *port;
    pjsua_conf_port_id slot;
    int playing;
} ringback_tone;

static int running;
static int network_available = 1, network_path_available = 1, network_suspended;
static double network_recovery_at;
static int null_audio;
static char meeting_audio_reference[37];
static pjsua_transport_id verified_tls = PJSUA_INVALID_ID;
static double last_call_started;
static unsigned long long conference_sequence;
#ifdef SIPPER_TESTING
static const char *test_ca_file;
#endif
static account_slot accounts[PJSUA_MAX_ACC];
static call_context calls[PJSUA_MAX_CALLS];
static void finish_hold(call_context *call, const char *error);
static char *applied_stun; /* JSON array text of the STUN servers pjsua knows */
static int stun_count;
static ringback_tone ringback = { NULL, NULL, PJSUA_INVALID_ID, 0 };
static char last_transport_error[320];
static double last_transport_error_at;
static void network_changed(void);
static void observe_network(void);

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

static int account_available(const account_slot *account) {
    return account && account->used && !account->retiring && !account->pending_config &&
           (account->managed_until == 0 || account->managed_until > now_ms());
}

static int account_has_calls(const account_slot *account) {
    int i;
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        if (calls[i].used && strcmp(calls[i].account_id, account->id) == 0) return 1;
    }
    return 0;
}

static int tls_uri(const char *value) {
    pj_pool_t *pool = pjsua_pool_create("gateway-uri", 512, 512);
    pj_str_t text;
    pjsip_uri *parsed;
    int valid = 0;
    if (!pool) return 0;
    pj_strdup2(pool, &text, value);
    parsed = pjsip_parse_uri(pool, text.ptr, text.slen, 0);
    if (parsed && PJSIP_URI_SCHEME_IS_SIP(parsed)) {
        pjsip_sip_uri *uri = (pjsip_sip_uri *)pjsip_uri_get_uri(parsed);
        valid = pj_stricmp2(&uri->transport_param, "tls") == 0 && pj_list_empty(&uri->header_param);
    }
    pj_pool_release(pool);
    return valid;
}

static int gateway_destination(const account_slot *account, const char *uri) {
    const char *number, *at;
    const char *registrar;
    cJSON *config;
    int valid;
    if (!account->gateway) return 1;
    if (strncmp(uri, "sip:", 4) != 0) return 0;
    number = uri + 4;
    at = strchr(number, '@');
    if (!at || at == number || at - number > 128 || strspn(number, "0123456789+*#") != (size_t)(at - number)) return 0;
    config = cJSON_Parse(account->config);
    registrar = param_str(config, "registrar", "");
    valid = strncmp(registrar, "sip:", 4) == 0 && strcmp(at + 1, registrar + 4) == 0;
    cJSON_Delete(config);
    return valid;
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
    call->transfer_peer = PJSUA_INVALID_ID;
    call->conference_peer = PJSUA_INVALID_ID;
    call->started_at = now_ms();
    if (call->started_at <= last_call_started) call->started_at = last_call_started + 1;
    last_call_started = call->started_at;
    return call;
}

static cJSON *call_json(int call_id, const call_context *call) {
    cJSON *object = cJSON_CreateObject();
    cJSON_AddNumberToObject(object, "id", call_id);
    cJSON_AddStringToObject(object, "accountId", call->account_id);
    cJSON_AddStringToObject(object, "direction", call->direction == DIR_INCOMING ? "incoming" : "outgoing");
    cJSON_AddStringToObject(object, "state", call->state);
    cJSON_AddStringToObject(object, "remote", call->remote);
    if (call->gateway_call_id[0]) {
        cJSON_AddStringToObject(object, "gatewayCallId", call->gateway_call_id);
        cJSON_AddStringToObject(object, "callerName", call->caller_name);
        cJSON_AddStringToObject(object, "callerNumber", call->caller_number);
    }
    cJSON_AddBoolToObject(object, "muted", call->muted);
    if (call->conference_id[0]) cJSON_AddStringToObject(object, "conferenceId", call->conference_id);
    cJSON_AddBoolToObject(object, "onHold", call->media_status == PJSUA_CALL_MEDIA_LOCAL_HOLD || (call->confirmed_hold && call->media_status == PJSUA_CALL_MEDIA_NONE));
    cJSON_AddBoolToObject(object, "remoteHold", call->remote_hold);
    cJSON_AddBoolToObject(object, "activeMedia", call->active_media);
    cJSON_AddBoolToObject(object, "recording", call->recorder_id != PJSUA_INVALID_ID);
    cJSON_AddBoolToObject(object, "transferring", call->transfer_state != 0);
    cJSON_AddStringToObject(object, "transferStatus", call->transfer_status);
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

static void transfer_state(call_context *call, int state, const char *message) {
    call->transfer_state = state;
    copy_text(call->transfer_status, sizeof call->transfer_status, message, strlen(message));
    emit_call("callChanged", (int)(call - calls), call);
}

static void release_transfer_peer(call_context *call, int success) {
    call_context *peer = call_for(call->transfer_peer);
    if (peer && peer->started_at == call->transfer_peer_started && peer->transfer_state == 2) {
        peer->transfer_end_pending = success;
        transfer_state(peer, success ? 3 : 0, success ? "Transfer completed" : "Transfer failed. Your call is still connected.");
    }
    call->transfer_peer = PJSUA_INVALID_ID;
    call->transfer_peer_started = 0;
}

/* Run outside PJSIP callbacks. A reused slot is reset by call_begin and cannot inherit cleanup. */
static void finish_transfers(void) {
    int i;
    if (!running) return;
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        call_context *call = call_for(i);
        if (!call || !call->transfer_end_pending) continue;
        call->transfer_end_pending = 0;
        if (pjsua_call_hangup(i, 0, NULL, NULL) != PJ_SUCCESS && call->used)
            transfer_state(call, 0, "Transfer completed. Use End call to close the local call.");
    }
}

static void emit_registration(const char *account_id, const char *state, int code, const char *reason, int expires) {
    cJSON *event = event_new("registration");
    if (!network_available && account_available(account_by_id(account_id))) {
        state = "failed"; code = 0; reason = "No network connection"; expires = 0;
    }
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

static call_context *conference_peer(call_context *call) {
    call_context *peer = call_for(call->conference_peer);
    return call->conference_id[0] && peer && peer->started_at == call->conference_peer_started &&
        peer->conference_peer == (int)(call - calls) && peer->conference_peer_started == call->started_at &&
        strcmp(peer->conference_id, call->conference_id) == 0 && strcmp(peer->account_id, call->account_id) == 0 ? peer : NULL;
}

static void apply_media_wiring(call_context *call) {
    call_context *peer = conference_peer(call);
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
    if (peer && peer->conf_slot != PJSUA_INVALID_ID) {
        int mix = call->active_media && peer->active_media && !call->hold_pending && !peer->hold_pending;
        if (mix) {
            pjsua_conf_connect(slot, peer->conf_slot);
            pjsua_conf_connect(peer->conf_slot, slot);
        } else {
            pjsua_conf_disconnect(slot, peer->conf_slot);
            pjsua_conf_disconnect(peer->conf_slot, slot);
        }
        if (call->recorder_slot != PJSUA_INVALID_ID) {
            if (mix) pjsua_conf_connect(peer->conf_slot, call->recorder_slot);
            else pjsua_conf_disconnect(peer->conf_slot, call->recorder_slot);
        }
        if (peer->recorder_slot != PJSUA_INVALID_ID) {
            if (mix) pjsua_conf_connect(slot, peer->recorder_slot);
            else pjsua_conf_disconnect(slot, peer->recorder_slot);
        }
    }
}

static void break_conference(call_context *call) {
    call_context *peer = conference_peer(call);
    if (peer) {
        if (call->conf_slot != PJSUA_INVALID_ID && peer->conf_slot != PJSUA_INVALID_ID) {
            pjsua_conf_disconnect(call->conf_slot, peer->conf_slot);
            pjsua_conf_disconnect(peer->conf_slot, call->conf_slot);
            if (call->recorder_slot != PJSUA_INVALID_ID) pjsua_conf_disconnect(peer->conf_slot, call->recorder_slot);
            if (peer->recorder_slot != PJSUA_INVALID_ID) pjsua_conf_disconnect(call->conf_slot, peer->recorder_slot);
        }
        peer->conference_id[0] = '\0';
        peer->conference_peer = PJSUA_INVALID_ID;
        peer->conference_peer_started = 0;
        apply_media_wiring(peer);
        emit_call("callChanged", (int)(peer - calls), peer);
    }
    call->conference_id[0] = '\0';
    call->conference_peer = PJSUA_INVALID_ID;
    call->conference_peer_started = 0;
}

static void destroy_recorder(call_context *call) {
    call_context *peer = conference_peer(call);
    if (call->recorder_id == PJSUA_INVALID_ID) return;
    if (call->recorder_slot != PJSUA_INVALID_ID) {
        if (call->conf_slot != PJSUA_INVALID_ID) pjsua_conf_disconnect(call->conf_slot, call->recorder_slot);
        pjsua_conf_disconnect(0, call->recorder_slot);
        if (peer && peer->conf_slot != PJSUA_INVALID_ID) pjsua_conf_disconnect(peer->conf_slot, call->recorder_slot);
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

static int uuid_reference(const char *value, size_t length, char output[37]) {
    size_t i;
    if (!value || length != 36) return 0;
    for (i = 0; i < 36; i++) {
        char c = value[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) { if (c != '-') return 0; }
        else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return 0;
        output[i] = c >= 'A' && c <= 'F' ? c + ('a' - 'A') : c;
    }
    output[36] = '\0';
    return 1;
}

/* A gateway offer must arrive on an outgoing verified TLS connection, with exactly
 * one canonical UUID header. SIP From never supplies the displayed caller identity. */
static int gateway_call_id(const pjsip_rx_data *data, char *output) {
    const pjsip_generic_string_hdr *found = NULL;
    const pjsip_hdr *header;
    pj_str_t name = pjs("X-Sipper-Call-ID");
    if (!data || !data->tp_info.transport || verified_tls == PJSUA_INVALID_ID ||
        !(data->tp_info.transport->flag & PJSIP_TRANSPORT_SECURE) ||
        data->tp_info.transport->dir != PJSIP_TP_DIR_OUTGOING || !data->msg_info.msg) return 0;
    for (header = data->msg_info.msg->hdr.next; header != &data->msg_info.msg->hdr; header = header->next) {
        if (pj_stricmp(&header->name, &name) != 0) continue;
        if (found) return 0;
        found = (const pjsip_generic_string_hdr *)header;
    }
    return found && uuid_reference(found->hvalue.ptr, (size_t)found->hvalue.slen, output);
}

static void on_incoming_call(pjsua_acc_id acc_id, pjsua_call_id call_id, pjsip_rx_data *rdata) {
    pjsua_call_info info;
    account_slot *account = account_by_pj(acc_id);
    call_context *call;
    char reference[37] = "";
    int i;
    if (!account_available(account)) {
        pjsua_call_hangup(call_id, 480, NULL, NULL);
        return;
    }
    if (account->managed_until != 0 && !account->gateway && account->managed_dnd) {
        pjsua_call_hangup(call_id, 486, NULL, NULL);
        return;
    }
    if (pjsua_call_get_info(call_id, &info) != PJ_SUCCESS) {
        pjsua_call_hangup(call_id, 500, NULL, NULL);
        return;
    }
    if (account->gateway) {
        if (!gateway_call_id(rdata, reference)) { pjsua_call_hangup(call_id, 400, NULL, NULL); return; }
        for (i = 0; i < PJSUA_MAX_CALLS; i++) {
            if (calls[i].used && strcmp(calls[i].account_id, account->id) == 0 && strcmp(calls[i].gateway_call_id, reference) == 0) {
                pjsua_call_hangup(call_id, 400, NULL, NULL); return;
            }
        }
    }
    call = call_begin(call_id, account->id, DIR_INCOMING);
    if (account->gateway) copy_text(call->gateway_call_id, sizeof call->gateway_call_id, reference, 36);
    else copy_text(call->remote, sizeof call->remote, info.remote_info.ptr, (size_t)info.remote_info.slen);
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
        if (info.role != PJSIP_ROLE_UAC && account->gateway) return;
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
        call->active_media = 0;
        break_conference(call);
        finish_hold(call, "The call no longer exists.");
        if (call->transfer_state == 1) release_transfer_peer(call, 0);
        destroy_recorder(call);
        emit_call("callEnded", call_id, call);
        call->used = 0;
    } else {
        emit_call("callChanged", call_id, call);
    }
}

static void finish_hold(call_context *call, const char *error) {
    cJSON *response;
    if (!call->hold_pending) return;
    if (!error && (!call->hold_accepted ||
        (call->hold_target ? (call->media_status != PJSUA_CALL_MEDIA_LOCAL_HOLD && call->media_status != PJSUA_CALL_MEDIA_NONE) :
         (call->media_status != PJSUA_CALL_MEDIA_NONE && call->media_status != PJSUA_CALL_MEDIA_ACTIVE && call->media_status != PJSUA_CALL_MEDIA_REMOTE_HOLD)))) return;
    if (!error) {
        /* Both parties holding produces NONE. This is confirmed negotiation, never a requested-state flag. */
        call->confirmed_hold = call->hold_target;
    }
    call->hold_pending = 0;
    apply_media_wiring(call);
    emit_call("callChanged", (int)(call - calls), call);
    if (!call->hold_reply_pending) return;
    call->hold_reply_pending = 0;
    response = cJSON_CreateObject();
    cJSON_AddNumberToObject(response, "id", call->hold_request_id);
    cJSON_AddBoolToObject(response, "ok", error == NULL);
    if (error) cJSON_AddStringToObject(response, "error", error);
    emit(response);
}

static void on_call_tsx_state(pjsua_call_id id, pjsip_transaction *tsx, pjsip_event *event) {
    call_context *call = call_for(id);
    char error[128];
    if (!call || !call->hold_pending || tsx->role != PJSIP_ROLE_UAC || tsx->method.id != PJSIP_INVITE_METHOD) return;
    if (tsx->state == PJSIP_TSX_STATE_CALLING) call->hold_sequence = tsx->cseq;
    if (call->hold_sequence != tsx->cseq || tsx->state < PJSIP_TSX_STATE_COMPLETED || tsx->status_code < 200 ||
        tsx->status_code == 401 || tsx->status_code == 407 || tsx->status_code == 422) return;
    if (tsx->status_code < 300) { call->hold_accepted = 1; finish_hold(call, NULL); }
    else {
        snprintf(error, sizeof error, "The phone system rejected the hold change (SIP %d).", tsx->status_code);
        finish_hold(call, error);
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
    if (call->active_media) ringback_stop_for(call);
    apply_media_wiring(call);
    emit_call("callChanged", call_id, call);
    finish_hold(call, NULL);
}

static void on_reg_state2(pjsua_acc_id acc_id, pjsua_reg_info *info) {
    char reason[512];
    account_slot *account = account_by_pj(acc_id);
    if (!account) return;
    if (!account_available(account)) {
        emit_registration(account->id, "unregistered", 0, "Managed access unavailable", 0);
        return;
    }

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

static void on_call_transfer_request(pjsua_call_id call_id, const pj_str_t *destination, pjsip_status_code *code) {
    call_context *call = call_for(call_id);
    account_slot *account = call ? account_by_id(call->account_id) : NULL;
    /* Gateway call legs must be admitted by the service, never by an unsolicited REFER. */
    if (!account_available(account) || account->gateway) *code = PJSIP_SC_FORBIDDEN;
}

static void on_call_replace_request(pjsua_call_id call_id, pjsip_rx_data *rdata, int *code, pj_str_t *text) {
    call_context *call = call_for(call_id);
    account_slot *account = call ? account_by_id(call->account_id) : NULL;
    if (!account_available(account) || account->gateway) {
        *code = PJSIP_SC_FORBIDDEN;
        *text = pjs("Managed access unavailable");
    }
}

static void on_call_transfer_status(pjsua_call_id call_id, int code, const pj_str_t *text, pj_bool_t final,
                                    pj_bool_t *p_continue) {
    call_context *call = call_for(call_id);
    int success = code >= 200 && code < 300, finished = code >= 200 || final;
    cJSON *event;
    if (!call || call->transfer_state != 1) { *p_continue = PJ_FALSE; return; }
    if (finished) {
        *p_continue = PJ_FALSE;
        release_transfer_peer(call, success);
        call->transfer_end_pending = success;
    }
    transfer_state(call, finished ? (success ? 3 : 0) : 1,
        !finished ? "Transferring…" : success ? "Transfer completed" : "Transfer failed. Your call is still connected.");
    event = event_new("transferStatus");
    cJSON_AddNumberToObject(event, "callId", call_id);
    cJSON_AddStringToObject(event, "accountId", call->account_id);
    cJSON_AddNumberToObject(event, "startedAt", call->started_at);
    cJSON_AddNumberToObject(event, "code", code);
    cJSON_AddStringToObject(event, "text", call->transfer_status);
    cJSON_AddBoolToObject(event, "final", finished);
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
#ifdef SIPPER_TESTING
    if (kind == TP_TLS && test_ca_file) config.tls_setting.ca_list_file = pjs(test_ca_file);
#endif

    status = pjsua_transport_create(type, &config, &id);
    if (status != PJ_SUCCESS && config.port != 0) {
        app_log("%s port %d unavailable (%s), using a random port", names[kind], port,
                pj_message(status, message, sizeof message));
        config.port = 0;
        status = pjsua_transport_create(type, &config, &id);
    }
    if (status == PJ_SUCCESS) {
        if (kind == TP_TLS && verify_tls) verified_tls = id;
        return 1;
    }
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

    if (!running || null_audio || meeting_audio_reference[0]) return;
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

static void request_meeting_audio(const cJSON *params, reply_t *reply) {
    const cJSON *enabled = cJSON_GetObjectItemCaseSensitive(params, "enabled");
    const char *value = param_str(params, "reference", NULL);
    char reference[37];
    int i;
    if (!cJSON_IsBool(enabled) || !value || !uuid_reference(value, strlen(value), reference)) {
        fail(reply, "A valid meeting audio reference and boolean enabled value are required."); return;
    }
    if (meeting_audio_reference[0] && strcmp(reference, meeting_audio_reference) != 0) {
        fail(reply, "Meeting audio belongs to another session."); return;
    }
    if (cJSON_IsTrue(enabled) && !meeting_audio_reference[0]) {
        for (i = 0; i < PJSUA_MAX_CALLS; i++) {
            const call_context *call = &calls[i];
            if (!call->used) continue;
            if (call->hold_pending || call->transfer_state ||
                (!(strcmp(call->state, "confirmed") == 0 && call->confirmed_hold) &&
                 !(strcmp(call->state, "incoming") == 0 && !call->active_media))) {
                fail(reply, "Hold your phone calls before joining a meeting."); return;
            }
        }
        if (running && !check(pjsua_set_null_snd_dev(), "release phone audio", reply)) return;
        memcpy(meeting_audio_reference, reference, sizeof reference);
    } else if (!cJSON_IsTrue(enabled) && meeting_audio_reference[0]) {
        meeting_audio_reference[0] = '\0';
        apply_audio_devices(param_str(params, "input", NULL), param_str(params, "output", NULL));
    }
    reply->result = cJSON_CreateObject();
    cJSON_AddBoolToObject(reply->result, "claimed", meeting_audio_reference[0] != '\0');
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
    {
        const cJSON *reference = cJSON_GetObjectItemCaseSensitive(params, "meetingAudioReference");
        if (reference) {
            char normalised[37];
            if (cJSON_IsNull(reference)) meeting_audio_reference[0] = '\0';
            else if (!cJSON_IsString(reference) || !uuid_reference(reference->valuestring, strlen(reference->valuestring), normalised)) {
                fail(reply, "A valid meeting audio reference is required."); return 0;
            } else memcpy(meeting_audio_reference, normalised, sizeof normalised);
        }
    }
    network_suspended = param_bool(params, "suspended", network_suspended);
    network_available = network_path_available && !network_suspended;
    verified_tls = PJSUA_INVALID_ID;
#ifdef SIPPER_TESTING
    test_ca_file = param_str(params, "testCaFile", NULL);
#endif
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
    config.cb.on_call_tsx_state = &on_call_tsx_state;
    config.cb.on_reg_state2 = &on_reg_state2;
    config.cb.on_mwi_info = &on_mwi_info;
    config.cb.on_call_transfer_status = &on_call_transfer_status;
    config.cb.on_call_transfer_request = &on_call_transfer_request;
    config.cb.on_call_replace_request = &on_call_replace_request;
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
    network_changed();
    network_recovery_at = 0; /* Fresh listeners need no IP-change restart. */
    null_audio = param_bool(params, "nullAudio", 0);
    if (null_audio || meeting_audio_reference[0]) {
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
    network_recovery_at = 0;
    ringback_silence();
    pjsua_call_hangup_all();
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        call_context *call = &calls[i];
        if (!call->used) continue;
        finish_hold(call, "The SIP engine stopped.");
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
        free(accounts[i].pending_config);
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
    int gateway = param_bool(account, "gateway", 0);
    int reg_timeout = param_int(account, "regTimeout", 300);
    int use_stun = param_bool(account, "useStun", 0) && stun_count > 0;

    config->id = pjs(param_str(account, "aor", ""));
    config->reg_uri = pjs(param_str(account, "registrar", ""));
    config->reg_timeout = (unsigned)(reg_timeout < 60 ? 60 : reg_timeout);
    config->reg_retry_interval = 30;
    config->reg_first_retry_interval = 5;
    config->reg_delay_before_refresh = 5;
    config->register_on_acc_add = network_available ? PJ_TRUE : PJ_FALSE;
    config->ip_change_cfg.hangup_calls = PJ_FALSE;
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
    config->cred_info[0].algorithm_type = gateway ? PJSIP_AUTH_ALGORITHM_SHA256 : PJSIP_AUTH_ALGORITHM_MD5;
    if (!gateway && pjsip_auth_is_algorithm_supported(PJSIP_AUTH_ALGORITHM_SHA256)) {
        config->cred_info[1] = config->cred_info[0];
        config->cred_info[1].algorithm_type = PJSIP_AUTH_ALGORITHM_SHA256;
        config->cred_count = 2;
    }

    config->proxy_cnt = 1;
    config->proxy[0] = pjs(param_str(account, "proxy", ""));

    if (strcmp(srtp, "mandatory") == 0) config->use_srtp = PJMEDIA_SRTP_MANDATORY;
    else if (strcmp(srtp, "optional") == 0) config->use_srtp = PJMEDIA_SRTP_OPTIONAL;
    else config->use_srtp = PJMEDIA_SRTP_DISABLED;
    config->srtp_secure_signaling = gateway ? 1 : 0;
    if (gateway) config->transport_id = verified_tls;

    config->sip_stun_use = use_stun ? PJSUA_STUN_USE_DEFAULT : PJSUA_STUN_USE_DISABLED;
    config->media_stun_use = use_stun ? PJSUA_STUN_USE_DEFAULT : PJSUA_STUN_USE_DISABLED;
    config->ice_cfg_use = PJSUA_ICE_CONFIG_USE_CUSTOM;
    config->ice_cfg.enable_ice = param_bool(account, "useIce", 0) ? PJ_TRUE : PJ_FALSE;

    config->vid_in_auto_show = PJ_FALSE;
    config->vid_out_auto_transmit = PJ_FALSE;
}

static void add_account(const char *id, const cJSON *account, char *config_text, double managed_until) {
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
            accounts[i].managed_until = managed_until;
            accounts[i].managed_dnd = param_bool(account, "managedDoNotDisturb", 0);
            accounts[i].gateway = param_bool(account, "gateway", 0);
            accounts[i].registration_deferred = !network_available;
            break;
        }
    }
    emit_registration(id, "registering", 0, "", 0);
}

static int modify_account(account_slot *slot, const cJSON *account, char *config_text) {
    pjsua_acc_config config;
    pj_status_t status;
    char message[256];

    pjsua_acc_config_default(&config);
    fill_account_config(&config, account);
    status = pjsua_acc_modify(slot->acc, &config);
    if (status == PJ_SUCCESS) {
        free(slot->config);
        slot->config = config_text;
        slot->gateway = param_bool(account, "gateway", 0);
        slot->retiring = 0;
        slot->withdrawal_retry_at = 0;
        slot->registration_deferred = !network_available;
        if (network_available) pjsua_acc_set_registration(slot->acc, PJ_TRUE);
        emit_registration(slot->id, "registering", 0, "", 0);
    } else {
        pj_message(status, message, sizeof message);
        app_log("modifying account %s failed: %s", slot->id, message);
        emit_registration(slot->id, "failed", 0, message, 0);
        free(config_text);
    }
    return status == PJ_SUCCESS;
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
    free(slot->pending_config);
    memset(slot, 0, sizeof *slot);
    emit_registration(id, "unregistered", 0, "", 0);
}

/* Withdraw registration and admission immediately, but keep established SIP dialogs alive.
 * Deletion and deferred updates run on the main loop, never inside a PJSIP callback. */
static void retire_account(account_slot *slot) {
    int i;
    cJSON *account;
    pjsua_acc_config config;
    pj_status_t status = PJ_EINVAL;
    if (slot->retiring && (!slot->withdrawal_retry_at || slot->withdrawal_retry_at > monotonic_ms())) return;
    slot->retiring = 1;
    account = slot->config ? cJSON_Parse(slot->config) : NULL;
    if (account) {
        pjsua_acc_config_default(&config);
        fill_account_config(&config, account);
        config.reg_uri = pjs("");
        config.register_on_acc_add = PJ_FALSE;
        status = pjsua_acc_modify(slot->acc, &config);
        cJSON_Delete(account);
    }
    slot->withdrawal_retry_at = status == PJ_SUCCESS ? 0 : monotonic_ms() + 5000;
    if (status != PJ_SUCCESS) {
        pjsua_acc_set_registration(slot->acc, PJ_FALSE);
        app_log("disabling managed registration failed; recovery waits for withdrawal (%d)", status);
    }
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        if (calls[i].used && calls[i].connected_at <= 0 && strcmp(calls[i].account_id, slot->id) == 0)
            pjsua_call_hangup(i, 480, NULL, NULL);
    }
    emit_registration(slot->id, "unregistered", 0, "Managed access unavailable", 0);
}

static void maintain_managed_accounts(void) {
    int i;
    if (!running) return;
    for (i = 0; i < PJSUA_MAX_ACC; i++) {
        account_slot *slot = &accounts[i];
        if (!slot->used || slot->managed_until == 0) continue;
        if (slot->retiring && slot->withdrawal_retry_at) retire_account(slot);
        if (slot->managed_until <= now_ms()) {
            free(slot->pending_config);
            slot->pending_config = NULL;
            retire_account(slot);
        }
        if (account_has_calls(slot)) continue;
        if (slot->pending_config) {
            char *text = slot->pending_config;
            cJSON *config = cJSON_Parse(text);
            slot->pending_config = NULL;
            if (!config || !modify_account(slot, config, text)) {
                if (!config) free(text);
                retire_account(slot);
            }
            cJSON_Delete(config);
        }
        if (slot->retiring) remove_account(slot);
    }
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
        if (!wanted) {
            free(accounts[i].pending_config);
            accounts[i].pending_config = NULL;
            if (accounts[i].managed_until != 0) retire_account(&accounts[i]);
            else remove_account(&accounts[i]);
        }
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
        cJSON *config;
        const cJSON *lease = cJSON_GetObjectItemCaseSensitive(item, "managedUntil");
        const cJSON *gateway = cJSON_GetObjectItemCaseSensitive(item, "gateway");
        const cJSON *dnd = cJSON_GetObjectItemCaseSensitive(item, "managedDoNotDisturb");
        double managed_until = lease ? (cJSON_IsNumber(lease) ? lease->valuedouble : -1) : 0;
        if (!id || strlen(id) >= sizeof accounts[0].id) continue;
        slot = account_by_id(id);
        /* A malformed or missing lease cannot downgrade an existing managed account. */
        if ((dnd && (!cJSON_IsBool(dnd) || !lease)) || (gateway && !cJSON_IsBool(gateway)) ||
            (cJSON_IsTrue(gateway) && (!lease || verified_tls == PJSUA_INVALID_ID ||
                !pjsip_auth_is_algorithm_supported(PJSIP_AUTH_ALGORITHM_SHA256) ||
                strcmp(param_str(item, "srtp", ""), "mandatory") != 0 ||
                !tls_uri(param_str(item, "registrar", "")) || !tls_uri(param_str(item, "proxy", "")))) ||
            (lease && !(managed_until > now_ms() && managed_until <= now_ms() + 86460000)) ||
            (slot && slot->managed_until != 0 && !lease)) {
            if (slot) {
                free(slot->pending_config);
                slot->pending_config = NULL;
                retire_account(slot);
            }
            continue;
        }
        config = cJSON_Duplicate(item, 1);
        if (!config) continue;
        cJSON_DeleteItemFromObjectCaseSensitive(config, "managedUntil");
        cJSON_DeleteItemFromObjectCaseSensitive(config, "managedDoNotDisturb");
        text = cJSON_PrintUnformatted(config);
        cJSON_Delete(config);
        if (!text) continue;
        if (!slot) add_account(id, item, text, managed_until);
        else {
            slot->managed_until = managed_until;
            slot->managed_dnd = cJSON_IsTrue(dnd);
            free(slot->pending_config);
            slot->pending_config = NULL;
            if (!slot->config || strcmp(slot->config, text) != 0) {
                if (managed_until != 0 && account_has_calls(slot)) {
                    slot->pending_config = text;
                    retire_account(slot);
                } else if (!modify_account(slot, item, text) && managed_until != 0) retire_account(slot);
            } else if (slot->retiring) modify_account(slot, item, text);
            else free(text);
        }
    }
    maintain_managed_accounts();
    reply->result = cJSON_CreateObject();
    {
        cJSON *applied = cJSON_AddArrayToObject(reply->result, "appliedAccountIds");
        for (i = 0; i < PJSUA_MAX_ACC; i++) {
            if (account_available(&accounts[i])) cJSON_AddItemToArray(applied, cJSON_CreateString(accounts[i].id));
        }
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
    int other = strcmp(key, "otherCallId") == 0;
    const cJSON *item = cJSON_GetObjectItemCaseSensitive(params, key);
    const cJSON *started = cJSON_GetObjectItemCaseSensitive(params, other ? "otherStartedAt" : "expectedStartedAt");
    const char *account = param_str(params, other ? "otherAccountId" : "accountId", NULL);
    call_context *call = cJSON_IsNumber(item) && item->valuedouble == item->valueint ? call_for(item->valueint) : NULL;
    if (call &&
        ((started && (!cJSON_IsNumber(started) || started->valuedouble != call->started_at)) ||
         (account && strcmp(account, call->account_id) != 0))) call = NULL;
    if (!call) fail(reply, "The call no longer exists.");
    return call;
}

static call_context *require_call_identity(const cJSON *params, const char *key, reply_t *reply) {
    int other = strcmp(key, "otherCallId") == 0;
    if (!cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(params, other ? "otherStartedAt" : "expectedStartedAt")) ||
        !cJSON_IsString(cJSON_GetObjectItemCaseSensitive(params, other ? "otherAccountId" : "accountId"))) {
        fail(reply, "A call identity is required."); return NULL;
    }
    return require_call(params, key, reply);
}

static call_context *require_conference(const cJSON *params, reply_t *reply) {
    call_context *call = require_call_identity(params, "callId", reply);
    if (!call) return NULL;
    if (!call->conference_id[0] || strcmp(call->conference_id, param_str(params, "conferenceId", "")) != 0 || !conference_peer(call)) {
        fail(reply, "This conference is no longer available."); return NULL;
    }
    return call;
}

static void request_begin_conference(const cJSON *params, reply_t *reply) {
    call_context *call = require_call_identity(params, "callId", reply), *peer;
    pj_status_t status;
    if (!call) return;
    peer = require_call_identity(params, "otherCallId", reply);
    if (!peer) return;
    if (call == peer || strcmp(call->account_id, peer->account_id) != 0 || !account_available(account_by_id(call->account_id))) {
        fail(reply, "Choose two connected calls on the same active account."); return;
    }
    if (strcmp(call->state, "confirmed") != 0 || strcmp(peer->state, "confirmed") != 0 ||
        call->conference_id[0] || peer->conference_id[0] || call->transfer_state || peer->transfer_state ||
        call->hold_pending || peer->hold_pending || !call->active_media || !peer->active_media ||
        call->conf_slot == PJSUA_INVALID_ID || peer->conf_slot == PJSUA_INVALID_ID) {
        fail(reply, "Both calls must finish resuming before they can be merged."); return;
    }
    for (int i = 0; i < PJSUA_MAX_CALLS; i++) {
        if (calls[i].used && &calls[i] != call && &calls[i] != peer && (calls[i].active_media || calls[i].hold_pending)) {
            fail(reply, "Hold your other calls before merging."); return;
        }
    }
    if (!check(pjsua_conf_connect(call->conf_slot, peer->conf_slot), "conference audio", reply)) return;
    status = pjsua_conf_connect(peer->conf_slot, call->conf_slot);
    if (!check(status, "conference audio", reply)) {
        pjsua_conf_disconnect(call->conf_slot, peer->conf_slot); return;
    }
    /* Fresh on each merge, including regrouping the same native legs. This is not an auth token. */
    snprintf(call->conference_id, sizeof call->conference_id, "%.0f:%llu", call->started_at, ++conference_sequence);
    copy_text(peer->conference_id, sizeof peer->conference_id, call->conference_id, strlen(call->conference_id));
    call->conference_peer = (int)(peer - calls); call->conference_peer_started = peer->started_at;
    peer->conference_peer = (int)(call - calls); peer->conference_peer_started = call->started_at;
    call->muted = peer->muted = call->muted || peer->muted;
    apply_media_wiring(call); apply_media_wiring(peer);
    emit_call("callChanged", (int)(call - calls), call); emit_call("callChanged", (int)(peer - calls), peer);
    reply->result = call_json((int)(call - calls), call);
}

static void request_split_conference(const cJSON *params, reply_t *reply) {
    call_context *call = require_conference(params, reply), *peer;
    if (!call) return;
    peer = conference_peer(call);
    if (call->hold_pending || peer->hold_pending || call->active_media || peer->active_media) {
        fail(reply, "Hold both participants before separating the conference."); return;
    }
    break_conference(call);
    apply_media_wiring(call);
    emit_call("callChanged", (int)(call - calls), call);
}

static void request_hangup_conference(const cJSON *params, reply_t *reply) {
    call_context *call = require_conference(params, reply), *peer;
    int peer_id;
    double peer_started;
    char peer_account[64];
    if (!call) return;
    peer = conference_peer(call);
    peer_id = (int)(peer - calls); peer_started = peer->started_at;
    copy_text(peer_account, sizeof peer_account, peer->account_id, strlen(peer->account_id));
    if (!check(pjsua_call_hangup((int)(call - calls), 0, NULL, NULL), "conference hangup", reply)) return;
    peer = call_for(peer_id);
    if (peer && peer->started_at == peer_started && strcmp(peer->account_id, peer_account) == 0)
        check(pjsua_call_hangup(peer_id, 0, NULL, NULL), "conference hangup", reply);
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
    if (!account_available(account)) {
        fail(reply, "The account is not active.");
        return;
    }
    for (int i = 0; i < PJSUA_MAX_CALLS; ++i) {
        if (calls[i].hold_pending) { fail(reply, "The call is still updating. Try again."); return; }
    }
    if (!gateway_destination(account, uri)) { fail(reply, "Use a phone number on this gateway account."); return; }
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
        /* ICE prepares media asynchronously before there is an active INVITE.
         * get_info also recognises that pending dialog; is_active does not. */
        pjsua_call_info info;
        if (pjsua_call_get_info(call_id, &info) != PJ_SUCCESS || info.state == PJSIP_INV_STATE_DISCONNECTED) {
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
    int code = param_int(params, "code", 200);
    if (!call) return;
    if (code >= 200 && code < 300) for (int i = 0; i < PJSUA_MAX_CALLS; ++i) {
        if (calls[i].hold_pending) { fail(reply, "The call is still updating. Try again."); return; }
    }
    call_id = (int)(call - calls);
    if (code >= 200 && code < 300 && (call->direction != DIR_INCOMING || call->connected_at > 0 || strcmp(call->state, "incoming") != 0)) {
        fail(reply, "The call is no longer ringing."); return;
    }
    if (code >= 200 && code < 300 && call->gateway_call_id[0] &&
        (!cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(params, "expectedStartedAt")) ||
         strcmp(param_str(params, "accountId", ""), call->account_id) != 0 ||
         strcmp(param_str(params, "claimedGatewayCallId", ""), call->gateway_call_id) != 0)) {
        fail(reply, "This gateway call needs an authenticated answer claim."); return;
    }
    if (code >= 200 && code < 300 && call->connected_at <= 0 && !account_available(account_by_id(call->account_id))) {
        pjsua_call_hangup(call_id, 480, NULL, NULL);
        fail(reply, "Managed access is unavailable.");
        return;
    }
    default_call_setting(&setting);
    check(pjsua_call_answer2(call_id, &setting, (unsigned)code, NULL, NULL),
          "pjsua_call_answer2", reply);
}

static void request_hangup(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    if (!call) return;
    if (param_bool(params, "onlyIfRinging", 0)) {
        if (!cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(params, "expectedStartedAt"))) { fail(reply, "A call identity is required."); return; }
        if (call->connected_at > 0 || strcmp(call->state, "incoming") != 0) return;
    }
    /* Code 0 lets pjsua pick BYE, CANCEL or 603 as appropriate. */
    check(pjsua_call_hangup((pjsua_call_id)(call - calls), (unsigned)param_int(params, "code", 0), NULL, NULL),
          "pjsua_call_hangup", reply);
}

static int caller_text(const char *text) {
    const unsigned char *p = (const unsigned char *)text;
    if (!text || strlen(text) > 640) return 0;
    for (; *p; p++) if (*p < 32 || *p == 127) return 0;
    return 1;
}

static void request_managed_caller(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    const char *name = param_str(params, "name", NULL), *number = param_str(params, "number", NULL);
    if (!call) return;
    if (!call->gateway_call_id[0] || strcmp(param_str(params, "gatewayCallId", ""), call->gateway_call_id) != 0 ||
        !cJSON_IsNumber(cJSON_GetObjectItemCaseSensitive(params, "expectedStartedAt")) ||
        strcmp(param_str(params, "accountId", ""), call->account_id) != 0 ||
        !account_available(account_by_id(call->account_id)) || call->connected_at > 0 ||
        strcmp(call->state, "incoming") != 0 || !caller_text(name) || !caller_text(number)) {
        fail(reply, "The managed caller identity is unavailable."); return;
    }
    copy_text(call->caller_name, sizeof call->caller_name, name, strlen(name));
    copy_text(call->caller_number, sizeof call->caller_number, number, strlen(number));
    reply->result = call_json((int)(call - calls), call);
}

static void request_set_hold(const cJSON *params, const cJSON *request_id, reply_t *reply) {
    call_context *call = require_call_identity(params, "callId", reply);
    int hold = param_bool(params, "hold", 1);
    pjsua_call_id call_id;
    pj_status_t status;
    if (!call) return;
    if ((call->conference_id[0] || cJSON_HasObjectItem(params, "conferenceId")) && !require_conference(params, reply)) return;
    if (strcmp(call->state, "confirmed") != 0 || call->transfer_state) { fail(reply, "This call is not available to hold."); return; }
    if (!cJSON_IsNumber(request_id)) { fail(reply, "A request identity is required."); return; }
    if (call->hold_pending) { fail(reply, "The call is still updating. Try again."); return; }
    if (strcmp(call->state, "confirmed") == 0 && (hold ? (call->media_status == PJSUA_CALL_MEDIA_LOCAL_HOLD || (call->confirmed_hold && call->media_status == PJSUA_CALL_MEDIA_NONE)) :
        (call->media_status == PJSUA_CALL_MEDIA_ACTIVE || call->media_status == PJSUA_CALL_MEDIA_REMOTE_HOLD || (call->media_status == PJSUA_CALL_MEDIA_NONE && !call->confirmed_hold)))) return;
    call_id = (pjsua_call_id)(call - calls);
    if (!hold) for (int i = 0; i < PJSUA_MAX_CALLS; ++i) {
        if (calls[i].hold_pending) { fail(reply, "The call is still updating. Try again."); return; }
    }
    call->hold_pending = 1;
    call->hold_reply_pending = 1;
    call->hold_target = hold;
    call->hold_sequence = 0;
    call->hold_accepted = 0;
    call->hold_request_id = request_id->valuedouble;
    call->hold_deadline = monotonic_ms() + 4000;
    apply_media_wiring(call);
    if (hold) {
        status = pjsua_call_set_hold2(call_id, 0, NULL);
    } else {
        pjsua_call_setting setting;
        default_call_setting(&setting);
        setting.flag |= PJSUA_CALL_UNHOLD;
        status = pjsua_call_reinvite2(call_id, &setting, NULL);
    }
    if (!check(status, hold ? "pjsua_call_set_hold2" : "pjsua_call_reinvite2", reply)) {
        call->hold_pending = 0; call->hold_reply_pending = 0; apply_media_wiring(call); return;
    }
    reply->deferred = 1;
}

static void request_set_muted(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    if (!call) return;
    call->muted = param_bool(params, "muted", 1);
    call_context *peer = conference_peer(call);
    if (peer) {
        peer->muted = call->muted;
        apply_media_wiring(peer);
        emit_call("callChanged", (int)(peer - calls), peer);
    }
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

static call_context *require_transfer_call(const cJSON *params, const char *key, reply_t *reply) {
    call_context *call = require_call_identity(params, key, reply);
    if (!call) return NULL;
    if (!account_available(account_by_id(call->account_id))) {
        fail(reply, "Calling account access is unavailable."); return NULL;
    }
    if (strcmp(call->state, "confirmed") != 0 || call->transfer_state || call->conference_id[0] || call->hold_pending) {
        fail(reply, "This call is not available to transfer."); return NULL;
    }
    return call;
}

static void request_transfer(const cJSON *params, reply_t *reply) {
    call_context *call = require_transfer_call(params, "callId", reply);
    const char *uri = param_str(params, "uri", "");
    pj_str_t destination = pjs(uri);
    pj_status_t status;
    if (!call) return;
    if (pjsua_verify_sip_url(uri) != PJ_SUCCESS) {
        fail(reply, "\xE2\x80\x9C%s\xE2\x80\x9D is not a valid SIP address.", uri);
        return;
    }
    if (!gateway_destination(account_by_id(call->account_id), uri)) { fail(reply, "Use a phone number on this gateway account."); return; }
    transfer_state(call, 1, "Transferring…");
    status = pjsua_call_xfer((pjsua_call_id)(call - calls), &destination, NULL);
    if (status != PJ_SUCCESS) transfer_state(call, 0, "Transfer failed. Your call is still connected.");
    check(status, "pjsua_call_xfer", reply);
}

static void request_attended_transfer(const cJSON *params, reply_t *reply) {
    call_context *call = require_transfer_call(params, "callId", reply);
    call_context *other = call ? require_transfer_call(params, "otherCallId", reply) : NULL;
    pj_status_t status;
    if (!call || !other) return;
    if (call == other || strcmp(call->account_id, other->account_id) != 0) {
        fail(reply, "Choose another connected call on the same account."); return;
    }
    call->transfer_peer = (int)(other - calls);
    call->transfer_peer_started = other->started_at;
    transfer_state(other, 2, "Transferring…");
    transfer_state(call, 1, "Transferring…");
    status = pjsua_call_xfer_replaces((pjsua_call_id)(call - calls), (pjsua_call_id)(other - calls), 0, NULL);
    if (status != PJ_SUCCESS) {
        release_transfer_peer(call, 0);
        transfer_state(call, 0, "Transfer failed. Your call is still connected.");
    }
    check(status, "pjsua_call_xfer_replaces", reply);
}

static void request_active_calls(reply_t *reply) {
    int i;
    reply->result = cJSON_CreateArray();
    for (i = 0; i < PJSUA_MAX_CALLS; i++) {
        if (calls[i].used) cJSON_AddItemToArray(reply->result, call_json(i, &calls[i]));
    }
}

#ifdef SIPPER_TESTING
static void request_test_digest(const cJSON *params, reply_t *reply) {
    const char *name = param_str(params, "algorithm", "");
    pjsip_auth_algorithm_type algorithm = strcmp(name, "md5") == 0 ? PJSIP_AUTH_ALGORITHM_MD5 :
        strcmp(name, "sha256") == 0 ? PJSIP_AUTH_ALGORITHM_SHA256 : PJSIP_AUTH_ALGORITHM_SHA512_256;
    pjsip_cred_info credential;
    char bytes[65] = { 0 };
    pj_str_t result = { bytes, 64 }, nonce = pjs("fixture-nonce"), count = pjs("00000001"),
        cnonce = pjs("fixture-cnonce"), qop = pjs(param_bool(params, "qop", 0) ? "auth" : ""),
        uri = pjs("sip:sipper.test"), realm = pjs("sipper.test"), method = pjs("REGISTER");
    if (!running || !pjsip_auth_is_algorithm_supported(algorithm)) { fail(reply, "Digest algorithm unavailable."); return; }
    pj_bzero(&credential, sizeof credential);
    credential.username = pjs("gateway-test");
    credential.data = pjs(param_str(params, "credential", ""));
    credential.data_type = param_bool(params, "precomputed", 0) ? PJSIP_CRED_DATA_DIGEST : PJSIP_CRED_DATA_PLAIN_PASSWD;
    credential.algorithm_type = algorithm;
    if (!check(pjsip_auth_create_digest2(&result, &nonce, &count, &cnonce, &qop, &uri, &realm, &credential, &method, algorithm), "test digest", reply)) return;
    bytes[result.slen] = '\0';
    reply->result = cJSON_CreateString(bytes);
}

static void request_test_media(const cJSON *params, reply_t *reply) {
    call_context *call = require_call(params, "callId", reply);
    pjsua_stream_info info;
    pjsua_stream_stat stats;
    char dump[16384], codec[64];
    int id;
    if (!call) return;
    id = (int)(call - calls);
    if (!check(pjsua_call_get_stream_info(id, 0, &info), "test stream info", reply) ||
        !check(pjsua_call_get_stream_stat(id, 0, &stats), "test stream stats", reply) ||
        !check(pjsua_call_dump(id, PJ_TRUE, dump, sizeof dump, ""), "test stream transport", reply)) return;
    copy_text(codec, sizeof codec, info.info.aud.fmt.encoding_name.ptr, info.info.aud.fmt.encoding_name.slen);
    reply->result = cJSON_CreateObject();
    cJSON_AddStringToObject(reply->result, "codec", codec);
    cJSON_AddNumberToObject(reply->result, "sent", stats.rtcp.tx.pkt);
    cJSON_AddNumberToObject(reply->result, "received", stats.rtcp.rx.pkt);
    cJSON_AddBoolToObject(reply->result, "srtp", strstr(dump, "SRTP status: Active") != NULL);
    cJSON_AddBoolToObject(reply->result, "ice", strstr(dump, "state: Negotiation Success") != NULL);
    unsigned tx_level = 0, rx_level = 0;
    pjsua_conf_get_signal_level(call->conf_slot, &tx_level, &rx_level);
    cJSON_AddNumberToObject(reply->result, "receivedLevel", rx_level);
}
#endif

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
    if (!account || (enabled && !account_available(account))) {
        fail(reply, "The account is not active.");
        return;
    }
    if (enabled && !network_available) {
        emit_registration(account->id, "failed", 0, "No network connection", 0);
        fail(reply, "No network connection");
        return;
    }
    status = pjsua_acc_set_registration(account->acc, enabled ? PJ_TRUE : PJ_FALSE);
    if (status == PJ_SUCCESS) {
        emit_registration(account->id, enabled ? "registering" : "unregistered", 0, "", 0);
    } else {
        emit_registration(account->id, "failed", 0, pj_message(status, message, sizeof message), 0);
    }
}

/* Network callbacks only mark a change. All account/media work stays on this loop. */
#ifdef _WIN32
static HANDLE interface_notification, address_notification, route_notification;
static volatile LONG network_dirty = 1;
static double network_observation_retry_at;
static VOID CALLBACK interface_changed(PVOID context, PMIB_IPINTERFACE_ROW row, MIB_NOTIFICATION_TYPE type) { InterlockedExchange(&network_dirty, 1); }
static VOID CALLBACK address_changed(PVOID context, PMIB_UNICASTIPADDRESS_ROW row, MIB_NOTIFICATION_TYPE type) { InterlockedExchange(&network_dirty, 1); }
static VOID CALLBACK route_changed(PVOID context, PMIB_IPFORWARD_ROW2 row, MIB_NOTIFICATION_TYPE type) { InterlockedExchange(&network_dirty, 1); }

static void start_network_observer(void) {
    DWORD a = interface_notification ? NO_ERROR : NotifyIpInterfaceChange(AF_UNSPEC, interface_changed, NULL, FALSE, &interface_notification);
    DWORD b = address_notification ? NO_ERROR : NotifyUnicastIpAddressChange(AF_UNSPEC, address_changed, NULL, FALSE, &address_notification);
    DWORD c = route_notification ? NO_ERROR : NotifyRouteChange2(AF_UNSPEC, route_changed, NULL, FALSE, &route_notification);
    if (a || b || c) {
        app_log("network notification setup failed; retrying (%lu, %lu, %lu)", a, b, c);
        network_observation_retry_at = monotonic_ms() + 5000;
    }
}
static void stop_network_observer(void) {
    if (interface_notification) CancelMibChangeNotify2(interface_notification);
    if (address_notification) CancelMibChangeNotify2(address_notification);
    if (route_notification) CancelMibChangeNotify2(route_notification);
}
static void observe_network(void) {
    PMIB_UNICASTIPADDRESS_TABLE table = NULL;
    ULONG i;
    int available = 0;
    int retry = network_observation_retry_at && monotonic_ms() >= network_observation_retry_at;
    DWORD status;
    if (!InterlockedExchange(&network_dirty, 0) && !retry) return;
    if (retry) { network_observation_retry_at = 0; start_network_observer(); }
    status = GetUnicastIpAddressTable(AF_UNSPEC, &table);
    if (status != NO_ERROR) {
        app_log("could not inspect network addresses; retrying (%lu)", status);
        network_path_available = 0;
        network_changed();
        network_observation_retry_at = monotonic_ms() + 5000;
        return;
    }
    for (i = 0; i < table->NumEntries; i++) {
        MIB_IF_ROW2 row;
        memset(&row, 0, sizeof row);
        row.InterfaceLuid = table->Table[i].InterfaceLuid;
        if ((table->Table[i].DadState == IpDadStatePreferred || table->Table[i].DadState == IpDadStateDeprecated) && GetIfEntry2(&row) == NO_ERROR &&
            row.OperStatus == IfOperStatusUp && row.Type != IF_TYPE_SOFTWARE_LOOPBACK) { available = 1; break; }
    }
    FreeMibTable(table);
    network_path_available = available;
    network_changed();
}
#else
static void start_network_observer(void) {}
static void stop_network_observer(void) {}
static void observe_network(void) {}
#endif

static void network_changed(void) {
    int i;
    cJSON *event = event_new("network");
    network_available = network_path_available && !network_suspended;
    network_recovery_at = network_available ? monotonic_ms() + 500 : 0;
    cJSON_AddBoolToObject(event, "available", network_available);
    emit(event);
    if (!running) return;
    for (i = 0; i < PJSUA_MAX_ACC; i++) {
        pjsua_acc_info info;
        if (!account_available(&accounts[i])) continue;
        /* Preserve permanent credential failures; PJSIP deliberately skips them.
         * A transient failure will be replaced by its fresh registration callback. */
        if (network_available && pjsua_acc_get_info(accounts[i].acc, &info) == PJ_SUCCESS && info.status >= 300)
            on_reg_state2(accounts[i].acc, NULL);
        else emit_registration(accounts[i].id, "registering", 0, "", 0);
    }
}

static void recover_network(void) {
    int i;
    pj_status_t status;
    pjsua_ip_change_param param;
    if (!running || !network_available || !network_recovery_at || monotonic_ms() < network_recovery_at) return;
    for (i = 0; i < PJSUA_MAX_ACC; i++) {
        if (accounts[i].used && accounts[i].withdrawal_retry_at) return;
    }
    network_recovery_at = 0;
    for (i = 0; i < PJSUA_MAX_ACC; i++) {
        if (account_available(&accounts[i]) && accounts[i].registration_deferred) {
            status = pjsua_acc_set_registration(accounts[i].acc, PJ_TRUE);
            if (status == PJ_SUCCESS) accounts[i].registration_deferred = 0;
            else {
                char message[256];
                emit_registration(accounts[i].id, "failed", 0, pj_message(status, message, sizeof message), 0);
            }
        }
    }
    pjsua_ip_change_param_default(&param);
    status = pjsua_handle_ip_change(&param);
    if (status != PJ_SUCCESS) {
        app_log("network recovery failed (%d)", status);
        for (i = 0; i < PJSUA_MAX_ACC; i++) {
            if (account_available(&accounts[i])) emit_registration(accounts[i].id, "failed", 0, "Network recovery failed", 0);
        }
    } else emit(event_new("networkRecovered"));
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
    else if (strcmp(method, "setMeetingAudio") == 0) request_meeting_audio(params, &reply);
    else if (strcmp(method, "setSuspended") == 0) {
        const cJSON *value = cJSON_GetObjectItemCaseSensitive(params, "suspended");
        if (!cJSON_IsBool(value)) fail(&reply, "setSuspended needs a boolean suspended value.");
        else {
            network_suspended = cJSON_IsTrue(value);
#ifdef _WIN32
            if (!network_suspended) { InterlockedExchange(&network_dirty, 1); observe_network(); }
#endif
            network_changed();
        }
    }
#ifdef SIPPER_TESTING
    else if (strcmp(method, "testNetworkChanged") == 0) {
        const cJSON *value = cJSON_GetObjectItemCaseSensitive(params, "available");
        if (!cJSON_IsBool(value)) fail(&reply, "testNetworkChanged needs a boolean available value.");
        else { network_path_available = cJSON_IsTrue(value); network_changed(); }
    }
#endif
    else if (strcmp(method, "reRegisterAll") == 0) {
        int i;
        for (i = 0; i < PJSUA_MAX_ACC; i++) {
            if (account_available(&accounts[i])) {
                if (network_available) pjsua_acc_set_registration(accounts[i].acc, PJ_TRUE);
                else emit_registration(accounts[i].id, "failed", 0, "No network connection", 0);
            }
        }
    }
    else if (!running && strcmp(method, "version") != 0 && strcmp(method, "shutdown") != 0 &&
             strcmp(method, "activeCalls") != 0 && strcmp(method, "audioDevices") != 0 &&
             strcmp(method, "codecs") != 0) fail(&reply, "The SIP engine is not running.");
    /* Every command that can resume/start phone media shares this ownership fence. */
    else if (meeting_audio_reference[0] && (strcmp(method, "makeCall") == 0 ||
             strcmp(method, "beginConference") == 0 ||
             (strcmp(method, "setHold") == 0 && !param_bool(params, "hold", 0)) ||
             (strcmp(method, "answer") == 0 && param_int(params, "code", 200) >= 200 && param_int(params, "code", 200) < 300)))
        fail(&reply, "Leave the meeting before starting or resuming phone audio.");
    else if (strcmp(method, "makeCall") == 0) request_make_call(params, &reply);
    else if (strcmp(method, "answer") == 0) request_answer(params, &reply);
    else if (strcmp(method, "setManagedCaller") == 0) request_managed_caller(params, &reply);
    else if (strcmp(method, "hangup") == 0) request_hangup(params, &reply);
    else if (strcmp(method, "hangupAll") == 0) pjsua_call_hangup_all();
    else if (strcmp(method, "setHold") == 0) request_set_hold(params, id_item, &reply);
    else if (strcmp(method, "setMuted") == 0) request_set_muted(params, &reply);
    else if (strcmp(method, "sendDtmf") == 0) request_send_dtmf(params, &reply);
    else if (strcmp(method, "beginConference") == 0) request_begin_conference(params, &reply);
    else if (strcmp(method, "splitConference") == 0) request_split_conference(params, &reply);
    else if (strcmp(method, "hangupConference") == 0) request_hangup_conference(params, &reply);
    else if (strcmp(method, "transfer") == 0) request_transfer(params, &reply);
    else if (strcmp(method, "attendedTransfer") == 0) request_attended_transfer(params, &reply);
    else if (strcmp(method, "activeCalls") == 0) request_active_calls(&reply);
#ifdef SIPPER_TESTING
    else if (strcmp(method, "testMedia") == 0) request_test_media(params, &reply);
    else if (strcmp(method, "testDigest") == 0) request_test_digest(params, &reply);
#endif
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

    if (cJSON_IsNumber(id_item) && !reply.deferred) {
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
    start_network_observer();

    while (!quit_requested) {
        line_node *node;
        int closed;
        int i;

        for (i = 0; i < PJSUA_MAX_CALLS; i++) {
            if (calls[i].hold_pending && calls[i].hold_reply_pending && monotonic_ms() >= calls[i].hold_deadline) {
                cJSON *response = cJSON_CreateObject();
                cJSON_AddNumberToObject(response, "id", calls[i].hold_request_id);
                cJSON_AddBoolToObject(response, "ok", 0);
                cJSON_AddStringToObject(response, "error", "The phone system did not confirm the hold change. Check the call and try again.");
                emit(response);
                /* A late response may still change media; keep admission fenced until it resolves. */
                calls[i].hold_reply_pending = 0;
            }
        }

        observe_network();
        finish_transfers();
        maintain_managed_accounts();
        recover_network();

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

    stop_network_observer();
    engine_stop();
    return 0;
}
