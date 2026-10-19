# Design notes

boards is an Excalidraw editor that serves people and AI agents equally. People draw in the browser; an
agent reads the same board as short markdown and edits it through a JSON API. A board lives at
`<origin>/b/<slug>?k=<key>`.

This document explains how the pieces work and why they were built this way. For deployment see the README,
for configuration `docs/configuration.md`, for the on-disk format `docs/storage.md`.

## Why

Diagrams used to be screenshots or live in third-party services. Given an image, an agent spends thousands
of tokens on it and still gets arrow directions wrong; drawing a diagram that a person can then adjust with
the mouse was out of reach entirely. An Excalidraw scene already holds everything in structure: a shape has
a label, an arrow is bound to the shapes at both ends. So the agent needs that structure folded into a short
text, not a picture.

## Alternatives considered

| Option | What it is | Verdict |
| --- | --- | --- |
| Self-hosted excalidraw.com | the app + `excalidraw-room` (Socket.IO) + a share-link store | Scenes are encrypted in the browser and the key lives only in the URL fragment; there is no listing API. Neither a board list nor agent reading is possible. `excalidraw-room` has not been updated since 2024. |
| `excalidraw/excalidraw-mcp` | official MCP App, a widget inside the chat | Not storage: checkpoints go to temp files or Redis with a TTL, export goes to excalidraw.com. |
| `mcp_excalidraw` (community) | MCP with element CRUD and `describe_scene` | In-memory canvas, empty after a restart; its own frontend. |
| `y-excalidraw` | Yjs binding | Targets 0.17, no tests, and sync is per element anyway. |
| **npm package + own storage** | `@excalidraw/excalidraw` 0.18.1 inside this service | **Chosen.** The scene is stored in the clear, so it can be listed, read and extended. |

## Collaborative editing

The package has no collaboration API; the official app builds sync itself on top of `reconcileElements`.
boards does the same (`server/merge.mjs`, `server/store.mjs`):

1. The browser sends the elements whose `version` changed and receives everyone else's changes since the
   last revision it saw. Without the live channel this is an HTTP poll of `POST /b/<slug>/sync` every 1.5 s.
2. The server merges element by element: the higher `version` wins; on a tie, the lower `versionNonce`. The
   rule is deterministic, so all participants converge on the same scene whatever order edits arrive in.
3. A delete is an edit too (`isDeleted: true`, a tombstone). Otherwise a stale copy in someone else's browser
   would resurrect the deleted element.

Every write path — polling, the live channel, agent edits — goes through the same `store.apply`, so live
clients, polling clients and agents coexist on one board.

**Restarts.** The server has an *epoch* (random per process). A client that sees a different epoch sends its
whole scene, and the per-element merge restores anything drawn since the last write. Boards are flushed on
`SIGTERM`, so a normal rollout loses nothing.

### Live channel

Polling is enough while one person draws and the rest watch. With two people drawing, 1.5 s turns into
guesswork: you cannot see who is where, someone else's shape pops in fully formed, and editing the same spot
at once is something you find out about afterwards. So on top of the same store there is a WebSocket
`/b/<slug>/live?k=…` (`server/live.mjs`, `web/src/live.ts`):

| Message | What it does |
| --- | --- |
| `hello` → `sync` | Same as the first `/sync`: everything the client lacks since its revision; everything on a foreign epoch. |
| `push` → `ack` | Edits batched every 40 ms while a shape is dragged; `ack` confirms versions, anything unconfirmed is resent. |
| `elements`, `edit` | Other people's edits and agent edits, broadcast to everyone on the board except the author. |
| `pointer`, `select` | A participant's cursor (and laser) and selection. Not stored; the server only relays them. |
| `presence`, `state` | Who is on the board and their state: `active`, `away` (tab hidden) or `idle` (a minute without movement). |
| `follow` → `followers`, `viewport` | Follow mode: the leader sends its visible area only to those following it. |
| `timer`, `checkpoints`, `notes`, `meta` | Shared timer, checkpoint list, reactions and comments, title/access/tags. |
| `ping` → `pong` | Liveness probe (see below). |

The cursor name is set by the server — from the sign-in or the guest's chosen name — so nobody can pose as
someone else. The `Origin` header is checked against `BOARDS_PUBLIC_URL`: the sign-in cookie is sent on a
WebSocket opened from any page.

The channel is an accelerator, not the only path. While it is down (proxy, rollout, mobile network) the editor
syncs by polling and the channel reconnects with exponential backoff (0.5 s up to 10 s, with jitter, so tabs do
not stampede after a deploy). A server heartbeat every 25 s keeps the connection alive through proxies with a
typical 60 s read timeout.

### When the channel dies silently

