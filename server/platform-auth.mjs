/**
 * Sign-in with a harnessly platform token (`BOARDS_AUTH=harnessly`).
 *
 * Why. An agent in harnessly works with boards on behalf of the person in its conversation, not with a shared API
 * token: the harnessly machine gets a short-lived JWT (5 minutes) from the hub and sends it as
 * `Authorization: Bearer` with every call to `/mcp`. boards checks the signature with the hub's keys and signs edits
 * with the person in the token — `sub` as the key, `name`/`email` for display.
 *
 * What is checked: an Ed25519 signature (`alg: EdDSA`, no other algorithm is accepted), `typ: harnessly-app+jwt`,
 * `iss` exactly equal to the configured hub, `aud` equal to our own origin (BOARDS_PUBLIC_URL), `exp`/`nbf` with a
 * minute of leeway. Keys come from discovery (`<iss>/.well-known/openid-configuration` → `jwks_uri`, only on the hub's
 * own host) or, when the hub has no discovery document, straight from `<iss>/.well-known/jwks.json`. Keys are cached
 * for five minutes; an unknown `kid` triggers one refetch, at most every 30 seconds, so foreign tokens cannot turn the
 * service into a hammer against the hub.
 *
 * Off by default: without `harnessly` in BOARDS_AUTH no platform token is accepted, and board keys (`?k=`), API
 * tokens and the configured sign-in mode work exactly as before.
 */
import { createPublicKey, verify as verifySignature } from 'node:crypto'

export const TOKEN_TYPE = 'harnessly-app+jwt'
const SKEW_S = 60
const KEYS_TTL_MS = 5 * 60_000
const REFETCH_GAP_MS = 30_000

export class TokenError extends Error {}

/** Whether a value looks like a JWT: three base64url parts joined by dots. */
export function looksLikeJwt(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)
}

export function bearerOf(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.headers.authorization ?? ''))
  return m ? m[1].trim() : ''
}

function decodePart(part) {
  try {
    return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
  } catch {
    throw new TokenError('the token cannot be decoded')
  }
}

/** The name edits are signed with: the token's name, else the local part of the e-mail, else the id. */
export function platformDisplayName(claims) {
  const name = typeof claims.name === 'string' ? claims.name.trim() : ''
  if (name) return name.slice(0, 60)
  const email = typeof claims.email === 'string' ? claims.email.split('@')[0] : ''
  return email || String(claims.sub)
}

/**
 * `harnessly` — `{ issuer, orgs }` from the configuration, or null when the mode is off.
 * `audience` — our public origin.
 */
export function createPlatformAuth({ harnessly = null, audience = '', fetchImpl = fetch, now = () => Date.now() } = {}) {
  if (!harnessly) return { enabled: false, verify: async () => { throw new TokenError('platform tokens are not accepted here') } }
  const iss = String(harnessly.issuer ?? '').replace(/\/+$/, '')
  if (!iss) throw new Error('BOARDS_AUTH=harnessly needs BOARDS_HARNESSLY_ISSUER')
  const aud = new URL(audience).origin
  const allowedOrgs = new Set(harnessly.orgs ?? [])
  let keys = null // { byKid: Map, until }
  let lastFetch = 0
  let inflight = null

  async function getJson(url) {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`${url}: ${response.status}`)
    return response.json()
  }

  async function jwksUri() {
    try {
      const doc = await getJson(`${iss}/.well-known/openid-configuration`)
      if (doc?.issuer === iss && typeof doc.jwks_uri === 'string' && new URL(doc.jwks_uri).origin === new URL(iss).origin) return doc.jwks_uri
    } catch {
      // A hub without discovery: use the well-known key set address.
    }
    return `${iss}/.well-known/jwks.json`
  }

  async function fetchKeys() {
    lastFetch = now()
    const jwks = await getJson(await jwksUri())
    const byKid = new Map()
    for (const jwk of Array.isArray(jwks?.keys) ? jwks.keys : []) {
      if (jwk?.kty !== 'OKP' || jwk?.crv !== 'Ed25519' || typeof jwk.x !== 'string') continue
      try {
        byKid.set(String(jwk.kid ?? ''), createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: jwk.x }, format: 'jwk' }))
      } catch {
        // Skip a broken key; the others still count.
      }
    }
    keys = { byKid, until: now() + KEYS_TTL_MS }
    return keys
  }

  function refresh() {
    inflight ??= fetchKeys().finally(() => {
      inflight = null
    })
    return inflight
  }

  async function keyFor(kid) {
    if (!keys || keys.until <= now()) {
      try {
        await refresh()
      } catch {
        if (!keys) throw new TokenError('the hub keys are unavailable')
      }
    }
    let key = keys.byKid.get(kid)
    if (!key && now() - lastFetch >= REFETCH_GAP_MS) {
      try {
        await refresh()
      } catch {
        throw new TokenError('the hub keys are unavailable')
      }
      key = keys.byKid.get(kid)
    }
    if (!key) throw new TokenError('the token is signed with an unknown key')
    return key
  }

  /** Check a token. Returns the person or throws TokenError. */
  async function verify(token) {
    if (!looksLikeJwt(token)) throw new TokenError('not a JWT')
    const [h, p, s] = token.split('.')
    const header = decodePart(h)
    if (header.alg !== 'EdDSA') throw new TokenError('the signature algorithm is not EdDSA')
    if (header.typ !== TOKEN_TYPE) throw new TokenError(`the token type is not ${TOKEN_TYPE}`)
    const key = await keyFor(String(header.kid ?? ''))
    if (!verifySignature(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, 'base64url'))) throw new TokenError('the signature does not match')
    const claims = decodePart(p)
    if (claims.iss !== iss) throw new TokenError('the token was issued by another hub')
    const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud]
    if (!audiences.includes(aud)) throw new TokenError('the token was issued for another service')
    const t = now() / 1000
    if (!Number.isFinite(claims.exp) || claims.exp + SKEW_S < t) throw new TokenError('the token has expired')
    if (Number.isFinite(claims.nbf) && claims.nbf - SKEW_S > t) throw new TokenError('the token is not valid yet')
    if (typeof claims.sub !== 'string' || !claims.sub) throw new TokenError('the token has no sub')
    if (allowedOrgs.size && !allowedOrgs.has(String(claims.org ?? ''))) throw new TokenError('the token organization has no access to boards')
    return {
      sub: claims.sub,
      name: platformDisplayName(claims),
      email: typeof claims.email === 'string' ? claims.email : null,
      org: claims.org ?? null,
      space: claims.space ?? null,
    }
  }

  return { enabled: true, issuer: iss, audience: aud, verify }
}
