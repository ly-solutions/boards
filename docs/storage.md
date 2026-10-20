# Storage

boards keeps live board state in memory and writes each board to storage a few seconds after the last edit
(`BOARDS_FLUSH_DELAY_MS`, at least every `BOARDS_FLUSH_MAX_MS` during continuous work) and on shutdown. Storage is
a small driver interface ([`server/storage/objects.mjs`](../server/storage/objects.mjs)) with two drivers:

| Driver | Use | Concurrency | History |
| --- | --- | --- | --- |
| `s3` (default when `BOARDS_S3_BUCKET` is set) | production; AWS S3 and any S3-compatible store | ETag preconditions (`If-Match` / `If-None-Match: *`), probed, with a compare-then-write fallback | bucket versioning or snapshot objects |
| `fs` | development, docker compose, a single VM | atomic writes (temp file + rename), per-key locks in the process | snapshot objects |

## Layout

Both drivers store the same files under the same keys, so a board can be copied between drivers, buckets or
machines with any tool (`aws s3 sync`, `rclone`, `cp -r`):

```
<prefix>boards/<slug>/scene.excalidraw              Excalidraw scene (open it in excalidraw.com or VS Code)
<prefix>boards/<slug>/meta.yaml                     title, author, access, key, tags, counters
<prefix>boards/<slug>/board.md                      the board as text — what agents read; greppable
<prefix>boards/<slug>/preview.svg                   thumbnail, rendered by a browser
<prefix>boards/<slug>/notes.json                    reactions and comment threads
<prefix>boards/<slug>/checkpoints.json              named checkpoints …
<prefix>boards/<slug>/checkpoints/<id>.excalidraw   … and their scenes
<prefix>boards/<slug>/snapshots/<ts>.excalidraw     automatic history (immutable)
<prefix>boards/<slug>/snapshots/index.json          snapshot manifest
```

A board exists when its `meta.yaml` exists. `<prefix>` is `BOARDS_S3_PREFIX` (S3 only), so several instances can
share a bucket.

## Concurrency

Run **one replica**. A board's live state (open sockets, merged edits) must exist once.

Inside the process, writes are serialised: every object key is written by one request at a time, a board's scene
flushes run one after another, and so do its checkpoints and its snapshot manifest. No two requests for the same
object ever reach the store at once, whatever the store does with preconditions.

Between processes, safety rests on the store's conditional writes. When two processes write one board (a second
replica by mistake, the overlap of a rolling update, a person editing the bucket), each writes `scene.excalidraw`
with `If-Match: <the ETag it read>`. The loser gets a precondition failure, re-reads the winner's scene, merges
element by element (higher `version` wins, then lower `versionNonce` — the same rule Excalidraw uses) and writes
again. Hard kills lose at most the last few seconds on the server, and open browsers resend their scene when they
notice the new server epoch.

### Stores whose preconditions are not atomic

S3-compatible stores differ in their support for conditional writes. Some reject `If-Match` / `If-None-Match`, some
silently ignore them, and some check them correctly one request at a time but not when requests for one key overlap.
The last kind was seen on Selectel ru-3 in 2026: 8 parallel `If-None-Match: *` creates of one key gave 7 or 8
successes, and 8 parallel `If-Match` replaces with the same ETag all succeeded. A sequential test passes on such a
store, so it looks fine until two writers actually race.

With `BOARDS_S3_CONDITIONAL_WRITES=auto` the driver probes once, at the first conditional write, with overlapping
requests: 8 parallel creates of a fresh `.boards-probe/…` key, then 8 parallel replaces conditional on the same ETag.
Each phase must let exactly one write through. Only then does it use the store's preconditions (`native`); otherwise
it compares ETags itself before writing (`emulated`). The verdict is logged once with the counts:

```json
{"event":"s3_conditional_writes","mode":"native","create":"1/8","replace":"1/8"}
{"level":"warn","event":"s3_conditional_writes","mode":"emulated","create":"8/8","note":"the store does not enforce If-Match / If-None-Match atomically under concurrency; …"}
```

Force either mode with `on` / `off`. Neither mode makes two processes safe on a store whose preconditions are not
atomic, so on such a store (or whenever the probe says `emulated`) run exactly one process and roll it out with
`Recreate`, never with an overlapping rolling update. That is the Helm chart's and the kustomize base's default.
On a store where the probe says `native` (AWS S3, MinIO) an overlapping rolling update is safe and avoids the few
seconds of downtime.

Tested against MinIO, against an in-process fake with AWS semantics, and against fakes that ignore or reject the
headers or check them non-atomically.

## Stores with slow reads

Some stores start sending an object only after seconds while HEAD and listings stay fast. One example is Selectel
ru-3, measured in 2026 at 3–4 s to the first byte of every GET whatever the size, against 0.1–0.3 s for HEAD and
LIST (range requests and other GET variants do not help). The s3 driver therefore keeps a read cache in memory
(`BOARDS_CACHE_MB`, 128 MiB by default, `0` turns it off):

