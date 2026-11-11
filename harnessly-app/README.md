# Boards — a harnessly app

The harnessly app package of this service: the agent works with boards through MCP tools (`board_read`,
`board_create`, `board_edit`, `board_comment`, `board_react`, `board_list`, `board_library`, `board_templates`); people
get a "Boards" entry under Apps — the boards home with the library, and a board canvas next to the conversation.

- `harnessly/app.json` — the manifest (`trust: sandboxed`, targets `app`, `pane` and `chat`).
- `.mcp.json` — the `boards` server: `${install:boardsUrl}/b/mcp`, signed in with a platform token (`auth: platform`).
  `boardsUrl` is the service origin (as in the view `${install:boardsUrl}/b/app`); `/b/mcp` also works where the host
  gives the service only the `/b` prefix.
- `instructions.md` and `skills/boards/` — how the agent works with boards.
- `ui/` — a small pane view with recent boards; `evals/` — scenarios for `harnessly app eval`.

## Install in an organization

1. Run the service with `BOARDS_AUTH=harnessly` (or e.g. `oidc,harnessly`), `BOARDS_HARNESSLY_ISSUER=<hub address>`,
   `BOARDS_HARNESSLY_ORGS=<hub organization ids or *>`, `BOARDS_PUBLIC_URL=<public boards address>`, and for the full-screen view `BOARDS_APP_VIEW=on` with the hub and
   machine origins in `BOARDS_FRAME_ANCESTORS` (see [docs/integrations/harnessly.md](../docs/integrations/harnessly.md)).
2. Give the hub the boards address (the install setting `boardsUrl`).
3. An organization admin adds an "App" item to the organization's environment: this repository, folder
   `harnessly-app`. Machines put the service address in place of `${install:boardsUrl}`; without an address the app is
   "not configured" and hidden.
4. Switching the app off for the organization removes the entry and the tools for everyone; boards and links to them
   stay.

## Check

```sh
harnessly app validate ./harnessly-app --strict
harnessly app eval ./harnessly-app
```
