# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- The boards list keeps one centred column up to 1200 px on a wide screen (HRN-1477): the site bar, the head, the
  tabs, the templates and the grid line up, with 32 px on the sides.
- Big boards keep up (HRN-1515): a zoom draws the last frame or a picture of the whole board scaled, made in idle
  time; dragging many shapes moves them as one layer and sends the change when they are dropped; the editor is
  compiled with React Compiler; comments, the chat, the palette, templates, properties and checkpoints load when
  needed; the browser no longer exports a thumbnail after edits (the server draws it); the boards list loads
  thumbnails of the cards on screen only, and a thumbnail a browser once sent as a vector drawing of the whole board
  is replaced by the server's picture (720 px at most) the first time the list asks for it. An idle board no longer
  draws frames 60 times a second (Excalidraw's check for collaborators' laser trails ran in an endless frame loop and
  handed both canvases to the compositor every frame); typing into a sticky no longer redraws the canvas on every key;
  the comments chunk loads next to the scene.
- Dark theme keeps colours (HRN-1480): the canvas is no longer inverted as a whole. Colour fills (stickies, shapes,
  column headers) keep their light-theme colour with dark text; black and grey lines, free text and near-white tints
  are inverted as before; a white, grey or empty sticky becomes a raised dark card with a shadow; the stage is the
  dark harnessly background with a dot grid that follows the camera. Text typed into a coloured sticky stays dark.
  Board data does not change; browsers without canvas filters keep the old inversion.
- Boards 2.0 (HRN-1480): the editor's own islands replace Excalidraw's menus — a bottom toolbar with tooltips (name and
  key) and popovers (sticky colours, shapes, arrows, pen, text, frame, comment, reactions, «+» for a site, an image
  and, in harnessly, the machine's terminal); a context bar over the selection per kind (sticky, shape, arrow, text,
  site, terminal, several objects) with font, size, bold/italic/underline/strike, alignment, colours with hex, line
  height and a «⋯» for opacity, lock, layers, duplicate, style copy and links; the title, the menu and view mode top
  left; people, share and comments top right; zoom bottom right. Excalidraw's own UI stays hidden and is driven
  through its API.
- Sticky text shrinks while it is typed (28 → 10px) and the sticky grows once even 10px does not fit; a text's box
  follows its words.
- Reactions can go on any object (not only stickies): a row of counters under the object, a click takes one's own back.
- Comments: the panel has filters (open, resolved, mine) and, in the harnessly view, sits under «Комментарии · Чат»
  tabs; the chat tab and «Спросить» ask the harnessly chat about the selection (`chat.prompt`).
- Objects the agent has just changed are outlined for a moment.
- The view-only and guest-name banners centre over the canvas left of the comments panel (on a phone they go up under
  the top islands) instead of hiding under it.
- harnessly app package 0.6.0: the view hides its own bar under the editor's islands, «Спросить» publishes the
  selection as the chat's context and sends the person's words to the chat, a site (http/https only) opens in the right
  pane (`pane.open`), and a terminal card shows the last lines of the chat's terminal (new permission `terminal.read`).

### Fixed

- A guest of a team board (HRN-1480): no second banner over the board — «Войти» sits in the «Только просмотр» island
  and fits a narrow window. Opening a board fits it between the islands (title at the top, tools at the bottom); a wide
  window opens at 100 % around the content, a board larger than the window from its top-left corner.
- Opening a board on a slow connection: the editor's own centring no longer lands after our fit and undoes it; the fit
  is applied again until the person touches the board (not for a link to a thread).
- The board flash of quick edits (HRN-1466) used helpers that #25 removed; it outlines with the shared glow now.

### Added

