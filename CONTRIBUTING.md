# Contributing to boards

Thanks for your interest in boards. Bug reports, fixes, documentation and new features are all welcome. For a
larger change, open an issue or a discussion first so we can agree on the approach before you spend time on it.

## Development setup

You need Node.js 22 or later and npm. Docker is optional (see [Running tests](#running-tests)).

```bash
npm ci
npm run build   # editor (Vite) + server-side Excalidraw bundle (esbuild)
npm run dev     # http://localhost:8080
```

`npm run dev` starts the server with `BOARDS_AUTH=none` (everyone is signed in) and the `fs` storage driver, which
keeps boards in `.data/` in the repository root. It also sets an API token, `dev-token-0123456789abcdef`, for trying
the JSON and text API locally. This setup is for local development only.

Rebuild with `npm run build` after changing anything under `web/` or `engine/`; restart `npm run dev` after server
changes. To try the S3 driver, `docker compose up` runs boards with MinIO, or point the `BOARDS_S3_*` variables at
any S3-compatible store (see `docs/configuration.md`, `docs/storage.md` and `.env.example`).

## Running tests

```bash
npm run build:engine   # the engine and summary tests use the server-side bundle
npm test
```

Tests use the built-in `node:test` runner. `tests/storage.test.mjs` starts a throwaway MinIO container when Docker
is available, so the S3 driver is tested against a real S3 implementation. Without Docker the tests fall back to an
in-process fake S3. To force the fake even when Docker is running:

```bash
BOARDS_TEST_MINIO=off npm test
```

Run a single file with `node --test tests/merge.test.mjs`.

Before opening a pull request, also run:

```bash
npm run lint   # tsc, node --check on every module, configuration docs up to date
```

If you add or change a configuration option in `server/config.mjs`, regenerate the table in
`docs/configuration.md` with `npm run docs:config` and commit the result. CI fails when it is out of date.

## Code style

- ES modules everywhere (`.mjs` on the server, TypeScript/TSX in `web/src`).
- No semicolons, single quotes, two-space indentation. Match the surrounding code.
- Comments explain *why*: the constraint, the trade-off, the bug that made the code look this way. Do not restate
  what the code does.
- Keep dependencies few. The server's runtime dependencies end up in the container image; discuss new ones in the
  pull request.

## Project layout

| Path | What lives there |
| --- | --- |
| `server/` | HTTP and WebSocket server: API, auth, live collaboration, board store, metrics, `boards` CLI commands |
| `server/storage/` | Storage drivers (`s3`, `fs`) and snapshot handling |
| `shared/` | Code used by both the server and the editor (links, checkpoints, templates, slop check) |
| `web/src/` | The editor: Excalidraw plus the boards UI (live cursors, comments, checkpoints, timer, ...) |
| `engine/` | Entry and DOM shim for the server-side Excalidraw bundle used to lay out and render boards |
| `scripts/` | Build scripts, the Excalidraw patches, config docs generator, syntax check |
| `tests/` | `node:test` suites and helpers (fake S3, MinIO launcher) |
| `deploy/` | Helm chart, kustomize base, Argo CD example |
| `skills/` | Agent skill: `SKILL.md` and the `scripts/boards` shell client |
| `docs/` | Configuration, storage, integration guides, design notes |

## The Excalidraw pin

`@excalidraw/excalidraw` is pinned to exactly **0.18.1**. `scripts/excalidraw-patches.mjs` patches the package's
minified production build by replacing exact byte sequences, and the build fails if a sequence is not found exactly
once. Dependabot is configured to never bump this package.

Upgrading Excalidraw therefore means:

1. bumping the exact version in `package.json`,
2. re-locating every patched sequence in the new build and updating `scripts/excalidraw-patches.mjs`,
3. updating `tests/excalidraw-patches.test.mjs`,
4. running the full test suite and checking the editor by hand on a large board.

Please open an issue before starting an upgrade.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat: ...`, `fix: ...`, `docs: ...`,
  `refactor: ...`, `test: ...`, `chore: ...`, `ci: ...`. Mark breaking changes with `!` or a `BREAKING CHANGE:`
  footer.
- Keep a pull request focused on one change. Add or update tests for behaviour changes.
- Add a line under `## [Unreleased]` in `CHANGELOG.md` for anything a user or operator would notice.
- CI (lint, tests, build, container image, Helm chart) must pass before a pull request is merged.

A Developer Certificate of Origin sign-off is not required.

## License

boards is licensed under the [Apache License 2.0](LICENSE). By submitting a contribution you agree that it is
licensed under the same license (inbound = outbound, as described in section 5 of the license).

## Code of conduct

This project follows the [Contributor Covenant](CODE_OF_CONDUCT.md). By participating you agree to uphold it.
