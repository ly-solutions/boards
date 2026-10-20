/** API cheat sheet for agents: `GET /b/api`. The agent skill in skills/boards retells it. */
export const API_HELP = `# boards — API

A board is an Excalidraw scene at <origin>/b/<slug>?k=<key>. The link with its key lets anyone read the board.
Editing needs one of: an API token (\`Authorization: Bearer <token>\`), a signed-in user, or a board opened for
editing by link ("access": "link") — then guests sign edits with a name. Every edit is signed: elements carry
customData.editedBy and the board text shows "· edited by <who>".

## Read
GET /b/<slug>.md?k=…                → the board as text: shapes with labels, connections, text, element ids
GET /b/<slug>/scene.excalidraw?k=…  → the whole scene (.excalidraw format)
GET /b/api/boards                   → list (token or signed-in user); ?q=<search>&tag=<tag>
GET /b/api/boards/<slug>            → one board as JSON: metadata, links and the text (token or signed-in user)

## Create (token or signed-in user)
POST /b/api/boards
{ "title": "…", "description": "…", "task": "PROJ-123 or a URL", "tags": ["architecture"], "author": "who",
  "access": "team" | "link", "template": "architecture", "graph": { … }, "add": [ …skeleton… ] }
→ { url, markdown, slug, key, summary }
Templates: GET /b/api/templates — architecture, flow, weekly, retro, brainstorm, incident, decision.

## Draw and edit (token or signed-in user; the key alone is enough only when the board is open by link)
POST /b/<slug>/edit?k=…
{ "graph": {…}, "add": […], "update": […], "delete": ["id", …], "author": "…", "note": "what I did" }
Everything is applied as one revision; editors that are open show the change immediately.

### graph — the main way: the server does the layout
{ "direction": "LR" | "TB" | "RL" | "BT",
  "frame": "name of a frame around the whole diagram",
  "nodes": [ { "id": "api", "label": "Gateway\\nGo", "shape": "rectangle|ellipse|diamond",
               "color": "purple|blue|teal|green|amber|orange|rose|red|slate",
               "style": "zone|card|strong",
               "group": "name of a group frame", "link": "https://…", "dashed": false } ],
  "edges": [ { "from": "api", "to": "billing", "label": "HTTP", "dashed": false,
               "bidirectional": false, "color": "red" } ] }
Edges may reference ids of shapes already on the board (they are listed in the .md).
A new diagram is placed to the right of existing content; choose a spot with "at": {"x": 0, "y": 600}.

Colours are palette tones (GET /b/api/palette): a node is a pastel zone with a matching stroke ("zone"), a white
card with a coloured stroke ("card") or a solid badge ("strong"). A node without a colour is a white card with a
grey stroke. A colour should mean one thing across the board (red = problem, green = done) rather than paint
every node differently.

### Avoiding AI slop
The board text ends with a "Slop check": a 0–100 score and the elements at fault. Read it after your edit and
fix things if the score went up. It counts: more than three bright fills, emoji in labels, more than two fonts
or five font sizes, mixed hand-drawn and straight strokes, 1–6 px misalignments, dangling or crossing arrows,
overlaps, walls of text, decoration without meaning, crowding. Good looks like: pastel zones with a heading rule,
white cards, one font (Nunito), straight lines, whitespace between blocks.

### add — Excalidraw skeleton with coordinates, when precision matters
{ "type": "rectangle|ellipse|diamond", "id": "…", "x": 0, "y": 0, "width": 180, "height": 80,
  "label": { "text": "…" }, "backgroundColor": "#a5d8ff", "strokeColor": "#1971c2" }
{ "type": "text", "x": 0, "y": 200, "text": "Note", "fontSize": 20 }
{ "type": "arrow", "start": { "id": "a" }, "end": { "id": "b" }, "label": { "text": "…" } }

### update and delete
"update": [ { "id": "api", "label": "new label", "x": 100, "y": 40, "color": "red", "link": null } ]
"delete": [ "id1", "id2" ]   — a shape is deleted with its label; arrows are unbound

### link cards — other boards and bookmarks
A card is a rectangle with customData { "kind": "card", "url": "<url>" } and the same URL in link; its label is
fallback text for export. Links to boards on this server show the board's title; anything else is a bookmark,
unless a plugin resolves it into a rich card (GET /b/api/plugins lists them). A plugin's text reference (an issue
key, say) is a card with customData { "kind": "card", "ref": "ref:<resolver>:<text>" }.
POST /b/<slug>/links?k=…  { "refs": ["board:<slug>", "link:<url>", "ref:<resolver>:<text>"] } → { meta: { "<ref>": { title, … } | null } }

### shared timer — one per board, runs for everyone
POST /b/<slug>/timer?k=…  { "do": "start", "minutes": 5 } | { "do": "pause" } | { "do": "resume" } | { "do": "add", "minutes": 1 } | { "do": "stop" }
→ { timer: { endsAt, leftMs, durationMs, by } | null, now } — endsAt and now are server-clock milliseconds

### checkpoints — named snapshots and the diff between them
GET  /b/<slug>/checkpoints?k=…              → { checkpoints: [{ id, title, by, at, summary }], pending, week }
POST /b/<slug>/checkpoints?k=…              { "title": "Week of Oct 5", "closeWeek": false }
GET  /b/<slug>/checkpoints/<id|now>/diff?k=… → { added, changed, removed, moved }; now = since the last checkpoint
GET  /b/<slug>/checkpoints/<id>/scene?k=…   → the scene as it was
POST /b/<slug>/checkpoints/<id>/copy?k=…    → a new board from the checkpoint
closeWeek is the planning-board ritual: after the checkpoint, green (done) stickies leave the board and failed
ones go back to the "in progress" colour.

### history — automatic snapshots
GET  /b/<slug>/history?k=…                  → { snapshots: [{ id, at, source, elements }] } newest first
GET  /b/<slug>/history/<id>?k=…             → the scene at that point
POST /b/<slug>/history/<id>/restore?k=…     → bring the board back to it (as a new edit; token or signed-in user)

### properties and access
POST /b/<slug>/meta?k=…  { "title", "description", "tags": ["…"], "task": "PROJ-123" | null, "access": "team" | "link" }
— token or signed-in user; guests cannot change access

### stickies and reactions
A sticky is a rectangle with customData.kind = "sticky" (in a skeleton: "customData": {"kind": "sticky"}).
The server sets its author. Reactions 👍 👎 ❤️ change only via:
POST /b/<slug>/react?k=…  { "id": "<sticky id>", "emoji": "👍", "on": true }

### comments (Figma-style)
Open threads are in the board text, section "Comments": [thread id], which shape, who wrote what.
POST /b/<slug>/comments?k=…          { "text": "…", "x": 0, "y": 0, "elementId": "gw" }   — new thread; with elementId the pin moves with the shape
POST /b/<slug>/comments/<id>?k=…     { "reply": "…", "replyTo": "<message id>" } | { "resolved": true } | { "remove": true }
                                     | { "removeMessage": "<message id>" } | { "x": 0, "y": 0, "elementId": "…"|null } — move the pin
Answer where you were asked — reply in the thread rather than adding text to the board.

## Integrations
GET  /b/api/oembed?url=<board url>   → oEmbed (rich, iframe of the read-only embed view)
POST /b/api/handoff (token)          { "user": { "id", "name", "email" }, "next": "/b/<slug>?k=…" } → { url } — a one-time
                                       sign-in link for a user already authenticated by the integration
`
