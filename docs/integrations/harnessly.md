# Integrating boards with harnessly

[harnessly](https://github.com/ly-solutions/harnessly) is a workspace where people and coding agents work side by
side: terminals, conversations, documents and boards in one place. boards is the "boards" part. It stays a
separate service with its own storage and release cycle; harnessly talks to it over HTTP and embeds its editor.

This document is the contract between the two. Everything below exists in boards today; the last section lists what
harnessly has to add on its side.

```
┌──────────── harnessly web UI (https://work.example.com) ────────────┐
│  conversation / document          right pane                        │
│  "see https://boards…/b/x?k=…"   ┌───────────────────────────────┐  │
│        │ unfurl (oEmbed)         │ <iframe src=…/b/x?k=…>        │  │
│        ▼                         │  boards editor (live)         │  │
└────────┼─────────────────────────┴───────────────┬───────────────┘  │
         │ server-to-server, Bearer token          │ browser → boards (same site), session cookie
         ▼                                         ▼
   harnessly runtime ── /b/api/boards, /b/<slug>.md, /b/api/handoff ──▶ boards ──▶ S3
   coding agents     ── skills/boards (BOARDS_URL, BOARDS_TOKEN)   ──▶
```

## 1. Configuration on the boards side

```sh
BOARDS_PUBLIC_URL=https://boards.example.com
BOARDS_AUTH=oidc                                  # or proxy — the same identity provider harnessly uses
BOARDS_OIDC_ISSUER=https://id.example.com/realms/work
BOARDS_OIDC_CLIENT_ID=boards
BOARDS_OIDC_CLIENT_SECRET=…
BOARDS_API_TOKENS=<token for the harnessly runtime>,<token for agents>
BOARDS_SESSION_SECRET=<32+ random bytes>

# Let the harnessly UI embed the full editor and call the JSON API from the browser:
BOARDS_FRAME_ANCESTORS="'self' https://work.example.com"
BOARDS_CORS_ORIGINS=https://work.example.com

# Only if boards and harnessly are on different sites (different registrable domains):
# BOARDS_COOKIE_SAMESITE=none                     # requires https; see "Cookies" below

# Optional: push comment events to harnessly so agents can answer threads
BOARDS_COMMENTS_WEBHOOK_URL=https://work.example.com/api/integrations/boards/comments
BOARDS_COMMENTS_WEBHOOK_SECRET=<shared secret>
```

Helm (`deploy/helm/boards`) equivalents: `integration.frameAncestors`, `integration.corsOrigins`,
`auth.cookieSameSite`, `webhook.url`, `webhook.secret`.

## 2. Board links and mentions

A board is identified by its link — `https://boards.example.com/b/<slug>?k=<key>`. The slug is unguessable
(readable prefix + 12 random characters) and the key (22 characters) is a bearer secret: whoever has the link can
read the board. Treat links like document share links.

- **Recognise** a board link with `^https://boards\.example\.com/b/([a-z0-9][a-z0-9-]{2,63})(\?.*)?$` and read `k`
  from the query string.
- **Mention format** in harnessly text: just the link. Optionally render it as a chip using oEmbed (below).
- Inside boards, a link to another board pasted on a canvas becomes a *board card* that shows the target's title —
  the same link works in both directions.

### Unfurl (oEmbed)

```
GET /b/api/oembed?url=<board link>[&maxwidth=800&maxheight=500]
→ 200 { "version": "1.0", "type": "rich", "provider_name": "boards", "title": "Checkout architecture",
        "author_name": "Ada Lovelace", "width": 800, "height": 500,
        "html": "<iframe src=\"…/b/<slug>?k=…&amp;embed=1\" …></iframe>",
        "thumbnail_url": "…/b/<slug>/preview.svg?k=…" }
→ 404 not a board on this server / wrong key
```

No token needed (the key is in the URL). Every board page also advertises it with
`<link rel="alternate" type="application/json+oembed">`.

## 3. Embedding the board view

| URL | What it is | Who may frame it |
| --- | --- | --- |
| `/b/<slug>?k=<key>&embed=1` | read-only view, scene fitted into the frame, "Fullscreen" and "Open board" buttons; works without cookies (the scene is inlined into the page) | anyone (no `frame-ancestors`, so even sandboxed/opaque-origin documents can embed it) |
| `/b/<slug>?k=<key>` | the full editor: live collaboration, cursors, comments | origins in `BOARDS_FRAME_ANCESTORS` |
| `/b/<slug>?k=<key>&at=<checkpoint>` | the board as it was at a checkpoint, read-only | as above |

Recommended iframe attributes for the editor:

```html
<iframe src="https://boards.example.com/b/<slug>?k=<key>"
        allow="clipboard-read; clipboard-write; fullscreen"
        referrerpolicy="no-referrer"
        style="border:0;width:100%;height:100%"></iframe>
```

Do not add `sandbox` to the editor iframe (it needs same-origin storage and its own cookies); the read-only embed
tolerates `sandbox="allow-scripts allow-popups"`.

### Auth hand-off (who is drawing)

Inside the iframe the editor uses boards' own session cookie. If the user is already signed in to boards (same OIDC
provider, or the same reverse proxy), nothing else is needed. To skip the extra sign-in, harnessly's backend can
vouch for the user it has already authenticated:

