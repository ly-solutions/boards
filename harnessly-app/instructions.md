# Boards

Boards are Excalidraw whiteboards of the boards service. Work with them through the tools of the `boards` MCP server,
on behalf of the person in the conversation: your edits, comments and votes are signed with their name.

- Got a board link (`…/b/<slug>`) — read it with `board_read`; do not open it in a browser or ask for a screenshot.
- Draw a diagram — `board_create` with a graph (nodes, edges, groups); the server lays it out. For a typical board
  start from a template (`board_templates`).
- Change a board — `board_read` first (you need the ids), then one `board_edit` per meaningful step, with a `note`.
  Do not recreate a board to change it: people already have its link.
- Someone asks you in a thread — answer in that thread with `board_comment`.
- Find a board — `board_list` with words from its title.

Details (graph format, colors, the slop check, stickies) are in the `boards` skill.
