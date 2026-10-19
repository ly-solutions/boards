/**
 * Configuration: environment variables only, one place, validated at start-up.
 *
 * `OPTIONS` is the single source of truth — `npm run docs:config` renders it into docs/configuration.md, so the
 * reference never drifts from the code.
 */

const list = (raw) =>
  String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

const bool = (raw, fallback = false) => {
  if (raw === undefined || raw === null || raw === '') return fallback
  return /^(1|true|yes|on)$/i.test(String(raw).trim())
}

const int = (raw, fallback) => {
  if (raw === undefined || raw === null || raw === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`expected a number, got "${raw}"`)
  return n
}

/** [env, default, description, group] */
export const OPTIONS = [
  ['PORT', '8080', 'HTTP port.', 'Server'],
  ['BOARDS_HOST', '0.0.0.0', 'Interface to bind.', 'Server'],
  ['BOARDS_PUBLIC_URL', 'http://localhost:$PORT', 'Public origin of the service as users reach it (scheme + host, no path). Used in links, OIDC redirects, cookie security and the WebSocket origin check.', 'Server'],
  ['BOARDS_METRICS_PORT', '9090', 'Port for Prometheus metrics (`/metrics`), kept off the public port. `0` disables.', 'Server'],
  ['BOARDS_DISABLE_FEATURES', '', 'Comma-separated editor features to switch off: `live` (WebSocket collaboration, falls back to polling), `studio` (stickies, palette, templates, slop check), `workboard` (checkpoints, timer, link cards), `snap`, `motion`.', 'Server'],
  ['BOARDS_FLUSH_DELAY_MS', '8000', 'Quiet time after the last edit before a board is written to storage.', 'Server'],
  ['BOARDS_FLUSH_MAX_MS', '90000', 'Upper bound on how long continuous editing may delay a write.', 'Server'],

  ['BOARDS_STORAGE', 's3 if BOARDS_S3_BUCKET is set, else fs', 'Storage driver: `s3` (production) or `fs` (local folder).', 'Storage'],
  ['BOARDS_DATA_DIR', './data', '`fs` driver: folder for boards.', 'Storage'],
  ['BOARDS_S3_BUCKET', '', '`s3` driver: bucket name.', 'Storage'],
  ['BOARDS_S3_PREFIX', '', 'Key prefix inside the bucket, e.g. `team-a/`.', 'Storage'],
  ['BOARDS_S3_ENDPOINT', '', 'Endpoint for S3-compatible stores (MinIO, Ceph, R2, …). Empty for AWS.', 'Storage'],
  ['BOARDS_S3_REGION', '$AWS_REGION or us-east-1', 'Region.', 'Storage'],
  ['BOARDS_S3_FORCE_PATH_STYLE', 'false', 'Use path-style URLs (`endpoint/bucket/key`); needed by MinIO and most self-hosted stores.', 'Storage'],
  ['BOARDS_S3_ACCESS_KEY_ID', '', 'Static credentials. Leave empty to use the AWS default chain: `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, web identity (EKS IRSA), ECS/EC2 roles, profiles.', 'Storage'],
  ['BOARDS_S3_SECRET_ACCESS_KEY', '', 'Static credentials (see above).', 'Storage'],
  ['BOARDS_S3_CONDITIONAL_WRITES', 'auto', '`auto` probes whether the store honours `If-Match`/`If-None-Match` on PUT and falls back to compare-then-write; `on` forces conditional writes; `off` always compares first.', 'Storage'],
  ['BOARDS_S3_CREATE_BUCKET', 'false', 'Create the bucket at start-up if it does not exist (handy for compose and tests).', 'Storage'],
  ['BOARDS_SNAPSHOTS', 'auto', 'History: `bucket` (rely on bucket versioning), `objects` (immutable `snapshots/<ts>.excalidraw` objects + manifest), `auto` (bucket when versioning is enabled, else objects), `off`.', 'Storage'],
  ['BOARDS_SNAPSHOT_INTERVAL', '600', '`objects` mode: minimum seconds between two snapshots of a board.', 'Storage'],
  ['BOARDS_SNAPSHOT_KEEP', '500', '`objects` mode: snapshots kept per board; older ones are pruned.', 'Storage'],

  ['BOARDS_AUTH', 'token', 'Who may sign in to the web UI: `token` (paste an API token once; a session cookie follows), `oidc` (any OpenID Connect provider), `proxy` (trust identity headers from a reverse proxy), `none` (everyone is a signed-in user — local use only).', 'Auth'],
  ['BOARDS_API_TOKENS', '', 'Comma-separated bearer tokens for agents and integrations. Required in `token` mode. Works in every mode.', 'Auth'],
  ['BOARDS_SESSION_SECRET', 'random per process', 'HMAC key for session cookies. Set it (32+ random bytes) so sessions survive restarts and replicas agree.', 'Auth'],
  ['BOARDS_SESSION_TTL', '2592000', 'Session lifetime in seconds (30 days).', 'Auth'],
  ['BOARDS_COOKIE_SECURE', 'auto', '`Secure` cookies: `auto` = when BOARDS_PUBLIC_URL is https.', 'Auth'],
  ['BOARDS_COOKIE_SAMESITE', 'lax', '`lax`, `strict` or `none`. Use `none` only when the editor is embedded cross-site (requires https).', 'Auth'],
  ['BOARDS_OIDC_ISSUER', '', 'OIDC issuer URL (discovery at `<issuer>/.well-known/openid-configuration`).', 'Auth'],
  ['BOARDS_OIDC_CLIENT_ID', '', 'OIDC client id. Redirect URI to register: `<BOARDS_PUBLIC_URL>/b/auth/callback`.', 'Auth'],
  ['BOARDS_OIDC_CLIENT_SECRET', '', 'OIDC client secret (confidential client; PKCE is used as well).', 'Auth'],
  ['BOARDS_OIDC_SCOPES', 'openid email profile', 'Requested scopes.', 'Auth'],
  ['BOARDS_OIDC_ALLOWED_DOMAINS', '', 'Only allow these e-mail domains (comma-separated). Empty = anyone the provider authenticates.', 'Auth'],
  ['BOARDS_OIDC_GROUPS_CLAIM', 'groups', 'Claim holding group membership.', 'Auth'],
  ['BOARDS_OIDC_ALLOWED_GROUPS', '', 'Only allow members of these groups (comma-separated). Empty = no group check.', 'Auth'],
  ['BOARDS_PROXY_USER_HEADER', 'x-forwarded-user', '`proxy` mode: header with the user id.', 'Auth'],
  ['BOARDS_PROXY_EMAIL_HEADER', 'x-forwarded-email', '`proxy` mode: header with the e-mail.', 'Auth'],
  ['BOARDS_PROXY_NAME_HEADER', 'x-forwarded-preferred-username', '`proxy` mode: header with a display name.', 'Auth'],
  ['BOARDS_PROXY_TRUSTED', '127.0.0.1/32,::1/128', '`proxy` mode: comma-separated IPs/CIDRs allowed to set identity headers (the proxy). Requests from elsewhere are anonymous.', 'Auth'],
  ['BOARDS_PROXY_SECRET', '', '`proxy` mode: optional shared secret the proxy must send in `x-boards-proxy-secret`.', 'Auth'],
  ['BOARDS_PROXY_LOGOUT_URL', '', '`proxy` mode: where "Sign out" goes (e.g. `/oauth2/sign_out`).', 'Auth'],

  ['BOARDS_FRAME_ANCESTORS', "'self'", 'CSP `frame-ancestors` for the editor: origins allowed to embed it in an iframe, e.g. `\'self\' https://workspace.example.com`. Read-only `?embed=1` views can be embedded anywhere.', 'Integration'],
  ['BOARDS_CORS_ORIGINS', '', 'Origins allowed to call the JSON/text API from a browser (no cookies; bearer tokens or board keys only).', 'Integration'],
  ['BOARDS_HANDOFF_TTL', '120', 'Lifetime in seconds of hand-off links minted by `POST /b/api/handoff`.', 'Integration'],
  ['BOARDS_COMMENTS_WEBHOOK_URL', '', 'POST comment events (`thread.created`, `thread.replied`, …) here.', 'Integration'],
  ['BOARDS_COMMENTS_WEBHOOK_SECRET', '', 'Sent as `x-boards-webhook-secret` with every webhook call.', 'Integration'],
]

