# API reference

Base path `/b`. JSON in and out unless noted; errors are `{ "error": "<reason>" }` with a 4xx/5xx status. A short,
agent-oriented cheat sheet is served by every instance at `GET /b/api`.

## Authentication

| Caller | How | Can |
| --- | --- | --- |
| Agent / integration | `Authorization: Bearer <token>` (one of `BOARDS_API_TOKENS`) | everything: list, create, read, edit, restore, hand-off |
| Signed-in person | session cookie (`BOARDS_AUTH` = token form, OIDC, trusted proxy; everyone in `none`) | list, create, read, edit, change access |
| Anyone with a board link | `?k=<key>` or `X-Board-Key: <key>` | read that board; edit it only when its access is `link` (signs as `guest: <name>`) |

A wrong key returns the same `404` as a missing board. Cookie-authenticated `POST`s with a foreign `Origin` are
refused. Browsers on origins listed in `BOARDS_CORS_ORIGINS` may call the API with tokens or keys (not cookies).

## Boards

| Method | Path | Auth | Body / result |
| --- | --- | --- | --- |
| GET | `/b/api/boards?q=&tag=` | token / user | `{ boards: [ { slug, title, description, tags, task, author, access, createdAt, updatedAt, stats, key, url, markdown, json, embed, scene, live, preview } ] }` |
| POST | `/b/api/boards` | token / user | `{ title, description?, tags?, task?, access?, author?, template?, graph?, add?, at? }` → `201 { slug, title, key, url, markdown, json, embed, scene, live, summary }` |
| GET | `/b/api/boards/<slug>` | token / user | board JSON (below), no key needed |
| GET | `/b/<slug>.json?k=` | key | board JSON: metadata, links, `rev`, `stats`, `preview`, `text` |
| GET | `/b/<slug>.md?k=` | key | `text/markdown` — the board as text |
| GET | `/b/<slug>?k=` | key | editor page (HTML); `Accept: text/markdown` or `?format=md` returns the text; `&embed=1` read-only embed |
| GET | `/b/<slug>/scene.excalidraw?k=` | key | scene JSON (+ `notes`, `rev`, `epoch`); `&download` for a file |
| GET | `/b/<slug>/preview.svg?k=` | key | thumbnail |
| POST | `/b/<slug>/meta?k=` | editor (access: token/user) | `{ title?, description?, tags?, task?, access? }` |

## Editing

`POST /b/<slug>/edit?k=` — `{ graph?, add?, update?, delete?, author?, note?, at? }`, applied as one revision.
Returns `{ …links, rev, accepted, created: [ids], summary }`.

- `graph`: `{ direction: LR|TB|RL|BT, frame?, nodes: [{ id, label, shape?, color?, style?: zone|card|strong, group?, link?, dashed? }], edges: [{ from, to, label?, dashed?, bidirectional?, color? }] }` — laid out by dagre next to existing content; edges may reference existing ids.
- `add`: Excalidraw element skeletons (`rectangle|ellipse|diamond|text|arrow|line|frame`, `label`, `start/end` bindings).
- `update`: `[{ id, label?, x?, y?, color?, link? }]`; `delete`: `[ids]`.

Colour names: `purple, blue, teal, green, amber, orange, rose, red, slate` (`GET /b/api/palette`). Templates:
`GET /b/api/templates`, `GET /b/api/templates/<id>`; library: `GET /b/api/library` (`.excalidrawlib`).

## Collaboration

| Method | Path | Notes |
| --- | --- | --- |
| GET (WebSocket) | `/b/<slug>/live?k=&client=<id>` | messages `hello→sync`, `push→ack`, `elements`, `edit`, `pointer`, `select`, `presence`, `state`, `follow`, `viewport`, `meta`, `notes`, `timer`, `checkpoints`; `Origin` must equal `BOARDS_PUBLIC_URL` |
| POST | `/b/<slug>/sync?k=` | polling fallback: `{ since, epoch, elements, files, client }` → changes since `since` |
| POST | `/b/<slug>/preview?k=` | SVG body, scripts rejected |
| POST | `/b/<slug>/comments?k=` | `{ text, x, y, elementId? }` → thread |
| POST | `/b/<slug>/comments/<thread>?k=` | `{ reply, replyTo? }` · `{ resolved }` · `{ remove: true }` · `{ removeMessage }` · `{ x, y, elementId }` |
| POST | `/b/<slug>/react?k=` | `{ id: <sticky>, emoji: 👍 \| 👎 \| ❤️, on }` |
| POST | `/b/<slug>/timer?k=` | `{ do: start\|pause\|resume\|add\|stop, minutes? }` |
| POST | `/b/<slug>/links?k=` | `{ refs: ["board:<slug>"] }` → titles of boards this board links to |

## History and checkpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/b/<slug>/history?k=` | `{ snapshots: [{ id, at, source: auto\|version\|migration\|restore, elements, bytes, commit?, by?, from? }] }` newest first |
| GET | `/b/<slug>/history/<id>?k=` | scene at that point |
| POST | `/b/<slug>/history/<id>/restore?k=` | token / user; re-applies the snapshot as a new edit → `{ changed, rev }` |
| GET / POST | `/b/<slug>/checkpoints?k=` | list (+ pending changes, week outcome) / create `{ title, closeWeek? }` |
| GET | `/b/<slug>/checkpoints/<id\|now>/diff?k=` | `{ added, changed, removed, moved }` |
| GET | `/b/<slug>/checkpoints/<id>/scene?k=` | scene |
| POST | `/b/<slug>/checkpoints/<id>/copy?k=` | new board from the checkpoint |

## Integration and auth endpoints

| Method | Path | Notes |
| --- | --- | --- |
| GET | `/b/api/oembed?url=<board link>&maxwidth&maxheight` | oEmbed `rich` with an iframe of the embed view |
| POST | `/b/api/handoff` | token; `{ user: { id?, name, email? }, next?, ttl? }` → `{ url }` one-time sign-in link |
| GET/POST | `/b/auth/login` | sign-in (token form, OIDC redirect, or proxy check) |
| GET | `/b/auth/callback`, `/b/auth/logout`, `/b/auth/handoff?t=` | |
| GET | `/healthz`, `/readyz` | probes |

Comment webhook payloads are documented in [integrations/harnessly.md](integrations/harnessly.md#comment-webhook).