A socket can stay `OPEN` while no data flows: laptop sleep, Wi-Fi switch, VPN reconnect. Until the editor
notices, it believes it is live, does not poll, and sends edits into the void — someone types into a sticky,
nobody sees it, then the text appears all at once. Timeouts of 15–35 s proved far too long. Now:

- The server acks an edit within tens of milliseconds. If nothing at all arrives within 2 s, the edit is
  duplicated via `/sync` right away and the channel is probed (`ping`, 4 s deadline). Typed text reaches
  others within 1–3 s even over a dead channel.
- A viewer probes after 5 s of silence and learns about a drop in about 10 s; 20 s of silence drops the
  socket outright. A handshake hanging longer than 10 s counts as a drop too.
- A slow but live channel is not dropped: any server message clears the probe, not just `pong`.
- Probes also run immediately when the tab becomes visible or the network comes back.
- Avatars and cursors survive short drops: they disappear only if the channel is not back within 6 s.
- The server logs `live_reconnect` with the reason reported by the browser (`no-reply`, `silence`,
  `handshake`, `closed`) and `live_close` with the socket lifetime, so you can see who drops and how often.

Operators can turn the channel off with `BOARDS_DISABLE_FEATURES=live`; boards then work by polling only.

## Smart guides and snapping

While a shape is dragged, resized or drawn, the editor shows where it lines up with its neighbours — edge,
center, corner to corner, equal spacing — and snaps it there. Stickies are ordinary shapes and snap the same
way.

This is Excalidraw's own object snapping (`appState.objectsSnapModeEnabled`) with three changes:

- **On by default.** In the package it is off and hidden behind Alt+S, so nobody knew about it. It can be
  turned off with Alt+S, the "Snap to objects" item in the main menu, or under "More" in the right-click menu;
  holding Ctrl/Cmd while dragging skips it for that move.
- **The choice is personal** and kept in the browser (`localStorage` key `boards-snap`), not in the scene:
  turning it off does not change anything for others on the same board.
- **Guides are more visible and cheaper.** Color and line width are patched at build time (`snap-guides` in
  `scripts/excalidraw-patches.mjs`), and gap computation no longer allocates per shape pair (`snap-gaps-*`),
  which removed a ~300 ms hitch at drag start on large boards.

Operators can disable it with `BOARDS_DISABLE_FEATURES=snap`.

## Smooth camera and motion

Excalidraw sets the view instantly: a wheel notch jumps 100 px and stops dead, a zoom step jumps 10 %, a
released pan stops on the spot. `web/src/motion.ts` turns input into a target the view eases towards:

- the mouse wheel accumulates remaining scroll that the view covers with decay; Ctrl+wheel multiplies the
  target zoom around the cursor;
- a board thrown by hand (space, middle button, hand tool) keeps coasting at the release speed;
- zoom buttons, "zoom to fit" and zoom reset glide instead of jumping;
- trackpad scrolling is left alone (the OS already adds inertia); trackpad pinch zoom is multiplicative —
  the same feel at any scale — and applied without glide so the fingers drive the board.

The package hands input to the camera through hooks patched in at build time (`motion-*` patches). New
blocks also get a short expanding ring (`web/src/motion-fx.tsx`), which shows where an agent just drew.

Overlays above the canvas (sticky badges, comment pins, link cards) live in scene coordinates under a single
CSS transform written in the same tick Excalidraw paints (`web/src/camera.tsx`), so they never lag a frame
behind.

Smooth motion is a personal setting ("Smooth board motion" in the main menu, `localStorage` key
`boards-motion`) and respects
`prefers-reduced-motion`. Operators can disable it with `BOARDS_DISABLE_FEATURES=motion`.

## Checkpoints and the close-week ritual

Boards are written to storage every few seconds of editing, and automatic history keeps snapshots. A busy
planning call produces dozens of them, each saying little more than "+40 stickies, 4 changed". That history
is not useful for people, so on top of it there are **checkpoints** — snapshots someone gave a name.

- **Storage.** `checkpoints.json` (title, who, when, summary) and `checkpoints/<id>.excalidraw` (the scene)
  inside the board folder. A checkpoint is a plain file, not a pointer into history, so it survives any
  storage backend and history pruning.
- **Meaningful diff** (`shared/checkpoints.mjs`, shared by server and editor). The unit is a labelled block:
  a shape with a label, standalone text, an image. Additions, removals and changes of text and color count;
  moves and resizes do not; arrows, lines and empty shapes are ignored.
- **Checkpoints panel** in the top toolbar: a "Now" row shows what changed since the last checkpoint, with
  highlights on the canvas (new, changed with a "was" label, removed as a ghost); below it the list.
- **Open as it was** opens the same board at `?k=…&at=<id>`: read-only, no live channel and no polling.
  **Copy** creates a new board from the checkpoint. No button overwrites the current board with an old version.
