/**
 * harnessly integration: platform tokens (`harnessly` in BOARDS_AUTH), the MCP endpoint and the app view
 * (BOARDS_APP_VIEW). Everything is off by default; board keys and API tokens keep working.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { generateKeyPairSync, sign } from 'node:crypto'
import { startApp, TOKEN, PUBLIC_URL } from './helpers/app.mjs'
import { KeysUnavailableError, createPlatformAuth } from '../server/platform-auth.mjs'
import { boardTools, slugOf } from '../server/mcp-tools.mjs'
import { appViewHeaders, libraryRow, renderAppView } from '../server/app-view.mjs'
import { loadConfig } from '../server/config.mjs'

// A fake hub: under /with it serves discovery and a key set, under /plain only jwks.json (a hub without discovery).
const hubKey = generateKeyPairSync('ed25519')
const strangerKey = generateKeyPairSync('ed25519')
const KID = 'hub-key-1'
const HUB = 'https://hub.example'

let hub
let hubBase
let app // harnessly on, discovery
let plain // harnessly on, jwks.json only
let off // harnessly off, app view off
let view // app view on
const hits = { with: 0, plain: 0 }

function jwt(claims, { key = hubKey.privateKey, kid = KID, alg = 'EdDSA', typ = 'harnessly-app+jwt' } = {}) {
  const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const head = `${enc({ alg, typ, kid })}.${enc(claims)}`
  return `${head}.${sign(null, Buffer.from(head), key).toString('base64url')}`
}

const nowS = () => Math.floor(Date.now() / 1000)
const claimsFor = (iss, extra = {}) => ({ iss, aud: PUBLIC_URL, sub: 'user-42', email: 'ada@example.org', name: 'Ada Lovelace', org: 'org-1', space: 'space-1', iat: nowS(), exp: nowS() + 300, ...extra })

before(async () => {
  const jwks = JSON.stringify({ keys: [{ ...hubKey.publicKey.export({ format: 'jwk' }), kid: KID, alg: 'EdDSA', use: 'sig' }] })
  hub = createServer((req, res) => {
    const [, root, ...rest] = req.url.split('/')
    const tail = rest.join('/')
    if (root === 'with' && tail === '.well-known/openid-configuration') {
      hits.with += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ issuer: `${hubBase}/with`, jwks_uri: `${hubBase}/with/keys` }))
    }
    if (root === 'with' && tail === 'keys') {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(jwks)
    }
    if (root === 'plain' && tail === '.well-known/jwks.json') {
      hits.plain += 1
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(jwks)
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => hub.listen(0, '127.0.0.1', resolve))
  hubBase = `http://127.0.0.1:${hub.address().port}`
  app = await startApp({ config: { auth: { harnessly: { issuer: `${hubBase}/with`, orgs: ['org-1'] } } } })
  plain = await startApp({ config: { auth: { harnessly: { issuer: `${hubBase}/plain/`, orgs: ['*'] } } } })
  off = await startApp()
  view = await startApp({ config: { appView: true, frameAncestors: `'self' ${HUB}` } })
})

after(async () => {
  for (const t of [app, plain, off, view]) await t?.close()
  hub?.close()
})

let rpcId = 0
async function rpc(base, token, method, params, path = '/mcp') {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }),
  })
  const body = response.status === 200 ? await response.json() : await response.text()
  return { status: response.status, body, challenge: response.headers.get('www-authenticate') }
}

async function call(base, token, name, args) {
  const { status, body } = await rpc(base, token, 'tools/call', { name, arguments: args })
  assert.equal(status, 200)
  return body.result
}

const createdSlug = (result) => slugOf(/Board created: (\S+)/.exec(result.content[0].text)[1])

test('configuration: harnessly is off by default, needs the hub and the public address, combines with a sign-in mode', () => {
  const base = { BOARDS_STORAGE: 'memory', BOARDS_API_TOKENS: 'x'.repeat(32) }
  assert.equal(loadConfig(base).auth.harnessly, null)
  assert.equal(loadConfig(base).appView, false)
  assert.throws(() => loadConfig({ ...base, BOARDS_AUTH: 'harnessly' }), /BOARDS_HARNESSLY_ISSUER[\s\S]*BOARDS_PUBLIC_URL[\s\S]*BOARDS_HARNESSLY_ORGS/)
  const only = loadConfig({ BOARDS_STORAGE: 'memory', BOARDS_AUTH: 'harnessly', BOARDS_HARNESSLY_ISSUER: `${HUB}/`, BOARDS_HARNESSLY_ORGS: '*', BOARDS_PUBLIC_URL: 'https://boards.example' })
  assert.equal(only.auth.mode, 'token')
  assert.deepEqual(only.auth.harnessly, { issuer: HUB, orgs: ['*'] })
  const both = loadConfig({ ...base, BOARDS_AUTH: 'oidc,harnessly', BOARDS_OIDC_ISSUER: 'https://id.example', BOARDS_OIDC_CLIENT_ID: 'b', BOARDS_OIDC_CLIENT_SECRET: 's', BOARDS_HARNESSLY_ISSUER: HUB, BOARDS_HARNESSLY_ORGS: 'org-1, org-2', BOARDS_PUBLIC_URL: 'https://boards.example', BOARDS_APP_VIEW: 'on' })
  assert.equal(both.auth.mode, 'oidc')
  assert.deepEqual(both.auth.harnessly.orgs, ['org-1', 'org-2'])
  assert.equal(both.appView, true)
  assert.throws(() => loadConfig({ ...base, BOARDS_AUTH: 'oidc,proxy' }), /one sign-in mode/)
  assert.equal(createPlatformAuth().enabled, false)
  // Fail closed: no organization list, no platform tokens.
  assert.throws(() => createPlatformAuth({ harnessly: { issuer: HUB, orgs: [] }, audience: PUBLIC_URL }), /BOARDS_HARNESSLY_ORGS/)
})

test('/mcp without a token answers 401 with a Bearer challenge', async () => {
  const { status, challenge } = await rpc(app.base, null, 'tools/list')
  assert.equal(status, 401)
  assert.equal(challenge, 'Bearer realm="boards"')
})

test('a foreign audience, expired, foreign key, wrong issuer, type or algorithm — 401 invalid_token', async () => {
  const iss = `${hubBase}/with`
  const bad = {
    'foreign aud': jwt(claimsFor(iss, { aud: 'https://other.example' })),
    expired: jwt(claimsFor(iss, { exp: nowS() - 120 })),
    'not yet valid': jwt(claimsFor(iss, { nbf: nowS() + 600 })),
    'foreign key with our kid': jwt(claimsFor(iss), { key: strangerKey.privateKey }),
    'unknown kid': jwt(claimsFor(iss), { key: strangerKey.privateKey, kid: 'stranger' }),
    'foreign issuer': jwt(claimsFor('https://evil.example')),
    'wrong type': jwt(claimsFor(iss), { typ: 'JWT' }),
    'wrong algorithm': jwt(claimsFor(iss), { alg: 'HS256' }),
    'organization not listed': jwt(claimsFor(iss, { org: 'org-2' })),
  }
  for (const [why, token] of Object.entries(bad)) {
    const { status, challenge } = await rpc(app.base, token, 'tools/list')
    assert.equal(status, 401, why)
    assert.match(challenge, /^Bearer realm="boards", error="invalid_token"/, why)
  }
})

test('MCP with a platform token: create, read, edit and comment are signed by the person in the token', async () => {
  const token = jwt(claimsFor(`${hubBase}/with`))
  const init = await rpc(app.base, token, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } })
  assert.equal(init.status, 200)
  assert.equal(init.body.result.protocolVersion, '2025-06-18')
  assert.ok(init.body.result.capabilities.tools)
  const note = await fetch(`${app.base}/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })
  assert.equal(note.status, 202)

  const list = await rpc(app.base, token, 'tools/list')
  assert.deepEqual(list.body.result.tools.map((t) => t.name).sort(), ['board_comment', 'board_create', 'board_edit', 'board_library', 'board_list', 'board_react', 'board_read', 'board_templates'])

  const created = await call(app.base, token, 'board_create', { title: 'Order flow', graph: { nodes: [{ id: 'web', label: 'Site' }, { id: 'api', label: 'API' }], edges: [{ from: 'web', to: 'api', label: 'HTTP' }] } })
  assert.equal(created.isError, false, created.content[0].text)
  const slug = createdSlug(created)
  const state = await app.store.get(slug)
  assert.equal(state.meta.author, 'Ada Lovelace')

  const read = await call(app.base, token, 'board_read', { board: `${PUBLIC_URL}/b/${slug}?k=${state.meta.key}` })
  assert.match(read.content[0].text, /\[web\] → .*\[api\]/)

  const edited = await call(app.base, token, 'board_edit', { board: slug, graph: { nodes: [{ id: 'db', label: 'Database' }], edges: [{ from: 'api', to: 'db' }] }, note: 'added the database' })
  assert.equal(edited.isError, false, edited.content[0].text)
  assert.equal(state.elements.get('db').customData?.editedBy, 'Ada Lovelace')

  const comment = await call(app.base, token, 'board_comment', { board: slug, text: 'Do we need a cache here?', elementId: 'api' })
  assert.equal(comment.isError, false, comment.content[0].text)
  const thread = app.store.notes(state).comments.at(-1)
  assert.equal(thread.author, 'Ada Lovelace')
  assert.equal(thread.elementId, 'api')
  assert.equal(thread.messages[0].authorKind, 'agent')

  const reply = await call(app.base, token, 'board_comment', { board: slug, thread: thread.id, reply: 'Yes', resolved: true })
  assert.match(reply.content[0].text, /resolved/)

  assert.match((await call(app.base, token, 'board_list', { query: 'order' })).content[0].text, /Order flow/)
  assert.match((await call(app.base, token, 'board_templates', {})).content[0].text, /architecture/)
  const library = JSON.parse((await call(app.base, token, 'board_library', { board: slug })).content[0].text)
  assert.equal(library.boards[0].mine, true)

  const missing = await call(app.base, token, 'board_read', { board: 'no-such-board-000000000000' })
  assert.equal(missing.isError, true)
})

test('a platform token works only in /mcp: no key-less HTTP access, no hand-off links; keys from jwks.json without discovery', async () => {
  const token = jwt(claimsFor(`${hubBase}/plain`, { org: 'any-org' }))
  const slug = createdSlug(await call(plain.base, token, 'board_create', { title: 'No discovery' }))
  assert.ok(hits.plain >= 1)
  assert.ok(hits.with >= 1)
  const bearer = { authorization: `Bearer ${token}`, 'content-type': 'application/json' }
  assert.equal((await fetch(`${plain.base}/b/${slug}.md`, { headers: bearer })).status, 404)
  assert.equal((await fetch(`${plain.base}/b/api/boards`, { headers: bearer })).status, 401)
  const handoff = await fetch(`${plain.base}/b/api/handoff`, { method: 'POST', headers: bearer, body: JSON.stringify({ user: { name: 'Someone else', email: 'x@example.org' } }) })
  assert.equal(handoff.status, 401)
})

test('cached hub keys outlive a short hub outage but not KEYS_MAX_AGE', async () => {
  let clock = Date.now()
  let up = true
  const jwk = { ...hubKey.publicKey.export({ format: 'jwk' }), kid: KID }
  const fetchImpl = async (url) => {
    if (!up) throw new Error('hub down')
    if (url.endsWith('/openid-configuration')) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  const auth = createPlatformAuth({ harnessly: { issuer: HUB, orgs: ['*'] }, audience: PUBLIC_URL, fetchImpl, now: () => clock })
  const token = () => jwt({ ...claimsFor(HUB), iat: Math.floor(clock / 1000), exp: Math.floor(clock / 1000) + 300 })
  assert.equal((await auth.verify(token())).sub, 'user-42')
  up = false
  clock += 6 * 60_000
  assert.equal((await auth.verify(token())).sub, 'user-42')
  clock += 10 * 60_000
  await assert.rejects(auth.verify(token()), KeysUnavailableError)
})

test('an API token works in /mcp; with harnessly off a JWT is refused and board keys work as before', async () => {
  const slug = createdSlug(await call(off.base, TOKEN, 'board_create', { title: 'Agent board', author: 'build bot' }))
  const state = await off.store.get(slug)
  assert.equal(state.meta.author, 'build bot')
  assert.equal((await rpc(off.base, jwt(claimsFor(`${hubBase}/with`)), 'tools/list')).status, 401)
  assert.equal((await call(app.base, TOKEN, 'board_templates', {})).isError, false)
  assert.equal((await fetch(`${off.base}/b/${slug}.md?k=${state.meta.key}`)).status, 200)
})

test('GET /b/mcp is 405: a server without a stream', async () => {
  const response = await fetch(`${app.base}/b/mcp`, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(response.status, 405)
})

test('app view: off by default; on, the home loads the bridge first and may be framed by BOARDS_FRAME_ANCESTORS', async () => {
  assert.equal((await fetch(`${off.base}/b/app`)).status, 404)
  const response = await fetch(`${view.base}/b/app`)
  assert.equal(response.status, 200)
  const csp = response.headers.get('content-security-policy')
  assert.match(csp, new RegExp(`frame-ancestors 'self' ${HUB}(;|$)`))
  assert.match(csp, /script-src 'self'(;|$)/)
  const html = await response.text()
  const shim = html.indexOf('hl/bridge-shim.js')
  assert.ok(shim > 0 && shim < html.indexOf('hl/app-sdk.classic.js') && shim < html.indexOf('app/app.js'))
  assert.match(appViewHeaders()['content-security-policy'], /frame-ancestors 'self'/)
  assert.match(renderAppView({ staticBase: '/b/_static', locale: 'ru' }), /<html lang="ru">/)
})

test('app view: ?app=1 marks the editor config only when the view is on', async () => {
  const pageConfig = async (t) => {
    const { body } = await t.createBoard({ title: 'Canvas' })
    const html = await (await fetch(`${t.base}/b/${body.slug}?k=${body.key}&app=1&theme=dark`)).text()
    return JSON.parse(/<script type="application\/json" id="board-config">([\s\S]*?)<\/script>/.exec(html)[1])
  }
  const on = await pageConfig(view)
  assert.equal(on.app, true)
  assert.equal(on.theme, 'dark')
  const plainConfig = await pageConfig(off)
  assert.equal(plainConfig.app, false)
  assert.equal(plainConfig.theme, null)
})

test('library rows: "mine" by the person in the token, a link with the key, the preview on our own path', () => {
  const meta = { slug: 'pay', key: 'k 1', title: 'Payments', author: 'Ada', tags: ['arch'], updatedAt: '2026-11-10T10:00:00Z', hasPreview: true }
  const row = libraryRow(meta, { publicUrl: 'https://boards.example', prefix: '/b', me: { name: 'Ada', email: 'ada@example.com' } })
  assert.equal(row.mine, true)
  assert.equal(row.url, 'https://boards.example/b/pay?k=k%201')
  assert.equal(row.preview, '/b/pay/preview.svg?k=k%201')
  assert.equal(libraryRow(meta, { publicUrl: '', prefix: '/b', me: { name: 'Bob' } }).mine, false)
  assert.equal(libraryRow(meta, { publicUrl: '', prefix: '/b', me: null }).mine, false)
})

test('board_library answers JSON, one board by slug or link, and searches by words', async () => {
  const rows = [
    { slug: 'pay', title: 'Payments', description: '', tags: ['arch'], mine: true },
    { slug: 'retro', title: 'Retro', description: 'week', tags: [], mine: false },
  ]
  let asked = null
  const tool = boardTools({ reactions: ['👍'], library: async (me) => ((asked = me), rows) }).find((t) => t.name === 'board_library')
  const all = JSON.parse(await tool.run({}, { who: { kind: 'agent', name: 'Ada', email: 'ada@example.com', sub: 'u1' } }))
  assert.equal(all.boards.length, 2)
  assert.deepEqual(asked, { name: 'Ada', email: 'ada@example.com' })
  assert.deepEqual(JSON.parse(await tool.run({ query: 'week' }, {})).boards.map((b) => b.slug), ['retro'])
  assert.deepEqual(JSON.parse(await tool.run({ board: 'https://x/b/pay?k=1' }, {})).boards.map((b) => b.slug), ['pay'])
  await assert.rejects(tool.run({ board: 'none' }, {}), /no board none/)
})
