/*
 * sipper-browser-host: the Chrome native messaging host of Sipper for Windows (docs/PROTOCOL.md).
 *
 * Chrome starts it with the extension origin as the first argument and exchanges JSON messages
 * framed by a 4-byte native-endian length on stdin and stdout. Accounts reach Sipper through a
 * sipper://add-accounts link, the same route the Mac app's helper and the plain link take, so
 * Sipper shows the same import dialog whichever way they arrive.
 *
 * SIPPER_HOST_DRY_RUN=1 writes the link to stderr instead of opening it (for tests).
 */

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "sipper_version.h"

#ifdef _WIN32
#  include <windows.h>
#  include <fcntl.h>
#  include <io.h>
#  include <shellapi.h>
#else
#  include <spawn.h>
#  include <sys/wait.h>
extern char **environ;
#endif

#ifndef SIPPER_VERSION
#  define SIPPER_VERSION "dev"
#endif

#define MAX_MESSAGE_BYTES (64 * 1024 * 1024)
#define MAX_PAYLOAD_BYTES (512 * 1024)
/* Windows passes the link to Sipper on a command line, which is limited to 32,767 characters. */
#define MAX_LINK_CHARS 32000

static int read_exact(unsigned char *buffer, size_t length) {
    size_t done = 0;
    while (done < length) {
        size_t got = fread(buffer + done, 1, length - done, stdin);
        if (got == 0) return 0;
        done += got;
    }
    return 1;
}

/* Returns the parsed message, a JSON null for text that is not JSON, or NULL at end of input. */
static cJSON *read_message(void) {
    unsigned char header[4];
    uint32_t length;
    char *body;
    cJSON *message;

    if (!read_exact(header, sizeof header)) return NULL;
    memcpy(&length, header, sizeof length);
    if (length == 0 || length > MAX_MESSAGE_BYTES) return NULL;
    body = (char *)malloc((size_t)length + 1);
    if (!body) return NULL;
    if (!read_exact((unsigned char *)body, length)) {
        free(body);
        return NULL;
    }
    body[length] = '\0';
    message = cJSON_Parse(body);
    free(body);
    return message ? message : cJSON_CreateNull();
}

static void write_message(cJSON *message) {
    char *text = cJSON_PrintUnformatted(message);
    uint32_t length;
    cJSON_Delete(message);
    if (!text) return;
    length = (uint32_t)strlen(text);
    fwrite(&length, sizeof length, 1, stdout);
    fwrite(text, 1, length, stdout);
    fflush(stdout);
    cJSON_free(text);
}

static cJSON *failure(const char *text) {
    cJSON *reply = cJSON_CreateObject();
    cJSON_AddBoolToObject(reply, "ok", 0);
    cJSON_AddStringToObject(reply, "error", text);
    return reply;
}

static char *base64url(const unsigned char *data, size_t length) {
    static const char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    char *out = (char *)malloc((length + 2) / 3 * 4 + 1);
    size_t i = 0, o = 0;
    if (!out) return NULL;
    while (i + 2 < length) {
        uint32_t n = ((uint32_t)data[i] << 16) | ((uint32_t)data[i + 1] << 8) | data[i + 2];
        out[o++] = alphabet[(n >> 18) & 63];
        out[o++] = alphabet[(n >> 12) & 63];
        out[o++] = alphabet[(n >> 6) & 63];
        out[o++] = alphabet[n & 63];
        i += 3;
    }
    if (length - i == 1) {
        uint32_t n = (uint32_t)data[i] << 16;
        out[o++] = alphabet[(n >> 18) & 63];
        out[o++] = alphabet[(n >> 12) & 63];
    } else if (length - i == 2) {
        uint32_t n = ((uint32_t)data[i] << 16) | ((uint32_t)data[i + 1] << 8);
        out[o++] = alphabet[(n >> 18) & 63];
        out[o++] = alphabet[(n >> 12) & 63];
        out[o++] = alphabet[(n >> 6) & 63];
    }
    out[o] = '\0';
    return out;
}

