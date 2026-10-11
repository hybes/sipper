# Sipper v1 handover

Scope frozen on 1 October 2026. This is the single checklist derived from the original request: standalone and managed apps on four platforms, plus the reseller/admin portal. It supersedes the expanding backlog in MANAGED-PLATFORM.md and IMPLEMENTATION-STATUS.md. “v1” is the scope name; the candidate still has app version 0.1.0 and build 1. It must not replace the existing public 0.1.0 release without a new release version/tag.

**Result:** local implementation work and the available candidate builds are complete; the table below records the outstanding release gates. Public activation remains gated by those prerequisites. This is not a claim of live payments, mobile push delivery, Windows execution, physical audio or production readiness. No new deployment, release upload, live payment, provider change or real PBX call was made.

## Completed checklist and verification

“Local pass” means the stated controlled tests/builds passed. “External gate” names what those checks cannot establish.

| ID | Original requirement | Current result and evidence |
| --- | --- | --- |
| V1-01 | Standalone SIP apps on macOS, Windows, iOS and Android; manual SIP setup without a Sipper login | Implemented. Current Mac/iOS/Android builds pass; Windows models and its native engine port are tested on Mac. Mac: 183 tests scheduled, 172 passed, 11 optional integration cases skipped. Shared Apple client: 42 passed. iOS: 19 selected storage/routing/recorded-CallKit/native-library cases passed on a disposable simulator. Android: 10 JVM and 34 managed-client instrumentation cases passed. Windows: 125 model cases passed; the latest real model/SIP-engine hold/return case passed separately. Native calling/gateway rehearsals and their limits are recorded in IMPLEMENTATION-STATUS.md. Windows build/execution and physical audio are external gates. |
| V1-02 | Managed mode in the same apps; own-email sign-in and protected, masked configuration | Implemented on all four clients: system-browser PKCE, enrolled-device/customer binding, secure storage, expiring configuration and applied-revision acknowledgement. Shared/client cases cover malformed, foreign, stale and late responses. Existing local portal harnesses cover the client/API paths; real Windows DPAPI/packaged callbacks, signed mobile sign-in and physical-device use remain acceptance gates. Upstream credentials stay server-side in gateway mode; direct mode delivers upstream credentials to the protected client store and cannot make them impossible to extract. |
| V1-03 | Personal and managed accounts coexist; suspension/disconnect/sign-out preserve personal accounts | Local pass. Client and portal cases cover explicit managed ownership, expiry/withdrawal, preservation of personal stores, exact-call identities and refusal to fall back to a personal account. Established calls retain controls during cooperative withdrawal; direct PBX credential revocation requires the PBX/provider. |
| V1-04 | Platform owner; resellers manage customers, groups, users, invitations, SIP assignments and suspension | Implemented. The current 154-case portal suite passes, including verified/MFA role checks, cross-tenant denials, last-owner protection, group/configuration revisions, invitations, assignments, seat races, suspension and device revocation. Owner access is deliberately granted to an already verified MFA account. No routine support view reveals secrets. |
| V1-05 | Self-service signup/verification/purchase; one named user across devices | Implemented and covered by local onboarding/billing/seat tests. Checkout return alone grants no capacity; signed webhooks/reconciliation are idempotent and seat allocation is transactional. One seat is per user within a billing workspace across its customers/devices. Stripe keys, actual recurring price IDs, commercial policies and a real purchase/renewal/refund acceptance remain activation gates. Email-worker/SMTP fixtures prove application behaviour and SMTP acceptance, not inbox delivery. |
| V1-06 | Managed mobile incoming calls with server/push infrastructure and native call controls | Implemented: Linux gateway/controller, device credentials, encrypted media, caller lookup/answer reservation, multi-device/cancel/renewal/recovery/drain handling, APNs PushKit/CallKit and FCM/Core-Telecom wake paths. Gateway tests pass 21 Node plus four Python cases; existing isolated Asterisk/native rehearsals are in the ledger. Real APNs/FCM delivery, locked/idle devices, two-way physical audio, Bluetooth, cellular interruption and network handover require provider credentials, signed builds and physical devices. Direct standalone mobile SIP has OS suspension limits and is not advertised as reliable background ringing. |
| V1-07 | Proper management tables, brand/layout, registrations, IPs, last login/request/seen and suspension | Implemented. Scoped telemetry projections distinguish desired/applied configuration, app/gateway registration, last-observed activity, DND and manual status. Database receipt time prevents application-clock skew hiding fresh reports. Portal cases and existing desktop/mobile rendered reviews cover tables, title-case badges, brand and responsive layout. Observations do not prove reachability; stale/absent data remain unknown. |
| V1-08 | Website, source/download links, support/privacy and separate unpacked extension | Current website passes nine route/security/proxy cases and deploy dry-run. Existing public download variables still target the older public Mac/Windows 0.1.0 releases; the portal origin is blank, so management is not activated publicly. Source/licence and extension packaging instructions are present. New candidate publication and domain/proxy/live checks are separate activation steps. The extension remains optional and can be installed unpacked. |
| V1-09 | Public files contain no credentials or real PBX/customer details; required notices/source accompany releases | Static source and candidate scans completed. Only synthetic test literals were found in the credential candidates; distributed app/IPA/APK/AAB entries showed no private-key/provider-token formats or private runtime account/signing files. Generated iOS DerivedData variants and local marketing authoring work are now ignored/excluded. Website screenshots were inspected: fictional Harbour Lane Studio, made-up contacts and sample numbers, no SIP/PBX/account secrets. Exact WebRTC 150.7871.02 third-party NOTICE was added to the Apple bundles alongside existing PJSIP/codec/SDK licences. The source candidate includes current sources, locks, patches and pinned PJSIP/Opus/OpenSSL source archives. This is a focused privacy/distribution review, not a comprehensive penetration test or legal certification. |
| V1-10 | Detailed environment examples and exact activation steps | Completed below, using the existing example files. Server private keys never belong in native app builds. Missing provider keys fail clearly; they do not create fake production entitlements. |

