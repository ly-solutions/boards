/** Auth modes and configuration validation (unit level; app-level flows live in app.test.mjs). */
import { describe, test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createAuth, ipMatcher, safeNext, sign, verify } from '../server/auth.mjs'
import { loadConfig } from '../server/config.mjs'

const fakeRes = () => {
  const res = { status: 0, headers: {}, body: '' }
  res.writeHead = (status, headers = {}) => {
    res.status = status
    res.headers = headers
  }
  res.end = (body = '') => {
    res.body = String(body)
  }
  return res
}
const req = (headers = {}, remoteAddress = '127.0.0.1') => ({ headers, socket: { remoteAddress }, method: 'GET' })

describe('helpers', () => {
  test('ipMatcher understands IPv4, IPv6, CIDRs and v4-mapped addresses', () => {
    const match = ipMatcher(['10.0.0.0/8', '192.168.1.5', '::1/128', 'fd00::/8'])
    assert.ok(match('10.1.2.3'))
    assert.ok(match('192.168.1.5'))
    assert.ok(!match('192.168.1.6'))
    assert.ok(match('::1'))
    assert.ok(match('fd12:3456::1'))
    assert.ok(match('::ffff:10.9.9.9'))
    assert.ok(!match('8.8.8.8'))
    assert.ok(!match('2001:db8::1'))
    assert.throws(() => ipMatcher(['not-an-ip']))
  })

  test('safeNext only allows our own paths', () => {
    assert.equal(safeNext('/b/my-board-123?k=abc'), '/b/my-board-123?k=abc')
    assert.equal(safeNext('/b/'), '/b/')
    assert.equal(safeNext('https://evil.example/'), '/b/')
    assert.equal(safeNext('//evil.example'), '/b/')
    assert.equal(safeNext('/b/x/../../etc'), '/b/')
  })

  test('signed tokens expire and resist tampering', () => {
    const token = sign({ a: 1, exp: Math.floor(Date.now() / 1000) + 60 }, 's')
    assert.equal(verify(token, 's').a, 1)
    assert.equal(verify(token, 'other'), null)
    assert.equal(verify(`${token.slice(0, -2)}xx`, 's'), null)
    assert.equal(verify(sign({ exp: 1 }, 's'), 's'), null)
  })
})

describe('modes', () => {
  test('none: everyone is the local user', () => {
    const auth = createAuth({ mode: 'none', tokens: [] })
    assert.equal(auth.user(req()).name, 'local')
  })

  test('API tokens work in every mode', () => {
    for (const mode of ['none', 'token', 'oidc', 'proxy']) {
      const auth = createAuth({ mode, tokens: ['first-token-aaaaaaaa', 'second-token-bbbbbbb'], sessionSecret: 's' })
      assert.ok(auth.agent(req({ authorization: 'Bearer second-token-bbbbbbb' })), mode)
      assert.ok(!auth.agent(req({ authorization: 'Bearer nope' })), mode)
      assert.ok(!auth.agent(req()), mode)
    }
  })

  test('proxy: identity headers only from trusted addresses, optional shared secret', () => {
    const auth = createAuth({ mode: 'proxy', tokens: [], proxy: { userHeader: 'x-forwarded-user', emailHeader: 'x-forwarded-email', nameHeader: 'x-forwarded-preferred-username', trusted: ['10.0.0.0/8'], secret: 'proxy-secret' } })
    const headers = { 'x-forwarded-user': 'ada', 'x-forwarded-email': 'ada@example.com', 'x-forwarded-preferred-username': 'Ada Lovelace', 'x-boards-proxy-secret': 'proxy-secret' }
    assert.deepEqual(auth.user(req(headers, '10.0.0.7')), { sub: 'ada', name: 'Ada Lovelace', email: 'ada@example.com', login: 'ada', via: 'proxy' })
    assert.equal(auth.user(req(headers, '203.0.113.9')), null, 'untrusted address')
    assert.equal(auth.user(req({ ...headers, 'x-boards-proxy-secret': 'wrong' }, '10.0.0.7')), null, 'wrong secret')
    assert.equal(auth.enabled, false, 'no sign-in page: the proxy signs people in')
  })

  test('token: the sign-in form exchanges a token and a name for a session', async () => {
    const auth = createAuth({ mode: 'token', tokens: ['the-right-token-123'], sessionSecret: 's', cookie: { secure: true, sameSite: 'lax' } })
    const form = (fields) => ({ readForm: async () => new URLSearchParams(fields), renderTokenForm: (res, next, error, status) => res.writeHead(status, { error }) })
    const ok = fakeRes()
    await auth.login({ ...req(), method: 'POST' }, ok, new URL('http://x/b/auth/login'), form({ token: 'the-right-token-123', name: 'Ada', next: '/b/board-abc-123?k=1' }))
    assert.equal(ok.status, 302)
    assert.equal(ok.headers.location, '/b/board-abc-123?k=1')
    const cookie = ok.headers['set-cookie'][0]
    assert.match(cookie, /^boards_session=.+; Path=\/b; HttpOnly; Secure; SameSite=Lax/)
    assert.equal(auth.user(req({ cookie: cookie.split(';')[0] })).name, 'Ada')
    const bad = fakeRes()
    await auth.login({ ...req(), method: 'POST' }, bad, new URL('http://x/b/auth/login'), form({ token: 'wrong', name: 'Ada' }))
    assert.equal(bad.status, 401)
  })
})