- Agent edits you can watch (HRN-1480): an agent sees the board as a picture — `GET /b/<slug>/picture.png[?ids=a,b]`
  (the package's SVG export rendered by resvg-wasm with the editor's fonts), MCP `board_look`, `boards look` in the
  skill — and is told to look before and after an edit. `POST /b/<slug>/agent {status}` and every look show
  «Агент рисует…» to editors; an agent's edit plays in one by one with a short glow and a cursor named after the agent,
  and the camera follows when it draws off-screen; the whole turn is one bar «Агент изменил N объектов · Показать ·
  Отменить». `/edit` answers with `changed` ids and a `show` link (`?show=a,b` opens the board on them and outlines
  them); a comment reply may carry `ids` («Показать на доске» under it). Board thumbnails come from the server
  picture while no browser has sent one.
- Comments panel as in the prototype: «Комментарии | Чат» tabs on the standalone board too (the chat lists threads
  that call the agent and asks it with `@harnessly` at the selection), «Решено» in the thread card head, 👍 and other
  reactions on a thread (`react: { emoji }` on `POST /comments/<id>`), «агент печатает…» while a call waits for its
  answer; right-island tooltips go to the left while the panel is open so they no longer cover its header.
- Board list as in the prototype: search, filters, templates row and a card menu, without native selects.
- Quick edit for voice (HRN-1466): MCP tools `quick_read` (the board as text, one JSON line per element, with a version),
  `quick_apply` (exact `{ old, new }` replacements on that text: change a label or a colour, add or, with `confirmed`,
  remove a shape) and `quick_undo` (put the last apply back). The harnessly manifest declares them as `quickEdit`
  (package 0.7.0); the app view outlines the changed elements when the host sends a `quick-edit` event.

- A mention reaches the person (HRN-1469): the board keeps a stable id for each person who was on it signed in
  (`hub:<id>` from the harnessly app view, else HMAC-SHA256 of the e-mail keyed with the webhook secret), in storage only;
  the webhook's `message.mentions` is `[{ name, id }]` (`{ name, agent: true }` for `@harnessly`) and `message.authorId`
  names the writer. Editors get the people by name (`notes.people`), so `@` offers everyone who was here, not only who
  is here now; `@Bobby` no longer calls `Bob`. `?thread=` (or a `board-thread` message from the app view) opens a
  thread's card; the app view follows a new board or thread harnessly asks for without starting again.

- Guest view of the read-only embed (`/b/<slug>?embed=1&guest=1`, API token only): the page carries no board key —
  no link back, and the cards that lead to other boards lose their keys. A platform fetches it and serves it under its
  own guest link, which has a term and can be revoked, while the board's own key stays a secret (HRN-1337).

### Changed

- harnessly app view (`/b/app`) is a site of its own: it reads the library from `GET /b/api/app/library` by the session
  cookie, opens a board in the same frame (`?board=<slug>`) with a way back, and no longer waits for the harnessly
  bridge or the machine. The first sign-in goes through the new MCP tool `board_signin` (a one-time pass the page posts to `/b/api/app/enter`).
  The "what shall we draw" field and its starters are gone. The app package (0.3.0) has one view, for the app and the
  pane.

### Added

- harnessly app: `harnessly` in `BOARDS_AUTH` (alone or next to a sign-in mode, e.g. `oidc,harnessly`) accepts
  harnessly platform tokens on `/mcp` — Ed25519 JWTs from the hub (`BOARDS_HARNESSLY_ISSUER`, required
  `BOARDS_HARNESSLY_ORGS`), checked against the hub's keys; edits are signed with the person in the token. `POST /mcp`
  serves MCP tools (`board_read`, `board_create`, `board_edit`, `board_comment`, `board_react`, `board_list`,
  `board_library`, `board_templates`) to agents with a platform or API token. `BOARDS_APP_VIEW=on` adds the app view:
  `/b/app` (home with the board library) and the bare canvas `?app=1`. The app package is in `harnessly-app/`. All of
  it is off by default. See docs/integrations/harnessly.md, section 7.
- In-memory read cache for the s3 driver (`BOARDS_CACHE_MB`, 128 MiB by default; Helm `storage.s3.cacheMb`) for
  stores that answer HEAD fast but take seconds per GET. Immutable snapshot and checkpoint scenes come from memory;
  other objects are revalidated with a HEAD. `BOARDS_CACHE_WARM` (on by default) fills it in the background after
  start, newest boards first. See docs/storage.md, "Stores with slow reads".
