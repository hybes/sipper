#include "pjsua_shim.h"
#include <string.h>

const char *sipper_pjsip_version(void) {
    return pj_get_version();
}

int sipper_registration_is_busy(pj_status_t status) {
    return status == PJSIP_EBUSY || status == PJ_EBUSY;
}

void sipper_pj_strerror(pj_status_t status, char *buf, size_t size) {
    if (buf == NULL || size == 0) return;
    pj_str_t s = pj_strerror(status, buf, size);
    size_t len = (size_t)s.slen;
    if (len >= size) len = size - 1;
    buf[len] = '\0';
}

pj_status_t sipper_transport_state_status(const pjsip_transport_state_info *info) {
    return info ? info->status : PJ_SUCCESS;
}

int sipper_call_media_is_active(const pjsua_call_info *info) {
    if (!info) return 0;
    return info->media_status == PJSUA_CALL_MEDIA_ACTIVE ||
           info->media_status == PJSUA_CALL_MEDIA_REMOTE_HOLD;
}

int sipper_gateway_call_id(const pjsip_msg *message, char *output, size_t size) {
    if (!message || !output || size < 37 || message->type != PJSIP_REQUEST_MSG ||
        message->line.req.method.id != PJSIP_INVITE_METHOD) return 0;
    pj_str_t name = pj_str("X-Sipper-Call-ID");
    const pjsip_generic_string_hdr *found = NULL;
    for (const pjsip_hdr *header = message->hdr.next; header != &message->hdr; header = header->next) {
        if (pj_stricmp(&header->name, &name) != 0) continue;
        if (found) return 0;
        found = (const pjsip_generic_string_hdr *)header;
    }
    if (!found || found->hvalue.slen != 36 || !found->hvalue.ptr) return 0;
    for (size_t i = 0; i < 36; ++i) {
        char c = found->hvalue.ptr[i];
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (c != '-') return 0;
        } else if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'))) return 0;
    }
    memcpy(output, found->hvalue.ptr, 36); output[36] = '\0';
    return 1;
}