Existing SSO/SCIM, shared directories, presence, messaging, video and conference code are carried as extras with their existing limits. They add no new v1 gates. The unfinished Android background-video addition was removed; foreground meetings keep their explicit background-stop behaviour. Preserving/pausing video meetings across phone interruptions is outside this frozen checklist.

## Candidate packages

Files are in `dist/v1-candidate/`; `ARTIFACTS.json` records sizes, SHA-256 and distribution status. `HANDOVER.md` is a copy of this document alongside `VERIFICATION.json` and `SHA256SUMS.txt`. The source archive is a dirty-worktree snapshot, not a Git commit/tag; this final handover accompanies the archive separately. All 639 selected repository files match the archive byte for byte, with three pinned dependency-source archives added.

| Artifact | Status |
| --- | --- |
| `Sipper-v1-candidate-mac-arm64.dmg` | Developer ID signed; final notarisation accepted and staple validated. macOS 14+ Apple Silicon. Do not publish as the already-used v0.1.0 tag. |
| `Sipper-v1-candidate-mac-arm64.zip` and `macos/Sipper.app` | Same signed app candidate; app notarisation accepted. |
| `Sipper-v1-candidate-iOS-UNSIGNED.ipa` | Current arm64 iPhone/iPad Release compilation, iOS 16+. Unsigned, no valid provisioning profile: not installable/distributable. |
| `Sipper-v1-candidate-Android-UNSIGNED.apk` / `.aab` | Current Release outputs, API 26+, arm64/x86_64; 14 native libraries, 18 notice assets and 16 KiB checks. Unsigned: do not distribute. |
| `Sipper-v1-candidate-SOURCE.tar.gz` | Frozen application source, lockfiles, patches and dependency-source archives; local credentials/build state/drafts excluded. |
| Windows installer | No current installer is represented as built. This Mac has no Windows/MSYS2 host, Windows compiler or current PE engine binaries. The current source and existing Windows workflow/build recipe are ready for that external gate. |
| Portal/gateway/recovery containers | Existing Dockerfiles and Compose assets package the services. Local packaged admission, gateway and recovery rehearsal evidence is in the ledger; record immutable image digests for the actual deployment. The last locally verified portal image is `sipper-meeting-reliability:local`, digest `69e24e267ce62d3600581709a17d9b32c789dd0f0bffec6b8b3601f7552ddce5`. |

Current evidence logs are named `/private/tmp/sipper-v1-*`. The retained summary is `dist/v1-candidate/VERIFICATION.json`; raw local logs are not public release assets. Old `/private/tmp` logs and existing public release assets are historical evidence, not proof of this candidate.

Both Mac `spctl` assessments reported `accepted`, `Notarized Developer ID`, and `override=security disabled`. This confirms the assessment output, not behaviour with Gatekeeper enforcement enabled. No security setting was changed. First launch on a Mac with default security remains unverified; Apple notarisation and staple validation are independently confirmed.

## External prerequisites and known limits

