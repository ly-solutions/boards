---
name: boards
description: Boards (Excalidraw whiteboards) through the tools of the boards MCP server — read a board as text from a link, draw a new diagram as a graph, add to or change an existing one, answer in comments, react, find a board. Use when someone sends a board link (…/b/<slug>), asks to "look at the board", "draw a diagram", "sketch the architecture", "add to the board", "update the board", when an explanation wants a picture (architecture, data flow, user journey, dependencies), and instead of reading a screenshot of a diagram that has a board.
---

# Boards: read as text, draw as a graph

A board is an Excalidraw canvas at `<boards service>/b/<slug>`. People draw in a browser; you read the board **as
text** and draw with the tools of the `boards` server. An edit shows up for everyone who has the board open within a
couple of seconds, signed with who did what. The tools work on behalf of the person in the conversation: the service
knows them by the platform token, the key in the link is not needed (a link with `?k=` works too).

| Tool | What it does |
| --- | --- |
| `board_read` | The board as text: frames, shapes with labels and ids, connections, stickies with votes, open threads, the slop check |
| `board_create` | A new board: empty, from a template or with a diagram (`graph`). Answers with the link and the board text |
| `board_edit` | One edit, one revision: `graph`, `add` (a skeleton with coordinates), `update`, `delete`, `note` |
| `board_comment` | A new thread at a shape or a point, a reply in a thread, "resolved" |
| `board_react` | A reaction on a sticky |
| `board_list` | Boards, newest first; `query` — words from the title, description or tags |
| `board_templates` | Templates for `board_create` |

The `board` argument is a board slug or a link to it.

## Read a board

Got a link — `board_read`, not a browser and not a screenshot. You get markdown: frames, shapes with labels,
coordinates and color, connections like `"Gateway" [gw] → "Orders" [orders] — "HTTP"`, free text. The ids in square
brackets are what edits refer to. An arrow dropped by hand next to a shape is already attached to it in the text.
Freehand drawings are only counted — if they matter, say so to the person.

## Draw a new one

Think in graphs, not coordinates: nodes, edges, groups. The server does the layout.

```json
{
  "direction": "LR",
  "nodes": [
    { "id": "web", "label": "Web client", "group": "Front end" },
    { "id": "bff", "label": "BFF", "group": "Front end" },
    { "id": "orders", "label": "Orders", "color": "green" },
    { "id": "pay", "label": "Payments", "shape": "ellipse", "color": "red" }
  ],
  "edges": [
    { "from": "web", "to": "bff", "label": "reads" },
    { "from": "web", "to": "orders", "label": "booking", "dashed": true },
    { "from": "orders", "to": "pay", "label": "payment" }
  ]
}
```

This graph is the `graph` argument of `board_create`, together with `title`. Give the person the link from the answer.
Start a typical board from a template: `board_templates` lists them (architecture, user journey, plan, retro,
brainstorm, incident, decision), `board_create` with `template` creates a board from one; then add to it with a graph.

A good diagram:

- **short meaningful ids** (`orders`, `pay`), not `n1`: later edits refer to them;
- a node label names the thing; a line break `\n` adds a detail;
- `group` draws a frame with that name around the nodes; groups do not nest;
- `color` is a palette tone: `purple|blue|teal|green|amber|orange|rose|red|slate`; `style` — `zone` (pastel fill, the
  default for a colored node), `card` (white with a tone outline), `strong` (a bright header — column headers only).
  A color means one thing across the board: red is a problem, green is done. A node without a color is a white card;
- `shape` — `rectangle` (default), `ellipse`, `diamond` for a decision or a fork;
- an edge: `label`, `dashed` for asynchronous or optional, `bidirectional`;
- `direction`: `LR` for flows and pipelines, `TB` for hierarchies.

When pixel precision matters, use an Excalidraw skeleton in `add` (the tool description has the format).

## Neat, not slop

"Make it nice" does not mean "add colors and emoji": pastel section zones, white cards with a tone outline, one font,
straight lines, air between blocks, three or four colors with a meaning. The server draws like that by itself.

The board text ends with **the slop check**: a score from 0 to 100 and the elements behind it. Read it after every
edit: if it went up, fix the named ids rather than repainting everything. Slop is:

- bright fills in more than three colors over a noticeable area;
- emoji in labels and emoji bullets;
- more than two fonts and five sizes, a mix of hand-drawn and straight lines;
- alignment misses of 1–6 px, neighbouring cards of one role in different sizes;
- dangling arrows and arrows through other shapes, overlapping shapes;
- walls of text in a card (longer than ~180 characters) — paragraphs go to a document, the board gets the gist;
- decoration without meaning, and crowding.

## Stickies and reactions

A sticky is a person's thought with an author and votes 👍 👎 ❤️; the board text lists them in a section of their own.
When asked to "sum up", "what did we decide", "what got the votes" — rely on them. A sticky is a skeleton in `add`:
`{"type":"rectangle","customData":{"kind":"sticky"},"backgroundColor":"#ffe299","strokeColor":"#ffe299","width":176,"height":176,"label":{"text":"…"}}`.
React (`board_react`) only when the person asks you to.

## Comments

People discuss a board in comments: a pin at a shape, a thread with replies, "Resolved". Open threads are in the board
text with the thread and shape ids. When someone asks you, or asks about what you drew, **answer in that thread**
(`board_comment` with `thread` and `reply`), not with a label on the board and not with a new thread. Your own question
about a shape — `board_comment` with `text` and `elementId`. Done what was asked — resolve the thread (`thread`,
`resolved: true`).

## Add to and change a board

`board_read` first — you need the ids. Then one `board_edit` per meaningful step:

- `graph.edges` may refer to shapes **already on the board** — the server places a new block next to them;
- a graph edit never moves existing shapes — that is someone else's work;
- `update` — `[{"id":"orders","label":"Orders (v2)","color":"red","x":100,"y":40}]`; moving a shape takes its label and
  bound arrows along;
- `delete` — `["id1","id2"]`: a shape goes with its label, arrows are unbound;
- `note` is shown to everyone who has the board open: say **what** you did, briefly.

The tool answers with the board text after the edit: check that you got what you meant.

## Do not

- **Do not read a screenshot of a diagram that has a board** — read the board.
- **Do not recreate a board to change it** — edit the same one: people have its link, and their edits live only there.
- **Do not put secrets on a board.** Anyone who gets a link with the key can open it.
- Do not draw with coordinates what a graph expresses: the server layout is neater than a manual one.