```
POST /b/api/handoff
Authorization: Bearer <BOARDS_API_TOKEN of the harnessly runtime>
Content-Type: application/json

{ "user": { "id": "u-123", "name": "Ada Lovelace", "email": "ada@example.com" },
  "next": "/b/<slug>?k=<key>",
  "ttl": 60 }

→ 201 { "url": "https://boards.example.com/b/auth/handoff?t=<signed token>" }
```

Load that `url` in the iframe (or a popup). boards verifies the signature, refuses a second use of the same token,
sets its session cookie for `/b` and redirects to `next` (only `/b/…` paths are accepted). The token lives `ttl`
seconds (10–3600, default `BOARDS_HANDOFF_TTL` = 120). Mint it per page view; never put it in a shareable place.

#### Cookies

Browsers send the session cookie inside an iframe only when the framing page and boards are the **same site**
(e.g. `work.example.com` and `boards.example.com`) with the default `SameSite=Lax`. If they are different sites, set
`BOARDS_COOKIE_SAMESITE=none` (https only) and expect browsers that block third-party cookies to fall back to the
read-only experience — host both under one registrable domain when you can. Cookie-authenticated requests that
carry a foreign `Origin` are refused (CSRF guard), so the editor only works with its own origin inside the frame,
which is what an iframe gives it.

## 4. JSON and text API (server-to-server, agents, harnessly UI)

All responses are JSON unless stated; errors are `{ "error": "<reason>" }` with a 4xx/5xx status.
Authentication: `Authorization: Bearer <token>` (any of `BOARDS_API_TOKENS`), or the board key for per-board
routes (`?k=<key>` or header `X-Board-Key: <key>`). From a browser on an origin listed in `BOARDS_CORS_ORIGINS`,
bearer tokens and board keys work; cookies are ignored.