describe('oidc against a fake provider', () => {
  let provider
  let issuer
  let claims
  before(async () => {
    provider = createServer((rq, rs) => {
      if (rq.url.endsWith('/.well-known/openid-configuration')) {
        rs.writeHead(200, { 'content-type': 'application/json' })
        return rs.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token` }))
      }
      if (rq.url.endsWith('/token')) {
        rs.writeHead(200, { 'content-type': 'application/json' })
        return rs.end(JSON.stringify({ id_token: `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s` }))
      }
      rs.writeHead(404)
      rs.end()
    })
    await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve))
    issuer = `http://127.0.0.1:${provider.address().port}/realms/demo`
  })
  after(() => provider.close())

  async function signIn(oidcExtra = {}, claimOverrides = {}) {
    const auth = createAuth({ mode: 'oidc', tokens: [], sessionSecret: 's', oidc: { issuer, clientId: 'boards', clientSecret: 'secret', scopes: 'openid email profile', ...oidcExtra } }, { publicUrl: 'https://boards.example.com' })
    const start = fakeRes()
    await auth.login(req(), start, new URL('https://boards.example.com/b/auth/login?next=/b/'))
    assert.equal(start.status, 302)
    const target = new URL(start.headers.location)
    assert.equal(target.searchParams.get('redirect_uri'), 'https://boards.example.com/b/auth/callback')
    assert.equal(target.searchParams.get('code_challenge_method'), 'S256')
    claims = { iss: issuer, aud: 'boards', exp: Math.floor(Date.now() / 1000) + 300, sub: 'u1', given_name: 'Ada', family_name: 'Lovelace', email: 'ada@example.com', nonce: target.searchParams.get('nonce'), groups: ['engineering'], ...claimOverrides }
    const flowCookie = start.headers['set-cookie'][0].split(';')[0]
    const done = fakeRes()
    await auth.callback(req({ cookie: flowCookie }), done, new URL(`https://boards.example.com/b/auth/callback?code=abc&state=${target.searchParams.get('state')}`))
    return { auth, done }
  }

  test('a successful sign-in sets a session with the display name', async () => {
    const { auth, done } = await signIn()
    assert.equal(done.status, 302)
    assert.equal(done.headers.location, '/b/')
    const session = done.headers['set-cookie'][0].split(';')[0]
    assert.deepEqual(auth.user(req({ cookie: session })), { sub: 'u1', name: 'Ada Lovelace', email: 'ada@example.com', login: null, via: 'oidc' })
  })

  test('allowed domains and groups are enforced', async () => {
    assert.equal((await signIn({ allowedDomains: ['example.com'] })).done.status, 302)
    assert.equal((await signIn({ allowedDomains: ['corp.example'] })).done.status, 400)
    assert.equal((await signIn({ allowedGroups: ['engineering'], groupsClaim: 'groups' })).done.status, 302)
    assert.equal((await signIn({ allowedGroups: ['admins'], groupsClaim: 'groups' })).done.status, 400)
  })

  test('a token for another audience or issuer is refused', async () => {
    assert.equal((await signIn({}, { aud: 'someone-else' })).done.status, 400)
    assert.equal((await signIn({}, { iss: 'https://evil.example' })).done.status, 400)
    assert.equal((await signIn({}, { nonce: 'replayed' })).done.status, 400)
  })
})

describe('configuration', () => {
  test('safe default: token auth requires a token', () => {
    assert.throws(() => loadConfig({}), /BOARDS_API_TOKENS: required with BOARDS_AUTH=token/)
    assert.equal(loadConfig({ BOARDS_API_TOKENS: 'a'.repeat(32) }).auth.mode, 'token')
    assert.equal(loadConfig({ BOARDS_AUTH: 'none' }).auth.mode, 'none')
  })

  test('every problem is reported at once', () => {
    try {
      loadConfig({ BOARDS_AUTH: 'oidc', BOARDS_STORAGE: 's3', BOARDS_COOKIE_SAMESITE: 'none', BOARDS_API_TOKENS: 'short' })
      assert.fail('should throw')
    } catch (error) {
      const text = error.problems.join('\n')
      for (const needle of ['BOARDS_S3_BUCKET', 'BOARDS_OIDC_ISSUER', 'BOARDS_OIDC_CLIENT_ID', 'SAMESITE=none requires Secure', 'at least 16 characters']) assert.ok(text.includes(needle), needle)
    }
  })

  test('storage defaults to s3 when a bucket is set, fs otherwise', () => {
    assert.equal(loadConfig({ BOARDS_AUTH: 'none' }).storage.driver, 'fs')
    const s3 = loadConfig({ BOARDS_AUTH: 'none', BOARDS_S3_BUCKET: 'b', BOARDS_S3_ENDPOINT: 'http://minio:9000', BOARDS_S3_FORCE_PATH_STYLE: 'true' })
    assert.equal(s3.storage.driver, 's3')
    assert.equal(s3.storage.s3.forcePathStyle, true)
  })

  test('cookies are Secure when the public URL is https; path in the public URL is rejected', () => {
    assert.equal(loadConfig({ BOARDS_AUTH: 'none', BOARDS_PUBLIC_URL: 'https://boards.example.com' }).auth.cookie.secure, true)
    assert.equal(loadConfig({ BOARDS_AUTH: 'none', BOARDS_PUBLIC_URL: 'http://localhost:8080' }).auth.cookie.secure, false)
    assert.throws(() => loadConfig({ BOARDS_AUTH: 'none', BOARDS_PUBLIC_URL: 'https://example.com/boards' }), /without a path/)
  })
})
