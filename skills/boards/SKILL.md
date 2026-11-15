---
name: boards
description: Read, create and edit Excalidraw whiteboards on a boards server (github.com/ly-solutions/boards) as text — get a board's shapes, labels, connections and comments as markdown from its link, draw a new diagram from a node/edge graph (the server does the layout), add or change shapes, reply to comments. Use when someone shares a board link (…/b/<slug>?k=…), says "look at the board", "draw a diagram", "sketch the architecture", "update the board", or when an explanation would be clearer as a diagram (architecture, data flow, user journey, dependencies). Prefer this over reading a screenshot of a board.
---

# boards

A board is an Excalidraw scene at `<origin>/b/<slug>?k=<key>`. People draw on it in the browser; you read the
same board as text and edit it through a JSON API. Edits show up live in every open editor, signed with your
name.

Setup (environment): `BOARDS_URL` — the server origin, e.g. `https://boards.example.com`; `BOARDS_TOKEN` — an
API token (needed to list and create boards, and to edit boards that are not open for editing by link). A board
link alone is enough to read it.

The helper `scripts/boards` (bash + curl) wraps the API; plain `curl` works the same way (shown below).

## Read a board

```sh
scripts/boards read '<board link>'
# = curl -s '<origin>/b/<slug>.md?k=<key>'
```

The text lists frames, shapes with labels and ids in `[brackets]`, connections (`"A" [a] → "B" [b] — "label"`),
free text, stickies with votes, open comment threads, and ends with a **Slop check** score. Opening the plain
board link with a web fetch also returns this text first. Never guess from a screenshot when you have the link.

## Look at it (before and after every edit)

The text tells you what is on the board, not how it looks. Look at the picture too:

```sh
scripts/boards look '<board link>'            # prints a PNG path — open it and look
scripts/boards look '<board link>' a,b        # just shapes [a] and [b] with what is around them
```

Look before you edit (where is free space, what style the board uses) and after (overlaps, text that does not fit,
arrows that cross, a column that ran off). Fix what you see before you answer. While you work, people who have the
board open see «Агент рисует…»; your shapes appear one by one and they can undo your whole turn in one click.
`scripts/boards done '<link>'` clears the badge at once when you finish.

## Create a board

```sh
cat > /tmp/board.json <<'JSON'
{ "description": "Checkout request path", "tags": ["architecture"],
  "graph": { "direction": "LR",
    "nodes": [ { "id": "web", "label": "Web app" },
               { "id": "api", "label": "API gateway", "color": "blue", "style": "zone" },
               { "id": "pay", "label": "Payments", "color": "amber" } ],
    "edges": [ { "from": "web", "to": "api", "label": "HTTPS" }, { "from": "api", "to": "pay" } ] } }
JSON
scripts/boards create "Checkout architecture" /tmp/board.json   # prints the link, then the board text
```

Give the person the link it prints. Templates: `"template": "architecture" | "flow" | "weekly" | "retro" |
"brainstorm" | "incident" | "decision"` (`GET /b/api/templates`).

## Edit a board

```sh
echo '{ "graph": { "nodes": [ { "id": "queue", "label": "Queue" } ], "edges": [ { "from": "api", "to": "queue" } ] },
        "update": [ { "id": "pay", "label": "Payments v2", "color": "green" } ],
        "delete": [ "old-shape-id" ],
        "note": "added the queue" }' | scripts/boards edit '<board link>'
# = curl -s -X POST '<origin>/b/<slug>/edit?k=<key>' -H "Authorization: Bearer $BOARDS_TOKEN" -H 'content-type: application/json' -d @payload.json
```

- **graph** (preferred): nodes `{ id, label, shape: rectangle|ellipse|diamond, color: purple|blue|teal|green|amber|orange|rose|red|slate, style: zone|card|strong, group, link, dashed }`, edges `{ from, to, label, dashed, bidirectional, color }`. Edges may point at ids already on the board. New content is placed to the right of existing content; choose a spot with `"at": { "x": 0, "y": 600 }`.
- **add**: raw Excalidraw skeleton with coordinates when you need exact placement.
- **update**: `{ id, label, x, y, color, link }`; **delete**: ids (labels go with their shapes, arrows are unbound).
- Everything in one request is one revision. The response contains the new board text — read it.

## Comments

Threads are listed in the board text with their ids. Answer where you were asked:

```sh
scripts/boards reply '<board link>' <thread-id> 'Moved the queue behind the gateway.' queue,api   # ids → «Показать на доске»
scripts/boards comment '<board link>' 'Is this call synchronous?' api    # pin a question to shape [api]
```

**"Make it dark" means the board's theme, not the objects' colours.** The editor has a dark theme that keeps colour
fills and turns black lines and white stickies dark by itself. Do not repaint fills darker — on the light canvas that
gives muddy stickies. Tell the person where to switch the theme; repaint only when they ask for specific colours.

**Answer short.** One or two sentences about what changed, then the link (or pass the changed ids to `reply`, so the
person gets «Показать на доске»). No lists of shapes, no coordinates, no recap of the board: they see it.

## Make it look good (the Slop check)

After each edit, check the score at the end of the board text and fix what it names if it went up. Rules of
thumb: let colour mean one thing across the board (red = problem, green = done), at most three bright fills,
no emoji in labels, one font, straight lines, align shapes, keep arrows attached at both ends, no walls of
text, leave whitespace between groups. Pastel zones with white cards inside read best.

## More

- `scripts/boards help` prints the server's full API cheat sheet (`GET /b/api`): checkpoints, history and
  restore, timer, stickies and reactions, link cards, properties and access.
- `scripts/boards history '<link>'` lists automatic snapshots; restore with
  `POST /b/<slug>/history/<id>/restore?k=…` (token).
- Errors come back as JSON `{ "error": "…" }` with a human-readable reason (e.g. sign-in required to edit a
  team board without a token).
