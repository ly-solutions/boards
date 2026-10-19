/**
 * Authentication: who is making a request.
 *
 * Two kinds of callers exist side by side in every mode:
 *
 * - **agents and integrations** send `Authorization: Bearer <token>` with one of `BOARDS_API_TOKENS`;
 * - **people** in a browser are "signed in" according to `BOARDS_AUTH`:
 *   - `token` — paste an API token once on the sign-in page; a signed session cookie follows;
 *   - `oidc`  — authorization-code flow with PKCE against any OpenID Connect provider;
 *   - `proxy` — identity headers set by a trusted reverse proxy (oauth2-proxy, Pomerium, Authelia, …);
 *   - `none`  — everyone is a signed-in user called "local". For a laptop, never for a shared network.
 *
 * Independently of that, a board link with its key (`?k=`) lets anyone read the board, and edit it when the
 * board is opened for editing by link (`access: link`) — then the visitor signs edits with a guest name.
 *
 * The session is our own HMAC-signed cookie with only name/e-mail/expiry in it, scoped to `/b`, HttpOnly. Provider
 * tokens are never stored. The OIDC id_token comes straight from the token endpoint over TLS with our client
 * secret, so its signature is not re-verified (OIDC Core 3.1.3.7 (6)); issuer, audience and expiry are.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { isIP } from 'node:net'
import { secretMatches } from './access.mjs'

const SESSION_COOKIE = 'boards_session'
const FLOW_COOKIE = 'boards_oidc'
const FLOW_TTL_S = 600
const LOCAL_USER = Object.freeze({ sub: 'local', name: 'local', email: null, login: 'local', via: 'none' })

const b64url = (buf) => Buffer.from(buf).toString('base64url')

export function sign(payload, secret) {
  const body = b64url(JSON.stringify(payload))
  const mac = createHmac('sha256', secret).update(body).digest('base64url')
  return `${body}.${mac}`
}

export function verify(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || !token.includes('.')) return null
  const [body, mac] = token.split('.')
  const expected = createHmac('sha256', secret).update(body).digest()
  const given = Buffer.from(mac, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.exp || payload.exp * 1000 < now) return null
    return payload
  } catch {
    return null
  }
}

export function parseCookies(header) {
  const out = {}
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    try {
      out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
    } catch {
      // ignore malformed cookies
    }
  }
  return out
}

/** Where to return after sign-in: only our own paths, never another site (open redirects are a phishing classic). */
export function safeNext(next) {
  const value = String(next ?? '')
  return /^\/b\/(?:[a-z0-9-]+)?(\?[A-Za-z0-9=&%._~-]*)?$/.test(value) ? value : '/b/'
}

/** "Ada Lovelace", not "ada@example.com". */
export function displayName(claims) {
  const full = [claims.given_name, claims.family_name].filter(Boolean).join(' ').trim()
  return full || claims.name || claims.preferred_username || String(claims.email ?? '').split('@')[0] || 'unnamed'
}

// ── trusted proxy addresses ────────────────────────────────────────────────

function ipToBigInt(ip) {
  if (isIP(ip) === 4) return { v: 4, n: ip.split('.').reduce((acc, part) => (acc << 8n) + BigInt(Number(part)), 0n) }
  if (isIP(ip) === 6) {
    let [head, tail = ''] = ip.split('::')
    if (!ip.includes('::')) tail = undefined
    const h = head ? head.split(':') : []
    const t = tail ? tail.split(':') : []
    // An embedded IPv4 tail (::ffff:1.2.3.4) becomes two groups.
    const expand = (groups) => groups.flatMap((g) => (g.includes('.') ? (() => { const n = ipToBigInt(g).n; return [(n >> 16n).toString(16), (n & 0xffffn).toString(16)] })() : [g]))
    const hh = expand(h)
    const tt = expand(t)
    const groups = tail === undefined ? hh : [...hh, ...Array(8 - hh.length - tt.length).fill('0'), ...tt]
    return { v: 6, n: groups.reduce((acc, g) => (acc << 16n) + BigInt(parseInt(g || '0', 16)), 0n) }
  }
  return null
}

