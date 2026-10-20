{{/* Chart name. */}}
{{- define "boards.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{/* Fully qualified app name, truncated to the 63 characters DNS names allow. */}}
{{- define "boards.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := default .Chart.Name .Values.nameOverride }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "boards.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "boards.labels" -}}
helm.sh/chart: {{ include "boards.chart" . }}
{{ include "boards.selectorLabels" . }}
app.kubernetes.io/version: {{ include "boards.imageTag" . | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "boards.selectorLabels" -}}
app.kubernetes.io/name: {{ include "boards.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "boards.serviceAccountName" -}}
{{- if .Values.serviceAccount.create }}
{{- default (include "boards.fullname" .) .Values.serviceAccount.name }}
{{- else }}
{{- default "default" .Values.serviceAccount.name }}
{{- end }}
{{- end }}

{{- define "boards.imageTag" -}}
{{- .Values.image.tag | default .Chart.AppVersion }}
{{- end }}

{{- define "boards.image" -}}
{{- printf "%s:%s" .Values.image.repository (include "boards.imageTag" .) }}
{{- end }}

{{/* The Secret the pod reads: the user's, or the one this chart creates. */}}
{{- define "boards.secretName" -}}
{{- default (include "boards.fullname" .) .Values.existingSecret }}
{{- end }}

{{/* True when the chart renders its own Secret. */}}
{{- define "boards.createSecret" -}}
{{- if not .Values.existingSecret }}true{{- end }}
{{- end }}

{{/* True when an API token is generated (token mode, no tokens given, no user Secret). */}}
{{- define "boards.generateApiToken" -}}
{{- if and (not .Values.existingSecret) (eq .Values.auth.mode "token") (empty .Values.auth.apiTokens) .Values.auth.generateApiToken }}true{{- end }}
{{- end }}

{{- define "boards.pvcName" -}}
{{- default (printf "%s-data" (include "boards.fullname" .)) .Values.persistence.existingClaim }}
{{- end }}

{{/* Deployment strategy: explicit value, else Recreate for fs + persistence (RWO), else a surge rollout. */}}
{{- define "boards.strategy" -}}
{{- if .Values.strategy }}
{{- toYaml .Values.strategy }}
{{- else }}
{{- /* One replica: two pods never overlap, so the result does not depend on the store's conditional writes. */}}
type: Recreate
{{- end }}
{{- end }}

{{/*
Fail early, at render time, on settings the app would reject at start-up. Mirrors loadConfig() in server/config.mjs.
*/}}
{{- define "boards.validate" -}}
{{- $v := .Values }}
{{- if not (has $v.storage.driver (list "s3" "fs")) }}
{{- fail (printf "storage.driver: %q — expected s3 or fs" $v.storage.driver) }}
{{- end }}
{{- if and (eq $v.storage.driver "s3") (not $v.storage.s3.bucket) }}
{{- fail "storage.s3.bucket is required with storage.driver=s3" }}
{{- end }}
{{- if and (eq $v.storage.driver "s3") (ne (empty $v.storage.s3.credentials.accessKeyId) (empty $v.storage.s3.credentials.secretAccessKey)) }}
{{- fail "storage.s3.credentials: set both accessKeyId and secretAccessKey, or neither (to use IRSA / the AWS default chain)" }}
{{- end }}
{{- if not (has $v.storage.s3.conditionalWrites (list "auto" "on" "off")) }}
{{- fail "storage.s3.conditionalWrites: expected auto, on or off" }}
{{- end }}
{{- if not (has $v.storage.snapshots.mode (list "auto" "bucket" "objects" "off")) }}
{{- fail "storage.snapshots.mode: expected auto, bucket, objects or off" }}
{{- end }}
{{- if not (has $v.auth.mode (list "token" "oidc" "proxy" "none")) }}
{{- fail (printf "auth.mode: %q — expected token, oidc, proxy or none" $v.auth.mode) }}
{{- end }}
{{- range $v.auth.apiTokens }}
{{- if lt (len (toString .)) 16 }}
{{- fail "auth.apiTokens: every token must be at least 16 characters (generate one with `openssl rand -hex 32`)" }}
{{- end }}
{{- end }}
{{- if and (eq $v.auth.mode "token") (empty $v.auth.apiTokens) (not $v.existingSecret) (not $v.auth.generateApiToken) }}
{{- fail "auth.mode=token needs auth.apiTokens, existingSecret with BOARDS_API_TOKENS, or auth.generateApiToken=true" }}
{{- end }}
{{- if eq $v.auth.mode "oidc" }}
{{- if not $v.auth.oidc.issuer }}{{ fail "auth.oidc.issuer is required with auth.mode=oidc" }}{{ end }}
{{- if not $v.auth.oidc.clientId }}{{ fail "auth.oidc.clientId is required with auth.mode=oidc" }}{{ end }}
{{- if and (not $v.auth.oidc.clientSecret) (not $v.existingSecret) }}
{{- fail "auth.oidc.clientSecret is required with auth.mode=oidc (or provide BOARDS_OIDC_CLIENT_SECRET in existingSecret)" }}
{{- end }}
{{- end }}
{{- if not (has (lower $v.auth.cookieSameSite) (list "lax" "strict" "none")) }}
{{- fail "auth.cookieSameSite: expected lax, strict or none" }}
{{- end }}
{{- if and (eq (lower $v.auth.cookieSameSite) "none") (not (hasPrefix "https://" $v.publicUrl)) }}
{{- fail "auth.cookieSameSite=none requires an https publicUrl (Secure cookies)" }}
{{- end }}
{{- if $v.ingress.enabled }}
{{- $_ := required "publicUrl is required when ingress.enabled is true, e.g. --set publicUrl=https://boards.example.com" $v.publicUrl }}
{{- end }}
{{- if and $v.publicUrl (not (regexMatch "^https?://[^/]+/?$" $v.publicUrl)) }}
{{- fail (printf "publicUrl: %q must be an origin (scheme + host[:port]) without a path; boards always lives under /b" $v.publicUrl) }}
{{- end }}
{{- range $v.features.disable }}
{{- if not (has . (list "live" "studio" "workboard" "snap" "motion")) }}
{{- fail (printf "features.disable: unknown feature %q (known: live, studio, workboard, snap, motion)" .) }}
{{- end }}
{{- end }}
{{- if and $v.serviceMonitor.enabled (not $v.metrics.enabled) }}
{{- fail "serviceMonitor.enabled requires metrics.enabled" }}
{{- end }}
{{- if and $v.metrics.enabled (eq (int $v.metrics.port) 8080) }}
{{- fail "metrics.port must differ from the HTTP port 8080" }}
{{- end }}
{{- end }}
