# boards Helm chart

Deploys [boards](https://github.com/ly-solutions/boards) — Excalidraw whiteboards that people draw and AI agents read as
text and edit through an API — on Kubernetes 1.25+.

## What it deploys

| Resource | When |
| --- | --- |
| Deployment (exactly 1 replica, non-root uid 1000, read-only root filesystem, `/tmp` as `emptyDir`) | always |
| Service: `http` 8080 (HTTP + WebSocket), `metrics` 9090 (`/metrics`) | always (`metrics` port when `metrics.enabled`) |
| ConfigMap with every non-secret `BOARDS_*` setting | always |
| Secret with tokens, session secret and credentials | unless `existingSecret` is set |
| ServiceAccount (annotate it for IRSA / workload identity) | `serviceAccount.create` |
| Ingress | `ingress.enabled` |
| PersistentVolumeClaim | `storage.driver=fs` and `persistence.enabled` (and no `existingClaim`) |
| ServiceMonitor (`monitoring.coreos.com/v1`) | `serviceMonitor.enabled` |
| NetworkPolicy (ingress to the two ports only) | `networkPolicy.enabled` |
| Test pod hitting `/healthz` (`helm test`) | `helm test` only |

Configuration is environment variables only; every value below maps to a `BOARDS_*` variable from
[`server/config.mjs`](../../../server/config.mjs). Anything the chart does not model can be set with `extraEnv`
(for example `BOARDS_FLUSH_DELAY_MS`, `BOARDS_SESSION_TTL`, `BOARDS_COOKIE_SECURE`).

The chart validates settings at render time the way the app does at start-up (storage driver, bucket, token length,
OIDC fields, `publicUrl` shape, `cookieSameSite=none` without https, unknown features), so a broken release fails on
`helm install` rather than in a crash-looping pod. `values.schema.json` catches typos in keys and enum values.

## Why one replica

Live board state (open boards, WebSocket rooms, pending writes) lives in process memory, so the Deployment is pinned
to `replicas: 1` and the chart offers no HPA or PodDisruptionBudget. Rollouts are still safe:

- With S3 (and `fs` without persistence) the strategy is `RollingUpdate` with `maxSurge: 1, maxUnavailable: 0`. For a
  few seconds two pods overlap; writes carry ETag preconditions (`If-Match`), so the pod that loses a race re-reads and
  merges instead of overwriting.
- With `storage.driver=fs` and persistence the strategy is `Recreate`: a ReadWriteOnce volume cannot be mounted by
  two pods. Expect a short gap during upgrades.
- On SIGTERM the pod flushes every dirty board before exiting (`terminationGracePeriodSeconds: 30`).

Override with `strategy` if you know better for your storage.

## Install

The chart lives in this repository (an OCI copy at `oci://ghcr.io/ly-solutions/charts/boards` is planned):

```bash
git clone https://github.com/ly-solutions/boards.git
helm install boards ./boards/deploy/helm/boards -n boards --create-namespace -f my-values.yaml
helm test boards -n boards
```

`publicUrl` must be the origin users type in the browser: it is used for links, OIDC redirects, cookie security and
the WebSocket origin check. Without an Ingress, leave it empty and use
`kubectl -n boards port-forward svc/boards 8080:8080`, then open <http://localhost:8080/b/>.

The default `storage.s3.bucket: boards` is a placeholder so the chart renders out of the box — point it at a real
bucket (or set `storage.s3.createBucket: true`).

### S3 on AWS with IRSA (no static keys)

```yaml
publicUrl: https://boards.example.com
storage:
  driver: s3
  s3:
    bucket: my-company-boards
    region: eu-central-1
serviceAccount:
  annotations:
    eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/boards
auth:
  apiTokens:
    - "<openssl rand -hex 32>"
ingress:
  enabled: true
  className: nginx
  annotations:
    nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"
    cert-manager.io/cluster-issuer: letsencrypt
  hosts:
    - host: boards.example.com
      paths: [{ path: /, pathType: Prefix }]
  tls:
    - secretName: boards-tls
      hosts: [boards.example.com]
```

The role needs, on the bucket ARN: `s3:ListBucket`, `s3:GetBucketVersioning`, `s3:ListBucketVersions`; on
`<bucket ARN>/*`: `s3:GetObject`, `s3:GetObjectVersion`, `s3:PutObject`, `s3:DeleteObject` (plus `s3:CreateBucket`
only with `createBucket: true`). Its trust policy must allow the ServiceAccount `system:serviceaccount:boards:boards`
(the ServiceAccount name is the release full name unless `serviceAccount.name` is set). EKS Pod Identity works the
same way without the annotation.

Turn on bucket versioning to get history for free (`storage.snapshots.mode: auto` picks it up); otherwise boards
writes its own snapshot objects.

### S3-compatible store (MinIO, Ceph, R2) with static keys

```yaml
publicUrl: https://boards.example.com
storage:
  s3:
    bucket: boards
    endpoint: http://minio.minio.svc:9000
    region: us-east-1
    forcePathStyle: true
    createBucket: true
    credentials:
      accessKeyId: boards
      secretAccessKey: "<secret key>"
```

The keys land in the chart Secret. To keep them out of values files, use `existingSecret` instead.

### Credentials from your own Secret (`existingSecret`)

Create the Secret with any tool (kubectl, External Secrets, Sealed Secrets, SOPS). All keys are optional; include
the ones your setup needs:

```bash
kubectl -n boards create secret generic boards-secrets \
  --from-literal=BOARDS_API_TOKENS="$(openssl rand -hex 32)" \
  --from-literal=BOARDS_SESSION_SECRET="$(openssl rand -hex 32)" \
  --from-literal=BOARDS_S3_ACCESS_KEY_ID=... \
  --from-literal=BOARDS_S3_SECRET_ACCESS_KEY=... \
  --from-literal=BOARDS_OIDC_CLIENT_SECRET=... \
  --from-literal=BOARDS_PROXY_SECRET=... \
  --from-literal=BOARDS_COMMENTS_WEBHOOK_SECRET=...
```

```yaml
existingSecret: boards-secrets
```

The pod loads it with `envFrom`, and the chart creates no Secret of its own. Include `BOARDS_SESSION_SECRET`, or
sessions reset on every restart. The chart cannot checksum a Secret it does not render, so restart the pod after
rotating it (`kubectl -n boards rollout restart deploy/boards`) or use a reloader.

### OpenID Connect sign-in

```yaml
publicUrl: https://boards.example.com
auth:
  mode: oidc
  oidc:
    issuer: https://id.example.com/realms/main
    clientId: boards
    clientSecret: "<client secret>"   # or BOARDS_OIDC_CLIENT_SECRET in existingSecret
    allowedDomains: [example.com]
    allowedGroups: [boards-users]
  apiTokens:                          # optional: agents still use bearer tokens
    - "<openssl rand -hex 32>"
```

Register the redirect URI `https://boards.example.com/b/auth/callback` with the provider.

### Behind an authenticating proxy (`auth.mode=proxy`)

```yaml
auth:
  mode: proxy
  proxy:
    trusted: [10.0.0.0/8]       # the proxy's pod/node CIDR
    secret: "<shared secret>"    # proxy sends it in x-boards-proxy-secret
    logoutUrl: /oauth2/sign_out
```

### Local folder on a PersistentVolumeClaim

```yaml
storage:
  driver: fs
  fs:
    dataDir: /data
persistence:
  enabled: true
  size: 10Gi
  storageClass: ""          # cluster default
  annotations:
    helm.sh/resource-policy: keep
```

Without `persistence.enabled` the folder is an `emptyDir` and boards disappear with the pod — fine for a try-out only.

### Ingress and WebSockets

The editor keeps a WebSocket open at `/b/<slug>/live`. ingress-nginx passes upgrades by default but closes idle
proxied connections after 60 s; raise `proxy-read-timeout`/`proxy-send-timeout` (examples above). Traefik, HAProxy
and Gateway-API controllers generally need nothing extra. If the WebSocket cannot get through, the editor falls back
to polling; `features.disable: [live]` makes that permanent. Keep the path `/` (the app redirects `/` to `/b/`), or
route only `/b` when sharing a host with other apps.

### Metrics

Prometheus metrics are served on a separate port (`metrics.port`, default 9090) so they never reach the public
Ingress. With the Prometheus Operator:

```yaml
serviceMonitor:
  enabled: true
  labels:
    release: kube-prometheus-stack
```

### NetworkPolicy

`networkPolicy.enabled: true` admits traffic only to the HTTP and metrics ports. Narrow the sources with
`networkPolicy.ingressFrom` (e.g. the ingress controller's namespace) and `networkPolicy.metricsFrom` (the monitoring
namespace). Egress is not restricted, since S3, the OIDC provider and the webhook usually live outside the cluster.

## Upgrading

- One replica: an upgrade replaces the pod. With S3 the new pod is started before the old one stops; with `fs` +
  persistence the old pod stops first.
- Generated values (the session secret and, in token mode, the API token) are read back from the existing Secret
  with `lookup` and kept. Tools that render without cluster access (Argo CD, `helm template | kubectl apply`) cannot
  do that and would regenerate them on every render — set `auth.sessionSecret`/`auth.apiTokens` or use
  `existingSecret` there.
- ConfigMap and Secret changes roll the pod automatically (`checksum/*` annotations).

## Values

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| image.repository | string | `"ghcr.io/ly-solutions/boards"` | Container image repository. |
| image.tag | string | `""` | Image tag. Defaults to the chart `appVersion`. |
| image.pullPolicy | string | `"IfNotPresent"` | Image pull policy. |
| imagePullSecrets | list | `[]` | Secrets for pulling the image from a private registry, e.g. `[{name: regcred}]`. |
| nameOverride | string | `""` | Override the chart name used in resource names. |
| fullnameOverride | string | `""` | Override the full resource name (default `<release>-boards`, or `<release>` when it already contains `boards`). |
| publicUrl | string | `""` | Public origin of the service as users reach it: scheme + host, no path (`BOARDS_PUBLIC_URL`), e.g. `https://boards.example.com`. Used in links, OIDC redirects, cookie security and the WebSocket origin check. Required when `ingress.enabled` is true. When empty the app assumes `http://localhost:8080`, which matches `kubectl port-forward svc/<name> 8080:8080`. |
| storage.driver | string | `"s3"` | Storage driver (`BOARDS_STORAGE`): `s3` (recommended) or `fs` (local folder; enable `persistence` too). |
| storage.s3.bucket | string | `"boards"` | Bucket name (`BOARDS_S3_BUCKET`). Required with `driver: s3`. The default is only a placeholder: set it to a bucket that exists, or set `createBucket: true`. |
| storage.s3.prefix | string | `""` | Key prefix inside the bucket, e.g. `team-a/` (`BOARDS_S3_PREFIX`). |
| storage.s3.endpoint | string | `""` | Endpoint for S3-compatible stores such as MinIO, Ceph or R2 (`BOARDS_S3_ENDPOINT`). Empty for AWS. |
| storage.s3.region | string | `""` | Region (`BOARDS_S3_REGION`). Empty = `$AWS_REGION`, else `us-east-1`. |
| storage.s3.forcePathStyle | bool | `false` | Use path-style URLs (`BOARDS_S3_FORCE_PATH_STYLE`); needed by MinIO and most self-hosted stores. |
| storage.s3.conditionalWrites | string | `"auto"` | `auto` probes whether the store honours `If-Match`/`If-None-Match` on PUT; `on` forces conditional writes; `off` always compares first (`BOARDS_S3_CONDITIONAL_WRITES`). |
| storage.s3.createBucket | bool | `false` | Create the bucket at start-up if it does not exist (`BOARDS_S3_CREATE_BUCKET`). |
| storage.s3.credentials.accessKeyId | string | `""` | Static access key id, stored in the chart Secret (`BOARDS_S3_ACCESS_KEY_ID`). Leave both keys empty to use IRSA / EKS Pod Identity / the AWS default credential chain, or put them in `existingSecret`. |
| storage.s3.credentials.secretAccessKey | string | `""` | Static secret access key, stored in the chart Secret (`BOARDS_S3_SECRET_ACCESS_KEY`). |
| storage.snapshots.mode | string | `"auto"` | Board history (`BOARDS_SNAPSHOTS`): `bucket` (bucket versioning), `objects` (immutable snapshot objects + manifest), `auto` (bucket when versioning is on, else objects), `off`. |
| storage.snapshots.intervalSeconds | int | `600` | `objects` mode: minimum seconds between two snapshots of a board (`BOARDS_SNAPSHOT_INTERVAL`). |
| storage.snapshots.keep | int | `500` | `objects` mode: snapshots kept per board; older ones are pruned (`BOARDS_SNAPSHOT_KEEP`). |
| storage.fs.dataDir | string | `"/data"` | `fs` driver: folder for boards inside the container (`BOARDS_DATA_DIR`). The data volume is mounted here. |
| persistence.enabled | bool | `false` | `fs` driver only: keep boards on a PersistentVolumeClaim. When false the folder is an `emptyDir` and every board is lost when the pod is replaced. |
| persistence.size | string | `"5Gi"` | Size of the claim. |
| persistence.storageClass | string | `""` | StorageClass of the claim. Empty = cluster default; `"-"` = no class (`storageClassName: ""`). |
| persistence.accessModes | list | `["ReadWriteOnce"]` | Access modes of the claim. |
| persistence.existingClaim | string | `""` | Use an existing claim instead of creating one. |
| persistence.annotations | object | `{}` | Annotations for the created claim, e.g. `helm.sh/resource-policy: keep`. |
| auth.mode | string | `"token"` | Who may sign in to the web UI (`BOARDS_AUTH`): `token` (paste an API token once; a session cookie follows), `oidc` (any OpenID Connect provider), `proxy` (trust identity headers from a reverse proxy), `none` (everyone is a signed-in user; local use only). |
| auth.apiTokens | list | `[]` | Bearer tokens for agents and integrations, joined into `BOARDS_API_TOKENS` in the chart Secret. Each must be at least 16 characters (`openssl rand -hex 32`). Works in every mode; required in `token` mode. |
| auth.generateApiToken | bool | `true` | In `token` mode with no `apiTokens` and no `existingSecret`, generate one token into the chart Secret and keep it across upgrades. `helm install` NOTES show how to read it. |
| auth.sessionSecret | string | `""` | HMAC key for session cookies (`BOARDS_SESSION_SECRET`). Empty = generate 48 random characters on install and reuse them on upgrades (looked up from the existing Secret). Set it explicitly under GitOps tools that render without cluster access (Argo CD), otherwise it changes on every sync. |
| auth.cookieSameSite | string | `"lax"` | `lax`, `strict` or `none` (`BOARDS_COOKIE_SAMESITE`). `none` only when the editor is embedded cross-site; requires an https `publicUrl`. |
| auth.oidc.issuer | string | `""` | OIDC issuer URL (`BOARDS_OIDC_ISSUER`). Required with `mode: oidc`. |
| auth.oidc.clientId | string | `""` | OIDC client id (`BOARDS_OIDC_CLIENT_ID`). Register the redirect URI `<publicUrl>/b/auth/callback`. |
| auth.oidc.clientSecret | string | `""` | OIDC client secret, stored in the chart Secret (`BOARDS_OIDC_CLIENT_SECRET`). Required with `mode: oidc` unless it comes from `existingSecret`. |
| auth.oidc.scopes | string | `"openid email profile"` | Requested scopes (`BOARDS_OIDC_SCOPES`). |
| auth.oidc.allowedDomains | list | `[]` | Only allow these e-mail domains (`BOARDS_OIDC_ALLOWED_DOMAINS`). Empty = anyone the provider authenticates. |
| auth.oidc.groupsClaim | string | `"groups"` | Claim holding group membership (`BOARDS_OIDC_GROUPS_CLAIM`). |
| auth.oidc.allowedGroups | list | `[]` | Only allow members of these groups (`BOARDS_OIDC_ALLOWED_GROUPS`). Empty = no group check. |
| auth.proxy.userHeader | string | `"x-forwarded-user"` | Header with the user id (`BOARDS_PROXY_USER_HEADER`). |
| auth.proxy.emailHeader | string | `"x-forwarded-email"` | Header with the e-mail (`BOARDS_PROXY_EMAIL_HEADER`). |
| auth.proxy.nameHeader | string | `"x-forwarded-preferred-username"` | Header with a display name (`BOARDS_PROXY_NAME_HEADER`). |
| auth.proxy.trusted | list | `[]` | IPs/CIDRs allowed to set identity headers (`BOARDS_PROXY_TRUSTED`). Empty = app default (`127.0.0.1/32,::1/128`, i.e. a sidecar proxy). For an in-cluster proxy list the pod CIDR or the proxy pods. |
| auth.proxy.secret | string | `""` | Optional shared secret the proxy must send in `x-boards-proxy-secret`, stored in the chart Secret (`BOARDS_PROXY_SECRET`). |
| auth.proxy.logoutUrl | string | `""` | Where "Sign out" goes, e.g. `/oauth2/sign_out` (`BOARDS_PROXY_LOGOUT_URL`). |
| existingSecret | string | `""` | Name of a user-managed Secret loaded with `envFrom`. When set, the chart creates no Secret and ignores the secret values above (`auth.apiTokens`, `auth.sessionSecret`, `storage.s3.credentials.*`, `auth.oidc.clientSecret`, `auth.proxy.secret`, `webhook.secret`). Recognised keys, all optional: `BOARDS_API_TOKENS`, `BOARDS_SESSION_SECRET`, `BOARDS_S3_ACCESS_KEY_ID`, `BOARDS_S3_SECRET_ACCESS_KEY`, `BOARDS_OIDC_CLIENT_SECRET`, `BOARDS_PROXY_SECRET`, `BOARDS_COMMENTS_WEBHOOK_SECRET`. |
| integration.frameAncestors | string | `""` | CSP `frame-ancestors` for the editor (`BOARDS_FRAME_ANCESTORS`), e.g. `'self' https://workspace.example.com`. Empty = app default `'self'`. |
| integration.corsOrigins | list | `[]` | Origins allowed to call the JSON/text API from a browser (`BOARDS_CORS_ORIGINS`). |
| integration.handoffTtl | int | `120` | Lifetime in seconds of hand-off links minted by `POST /b/api/handoff` (`BOARDS_HANDOFF_TTL`). |
| webhook.url | string | `""` | POST comment events (`thread.created`, `thread.replied`, ...) here (`BOARDS_COMMENTS_WEBHOOK_URL`). |
| webhook.secret | string | `""` | Sent as `x-boards-webhook-secret` with every webhook call; stored in the chart Secret (`BOARDS_COMMENTS_WEBHOOK_SECRET`). |
| features.disable | list | `[]` | Editor features to switch off (`BOARDS_DISABLE_FEATURES`): `live`, `studio`, `workboard`, `snap`, `motion`. |
| metrics.enabled | bool | `true` | Serve Prometheus metrics on a separate port. When false `BOARDS_METRICS_PORT=0`. |
| metrics.port | int | `9090` | Metrics port inside the pod and on the Service (`BOARDS_METRICS_PORT`); path `/metrics`. |
| extraEnv | list | `[]` | Extra environment variables (list of EnvVar). They win over everything the chart sets, e.g. `[{name: BOARDS_FLUSH_DELAY_MS, value: "5000"}]`. |
| extraEnvFrom | list | `[]` | Extra `envFrom` sources (list of EnvFromSource), e.g. `[{secretRef: {name: other}}]`. |
| extraVolumes | list | `[]` | Extra volumes for the pod, e.g. a custom CA bundle. |
| extraVolumeMounts | list | `[]` | Extra volume mounts for the container. |
| serviceAccount.create | bool | `true` | Create a ServiceAccount. |
| serviceAccount.annotations | object | `{}` | Annotations for the ServiceAccount. For S3 on EKS with IRSA: `eks.amazonaws.com/role-arn: arn:aws:iam::123456789012:role/boards`. (EKS Pod Identity needs no annotation; GKE Workload Identity uses `iam.gke.io/gcp-service-account`.) |
| serviceAccount.name | string | `""` | Name of the ServiceAccount. Empty = the full name when `create` is true, else `default`. |
| serviceAccount.automount | bool | `false` | Mount the Kubernetes API token into the pod. boards never talks to the API server; IRSA and Pod Identity inject their own token regardless. |
| podAnnotations | object | `{}` | Annotations for the pod. |
| podLabels | object | `{}` | Extra labels for the pod. |
| resources | object | `{"requests":{"cpu":"100m","memory":"256Mi"},"limits":{"memory":"1Gi"}}` | Container resources. Boards are held in memory while open, so size the memory limit to your largest boards. |
| nodeSelector | object | `{}` | Node selector for the pod. |
| tolerations | list | `[]` | Tolerations for the pod. |
| affinity | object | `{}` | Affinity for the pod. |
| topologySpreadConstraints | list | `[]` | Topology spread constraints for the pod. |
| priorityClassName | string | `""` | Priority class of the pod. |
| strategy | object | `{}` | Deployment strategy. Empty = `RollingUpdate` with `maxSurge: 1, maxUnavailable: 0` (safe: writes use ETag preconditions and the loser merges), except `Recreate` for `storage.driver: fs` with persistence, where a ReadWriteOnce volume cannot be mounted by two pods. |
| terminationGracePeriodSeconds | int | `30` | Seconds the pod gets to flush boards to storage after SIGTERM. |
| podSecurityContext | object | `{"runAsNonRoot":true,"runAsUser":1000,"runAsGroup":1000,"fsGroup":1000,"seccompProfile":{"type":"RuntimeDefault"}}` | Pod security context. |
| securityContext | object | `{"allowPrivilegeEscalation":false,"readOnlyRootFilesystem":true,"capabilities":{"drop":["ALL"]}}` | Container security context. The root filesystem is read-only; `/tmp` is an `emptyDir`. |
| livenessProbe | object | `{"httpGet":{"path":"/healthz","port":"http"},"periodSeconds":10,"timeoutSeconds":3,"failureThreshold":3}` | Liveness probe (process is up). |
| readinessProbe | object | `{"httpGet":{"path":"/readyz","port":"http"},"periodSeconds":10,"timeoutSeconds":5,"failureThreshold":3}` | Readiness probe (storage is reachable). |
| startupProbe | object | `{"httpGet":{"path":"/healthz","port":"http"},"periodSeconds":2,"timeoutSeconds":3,"failureThreshold":30}` | Startup probe; liveness and readiness start after it succeeds (up to 60 s). |
| service.type | string | `"ClusterIP"` | Service type. |
| service.port | int | `8080` | Service port for HTTP and WebSocket traffic (the container listens on 8080). |
| service.annotations | object | `{}` | Annotations for the Service. |
| ingress.enabled | bool | `false` | Expose boards through an Ingress. Requires `publicUrl`. WebSocket upgrades must pass through (ingress-nginx does this by default) and idle live connections need a read timeout of at least 60 s. |
| ingress.className | string | `""` | IngressClass name, e.g. `nginx`. |
| ingress.annotations | object | `{}` | Annotations for the Ingress. Examples: ingress-nginx: `nginx.ingress.kubernetes.io/proxy-read-timeout: "3600"`, `nginx.ingress.kubernetes.io/proxy-send-timeout: "3600"`, `nginx.ingress.kubernetes.io/proxy-body-size: "16m"`; cert-manager: `cert-manager.io/cluster-issuer: letsencrypt`; Traefik and most other controllers pass WebSockets without extra settings. |
| ingress.hosts | list | `[{"host":"boards.example.com","paths":[{"path":"/","pathType":"Prefix"}]}]` | Hosts and paths. Keep path `/` (the app redirects `/` to `/b/`), or `/b` to share a host with other apps. |
| ingress.tls | list | `[]` | TLS, e.g. `[{secretName: boards-tls, hosts: [boards.example.com]}]`. |
| serviceMonitor.enabled | bool | `false` | Create a Prometheus Operator ServiceMonitor (`monitoring.coreos.com/v1`). Needs `metrics.enabled`. |
| serviceMonitor.interval | string | `"30s"` | Scrape interval. |
| serviceMonitor.scrapeTimeout | string | `""` | Scrape timeout. Empty = Prometheus default. |
| serviceMonitor.labels | object | `{}` | Extra labels so your Prometheus selects the ServiceMonitor, e.g. `release: kube-prometheus-stack`. |
| networkPolicy.enabled | bool | `false` | Create a NetworkPolicy that only admits traffic to the HTTP and metrics ports. Egress is not restricted (S3, the OIDC provider and the webhook are usually outside the cluster). |
| networkPolicy.ingressFrom | list | `[]` | Peers (NetworkPolicyPeer list) allowed to reach the HTTP port, e.g. the ingress controller namespace. Empty = any source. The chart's own `helm test` pod is always allowed. |
| networkPolicy.metricsFrom | list | `[]` | Peers allowed to reach the metrics port, e.g. the monitoring namespace. Empty = any source. |
