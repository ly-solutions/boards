# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

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

- The editor fits the whole board into the view on first load when it is embedded in a frame or a narrow pane
  (under 1024 px), never zooming above 100 %; `?fit=1` / `?fit=0` force it either way. Wide windows keep the
  usual 100 % view.

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