| Method & path | Auth | Purpose |
| --- | --- | --- |
| `GET /b/api/boards?q=&tag=` | token / signed-in | list boards: `{ boards: [{ slug, title, description, tags, task, author, access, createdAt, updatedAt, stats, url, markdown, json, embed, scene, live, preview, key }] }`, newest first |
| `POST /b/api/boards` | token / signed-in | create: `{ title, description?, tags?, task?, access?: "team"\|"link", author?, template?, graph?, add? }` → `201 { slug, title, key, url, markdown, json, embed, scene, live, summary }` |
| `GET /b/api/boards/<slug>` | token / signed-in | one board as JSON (no key needed): metadata, links, `rev`, `stats`, `preview`, `text` |
| `GET /b/<slug>.json?k=` | key | the same JSON with only the board key |
| `GET /b/<slug>.md?k=` | key | the board as markdown — what agents read |
| `GET /b/<slug>/scene.excalidraw?k=` | key | the full scene (Excalidraw JSON; headers `X-Board-Rev`, `X-Board-Epoch`) |
| `GET /b/<slug>/preview.svg?k=` | key | thumbnail (sandboxed SVG) |
| `POST /b/<slug>/edit?k=` | token / signed-in / guest on link boards | `{ graph?, add?, update?, delete?, author?, note? }` → new `summary`, `rev`, `created` ids |
| `POST /b/<slug>/meta?k=` | token / signed-in | title, description, tags, task, access |
| `POST /b/<slug>/comments?k=` · `POST /b/<slug>/comments/<id>?k=` | editors | new thread · reply / resolve / move / delete |
| `GET /b/<slug>/history?k=` · `GET …/history/<id>` · `POST …/history/<id>/restore` | key · key · token / signed-in | snapshots, a past scene, restore |
| `GET /b/<slug>/checkpoints?k=` (+ `/diff`, `/scene`, `/copy`) | key / editors | named checkpoints |
| `GET /b/<slug>/live?k=` (WebSocket) | key (+ session to edit) | live channel; `Origin` must be `BOARDS_PUBLIC_URL` |
| `GET /b/api` | none | text cheat sheet for agents |
| `GET /b/api/oembed?url=` | key in url | oEmbed |
| `POST /b/api/handoff` | token | one-time sign-in link |

Example — list and read as text:

```sh
curl -s https://boards.example.com/b/api/boards?q=checkout -H "Authorization: Bearer $BOARDS_TOKEN"
curl -s "https://boards.example.com/b/checkout-architecture-k3j2h1g0f9e8.md?k=$KEY"
```

### Comment webhook

With `BOARDS_COMMENTS_WEBHOOK_URL` set, boards POSTs (fire-and-forget, 5 s timeout) with header
`X-Boards-Webhook-Secret`:

```json
{ "event": "thread.created" | "thread.replied" | "thread.resolved" | "thread.reopened" | "thread.removed",
  "slug": "…", "key": "…", "title": "…", "url": "https://boards.example.com/b/…?k=…",
  "thread": { "id": "a1b2c3d4e5", "resolved": false, "anchor": { "elementId": "api", "label": "API gateway", "x": 120, "y": 40 } },
  "message": { "id": "…", "text": "…", "author": "Ada Lovelace", "authorEmail": "ada@example.com", "authorKind": "person" | "agent", "at": "2026-10-19T12:00:00.000Z" } }
```

An agent answers with `POST /b/<slug>/comments/<thread id>?k=<key>` `{ "reply": "…" }` using its token.

## 5. Agents

Coding agents use the skill in [`skills/boards`](../../skills/boards/SKILL.md) (also published in the Ly Solutions
skills collection). It needs `BOARDS_URL` and `BOARDS_TOKEN` in the agent's environment — harnessly should inject
both into the sessions it starts, with a token dedicated to agents (edits are signed with the `author` the agent
sends, defaulting to "agent").

## 6. What harnessly must add

1. **Settings**: `BOARDS_URL` (origin) and a `BOARDS_TOKEN` secret for the runtime; pass both to agent sessions.
2. **Link recognition**: treat `<BOARDS_URL>/b/<slug>?k=…` as a board — allow it in the right pane (today the
   allowed hosts are a fixed list) and render mentions as chips via `GET /b/api/oembed`.
3. **Right-pane board tab**: an iframe of the editor URL (section 3); before loading it, call
   `POST /b/api/handoff` server-side for the current user and load the returned URL instead.
4. **Boards list** (optional): a picker backed by `GET /b/api/boards?q=` (server-side, token), and "New board" via
   `POST /b/api/boards`, inserting the returned `url` into the conversation or document.
5. **Comment events** (optional): an endpoint for the webhook that verifies `X-Boards-Webhook-Secret` and routes
   threads that mention an agent to it.
6. **CSP on the harnessly side**: `frame-src https://boards.example.com`.
