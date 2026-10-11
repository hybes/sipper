# Public website and private management origin

This configuration is implemented locally. No public management route, tunnel,
DNS record or provider account has been activated. Use a separate staging origin,
database and secrets before connecting production.

## Request routing

The existing website Worker forwards these paths to `PORTAL_ORIGIN`:

- `/portal` and `/portal/*`
- `/api` and `/api/*`, including authentication, native clients and webhooks
- `/_nuxt/*` and `/assets/sipper-icon.png`
- `/.well-known/openid-configuration` and `/.well-known/oauth-authorization-server`

Other paths retain the marketing site and release-download behaviour. The
canonical public address is HTTPS `sipper.dev`; management redirects use 308 to
preserve the request method. Native metadata is at the issuer's root, with the
authentication endpoints under `/api/auth`.

`PORTAL_ORIGIN` must be a separate HTTPS origin, without a path, user information,
query or fragment. It cannot be `sipper.dev` or `www.sipper.dev`. Its certificate
must be valid. The portal's `SIPPER_BASE_URL` remains the public HTTPS origin,
not this private upstream address. Missing origin settings return a generic 503
for management paths; upstream failures return a generic 502.

## Origin authentication and client addresses

Generate a separate random edge secret, for example with `openssl rand -base64 48`.
Store the same value as `SIPPER_EDGE_SHARED_SECRET` in the private portal
environment and the website Worker's secret store. Use Wrangler's interactive
`secret put SIPPER_EDGE_SHARED_SECRET` from `website/`; never put it in
`wrangler.jsonc`, a URL, a client bundle or a command argument. The value accepts
32–512 ASCII base64/base64url characters. It is independent of authentication,
encryption, gateway and tunnel credentials. Production refuses an absent key.

The Worker removes visitor-supplied forwarding/internal headers and inserts this
key and Cloudflare's observed client address. The origin compares the key in
constant time and rejects unauthenticated page, API and compiled-asset requests.
Only GET/HEAD `/api/health` is exempt, with its existing minimal health response.
Protect the origin network as well; the shared secret is an additional boundary.

Authentication sessions and managed-device activity use the same validated,
single client IP. Visitors cannot supply `X-Sipper-Verified-IP` themselves. The
address is what the management service observed, not the SIP contact or PBX's
observed address. Development without an edge key retains the socket/exact
trusted-hop model. `SIPPER_TRUSTED_PROXY_IPS` does not replace production edge
authentication. Verify the actual address through Cloudflare before relying on
production telemetry, especially if other Workers or IP-header transforms exist.

Native apps, Stripe webhooks and the gateway controller should use the configured
public HTTPS address, which passes through this Worker. They do not receive the
edge secret. A separate private gateway API ingress would need a trusted proxy
that injects the origin key; connecting the controller directly to the protected
container without that proxy will return 403. The gateway's own service key and
controller lease remain mandatory independently of the edge key.

The proxy preserves bodies, bearer tokens and separate response cookies. It does
not follow redirects, so application credentials cannot be forwarded to a redirect
destination. Internal-origin redirects are rewritten to the public origin;
native app callbacks and external payment redirects are returned to the client.
Requests and responses bypass cache. Keep any external cache rules from
overriding these policies. Do not enable request/header/body logging or
cloudflared debug logs: they can record session cookies and the edge secret.

Rotate the edge secret on both ends together; a mismatch deliberately refuses
requests. Use a maintenance window or a separately verified replacement stack.
The current implementation does not accept overlapping old/new keys.

## Optional Cloudflare Tunnel

`compose.tunnel.yml` adds a digest-pinned official cloudflared image. Before using
it, create a remotely managed tunnel with a dedicated HTTPS origin hostname and
an upstream service of `http://portal:3100` on the Compose network. The public
Worker must not route that origin hostname back to itself. A browser challenge
on the origin will block this proxy; service authentication through Cloudflare
Access is not implemented by these files.

Save the tunnel token in the absolute `SIPPER_TUNNEL_TOKEN_FILE` from
[`infra/.env.example`](.env.example), outside the checkout. On the deployment host,
make it readable only by UID/GID `65532:65532`, mode 0400. The container mounts it
read-only and reads it using `--token-file`; it is not a command-line token or
container environment value. Host/Docker administrators can still access it.

After the operator has configured the origin, secrets and private environment:

```sh
docker compose --env-file /etc/sipper/deployment.env -f infra/compose.app.yml -f infra/compose.tunnel.yml config --quiet
docker compose --env-file /etc/sipper/deployment.env -f infra/compose.app.yml -f infra/compose.tunnel.yml up -d --no-build
```

The tunnel publishes no ports. Its readiness probe uses a loopback metrics
listener and establishes only tunnel connectivity, not application/provider
readiness. The portal listener remains host-loopback-only. An ordinary trusted
HTTPS reverse proxy can be used instead, provided it retains the origin key and
verified-address headers and provides equivalent network protection.

## Browser policy

The portal supplies its own production Content Security Policy, separate from
the marketing site's `form-action 'none'`. Scripts are restricted to the same
origin and SHA-256 hashes of framework-generated inline head/payload scripts.
Arbitrary page content is not hashed. Inline handlers, evaluation, framing,
objects and external base URLs are blocked. Forms and API connections use the
same origin; images also allow local data/blob URLs for QR codes. Inline styles
remain allowed for the component library's positioned controls.

Responses also restrict referrers, MIME sniffing and browser permissions, and
mark management pages noindex. HSTS is set on production HTTPS responses. The
hash hook targets the current non-streamed portal rendering; changes to SSR,
streaming or third-party scripts require a fresh built-browser check.
Unhandled production failures return a small, sanitised JSON response with the
correct status. They do not invoke a second unauthenticated HTML error request or
expose framework exception details. Application APIs retain their existing
actionable error messages.

## Verification and remaining deployment checks

Run the website tests and Worker dry-run, then the disposable recovery rehearsal
described in [`README.md`](README.md). It exercises the real proxy logic with
loopback HTTP substituted only for upstream HTTPS, production portal settings,
origin rejection including assets, CSP hashes, cookie sign-in/session, forged IP
headers, root discovery and PKCE authorisation/consent/token exchange. It checks
the issued token with the authentication library against the proxy's JWKS.

The `.invalid` issuer cannot resolve from the container. Consequently this
rehearsal does not prove the native API's production issuer/JWKS lookup. Existing
native HTTP tests cover that API locally. `--preview` leaves the isolated page
open for browser checks until Enter is pressed; full browser sign-in also needs
the configured HTTPS origin rather than this temporary loopback address.

Before public activation, verify actual HTTPS, Cloudflare-observed IPs, cache
bypass, origin denial, tunnel recovery, browser sign-in/MFA, discovery, native
sign-in and refresh, gateway admission and webhook delivery. Keep public
purchase links disabled until billing/provider verification and the wider launch
requirements are met. None of those live checks are implied by the local rehearsal.

References: [Cloudflare request forwarding and cache controls](https://developers.cloudflare.com/workers/runtime-apis/request/),
[Cloudflare client IP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/),
[cloudflared 2026.9.1](https://github.com/cloudflare/cloudflared/releases/tag/2026.9.1).