1. **Server and commerce:** production host/region, verified-TLS PostgreSQL, HTTPS/DNS, independent auth/encryption/edge/gateway keys, SMTP sender/domain and inbox proof. Supply Stripe API/webhook keys and real monthly/annual recurring price IDs; approve currency, prices, refund/tax/trial/grace/retention policies. Complete one real paid onboarding and cancellation/renewal/recovery path before collecting public payments.
2. **Mobile push/signing:** APNs key ID/team/private `.p8`, VoIP topic/environment and an explicit iOS App ID/provisioning profile with Push Notifications; signed iOS build with push enabled. Supply one FCM service account server-side and four public Android client identifiers; use the exact release package/certificate. Supply Android upload/app-signing keystores and credentials. Debug/staging tokens must not enter production.
3. **Windows:** Windows 10 1903+/11 x64 build/test host with MSYS2, CNG/Schannel and DPAPI. Build the current PE engine and installer, run packaged OAuth/callback/storage/audio tests, then apply code signing if avoiding unsigned-install warnings is required. Mac execution of the engine port cannot prove these Windows APIs.
4. **Physical acceptance:** signed iPhone and Android phones with real test-provider extensions. Check locked/idle answer, caller hangup before/while answer, another-device answer, mute/hold/hangup, two-way audio, Bluetooth, cellular interruption and network changes. Check Mac microphone/speaker/recording and Windows hardware separately. Provider compatibility beyond the controlled profiles, NAT/public media and TLS/TURN network acceptance are not inferred from local fixtures.
5. **Distribution/licensing:** PJSIP is GPL-2.0-or-later with an alternative proprietary licence available; bundled third-party terms also apply. Source and notices are prepared, but store licensing/distribution review and store approval remain owner-controlled prerequisites, especially for iOS. Review the actual app/business/purchase links against current Apple/Google rules; no approval is implied. [PJSIP licensing](https://www.pjsip.org/licensing.htm), [Apple review guidelines](https://developer.apple.com/app-store/review/guidelines/).

## Environment examples

| File | Required values / use |
| --- | --- |
| `portal/.env.example` | `NODE_ENV=production`, public HTTPS `SIPPER_BASE_URL`, verified-TLS `DATABASE_URL`, independent `BETTER_AUTH_SECRET`, 32-byte AES `SIPPER_ENCRYPTION_KEYS` JSON and active key ID; SMTP fields/`MAIL_FROM`; Stripe API/webhook/price IDs; admin MFA stays true; edge and gateway keys; gateway TLS hostname/port; APNs and FCM settings. Config TTL and retention/grace values are explicit policy. Production test billing stays false. Keep old encryption key IDs while records/backups need them. |
| `infra/.env.example` | Private absolute portal environment path, immutable image tag/digest and loopback origin port. Optional Cloudflare tunnel token is a private file, not a command-line token. |
| `gateway/.env.example`, `gateway/controller.env.example` | Least-privilege gateway DB role, verified TLS/CA, separate ARI/AMI credentials, matching portal/gateway key, allowed upstream host list, durable controller state path, signalling/public-media/local-network values and RTP range. Use real private operator settings, never repo defaults. |
| `infra/gateway.env.example` | Matching immutable Asterisk/controller images, private env/TLS paths and intentionally selected network bindings/ports. |
| `infra/recovery/.env.example` | Verified-TLS PostgreSQL, private pgpass/CA, age recipients/identity paths and encrypted backup/restore paths. Preserve keys, backups and service fencing/reconciliation records. |
| `website/.env.example` and `website/wrangler.jsonc` | Public `PORTAL_ORIGIN`; same edge secret entered as a Worker secret. Update download URLs only to actually published, tested assets. No private secret in wrangler variables. |
| `ios/.env.example` | Public OAuth origin; push/signing build settings. `SIPPER_PUSH_ENABLED=YES` only with matching signed provisioning/aps-environment. Release topic `com.hybes.sipper.ios.voip`; development uses a separate staging topic/environment. No APNs/provider secret in the app. |
| `android/.env.example` | Four public Firebase client identifiers plus four private signing inputs kept outside source. Release package `com.hybes.sipper.android`; debug/staging is separate. No FCM service-account key in APK/AAB. |
| `windows/.env.example` | Development-only server/data isolation controls. Packaged production origin is fixed; no server private key or OAuth client secret in the installer. |

The examples are detailed references; native apps do not automatically load `.env` files. Compose uses raw env-file parsing: no surrounding shell quotes around JSON, no shell expansion, PEM on one line using supported literal `\n`. Keep populated operator files outside the checkout, mode 0600. Never put secrets in command arguments, logs, source archives, public vars or app builds.

## Exact activation order

1. **Set private production configuration and images.** Copy the examples outside the repo (for example `/etc/sipper/portal.env`, `/etc/sipper/asterisk.env`, `/etc/sipper/controller.env`, `/etc/sipper/deployment.env`). Generate independent secrets with `openssl rand -base64 48`; use `openssl rand -base64 32` for each AES key. Populate database/SMTP/billing/push/network values, retaining required old encryption keys. Build and record tested immutable image digests:

   ```sh
   SIPPER_RELEASE_ID='replace-with-new-version'
   docker build -t "sipper-platform:$SIPPER_RELEASE_ID" portal
   docker build -t "sipper-controller:$SIPPER_RELEASE_ID" gateway
   docker build -t "sipper-asterisk:$SIPPER_RELEASE_ID" gateway/asterisk
   docker build -t "sipper-recovery:$SIPPER_RELEASE_ID" infra/recovery
   ```

2. **Migrate and start the platform.** Take/verify an encrypted backup before upgrading an existing database. Initial deployment uses the same private interpolation file on every command:

   ```sh
   docker compose --env-file /etc/sipper/deployment.env -f infra/compose.app.yml config --quiet
   docker compose --env-file /etc/sipper/deployment.env -f infra/compose.app.yml run --rm migrate
   docker compose --env-file /etc/sipper/deployment.env -f infra/compose.app.yml up -d --no-build
   ```

   Start the gateway pair using the matching private `infra/gateway.env.example` values:

   ```sh
   docker compose --env-file /etc/sipper/gateway-deployment.env -f infra/compose.gateway.yml config --quiet
   docker compose --env-file /etc/sipper/gateway-deployment.env -f infra/compose.gateway.yml up -d --no-build
   ```

   Configure trusted HTTPS ingress and the public SIP TLS/media ports/CA before devices connect. Preserve ARI/AMI/DB isolation and controller fencing. Follow `infra/README.md` for actual backup/restore/reconciliation, gateway upgrades and health checks; do not print populated Compose output.

3. **Activate the site/owner/billing.** In `website/`, enter the matching edge key with `npx wrangler secret put SIPPER_EDGE_SHARED_SECRET`, set the protected HTTPS `PORTAL_ORIGIN`, then run `npm run check` and `npm run deploy` only when the new release is authorised. Verify HTTPS/domain/proxy/header and native callback routes. Sign up the owner's own email, verify it and enrol MFA; then use the existing owner-grant command in the private application environment:

   ```sh
   SIPPER_OWNER_EMAIL='replace-with-your-verified-email'
   docker compose --env-file /etc/sipper/deployment.env -f infra/compose.app.yml exec portal node --import tsx scripts/grant-owner.ts "$SIPPER_OWNER_EMAIL"
   ```

   Create recurring per-user Stripe prices and a webhook at `https://sipper.dev/api/webhooks/stripe` for subscription/invoice/checkout events consumed by the service. Put the endpoint signing secret and price IDs in the private portal environment and restart the deployed services. Keep test billing false. Verify one real purchase before inviting paying users.

4. **Build/sign clients and test native delivery.** On the Windows/MSYS2 host, follow the existing CI sequence from the repository root in PowerShell:

   ```powershell
   .\windows\scripts\build-pjsip.ps1
   .\windows\engine\build-windows.ps1 -Testing
   Set-Location windows
   npm ci --no-audit --no-fund
   node node_modules/electron/install.js
   npm test
   npm run test:engine
   .\engine\build-windows.ps1
   npm run dist
   $env:SIPPER_APP = (Resolve-Path 'dist\win-unpacked\Sipper.exe').Path
   npm run test:e2e
   ```

   Run the managed OAuth/callback/DPAPI and hardware acceptance on that host as well; automated packaged UI coverage is not proof of every managed workflow. On Android export all `SIPPER_ANDROID_SIGNING_*` values privately (and all four Firebase identifiers together), then run `./gradlew :app:assembleRelease :app:bundleRelease` in `android/`; verify its signing certificate, alignment and release package. For iOS use the exact App ID/team/profile in Xcode, enable push and matching aps-environment, archive Release and distribute through Organizer/App Store Connect only after physical acceptance and licensing review. Export/source obligations apply to every binary release. Mac packaging is signed/notarised here; use the root `make release TEAM=<team> NOTARY_PROFILE=<stored-profile>` for subsequent versioned releases.

5. **Run the purchaser-to-user acceptance, then publish.** Purchaser signs up/verifies/pays; creates customer/group/SIP configuration; assigns one seat and invites the named user. User verifies/signs in on each platform, enrols, applies settings, registers and makes/receives controlled calls. Confirm admin IP/login/request/revision projections, suspend/revoke and personal-account preservation. Perform the physical/push/network checks listed above and a backup/restore drill on the actual deployment. Only then upload the new versioned binary/source/checksum assets, update download variables and enable public sales for the supported scope. The Chrome extension is optional: load `extension/` unpacked; do not require it for the app.

No optional backlog or new requirement is created by this handover. After the final manifest/verification entries are recorded, this goal ends; external activation and acceptance remain explicitly owner-controlled.
