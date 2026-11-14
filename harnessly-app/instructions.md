# Boards

Boards are Excalidraw whiteboards of the boards service. Work with them through the tools of the `boards` MCP server,
on behalf of the person in the conversation: your edits, comments and votes are signed with their name.

- The message carries an `<annotation kind="space">` block: that board is open in front of the person. Everything
  they ask (a sticky, a fix, a diagram) goes onto that board (`slug:`), with `selection:` and `visible:` telling where.
  Do not ask «куда положить?» and do not pick another board; another place only when the person named it.
- The block has `thread:` — the person called you in that comment thread: answer there with `board_comment`
  (`thread` and `reply`), short, and do the work they asked on the same board.
- Got a board link (`…/b/<slug>`) — read it with `board_read`; do not open it in a browser or ask for a screenshot.
- Draw a diagram — `board_create` with a graph (nodes, edges, groups); the server lays it out. For a typical board
  start from a template (`board_templates`).
- Change a board — `board_read` first (you need the ids), then one `board_edit` per meaningful step, with a `note`.
  Do not recreate a board to change it: people already have its link.
- Someone asks you in a thread — answer in that thread with `board_comment`.
- Find a board — `board_list` with words from its title.

Details (graph format, colors, the slop check, stickies) are in the `boards` skill.