- **Close week** is the planning-board ritual: a checkpoint named after the week, after which done (green)
  stickies leave the board — they stay in the checkpoint — and missed ones get the "in progress" color back.
  The week outcome is counted by the legend colors of the "Weekly plan" template.

## Link cards

Paste a single URL onto the canvas and it becomes a card (`web/src/links.tsx`, `shared/links.mjs`):

- **Board card** — for a link to another board on the same server (same origin, path `/b/<slug>`): the
  board's title and last update.
- **Bookmark card** — for any other URL: site and path.

URLs that Excalidraw embeds itself (YouTube, Vimeo, Figma, …) are pasted as before. A card opens through
Excalidraw's standard link icon.

In the scene a card is a plain rectangle with `customData.kind: 'card'`, the URL in `customData.url` and
`link`, and a fallback label inside. A DOM layer draws the live card on top. So in exports and in the board
text for agents the card stays a readable line with a link, while it moves, selects and deletes like any
shape.

Board titles come from `POST /b/<slug>/links {refs}` (`server/links.mjs`). The server answers only about
`board:` refs the current board actually contains and never fetches arbitrary URLs — bookmarks need no data.
Clients cache answers for a minute.

**Link onto a selected block.** With one block selected and a single URL in the clipboard, Cmd/Ctrl+V
attaches the URL to that block as its own link (the editor draws the icon at its corner) instead of creating
a card. While text is being typed inside the block, paste stays a text paste. The same by hand: "Link…" in
the right-click menu (Ctrl/Cmd+K).

## Right-click menu

Where the board can be edited, a short menu of our own replaces the stock Excalidraw one (`web/src/menu.tsx`).

- **On a block:** Link…, Comment, Copy, Cut, Duplicate, Bring to front, Send to back, Group (when several
  blocks are selected), Ungroup, Lock in place, Delete.
- **On empty canvas:** Paste, Sticky here, Comment here, Select all.
- **More** — everything else the stock menu offers for that spot: copy as PNG/SVG, styles, flip, layer
  steps, grid, snap to objects, modes. The list is read from the hidden stock menu together with its labels,
  shortcuts and checkmarks, so it never falls behind the editor. Nothing is removed, only moved under More.

The editor still opens its own menu; it is hidden by CSS (`body.board-menu-on`). Ours takes its place and
performs edits by clicking the stock item, so Paste, Duplicate and layer order remain real editor actions
with undo history, and the editor decides which items fit what was clicked. Long-press on touch devices takes
the same path. Read-only boards keep the stock menu.

When upgrading Excalidraw, check that the menu still hangs off `appState.contextMenu` and the markup
`.context-menu > li[data-testid=<action>]`.

## Shared timer

One timer per board, in the top toolbar next to checkpoints (bottom bar on phones). Anyone who can edit may
start, pause, add a minute or stop it.

- The server keeps when the timer ends (`endsAt`, server clock) or how much is left while paused (`leftMs`).
  Each client learns its clock offset from every `/sync` response, the live `sync` and each `timer` message,
  and computes the remainder itself, so everyone sees the same time, including late joiners.
- The last 30 s are orange. At the end three soft notes play (synthesised in the browser, no audio files),
  the badge turns red and shakes, and shows `00:00` for 20 s. Sound can be muted per person (`localStorage`
  key `boards-timer-sound`) and only plays for someone who has interacted with the page — browsers block it
  otherwise.
- The timer lives in server memory and is never written to storage: it is meeting state, and a write per
  pause would pollute history. A restart resets it.
- Viewers without edit rights do not see it: they have no toolbar.

## Stickies and reactions

A sticky is a rectangle with `customData.kind: 'sticky'` and a label. Author and reactions are drawn by a DOM
layer above the canvas; reactions are stored in the board's `notes.json`, not in the scene.

- **Shrinks with its text.** Excalidraw does not let a shape get smaller than its label. For a sticky it is
  the other way round: on resize the font size is fitted — the largest, no larger than the original, at which
  the text fits, but not below 8 px. The original size is kept in the label's `customData.stickyFont`, so
  enlarging the sticky brings it back (`sticky-text-fit` patch). Sticky font sizes are excluded from the
  slop check's "too many font sizes" rule.
- **Later lies on top.** Badges of a sticky covered by another are hidden, and the author is hidden when the
  text reaches the bottom edge.
- **Visible border.** The stroke is a tenth darker than the fill (`stickyStroke` in `shared/palette.mjs`),
  so two overlapping stickies of the same color do not merge.

## Comments

A comment is not a scene element: threads live in the board's notes next to reactions, stay out of the
diagram and exports, and are sent to everyone in full. A pin sits at a canvas point or on a shape — then it
keeps an offset from the shape and moves with it.

- A new comment is written in a card at the bottom center while the pin marks the clicked point; a thread
  opens as a card next to its pin: the shape's label, messages with avatars, a reply box.
