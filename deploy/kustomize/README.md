# Kustomize

[`base/`](base) is a minimal Helm-free deployment: ServiceAccount, Service (`http` 8080, `metrics` 9090) and a
single-replica Deployment with the same security settings and probes as the [Helm chart](../helm/boards). Settings
are plain `BOARDS_*` env vars in `base/deployment.yaml`; secrets are read from a Secret named `boards-secrets`, which
the base does not create. For Ingress, ServiceMonitor, NetworkPolicy, PVC or validated values, use the Helm chart.

```bash
kubectl kustomize deploy/kustomize/base   # inspect
```

Typical overlay (`overlays/prod/kustomization.yaml`):

```yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
namespace: boards
resources:
  - https://github.com/ly-solutions/boards//deploy/kustomize/base?ref=v0.1.0
  - ingress.yaml                  # your Ingress to service boards:8080
secretGenerator:
  - name: boards-secrets
    envs: [secrets.env]           # untracked: BOARDS_API_TOKENS=..., BOARDS_SESSION_SECRET=...
    options:
      disableNameSuffixHash: true
patches:
  - target: { kind: Deployment, name: boards }
    patch: |-
      - op: replace
        path: /spec/template/spec/containers/0/env
        value:
          - { name: BOARDS_PUBLIC_URL, value: https://boards.example.com }
          - { name: BOARDS_STORAGE, value: s3 }
          - { name: BOARDS_S3_BUCKET, value: my-company-boards }
          - { name: BOARDS_S3_REGION, value: eu-central-1 }
          - { name: BOARDS_AUTH, value: token }
          - { name: BOARDS_METRICS_PORT, value: "9090" }
```

Keep `replicas: 1`: live board state is in process memory. The base uses `strategy: Recreate`, so two pods never
write at once; see [storage.md](../../docs/storage.md#concurrency) for when a rolling update is safe. For
`BOARDS_STORAGE=fs`, mount a PVC at `BOARDS_DATA_DIR` and keep `Recreate`.
