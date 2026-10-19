# Configuration

boards is configured with environment variables only. The process validates them at start-up and exits with a
list of every problem (missing token, unknown driver, `SameSite=none` without https, …) instead of half-working.
`boards config` prints the same table.

Defaults are safe: authentication is on (`BOARDS_AUTH=token`) and refuses to start without `BOARDS_API_TOKENS`.
Turn it off explicitly with `BOARDS_AUTH=none` for a local instance.

<!-- options:start -->

### Server

| Variable | Default | Description |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port. |
| `BOARDS_HOST` | `0.0.0.0` | Interface to bind. |
| `BOARDS_PUBLIC_URL` | `http://localhost:$PORT` | Public origin of the service as users reach it (scheme + host, no path). Used in links, OIDC redirects, cookie security and the WebSocket origin check. |
| `BOARDS_METRICS_PORT` | `9090` | Port for Prometheus metrics (`/metrics`), kept off the public port. `0` disables. |
| `BOARDS_DISABLE_FEATURES` | — | Comma-separated editor features to switch off: `live` (WebSocket collaboration, falls back to polling), `studio` (stickies, palette, templates, slop check), `workboard` (checkpoints, timer, link cards), `snap`, `motion`. |
| `BOARDS_FLUSH_DELAY_MS` | `8000` | Quiet time after the last edit before a board is written to storage. |
| `BOARDS_FLUSH_MAX_MS` | `90000` | Upper bound on how long continuous editing may delay a write. |

### Storage

| Variable | Default | Description |
| --- | --- | --- |
| `BOARDS_STORAGE` | `s3 if BOARDS_S3_BUCKET is set, else fs` | Storage driver: `s3` (production) or `fs` (local folder). |
| `BOARDS_DATA_DIR` | `./data` | `fs` driver: folder for boards. |
| `BOARDS_S3_BUCKET` | — | `s3` driver: bucket name. |
| `BOARDS_S3_PREFIX` | — | Key prefix inside the bucket, e.g. `team-a/`. |
| `BOARDS_S3_ENDPOINT` | — | Endpoint for S3-compatible stores (MinIO, Ceph, R2, …). Empty for AWS. |
| `BOARDS_S3_REGION` | `$AWS_REGION or us-east-1` | Region. |
| `BOARDS_S3_FORCE_PATH_STYLE` | `false` | Use path-style URLs (`endpoint/bucket/key`); needed by MinIO and most self-hosted stores. |
| `BOARDS_S3_ACCESS_KEY_ID` | — | Static credentials. Leave empty to use the AWS default chain: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, web identity (EKS IRSA), ECS/EC2 roles, profiles. |
| `BOARDS_S3_SECRET_ACCESS_KEY` | — | Static credentials (see above). |
| `BOARDS_S3_CONDITIONAL_WRITES` | `auto` | `auto` probes whether the store honours `If-Match`/`If-None-Match` on PUT and falls back to compare-then-write; `on` forces conditional writes; `off` always compares first. |
| `BOARDS_S3_CREATE_BUCKET` | `false` | Create the bucket at start-up if it does not exist (handy for compose and tests). |
| `BOARDS_SNAPSHOTS` | `auto` | History: `bucket` (rely on bucket versioning), `objects` (immutable `snapshots/<ts>.excalidraw` objects + manifest), `auto` (bucket when versioning is enabled, else objects), `off`. |
| `BOARDS_SNAPSHOT_INTERVAL` | `600` | `objects` mode: minimum seconds between two snapshots of a board. |
| `BOARDS_SNAPSHOT_KEEP` | `500` | `objects` mode: snapshots kept per board; older ones are pruned. |

### Auth

| Variable | Default | Description |
| --- | --- | --- |
| `BOARDS_AUTH` | `token` | Who may sign in to the web UI: `token` (paste an API token once; a session cookie follows), `oidc` (any OpenID Connect provider), `proxy` (trust identity headers from a reverse proxy), `none` (everyone is a signed-in user — local use only). |
| `BOARDS_API_TOKENS` | — | Comma-separated bearer tokens for agents and integrations. Required in `token` mode. Works in every mode. |
| `BOARDS_SESSION_SECRET` | `random per process` | HMAC key for session cookies. Set it (32+ random bytes) so sessions survive restarts and replicas agree. |
| `BOARDS_SESSION_TTL` | `2592000` | Session lifetime in seconds (30 days). |
| `BOARDS_COOKIE_SECURE` | `auto` | `Secure` cookies: `auto` = when BOARDS_PUBLIC_URL is https. |
| `BOARDS_COOKIE_SAMESITE` | `lax` | `lax`, `strict` or `none`. Use `none` only when the editor is embedded cross-site (requires https). |
| `BOARDS_OIDC_ISSUER` | — | OIDC issuer URL (discovery at `<issuer>/.well-known/openid-configuration`). |
| `BOARDS_OIDC_CLIENT_ID` | — | OIDC client id. Redirect URI to register: `<BOARDS_PUBLIC_URL>/b/auth/callback`. |
| `BOARDS_OIDC_CLIENT_SECRET` | — | OIDC client secret (confidential client; PKCE is used as well). |
| `BOARDS_OIDC_SCOPES` | `openid email profile` | Requested scopes. |
| `BOARDS_OIDC_ALLOWED_DOMAINS` | — | Only allow these e-mail domains (comma-separated). Empty = anyone the provider authenticates. |
| `BOARDS_OIDC_GROUPS_CLAIM` | `groups` | Claim holding group membership. |
| `BOARDS_OIDC_ALLOWED_GROUPS` | — | Only allow members of these groups (comma-separated). Empty = no group check. |
| `BOARDS_PROXY_USER_HEADER` | `x-forwarded-user` | `proxy` mode: header with the user id. |
| `BOARDS_PROXY_EMAIL_HEADER` | `x-forwarded-email` | `proxy` mode: header with the e-mail. |
| `BOARDS_PROXY_NAME_HEADER` | `x-forwarded-preferred-username` | `proxy` mode: header with a display name. |
| `BOARDS_PROXY_TRUSTED` | `127.0.0.1/32,::1/128` | `proxy` mode: comma-separated IPs/CIDRs allowed to set identity headers (the proxy). Requests from elsewhere are anonymous. |
| `BOARDS_PROXY_SECRET` | — | `proxy` mode: optional shared secret the proxy must send in `x-boards-proxy-secret`. |
| `BOARDS_PROXY_LOGOUT_URL` | — | `proxy` mode: where "Sign out" goes (e.g. `/oauth2/sign_out`). |