- **Resolve** and **Reopen** live in the thread's row in the comments panel.
- **Reply to a specific message** with the arrow next to it; the reply stores `replyTo` and quotes the
  original, and clicking the quote jumps to it.
- **Clicking away** closes the draft or thread card; unsent text is kept and comes back next time.
- **Deleting** a thread or a message takes two clicks. Signed-in users and agents may delete anyone's;
  a guest only their own. Deleting the first message deletes the thread.
- **Moving**: drag a pin; dropped on a shape, it attaches to it.
- **Trackpad pinch** over a card, pin or panel zooms the canvas, not the page.
- Which threads you have opened is remembered per browser (`localStorage` key `boards-seen:<slug>`) only to
  clear the "new" dot.

**Webhook.** Integrations can follow threads instead of polling: with `BOARDS_COMMENTS_WEBHOOK_URL` set, boards
POSTs `thread.created`, `thread.replied`, `thread.resolved`, `thread.reopened` and `thread.removed` events (payload in
[integrations/harnessly.md](integrations/harnessly.md#comment-webhook)), signed with the shared secret header.
Delivery runs in the background with a timeout and is only logged, so a slow receiver can never hold up an edit
(`server/hooks.mjs`). Thread rules live in `server/comments.mjs`.

## Embed view (`?embed=1`)

`/b/<slug>?k=<key>&embed=1` is a separate, small page (`web/src/embed-view.tsx`, rendered by `renderEmbedPage`)
for showing a board inside another document. It is always read-only — even for people who could edit — and has no
toolbar, menus, panels, cursors or live channel; viewers can still pan and zoom. The scene is fitted into the frame
(never enlarged beyond 100 %) and refitted when the frame changes size until the viewer moves the view themselves.
Two quiet buttons sit in the corner: **Open board** (the full editor in a new tab) and **Fullscreen** (shown only
where the Fullscreen API is allowed).

The page is built for the strictest host: a document rendered in a sandbox without `allow-same-origin` gives the
frame an opaque origin, so it has no cookies and cannot call the boards API. The scene therefore comes inlined in
the HTML, asset URLs are absolute, static files carry `Access-Control-Allow-Origin: *`, and the response has no
`frame-ancestors` directive at all — an opaque parent matches no source expression, not even `*`. Framing the view
grants nothing beyond what the key already allows: reading. The full editor keeps `frame-ancestors` from
`BOARDS_FRAME_ANCESTORS`.

## Fonts from our own host

Excalidraw loads its hand-drawn and UI fonts at runtime. boards serves them itself:
`scripts/self-hosted-fonts.mjs` copies the package's font files into the build (`/b/_static/fonts/…`) and
`web/src/boot.ts` — the first script on every page — sets `EXCALIDRAW_ASSET_PATH` from its own URL, which also
works inside an opaque-origin embed. The package additionally lists a CDN copy of every font; the plugin points that
fallback at our host too and fails the build if any emitted chunk still references the CDN, so the strict
`font-src 'self'` CSP never has to block anything. Hashed font files are cached for a year, the rest for a day.

## Where boards are stored

Each board is a folder of plain files — `scene.excalidraw`, `meta.yaml`, `board.md`, `preview.svg`,
`notes.json` and checkpoints — in S3 (or any S3-compatible store) or a local folder. See `docs/storage.md`.

## Access

- **Link = read.** A board is reachable by two secrets in its link: an unguessable slug (title plus 12
  random characters, ~62 bits) and the key `?k=` (22 base62 characters, ~130 bits). A wrong key returns the
  same 404 as a missing board, and keys are compared in constant time. Opening a link needs no sign-in on
  purpose — boards are opened on phones and handed to agents as one line — so a board must not contain
  anything you would not show to whoever ends up with the link.
- **Who can edit:** an API token (agents, integrations), a signed-in user, or — on boards opened for editing
  by link (`access: link`) — guests, who sign their edits with a name of their choice (kept in `localStorage`
  key `boards-guest`). Boards default to `access: team`, where the link alone is read-only. Only signed-in
  users and agents can change access or restore history.
- **Listing** (`GET /b/` and `GET /b/api/boards`) is available to signed-in users and token holders only.

History makes vandalism recoverable.

## Agent workflow

- **Read:** `GET /b/<slug>.md?k=…` — shapes with labels, connections, text and element ids. A plain fetch of
  the editor URL without JavaScript also starts with the same text.
- **Create:** `POST /b/api/boards` with a token (title, tags, template, an initial `graph` or skeleton).
- **Edit:** `POST /b/<slug>/edit?k=…` — a `graph` (`nodes`/`edges`, the server does the layout), an Excalidraw
  skeleton in `add`, `update`, `delete`. Everything is applied as one revision and open editors show it
  immediately.
- **Cheat sheet:** `GET /b/api` returns the full API reference as markdown (`server/help.mjs`).
