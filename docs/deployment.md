# Running boards

boards is one Node 22 process (HTTP + WebSocket on `PORT`, metrics on `BOARDS_METRICS_PORT`) plus storage: an S3
bucket or a local folder. Pick whichever fits; all of them use the same [configuration](configuration.md).

| Way | Storage | Good for | Verified for 0.1.0 |
| --- | --- | --- | --- |
| [docker compose](#docker-compose) | MinIO (S3) | trying it, a small team on one VM | `docker compose up`, board round trip, restart, bucket versioning |
| [Docker image](#docker) | S3 or a volume | any container platform | image build, hadolint |
| [From source](#from-source) | fs or S3 | development, a VM without containers | fs and S3 round trips |
| [Helm](#kubernetes-helm) | S3 (IRSA, static keys, existing Secret) or PVC | Kubernetes | `helm lint --strict`, `helm template` |
| [Argo CD](#argo-cd) | as Helm | GitOps | manifest renders with the chart |
| [kustomize](#kustomize) | S3 | Kubernetes without Helm | `kubectl kustomize` |

Run a **single replica** everywhere — see [storage.md](storage.md#concurrency) for why rollouts are still safe.

## docker compose

```sh
git clone https://github.com/ly-solutions/boards.git && cd boards
docker compose up            # → http://localhost:8080
```

[`compose.yaml`](../compose.yaml) starts MinIO and boards; boards creates the bucket on start. Out of the box auth is
off and ports are bound to 127.0.0.1 — a local playground. For a shared instance copy `.env.example` to `.env`, set
`BOARDS_AUTH=token`, `BOARDS_API_TOKENS`, `BOARDS_SESSION_SECRET`, `BOARDS_PUBLIC_URL`, `BOARDS_BIND=0.0.0.0` and
put TLS in front. The upstream `minio/minio` image is no longer published on Docker Hub, so the file uses a
maintained community build; set `MINIO_IMAGE` to use another S3-compatible server (or point boards at real S3 and
drop the `minio` service).

## Docker

```sh
docker run -d --name boards -p 8080:8080 \
  -e BOARDS_PUBLIC_URL=https://boards.example.com \
  -e BOARDS_API_TOKENS=$(openssl rand -hex 32) -e BOARDS_SESSION_SECRET=$(openssl rand -hex 32) \
  -e BOARDS_S3_BUCKET=acme-boards -e BOARDS_S3_REGION=eu-central-1 \
  -e AWS_ACCESS_KEY_ID=… -e AWS_SECRET_ACCESS_KEY=… \
  ghcr.io/ly-solutions/boards:0.1.0

# or with a local folder
docker run -d -p 127.0.0.1:8080:8080 -v boards-data:/data -e BOARDS_AUTH=none -e BOARDS_STORAGE=fs \
  ghcr.io/ly-solutions/boards:0.1.0
```

The image is multi-stage (build in Debian, run on Alpine), runs as uid 1000, has a `HEALTHCHECK` on `/healthz`,
exposes 8080 and 9090, keeps fs data in `/data` and works with a read-only root filesystem. Entry point:
`boards` (`serve` by default; `docker run … ghcr.io/ly-solutions/boards config` prints the variables).

## From source

```sh
npm ci
npm run build                 # editor (Vite) + server-side Excalidraw bundle (esbuild)
BOARDS_AUTH=none BOARDS_STORAGE=fs BOARDS_DATA_DIR=./data node bin/boards.mjs serve
# or: npm run dev             # same, data in .data/
```

Node 22 or newer. For systemd, run `node /opt/boards/bin/boards.mjs serve` with an `EnvironmentFile=` holding the
configuration and `KillSignal=SIGTERM` (boards flushes on SIGTERM).

## Kubernetes (Helm)

```sh
helm install boards ./deploy/helm/boards -n boards --create-namespace \
  --set publicUrl=https://boards.example.com \
  --set storage.s3.bucket=acme-boards --set storage.s3.region=eu-central-1 \
  --set serviceAccount.annotations."eks\.amazonaws\.com/role-arn"=arn:aws:iam::123456789012:role/boards \
  --set ingress.enabled=true --set ingress.className=nginx --set ingress.hosts[0].host=boards.example.com
```

The chart README ([deploy/helm/boards](../deploy/helm/boards/README.md)) has examples for IRSA, MinIO with static
keys, `existingSecret`, OIDC and fs + PVC, and the full values table. It renders the security context
(non-root, read-only root FS, no capabilities), probes, optional ServiceMonitor and NetworkPolicy.

## Argo CD

[`deploy/argocd/application.yaml`](../deploy/argocd/application.yaml) is a plain `Application` pointing at the chart
in this repository with an S3 + OIDC example. Generated secrets do not survive Argo CD syncs (it renders without
cluster access), so the example uses `existingSecret`.

## kustomize

[`deploy/kustomize/base`](../deploy/kustomize) — Deployment, Service and ServiceAccount; add a Secret with your
`BOARDS_*` values and an Ingress in an overlay.

## Operations

- **Probes**: `/healthz` (process up), `/readyz` (storage reachable; cached 5 s).
- **Metrics**: `GET :9090/metrics` — `boards_http_requests_total{route,method,status}`,
  `boards_http_request_duration_seconds`, `boards_live_sockets`, `boards_loaded`, `boards_storage_errors_total`,
  `process_resident_memory_bytes`.
- **Logs**: one JSON object per line on stdout (`listening`, `flushed`, `flush_conflict_merged`, `snapshot_mode`,
  `s3_conditional_writes`, errors with `level: error`). Board keys are redacted from logged URLs.
- **Backups**: the bucket (or folder) is the only state. Enable bucket versioning and a lifecycle rule, or copy the
  prefix with any S3 tool.
- **Memory**: roughly the size of the boards open in the last hours; 256 Mi requests / 1 Gi limit suit a team.
