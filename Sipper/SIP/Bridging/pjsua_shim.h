// Small C helpers for things that are awkward to express in Swift.
#ifndef PJSUA_SHIM_H
#define PJSUA_SHIM_H

#ifndef PJ_AUTOCONF
#define PJ_AUTOCONF 1
#endif

#include <pjsua-lib/pjsua.h>

#ifdef __cplusplus
extern "C" {
#endif

/// PJSIP version string (e.g. "2.15.1").
const char *sipper_pjsip_version(void);

/// Fills `buf` with a human readable description of a pj_status_t.
void sipper_pj_strerror(pj_status_t status, char *buf, size_t size);

/// Returns the error status stored in a transport state info, or PJ_SUCCESS.
pj_status_t sipper_transport_state_status(const pjsip_transport_state_info *info);

/// Whether the given pjsua_call_info describes a call whose audio is active
/// (PJSUA_CALL_MEDIA_ACTIVE or PJSUA_CALL_MEDIA_REMOTE_HOLD).
int sipper_call_media_is_active(const pjsua_call_info *info);

#ifdef __cplusplus
}
#endif

#endif