- snapshot and checkpoint scenes and bucket object versions never change, so they are served from memory without
  asking the store;
- the scene, `meta.yaml`, `notes.json`, the thumbnail and the manifests are revalidated with a HEAD and served from
  memory while the ETag is unchanged, so an edit made by another process or by hand is still picked up;
- writes through the process fill the cache; a failed write (a lost conditional write included) and a delete drop
  the entry;
- the budget is in bytes, least recently used objects go first, and an object larger than an eighth of the budget
  is never cached.

Opening a board takes one round of parallel requests: GETs of `meta.yaml`, `scene.excalidraw` and `notes.json`, and
a HEAD for `preview.svg`, whose body is read only when someone asks for the thumbnail. On a slow store a cold open
therefore costs one GET latency, and an open from the cache costs one HEAD latency. Once open, a board lives in
memory and is not read again.

After a restart the cache is empty. With `BOARDS_CACHE_WARM=on` (the default when the cache is on) the server reads
every `meta.yaml` in the background after start, then scenes, notes and thumbnails, newest boards first, 16 at a
time, until 90 % of the budget is used; readiness does not wait for it. Measured on Selectel ru-3 with 42 boards
(24 MB): a cold open took 3.5–4 s, an open from the cache 0.12–0.35 s, and the warm-up about a minute.

## History

| `BOARDS_SNAPSHOTS` | Behaviour |
| --- | --- |
| `auto` (default) | `bucket` when the bucket reports versioning `Enabled`, otherwise `objects` |
| `bucket` | every write of `scene.excalidraw` is an S3 object version; history lists versions (ids `v-<versionId>`); retention via lifecycle rules |
| `objects` | at most once per `BOARDS_SNAPSHOT_INTERVAL` (600 s) the scene is also written to `snapshots/<ts>.excalidraw` (ids like `20261019T120000123Z`) and listed in `snapshots/index.json`; older than `BOARDS_SNAPSHOT_KEEP` (500) are pruned |
| `off` | no automatic history (checkpoints still work) |

Snapshot objects are written with `If-None-Match: *` and never modified. If the manifest is lost it is rebuilt from
the object listing. History is exposed at `GET /b/<slug>/history`, `GET /b/<slug>/history/<id>` and
`POST /b/<slug>/history/<id>/restore` — a restore is applied as a new edit (it bumps element versions), so it merges
with open browsers and can itself be undone.

Checkpoints are different: they are named by people ("Week of Oct 5"), diffable, and copyable into a new board.

## Credentials and permissions

Static keys (`BOARDS_S3_ACCESS_KEY_ID` / `BOARDS_S3_SECRET_ACCESS_KEY`) or the standard AWS chain: `AWS_*`
environment variables, web identity (EKS IRSA, `AWS_ROLE_ARN` + `AWS_WEB_IDENTITY_TOKEN_FILE`), ECS task roles, EC2
instance metadata, shared profiles. Minimal IAM policy for the bucket (`arn:aws:s3:::BUCKET` and `…/PREFIX*`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    { "Effect": "Allow", "Action": ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketVersioning"], "Resource": "arn:aws:s3:::BUCKET" },
    { "Effect": "Allow", "Action": ["s3:GetObject", "s3:GetObjectVersion", "s3:PutObject", "s3:DeleteObject"], "Resource": "arn:aws:s3:::BUCKET/*" }
  ]
}
```

Add `s3:CreateBucket` only if you use `BOARDS_S3_CREATE_BUCKET=true`. `DeleteObject` is used for pruning snapshots
and removing the conditional-write probe object (`.boards-probe/…`).

## Migrating from git

Earlier versions of this project stored boards in a git repository — one commit per save, `boards/<slug>/` folders.
`boards migrate` copies such a repository into any storage, turning every commit of a board's scene into a history
snapshot (with the commit id and author in the manifest) and the files at the chosen ref into the live board:

```sh
# from a local clone into S3 (credentials from BOARDS_S3_* or the AWS chain)
node bin/boards.mjs migrate --from-git ./artifacts --to s3://acme-boards/prod \
  --endpoint https://s3.example.net --path-style --create-bucket

# into a local folder (fs driver layout)
node bin/boards.mjs migrate --from-git ./artifacts --to ./data

# options: --ref main  --path boards  --only slug-a,slug-b  --overwrite  --dry-run
```

Boards that already exist in the target are skipped (use `--overwrite` to replace them) and snapshots already
imported are not duplicated, so the command is safe to re-run. It prints a JSON report and exits non-zero if any
board failed. The container image does not ship `git`; run the migration from a checkout of this repository (Node 22
+ git), or in a one-off container with git installed.
