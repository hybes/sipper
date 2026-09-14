#include "pjsua_shim.h"
#include <string.h>

const char *sipper_pjsip_version(void) {
    return pj_get_version();
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
