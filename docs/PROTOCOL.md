# Sipper hand-off protocol

This is the contract between the Sipper apps (Mac and Windows) and anything that
wants to add SIP accounts to them (the Chrome extension today, other tools later).
Both sides implement exactly this document.

## Transport

### 1. URL scheme (always available)

The app registers the `sipper` URL scheme. Opening the URL below launches Sipper
(or brings it forward) and shows the import sheet.

```
sipper://add-accounts?payload=<base64url(JSON)>
```

* `payload` is the UTF-8 JSON document described below, base64url encoded
  (RFC 4648 §5: `+`→`-`, `/`→`_`, padding `=` removed or kept, both accepted).
* Nothing else in the URL is significant. Unknown query parameters are ignored.
* Payloads larger than 512 KiB are rejected.

### 2. Chrome native messaging (optional, installed from Settings → Browser extension)

Host name: `com.hybes.sipper`. On a Mac the host executable is the Sipper app
binary; on Windows it is `sipper-browser-host.exe` in Sipper's `resources\engine`
folder. Chrome starts it with the extension origin as its first argument.
Messages are the same JSON document (no base64), framed with a 4-byte
native-endian length prefix as Chrome specifies.

Requests:

```json
{ "type": "ping" }
{ "type": "add-accounts", "payload": { ...document below... } }
```

Responses:

```json
{ "ok": true, "type": "pong", "version": "0.1.0" }
{ "ok": true, "type": "queued", "count": 2 }
{ "ok": false, "error": "human readable message" }
```

On `add-accounts` the host forwards the document to the running app through the
URL scheme (so the app behaves identically for both transports) and replies
`queued` once the app has been asked to open it. Windows passes the link on a
command line, so the Windows host refuses links longer than 32,000 characters
(roughly 70 typical accounts) with an error asking for a smaller selection.

## Document

```json
{
  "version": 1,
  "source": {
    "provider": "fusionpbx",
    "url": "https://pbx.example.com/app/extensions/extension_edit.php?id=…",
    "title": "Extension 1001"
  },
  "profile": {
    "name": "pbx.example.com"
  },
  "accounts": [
    {
      "label": "1001 · Alex",
      "displayName": "Alex Morgan",
      "username": "1001",
      "authUsername": "1001",
      "password": "s3cret",
      "domain": "tenant.pbx.example.com",
      "server": "pbx.example.com",
      "port": 5060,
      "transport": "udp",
      "callerIdName": "Alex Morgan",
      "callerIdNumber": "01onward",
      "voicemailNumber": "*97",
      "notes": "Desk phone"
    }
  ]
}
```

Field rules:

| Field | Required | Meaning |
|---|---|---|
| `version` | yes | Always `1`. The app rejects other versions. |
| `source.provider` | no | Free-form identifier of the scraper (`fusionpbx`, `manual`, …). |
| `source.url` | no | Page the data came from. Shown in the import sheet only. |
| `profile.name` | no | Suggested profile (account group). The app offers to reuse an existing profile with the same name or create it. |
| `accounts[]` | yes, ≥ 1 | Accounts to add. |
| `username` | yes | SIP user part (the extension number). |
| `domain` | yes | SIP domain / realm used in the AoR (`sip:username@domain`) and REGISTER. |
| `password` | yes | SIP auth password. Stored in the macOS Keychain, or on Windows encrypted with the Data Protection API; never on disk in clear. |
| `authUsername` | no | Auth user if different from `username`. |
| `server` | no | Registrar / outbound proxy host. Defaults to `domain`. When present the app registers to `domain` but sends traffic to `server`. |
| `port` | no | Port on `server`. Default `5060`, or `5061` when `transport` is `tls`. |
| `transport` | no | `udp` (default), `tcp`, or `tls`. |
| `label` | no | Sidebar name. Default `username @ domain`. |
| `displayName` | no | From display name for outgoing calls. |
| `callerIdName`, `callerIdNumber` | no | Informational, shown in the account detail. |
| `voicemailNumber` | no | Number dialled by the voicemail button. Default `*97` (FusionPBX default). |
| `notes` | no | Free text. |

Strings are trimmed, except `password`, which is kept exactly as sent. Accounts
whose `username` or `domain` are empty after trimming, or whose `password` is
empty or whitespace only, are shown as invalid in the import sheet and cannot be
imported.

## Duplicate handling

An account is a duplicate when an existing account has the same `username` and
`domain` (case-insensitive domain). The import sheet shows these as "update"
rows: importing them replaces the password and connection fields but keeps the
existing account id, profile, history and label unless the label was the
default.

## Example URL

```
sipper://add-accounts?payload=eyJ2ZXJzaW9uIjoxLCJhY2NvdW50cyI6W3sidXNlcm5hbWUiOiIxMDAxIiwiZG9tYWluIjoicGJ4LmV4YW1wbGUuY29tIiwicGFzc3dvcmQiOiJzM2NyZXQifV19
```

which decodes to

```json
{"version":1,"accounts":[{"username":"1001","domain":"pbx.example.com","password":"s3cret"}]}
```