- Plugins: `BOARDS_PLUGINS` loads server plugins at start-up. A plugin can add routes, card resolvers (rich cards
  for pasted URLs and text references, cached and with timeouts), block actions in the right-click menu that edit
  the board on the server, board properties shown in Board properties and on the boards list, incoming webhooks,
  event listeners, feature-flag providers and interface messages. Web plugins (`BOARDS_WEB_PLUGINS` or a plugin's
  `web`) register card renderers, block actions, toolbar buttons and property formatters in the editor. The plugin
  API is versioned with semver (1.0.0); incompatible plugins stop the start-up. See docs/plugins.md and
  examples/plugin-example.
- Feature flags per person: `BOARDS_FLAGS` for everyone, providers from plugins; flags named after editor features
  switch them off per person.
- Link previews from Open Graph tags (`BOARDS_LINK_PREVIEW=on`, off by default), fetched through an SSRF guard that
  refuses private, loopback, link-local and reserved addresses, pins the checked address and re-checks redirects.
- Interface language: `BOARDS_LOCALE=en|ru`. The editor, Excalidraw's own UI, the server pages and the board text
  for agents follow it; all strings live in message catalogs (`shared/locales/`), with a complete Russian locale.

### Changed

- Opening a board reads `meta.yaml`, the scene and the notes in one parallel round and only checks that the
  thumbnail exists; the thumbnail is read when someone asks for it.
- Kubernetes: the Helm chart and the kustomize base roll out with `Recreate` by default, so two pods never write at
  once. On a store whose conditional writes are atomic you can opt back into an overlapping `RollingUpdate`.
- The `auto` conditional-write probe now fires overlapping requests (8 parallel creates, then 8 parallel `If-Match`
  replaces) and trusts the store only if each phase lets exactly one write through. A sequential probe passed on
  stores that check preconditions correctly one request at a time but not under concurrency. The verdict is logged
  with the counts.
- The editor fits the whole board into the view on first load when it is embedded in a frame or a narrow pane
  (under 1024 px), never zooming above 100 %; `?fit=1` / `?fit=0` force it either way. Wide windows keep the
  usual 100 % view.

### Fixed

- Concurrent writes to one board within a process no longer depend on the store's preconditions: the S3 driver
  serialises writes per key in both modes, checkpoints are saved one at a time per board, and the snapshot manifest
  is updated under a per-board lock. On a store whose preconditions are not atomic (seen on Selectel ru-3), two
  checkpoints or snapshots saved at once could drop one.

## [0.1.0] - 2026-10-19

First open-source release.

### Added

- Excalidraw editor with live collaboration: WebSocket channel with a polling fallback, live cursors and follow
  mode.
- Boards readable as markdown by AI agents, and a JSON edit API: create boards from skeletons with automatic graph
  layout (dagre), update and delete elements.
- Stickies with reactions, comment threads with a webhook for comment events, checkpoints, a shared timer,
  templates and a slop check.
- Storage drivers: `s3` for any S3-compatible store (conditional writes with a capability probe and a
  compare-first fallback; history through bucket versioning or snapshot objects) and `fs` for a local folder.
- `boards migrate --from-git` to move boards, with their commit history as snapshots, from a Git repository into S3 or a folder.
- Pluggable authentication: API tokens, OpenID Connect, trusted reverse proxy, or none for local use.
- Boards list page.
- Board history and restore API.
- oEmbed endpoint, hand-off sign-in links, and configurable CORS origins and `frame-ancestors` for embedding.
- Prometheus metrics on a separate port.
- Dockerfile, Docker Compose setup with MinIO, Helm chart, Argo CD example and kustomize base.
- Agent skill with a shell client for reading and editing boards.

[Unreleased]: https://github.com/ly-solutions/boards/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ly-solutions/boards/releases/tag/v0.1.0