### Integration

| Variable | Default | Description |
| --- | --- | --- |
| `BOARDS_FRAME_ANCESTORS` | `'self'` | CSP `frame-ancestors` for the editor: origins allowed to embed it in an iframe, e.g. `'self' https://workspace.example.com`. Read-only `?embed=1` views can be embedded anywhere. |
| `BOARDS_CORS_ORIGINS` | — | Origins allowed to call the JSON/text API from a browser (no cookies; bearer tokens or board keys only). |
| `BOARDS_HANDOFF_TTL` | `120` | Lifetime in seconds of hand-off links minted by `POST /b/api/handoff`. |
| `BOARDS_COMMENTS_WEBHOOK_URL` | — | POST comment events (`thread.created`, `thread.replied`, …) here. |
| `BOARDS_COMMENTS_WEBHOOK_SECRET` | — | Sent as `x-boards-webhook-secret` with every webhook call. |

<!-- options:end -->

## Recipes

**Local, no auth, files in a folder**

```sh
BOARDS_AUTH=none BOARDS_STORAGE=fs BOARDS_DATA_DIR=./data node bin/boards.mjs
```

**AWS S3 with IRSA (no static keys)**

```sh
BOARDS_PUBLIC_URL=https://boards.example.com
BOARDS_S3_BUCKET=acme-boards
BOARDS_S3_REGION=eu-central-1
# AWS_ROLE_ARN and AWS_WEB_IDENTITY_TOKEN_FILE are injected by EKS
BOARDS_AUTH=oidc BOARDS_OIDC_ISSUER=https://id.example.com BOARDS_OIDC_CLIENT_ID=boards BOARDS_OIDC_CLIENT_SECRET=…
BOARDS_API_TOKENS=… BOARDS_SESSION_SECRET=…
```

**S3-compatible store (MinIO, Ceph, R2, Selectel, Yandex, B2, Wasabi …)**

```sh
BOARDS_S3_ENDPOINT=https://s3.example.net
BOARDS_S3_BUCKET=boards
BOARDS_S3_REGION=us-east-1          # whatever the provider expects
BOARDS_S3_FORCE_PATH_STYLE=true     # most self-hosted stores
BOARDS_S3_ACCESS_KEY_ID=… BOARDS_S3_SECRET_ACCESS_KEY=…
```

**Behind oauth2-proxy / Pomerium / Authelia**

```sh
BOARDS_AUTH=proxy
BOARDS_PROXY_TRUSTED=10.0.0.0/8          # the proxy's addresses only
BOARDS_PROXY_EMAIL_HEADER=x-forwarded-email
BOARDS_PROXY_SECRET=…                    # optional, sent by the proxy as x-boards-proxy-secret
BOARDS_PROXY_LOGOUT_URL=/oauth2/sign_out
BOARDS_API_TOKENS=…                      # agents still use bearer tokens
```

Generate secrets with `openssl rand -hex 32`.

## Reverse proxies and TLS

boards serves everything under `/b` (plus `/healthz`, `/readyz` and a redirect from `/`), so it can share a host
with other apps. The live channel is a WebSocket on `/b/<slug>/live`: the proxy must pass `Upgrade` and allow idle
connections for at least 60 s (the server sends a heartbeat every 25 s). Terminate TLS at the proxy and set
`BOARDS_PUBLIC_URL` to the https origin — it drives cookie security, OIDC redirect URIs, links and the WebSocket
origin check. Prometheus metrics are on a separate port (`BOARDS_METRICS_PORT`, default 9090) that the public
proxy should not route.

## Security headers

The editor page sends a strict Content-Security-Policy (`default-src 'self'`, no inline scripts, `connect-src`
limited to the public origin's WebSocket, `frame-ancestors` from `BOARDS_FRAME_ANCESTORS`), `Referrer-Policy:
no-referrer` (board keys live in URLs), `X-Content-Type-Options: nosniff` and `X-Robots-Tag: noindex`. Preview SVGs
are served with a sandboxing CSP and rejected on upload if they contain scripts. HSTS belongs to your TLS proxy.
