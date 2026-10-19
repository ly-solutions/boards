# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