/* Opens the link with its registered handler. Returns NULL on success or a message. */
static const char *open_link(const char *link) {
    const char *dry_run = getenv("SIPPER_HOST_DRY_RUN");
    if (dry_run && strcmp(dry_run, "1") == 0) {
        fprintf(stderr, "%s\n", link);
        fflush(stderr);
        return NULL;
    }
#ifdef _WIN32
    {
        int wide_length = MultiByteToWideChar(CP_UTF8, 0, link, -1, NULL, 0);
        wchar_t *wide = (wchar_t *)malloc(sizeof(wchar_t) * (size_t)wide_length);
        INT_PTR result;
        if (!wide) return "Out of memory.";
        MultiByteToWideChar(CP_UTF8, 0, link, -1, wide, wide_length);
        result = (INT_PTR)ShellExecuteW(NULL, L"open", wide, NULL, NULL, SW_SHOWNORMAL);
        free(wide);
        if (result == SE_ERR_NOASSOC || result == ERROR_FILE_NOT_FOUND) {
            return "Sipper is not installed, or its sipper: links are not registered. Reinstall Sipper.";
        }
        if (result <= 32) return "Could not open Sipper.";
        return NULL;
    }
#else
    {
        pid_t pid;
        int status = 0;
        char *argv[] = { "open", (char *)link, NULL };
        if (posix_spawnp(&pid, "open", NULL, NULL, argv, environ) != 0) return "Could not open Sipper.";
        if (waitpid(pid, &status, 0) < 0 || !WIFEXITED(status) || WEXITSTATUS(status) != 0) return "Could not open Sipper.";
        return NULL;
    }
#endif
}

/* The same checks and messages as the app's import parser for the parts the host can see. */
static cJSON *add_accounts(const cJSON *payload) {
    const cJSON *version, *accounts;
    char message[256];
    char *json, *encoded, *link;
    const char *problem;
    size_t length;
    int count;
    cJSON *reply;

    if (!cJSON_IsObject(payload)) return failure("Payload is not valid JSON.");
    version = cJSON_GetObjectItemCaseSensitive(payload, "version");
    accounts = cJSON_GetObjectItemCaseSensitive(payload, "accounts");
    if (!version) return failure("The import payload is not valid JSON (missing key \xE2\x80\x9Cversion\xE2\x80\x9D).");
    if (!cJSON_IsNumber(version) || version->valuedouble != (double)version->valueint) {
        return failure("The import payload is not valid JSON (\xE2\x80\x9Cversion\xE2\x80\x9D must be a whole number).");
    }
    if (!accounts) return failure("The import payload is not valid JSON (missing key \xE2\x80\x9C" "accounts\xE2\x80\x9D).");
    if (!cJSON_IsArray(accounts)) return failure("The import payload is not valid JSON (\xE2\x80\x9C" "accounts\xE2\x80\x9D must be an array).");
    if (version->valueint != 1) {
        snprintf(message, sizeof message, "Import format version %d is not supported by this version of Sipper.", version->valueint);
        return failure(message);
    }
    count = cJSON_GetArraySize(accounts);
    if (count == 0) return failure("The import contains no accounts.");

    json = cJSON_PrintUnformatted(payload);
    if (!json) return failure("Could not build the import link.");
    length = strlen(json);
    if (length > MAX_PAYLOAD_BYTES) {
        cJSON_free(json);
        return failure("The import payload is too large.");
    }
    encoded = base64url((const unsigned char *)json, length);
    cJSON_free(json);
    if (!encoded) return failure("Could not build the import link.");
    link = (char *)malloc(strlen(encoded) + 64);
    if (!link) {
        free(encoded);
        return failure("Could not build the import link.");
    }
    sprintf(link, "sipper://add-accounts?payload=%s", encoded);
    free(encoded);
    if (strlen(link) > MAX_LINK_CHARS) {
        free(link);
        return failure("Too many accounts for one hand-over. Select fewer and add them in two goes.");
    }
    problem = open_link(link);
    free(link);
    if (problem) return failure(problem);

    reply = cJSON_CreateObject();
    cJSON_AddBoolToObject(reply, "ok", 1);
    cJSON_AddStringToObject(reply, "type", "queued");
    cJSON_AddNumberToObject(reply, "count", count);
    return reply;
}

static cJSON *handle(const cJSON *message) {
    const cJSON *type = cJSON_GetObjectItemCaseSensitive(message, "type");
    if (cJSON_IsNull(message)) return failure("Message was not valid JSON.");
    if (cJSON_IsString(type) && strcmp(type->valuestring, "ping") == 0) {
        cJSON *reply = cJSON_CreateObject();
        cJSON_AddBoolToObject(reply, "ok", 1);
        cJSON_AddStringToObject(reply, "type", "pong");
        cJSON_AddStringToObject(reply, "version", SIPPER_VERSION);
        return reply;
    }
    if (cJSON_IsString(type) && strcmp(type->valuestring, "add-accounts") == 0) {
        const cJSON *payload = cJSON_GetObjectItemCaseSensitive(message, "payload");
        if (!payload) return failure("Missing payload.");
        return add_accounts(payload);
    }
    return failure("Unknown message type.");
}

int main(void) {
    cJSON *message;
#ifdef _WIN32
    _setmode(_fileno(stdin), _O_BINARY);
    _setmode(_fileno(stdout), _O_BINARY);
#endif
    while ((message = read_message()) != NULL) {
        write_message(handle(message));
        cJSON_Delete(message);
    }
    return 0;
}