export function ipMatcher(entries) {
  const nets = []
  for (const entry of entries) {
    const [addr, bits] = entry.split('/')
    const ip = ipToBigInt(addr)
    if (!ip) throw new Error(`not an IP or CIDR: ${entry}`)
    const width = ip.v === 4 ? 32 : 128
    const prefix = bits === undefined ? width : Number(bits)
    const mask = prefix === 0 ? 0n : ((1n << BigInt(prefix)) - 1n) << BigInt(width - prefix)
    nets.push({ v: ip.v, net: ip.n & mask, mask })
  }
  return (raw) => {
    let addr = String(raw ?? '')
    if (addr.startsWith('::ffff:') && isIP(addr.slice(7)) === 4) addr = addr.slice(7)
    const ip = ipToBigInt(addr)
    return Boolean(ip) && nets.some((n) => n.v === ip.v && (ip.n & n.mask) === n.net)
  }
}

// ── the auth object ────────────────────────────────────────────────────────

/**
 * @param {object} auth config.auth from loadConfig()
 * @param {object} opts  { publicUrl, fetchImpl, now, log }
 */
export function createAuth(auth = { mode: 'none', tokens: [] }, { publicUrl = 'http://localhost:8080', fetchImpl = fetch, now = () => Date.now(), log = () => {} } = {}) {
  const mode = auth.mode ?? 'none'
  const tokens = auth.tokens ?? []
  const sessionSecret = auth.sessionSecret || randomBytes(32).toString('hex')
  if (!auth.sessionSecret && mode !== 'none' && mode !== 'proxy') log({ level: 'warn', event: 'session_secret_random', note: 'BOARDS_SESSION_SECRET is not set: sessions end when the process restarts' })
  const sessionTtlS = auth.sessionTtlS ?? 30 * 24 * 3600
  const cookieOpts = { secure: auth.cookie?.secure ?? publicUrl.startsWith('https:'), sameSite: auth.cookie?.sameSite ?? 'lax' }
  const oidc = auth.oidc ?? {}
  const proxy = auth.proxy ?? {}
  const trusted = mode === 'proxy' ? ipMatcher(proxy.trusted ?? ['127.0.0.1/32', '::1/128']) : () => false
  const redirectUri = `${publicUrl}/b/auth/callback`
  let discovery = null

  const cookie = (name, value, { path = '/b', maxAge }) => {
    const sameSite = cookieOpts.sameSite[0].toUpperCase() + cookieOpts.sameSite.slice(1)
    return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; ${cookieOpts.secure ? 'Secure; ' : ''}SameSite=${sameSite}; Max-Age=${maxAge}`
  }

  const sessionCookie = (user) =>
    cookie(SESSION_COOKIE, sign({ sub: user.sub ?? null, name: user.name, email: user.email ?? null, login: user.login ?? null, via: user.via, exp: Math.floor(now() / 1000) + sessionTtlS }, sessionSecret), { maxAge: sessionTtlS })

  /** A valid API token in the Authorization header. */
  function agent(req) {
    const provided = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
    if (!provided) return false
    let ok = false
    // Compare against every token so timing does not reveal which one matched.
    for (const t of tokens) ok = secretMatches(provided, t) || ok
    return ok
  }

  function fromProxy(req) {
    if (!trusted(req.socket?.remoteAddress)) return null
    if (proxy.secret && !secretMatches(req.headers['x-boards-proxy-secret'], proxy.secret)) return null
    const id = String(req.headers[proxy.userHeader ?? 'x-forwarded-user'] ?? '').trim()
    const email = String(req.headers[proxy.emailHeader ?? 'x-forwarded-email'] ?? '').trim() || null
    if (!id && !email) return null
    const name = String(req.headers[proxy.nameHeader ?? 'x-forwarded-preferred-username'] ?? '').trim() || id || email.split('@')[0]
    return { sub: id || email, name: name.slice(0, 80), email, login: id || null, via: 'proxy' }
  }

  /** The signed-in person, or null. */
  function user(req) {
    if (mode === 'none') return LOCAL_USER
    if (mode === 'proxy') {
      const viaProxy = fromProxy(req)
      if (viaProxy) return viaProxy
    }
    const payload = verify(parseCookies(req.headers.cookie)[SESSION_COOKIE], sessionSecret, now())
    return payload ? { sub: payload.sub, name: payload.name, email: payload.email, login: payload.login, via: payload.via ?? 'session' } : null
  }

  async function endpoints() {
    if (discovery && discovery.until > now()) return discovery.value
    const response = await fetchImpl(`${oidc.issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status}`)
    const value = await response.json()
    if (value.issuer && value.issuer.replace(/\/+$/, '') !== oidc.issuer) throw new Error(`OIDC discovery issuer mismatch: ${value.issuer}`)
    discovery = { value, until: now() + 3600_000 }
    return value
  }

  const plain = (res, status, body, headers = {}) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers })
    res.end(body)
  }
  const redirect = (res, location, cookies = []) => {
    res.writeHead(302, { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer', ...(cookies.length ? { 'set-cookie': cookies } : {}) })
    res.end()
  }

  async function startOidc(res, next) {
    const { authorization_endpoint: authorize } = await endpoints()
    const state = b64url(randomBytes(18))
    const verifier = b64url(randomBytes(48))
    const nonce = b64url(randomBytes(18))
    const challenge = createHash('sha256').update(verifier).digest('base64url')
    const flow = sign({ state, verifier, nonce, next, exp: Math.floor(now() / 1000) + FLOW_TTL_S }, sessionSecret)
    const target = new URL(authorize)
    target.search = new URLSearchParams({
      client_id: oidc.clientId,
      response_type: 'code',
      scope: oidc.scopes ?? 'openid email profile',
      redirect_uri: redirectUri,
      state,
      nonce,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    }).toString()
    redirect(res, target.toString(), [cookie(FLOW_COOKIE, flow, { path: '/b/auth', maxAge: FLOW_TTL_S })])
  }

  /** GET /b/auth/login — start signing in. `renderTokenForm(next, error)` draws the token-mode page. */
  async function login(req, res, url, { renderTokenForm, readForm } = {}) {
    const next = safeNext(url.searchParams.get('next'))
    if (mode === 'none') return redirect(res, next)
    if (mode === 'proxy') return user(req) ? redirect(res, next) : plain(res, 401, 'Not signed in: this instance expects a reverse proxy to authenticate you (BOARDS_AUTH=proxy).')
    if (mode === 'oidc') return startOidc(res, next)
    // token mode
    if (req.method === 'POST') {
      const form = await readForm(req)
      const formNext = safeNext(form.get('next'))
      const name = String(form.get('name') ?? '').trim().slice(0, 60)
      const ok = agent({ headers: { authorization: `Bearer ${String(form.get('token') ?? '')}` } })
      if (!ok || !name) return renderTokenForm(res, formNext, ok ? 'Enter your name — it signs your edits.' : 'That token is not valid.', 401)
      return redirect(res, formNext, [sessionCookie({ sub: `token:${name.toLowerCase()}`, name, via: 'token' })])
    }
    return renderTokenForm(res, next, null, 200)
  }

  async function callback(req, res, url) {
    if (mode !== 'oidc') return plain(res, 404, 'not found')
    const flow = verify(parseCookies(req.headers.cookie)[FLOW_COOKIE], sessionSecret, now())
    const fail = (why) => plain(res, 400, `Sign-in failed: ${why}. Open the board again and choose "Sign in".`, { 'set-cookie': cookie(FLOW_COOKIE, '', { path: '/b/auth', maxAge: 0 }) })
    if (!flow || flow.state !== url.searchParams.get('state')) return fail('the sign-in attempt expired or was tampered with')
    const code = url.searchParams.get('code')
    if (!code) return fail(url.searchParams.get('error_description') ?? 'the provider returned no code')
    const { token_endpoint: tokenUrl } = await endpoints()
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: oidc.clientId, client_secret: oidc.clientSecret, code_verifier: flow.verifier }),
      signal: AbortSignal.timeout(10000),
    })
    if (!response.ok) return fail(`the provider refused the code exchange (${response.status})`)
    const tokens = await response.json()
    let claims
    try {
      claims = JSON.parse(Buffer.from(String(tokens.id_token).split('.')[1], 'base64url').toString('utf8'))
    } catch {
      return fail('the provider returned an unreadable id_token')
    }
    const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (String(claims.iss).replace(/\/+$/, '') !== oidc.issuer || !audience.includes(oidc.clientId) || claims.exp * 1000 < now()) return fail('the id_token is not for this service')
    if (claims.nonce !== undefined && claims.nonce !== flow.nonce) return fail('nonce mismatch')
    const email = claims.email ? String(claims.email).toLowerCase() : null
    if (oidc.allowedDomains?.length) {
      if (!email || claims.email_verified === false || !oidc.allowedDomains.includes(email.split('@')[1])) return fail('your account is not in an allowed domain')
    }
    if (oidc.allowedGroups?.length) {
      const groups = [].concat(claims[oidc.groupsClaim ?? 'groups'] ?? []).map(String)
      if (!groups.some((g) => oidc.allowedGroups.includes(g))) return fail('your account is not in an allowed group')
    }
    redirect(res, flow.next, [sessionCookie({ sub: claims.sub, name: displayName(claims), email, login: claims.preferred_username ?? null, via: 'oidc' }), cookie(FLOW_COOKIE, '', { path: '/b/auth', maxAge: 0 })])
  }

  function logout(req, res, url) {
    const next = safeNext(url.searchParams.get('next'))
    const target = mode === 'proxy' && proxy.logoutUrl ? proxy.logoutUrl : next
    redirect(res, target, [cookie(SESSION_COOKIE, '', { maxAge: 0 })])
  }

  /**
   * Hand-off: an integration that holds an API token (e.g. a workspace app whose user is already signed in
   * there) mints a short-lived, single-purpose link that signs that user in here and lands on a board.
   */
  const usedHandoffs = new Map()
  function issueHandoff({ user: who, next, ttlS = auth.handoffTtlS ?? 120 }) {
    const name = String(who?.name ?? '').trim().slice(0, 80)
    if (!name) throw new Error('user.name is required')
    const id = b64url(randomBytes(12))
    return sign({ t: 'handoff', id, sub: String(who.id ?? who.email ?? name), name, email: who.email ?? null, next: safeNext(next), exp: Math.floor(now() / 1000) + Math.min(Math.max(ttlS, 10), 3600) }, sessionSecret)
  }

  function handoff(req, res, url) {
    const payload = verify(url.searchParams.get('t'), sessionSecret, now())
    if (!payload || payload.t !== 'handoff') return plain(res, 400, 'This sign-in link is invalid or expired.')
    if (usedHandoffs.has(payload.id)) return plain(res, 400, 'This sign-in link was already used.')
    usedHandoffs.set(payload.id, payload.exp)
    for (const [id, exp] of usedHandoffs) if (exp * 1000 < now()) usedHandoffs.delete(id)
    redirect(res, payload.next, [sessionCookie({ sub: payload.sub, name: payload.name, email: payload.email, via: 'handoff' })])
  }

  return {
    mode,
    /** Whether a browser can sign in at all (false only in proxy mode, where the proxy does it). */
    enabled: mode !== 'proxy',
    agent,
    user,
    login,
    callback,
    logout,
    handoff,
    issueHandoff,
    /** Test helper: a session cookie value for `user`. */
    _session: (who) => sessionCookie({ via: 'test', ...who }).split(';')[0].split('=').slice(1).join('='),
    sessionCookieName: SESSION_COOKIE,
  }
}