const FEATURES = ['live', 'studio', 'workboard', 'snap', 'motion']
const AUTH_MODES = ['token', 'oidc', 'proxy', 'none']

/**
 * Parse the environment. Throws one error that lists every problem, so a misconfigured deployment fails loudly
 * at start-up instead of half-working.
 */
export function loadConfig(env = process.env) {
  const problems = []
  const read = (name, fn) => {
    try {
      return fn(env[name])
    } catch (error) {
      problems.push(`${name}: ${error.message}`)
      return undefined
    }
  }

  const port = read('PORT', (v) => int(v, 8080))
  const publicUrl = String(env.BOARDS_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '')
  let publicOrigin = publicUrl
  try {
    const parsed = new URL(publicUrl)
    publicOrigin = parsed.origin
    if (parsed.pathname !== '/' && parsed.pathname !== '') problems.push('BOARDS_PUBLIC_URL: must be an origin without a path (boards always lives under /b)')
  } catch {
    problems.push(`BOARDS_PUBLIC_URL: not a URL: ${publicUrl}`)
  }

  const disabled = new Set(list(env.BOARDS_DISABLE_FEATURES))
  for (const f of disabled) if (!FEATURES.includes(f)) problems.push(`BOARDS_DISABLE_FEATURES: unknown feature "${f}" (known: ${FEATURES.join(', ')})`)

  const driver = (env.BOARDS_STORAGE || (env.BOARDS_S3_BUCKET ? 's3' : 'fs')).toLowerCase()
  if (!['s3', 'fs', 'memory'].includes(driver)) problems.push(`BOARDS_STORAGE: "${driver}" — expected s3 or fs`)
  if (driver === 's3' && !env.BOARDS_S3_BUCKET) problems.push('BOARDS_S3_BUCKET: required with BOARDS_STORAGE=s3')
  const snapshotsMode = (env.BOARDS_SNAPSHOTS || 'auto').toLowerCase()
  if (!['auto', 'bucket', 'objects', 'off'].includes(snapshotsMode)) problems.push(`BOARDS_SNAPSHOTS: "${snapshotsMode}" — expected auto, bucket, objects or off`)
  const conditionalWrites = (env.BOARDS_S3_CONDITIONAL_WRITES || 'auto').toLowerCase()
  if (!['auto', 'on', 'off'].includes(conditionalWrites)) problems.push('BOARDS_S3_CONDITIONAL_WRITES: expected auto, on or off')

  const mode = (env.BOARDS_AUTH || 'token').toLowerCase()
  if (!AUTH_MODES.includes(mode)) problems.push(`BOARDS_AUTH: "${mode}" — expected ${AUTH_MODES.join(', ')}`)
  const tokens = list(env.BOARDS_API_TOKENS ?? env.BOARDS_API_TOKEN)
  for (const t of tokens) if (t.length < 16 && env.BOARDS_ALLOW_SHORT_TOKENS !== '1') problems.push('BOARDS_API_TOKENS: every token must be at least 16 characters (generate one with `openssl rand -hex 32`)')
  if (mode === 'token' && tokens.length === 0) problems.push('BOARDS_API_TOKENS: required with BOARDS_AUTH=token (the default). Generate one with `openssl rand -hex 32`, or set BOARDS_AUTH=none for a local, unauthenticated instance.')
  if (mode === 'oidc') {
    for (const name of ['BOARDS_OIDC_ISSUER', 'BOARDS_OIDC_CLIENT_ID', 'BOARDS_OIDC_CLIENT_SECRET']) if (!env[name]) problems.push(`${name}: required with BOARDS_AUTH=oidc`)
  }
  const sameSite = (env.BOARDS_COOKIE_SAMESITE || 'lax').toLowerCase()
  if (!['lax', 'strict', 'none'].includes(sameSite)) problems.push('BOARDS_COOKIE_SAMESITE: expected lax, strict or none')
  const https = publicOrigin.startsWith('https:')
  const secure = env.BOARDS_COOKIE_SECURE && env.BOARDS_COOKIE_SECURE !== 'auto' ? bool(env.BOARDS_COOKIE_SECURE) : https
  if (sameSite === 'none' && !secure) problems.push('BOARDS_COOKIE_SAMESITE=none requires Secure cookies (an https BOARDS_PUBLIC_URL)')

  const config = {
    port,
    host: env.BOARDS_HOST || '0.0.0.0',
    publicUrl: publicOrigin,
    metricsPort: read('BOARDS_METRICS_PORT', (v) => int(v, 9090)),
    features: Object.fromEntries(FEATURES.map((f) => [f, !disabled.has(f)])),
    flushDelayMs: read('BOARDS_FLUSH_DELAY_MS', (v) => int(v, 8000)),
    flushMaxMs: read('BOARDS_FLUSH_MAX_MS', (v) => int(v, 90000)),
    storage: {
      driver,
      fs: { dir: env.BOARDS_DATA_DIR || './data' },
      s3: {
        bucket: env.BOARDS_S3_BUCKET || '',
        prefix: env.BOARDS_S3_PREFIX || '',
        endpoint: env.BOARDS_S3_ENDPOINT || undefined,
        region: env.BOARDS_S3_REGION || env.AWS_REGION || env.AWS_DEFAULT_REGION || 'us-east-1',
        forcePathStyle: bool(env.BOARDS_S3_FORCE_PATH_STYLE),
        accessKeyId: env.BOARDS_S3_ACCESS_KEY_ID || undefined,
        secretAccessKey: env.BOARDS_S3_SECRET_ACCESS_KEY || undefined,
        conditionalWrites,
        createBucket: bool(env.BOARDS_S3_CREATE_BUCKET),
      },
      snapshots: {
        mode: snapshotsMode,
        intervalMs: read('BOARDS_SNAPSHOT_INTERVAL', (v) => int(v, 600)) * 1000,
        keep: read('BOARDS_SNAPSHOT_KEEP', (v) => int(v, 500)),
      },
    },
    auth: {
      mode,
      tokens,
      sessionSecret: env.BOARDS_SESSION_SECRET || '',
      sessionTtlS: read('BOARDS_SESSION_TTL', (v) => int(v, 30 * 24 * 3600)),
      cookie: { secure, sameSite },
      oidc: {
        issuer: (env.BOARDS_OIDC_ISSUER || '').replace(/\/+$/, ''),
        clientId: env.BOARDS_OIDC_CLIENT_ID || '',
        clientSecret: env.BOARDS_OIDC_CLIENT_SECRET || '',
        scopes: env.BOARDS_OIDC_SCOPES || 'openid email profile',
        allowedDomains: list(env.BOARDS_OIDC_ALLOWED_DOMAINS).map((d) => d.toLowerCase().replace(/^@/, '')),
        groupsClaim: env.BOARDS_OIDC_GROUPS_CLAIM || 'groups',
        allowedGroups: list(env.BOARDS_OIDC_ALLOWED_GROUPS),
      },
      proxy: {
        userHeader: (env.BOARDS_PROXY_USER_HEADER || 'x-forwarded-user').toLowerCase(),
        emailHeader: (env.BOARDS_PROXY_EMAIL_HEADER || 'x-forwarded-email').toLowerCase(),
        nameHeader: (env.BOARDS_PROXY_NAME_HEADER || 'x-forwarded-preferred-username').toLowerCase(),
        trusted: list(env.BOARDS_PROXY_TRUSTED || '127.0.0.1/32,::1/128'),
        secret: env.BOARDS_PROXY_SECRET || '',
        logoutUrl: env.BOARDS_PROXY_LOGOUT_URL || '',
      },
      handoffTtlS: read('BOARDS_HANDOFF_TTL', (v) => int(v, 120)),
    },
    frameAncestors: env.BOARDS_FRAME_ANCESTORS || "'self'",
    corsOrigins: list(env.BOARDS_CORS_ORIGINS).map((o) => o.replace(/\/+$/, '')),
    webhook: { url: env.BOARDS_COMMENTS_WEBHOOK_URL || '', secret: env.BOARDS_COMMENTS_WEBHOOK_SECRET || '' },
  }
  if (problems.length) {
    const error = new Error(`invalid configuration:\n  - ${problems.join('\n  - ')}`)
    error.problems = problems
    throw error
  }
  return config
}

/** A config for tests and embedding: defaults plus overrides, no validation of required secrets. */
export function testConfig(overrides = {}) {
  const base = loadConfig({ BOARDS_AUTH: 'none', BOARDS_STORAGE: 'memory', BOARDS_METRICS_PORT: '0' })
  const merge = (a, b) => {
    const out = { ...a }
    for (const [k, v] of Object.entries(b ?? {})) out[k] = v && typeof v === 'object' && !Array.isArray(v) && a?.[k] && typeof a[k] === 'object' ? merge(a[k], v) : v
    return out
  }
  return merge(base, overrides)
}

/** Markdown table of every option, grouped — used by scripts/gen-config-docs.mjs. */
export function optionsMarkdown() {
  const groups = new Map()
  for (const [name, def, description, group] of OPTIONS) {
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group).push(`| \`${name}\` | ${def ? `\`${def}\`` : '—'} | ${description} |`)
  }
  return [...groups.entries()].map(([group, rows]) => `### ${group}\n\n| Variable | Default | Description |\n| --- | --- | --- |\n${rows.join('\n')}\n`).join('\n')
}
