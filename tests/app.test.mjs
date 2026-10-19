import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, readdir } from 'node:fs/promises'
import { isSafePreview } from '../server/index.mjs'
import { createStore } from '../server/store.mjs'
import { createBoardStorage } from '../server/storage/boards.mjs'
import { fsObjects } from '../server/storage/objects.mjs'
import { startApp, PUBLIC_URL, TOKEN } from './helpers/app.mjs'

let t
let base
let store
let auth
let session

before(async () => {
  t = await startApp()
  base = t.base
  store = t.store
  auth = t.agent
  session = () => t.cookie()
})

after(async () => {
  await t.close()
})

const reopen = () => createStore({ storage: createBoardStorage({ objects: fsObjects({ dir: t.dir }) }), flushDelayMs: 50, baseUrl: PUBLIC_URL, log: () => {} })

async function create(body = {}) {
  return t.createBoard(body)
}

test('creating a board needs a token', async () => {
  const response = await fetch(`${base}/b/api/boards`, { method: 'POST', body: '{}' })
  assert.equal(response.status, 401)
})

test('an agent creates a board from a graph and reads it as text by link', async () => {
  const { status, body } = await create({ graph: { nodes: [{ id: 'a', label: 'Gateway' }, { id: 'b', label: 'orders-api' }], edges: [{ from: 'a', to: 'b', label: 'HTTP' }] } })
  assert.equal(status, 201)
  assert.match(body.url, /^http:\/\/boards\.test\/b\/payment-flow-[a-z0-9]{12}\?k=[A-Za-z0-9]{22}$/)
  const key = new URL(body.url).searchParams.get('k')
  const md = await (await fetch(`${base}/b/${body.slug}.md?k=${key}`)).text()
  assert.match(md, /"Gateway" \[a\] → "orders-api" \[b\] — "HTTP"/)
  // The editor page carries the same text, so an agent understands a bare link too.
  const html = await (await fetch(`${base}/b/${body.slug}?k=${key}`)).text()
  assert.match(html, /&quot;Gateway&quot; \[a\] → &quot;orders-api&quot; \[b\]/)
})

test('a Cyrillic title becomes a transliterated slug', async () => {
  const { status, body } = await create({ title: 'Схема' })
  assert.equal(status, 201)
  assert.match(body.slug, /^shema-[a-z0-9]{12}$/)
})

test('a wrong key is indistinguishable from a missing board', async () => {
  const { body } = await create()
  const wrong = await fetch(`${base}/b/${body.slug}.md?k=AAAAAAAAAAAAAAAAAAAAAA`)
  const missing = await fetch(`${base}/b/no-such-board-000000000000.md?k=AAAAAAAAAAAAAAAAAAAAAA`)
  assert.equal(wrong.status, 404)
  assert.equal(missing.status, 404)
  assert.deepEqual(await wrong.json(), await missing.json())
})

test("an agent's edit reaches the browser on the next exchange, and the browser's edit reaches the agent", async () => {
  const { body } = await create({ graph: { nodes: [{ id: 'a', label: 'A' }] } })
  const k = `?k=${body.key}`
  const scene = await (await fetch(`${base}/b/${body.slug}/scene.excalidraw${k}`)).json()

  const edit = await fetch(`${base}/b/${body.slug}/edit${k}`, { method: 'POST', headers: auth, body: JSON.stringify({ graph: { nodes: [{ id: 'b', label: 'B' }], edges: [{ from: 'a', to: 'b' }] }, author: 'Claude', note: 'added B' }) })
  assert.equal(edit.status, 200)

  const sync = await (await fetch(`${base}/b/${body.slug}/sync${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ since: scene.rev, epoch: scene.epoch, elements: [] }) })).json()
  assert.ok(sync.elements.some((el) => el.id === 'b'))
  assert.equal(sync.edits[0].by, 'Claude')

  const drawn = { id: 'human1', type: 'ellipse', x: 0, y: 500, width: 80, height: 80, version: 3, versionNonce: 7, isDeleted: false, index: 'b9', boundElements: [] }
  await fetch(`${base}/b/${body.slug}/sync${k}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: session() }, body: JSON.stringify({ since: sync.rev, epoch: sync.epoch, elements: [drawn] }) })
  const md = await (await fetch(`${base}/b/${body.slug}.md${k}`)).text()
  assert.match(md, /\[human1\] ellipse .* · edited by Ada Lovelace/)
  assert.match(md, /\[b\] rectangle "B" .* · edited by Claude/)
})

test('a broken edit answers 400 with the reason and leaves the board alone', async () => {
  const { body } = await create({ graph: { nodes: [{ id: 'a' }] } })
  const before = await (await fetch(`${base}/b/${body.slug}.md?k=${body.key}`)).text()
  const response = await fetch(`${base}/b/${body.slug}/edit?k=${body.key}`, { method: 'POST', headers: auth, body: JSON.stringify({ graph: { nodes: [{ id: 'a' }] } }) })
  assert.equal(response.status, 400)
  assert.match((await response.json()).error, /already on the board/)
  assert.equal(await (await fetch(`${base}/b/${body.slug}.md?k=${body.key}`)).text(), before)
})

test('a board snapshot goes to storage and survives a restart', async () => {
  const { body } = await create({ graph: { nodes: [{ id: 'a', label: 'Survivor' }] } })
  await store.flushAll()
  const reborn = reopen()
  const state = await reborn.get(body.slug)
  assert.match(reborn.text(state), /"Survivor"/)
})

test('a preview is accepted only as an SVG without scripts', () => {
  assert.equal(isSafePreview('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>'), true)
  assert.equal(isSafePreview('<svg><script>alert(1)</script></svg>'), false)
  assert.equal(isSafePreview('<svg onload="alert(1)"></svg>'), false)
  assert.equal(isSafePreview('<html><svg></svg></html>'), false)
})

test('preview upload: an editor may post a safe SVG, a viewer may not, scripts are refused', async () => {
  const { body } = await create({ graph: { nodes: [{ id: 'a' }] } })
  const k = `?k=${body.key}`
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>'
  const post = (payload, headers = {}) => fetch(`${base}/b/${body.slug}/preview${k}`, { method: 'POST', headers: { 'content-type': 'image/svg+xml', ...headers }, body: payload })
  assert.equal((await post(svg)).status, 403)
  assert.equal((await post('<svg><script>alert(1)</script></svg>', { cookie: session() })).status, 400)
  assert.equal((await post(svg, { cookie: session() })).status, 200)
  const served = await fetch(`${base}/b/${body.slug}/preview.svg${k}`)
  assert.equal(served.status, 200)
  assert.match(served.headers.get('content-security-policy'), /sandbox/)
  assert.equal(await served.text(), svg)
})

test('a team board opened by link without signing in is view-only', async () => {
  const { body } = await create({ graph: { nodes: [{ id: 'a' }] } })
  const k = `?k=${body.key}`
  const edit = await fetch(`${base}/b/${body.slug}/edit${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: ['a'] }) })
  assert.equal(edit.status, 403)
  const el = { id: 'x1', type: 'rectangle', x: 0, y: 0, width: 1, height: 1, version: 1, versionNonce: 1 }
  const write = await fetch(`${base}/b/${body.slug}/sync${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elements: [el] }) })
  assert.equal(write.status, 403)
  // Reading and receiving other people's edits is allowed.
  const read = await fetch(`${base}/b/${body.slug}/sync${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elements: [] }) })
  assert.equal(read.status, 200)
})

test('a board opened for editing by link is editable by a guest, and the edit is signed with their name', async () => {
  const { body } = await create({ graph: { nodes: [{ id: 'a' }] } })
  const k = `?k=${body.key}`
  // A guest cannot open the board for editing themselves.
  const sneaky = await fetch(`${base}/b/${body.slug}/meta${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access: 'link' }) })
  assert.equal(sneaky.status, 403)
  const open = await fetch(`${base}/b/${body.slug}/meta${k}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: session() }, body: JSON.stringify({ access: 'link' }) })
  assert.equal((await open.json()).access, 'link')
  const el = { id: 'g1', type: 'diamond', x: 0, y: 300, width: 50, height: 50, version: 1, versionNonce: 1, index: 'b9' }
  const write = await fetch(`${base}/b/${body.slug}/sync${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ elements: [el], guest: 'Kate', client: 'c1' }) })
  assert.equal(write.status, 200)
  assert.deepEqual((await write.json()).viewers.map((v) => v.name), ['guest: Kate'])
  const md = await (await fetch(`${base}/b/${body.slug}.md${k}`)).text()
  assert.match(md, /\[g1\] diamond .* · edited by guest: Kate/)
  assert.match(md, /anyone with the link can edit/)
  // Still, a guest cannot change access.
  const back = await fetch(`${base}/b/${body.slug}/meta${k}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ access: 'team', guest: 'Kate' }) })
  assert.equal(back.status, 403)
})

test('a browser gets an HTML page for "no such board", not JSON', async () => {
  const response = await fetch(`${base}/b/no-such-board-000000000000?k=AAAAAAAAAAAAAAAAAAAAAA`, { headers: { accept: 'text/html' } })
  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type'), /text\/html/)
  assert.match(await response.text(), /No such board/)
})

test('a board from a template, with tags; stickies are signed by their author, reactions are kept by the server', async () => {
  const templates = await (await fetch(`${base}/b/api/templates`)).json()
  assert.ok(templates.templates.some((tpl) => tpl.id === 'retro'))
  const { body: created } = await create({ title: 'Weekly retro', template: 'retro', tags: ['Retro', 'retro', ' Team '], task: 'PROJ-42' })
  const state = await store.get(created.slug)
  assert.deepEqual(state.meta.tags, ['Retro', 'Team'])
  assert.equal(state.meta.task, 'PROJ-42')
  const stickies = store.elements(state).filter((el) => el.customData?.kind === 'sticky')
  assert.equal(stickies.length, 3)
  assert.match(created.summary, /## Stickies/)
  assert.match(created.summary, /Tags: Retro, Team/)
  assert.match(created.summary, /Reference: PROJ-42/)

  const bad = await fetch(`${base}/b/api/boards`, { method: 'POST', headers: auth, body: JSON.stringify({ title: 'Nope', template: 'nope' }) })
  assert.equal(bad.status, 400)

  const react = (emoji, on, author) =>
    fetch(`${base}/b/${created.slug}/react`, { method: 'POST', headers: auth, body: JSON.stringify({ id: stickies[0].id, emoji, on, author }) }).then((r) => r.json())
  await react('👍', true, 'Ada')
  const both = await react('👍', true, 'Grace')
  assert.deepEqual(both.reactions, { '👍': ['Ada', 'Grace'] })
  // Editing or dragging a sticky leaves the votes alone: they live in the notes, not in the element version.
  const stale = { ...stickies[0], version: stickies[0].version + 5, versionNonce: 7, customData: { kind: 'sticky', reactions: {} } }
  store.apply(state, [stale], [], { by: 'Alan' })
  assert.deepEqual(store.notes(state).reactions[stickies[0].id], { '👍': ['Ada', 'Grace'] })
  const moved = store.elements(state).find((el) => el.id === stickies[0].id)
  assert.equal(moved.customData.reactions, undefined)
  // A template sticky has no author, and whoever moved it does not become one.
  assert.equal(moved.customData.author, null)
  assert.match(store.text(state), /👍 2 \(Ada, Grace\)/)
  assert.equal((await react('🔥', true, 'x')).error?.startsWith('emoji'), true)
  // Un-reacting removes the name.
  assert.deepEqual((await react('👍', false, 'Ada')).reactions, { '👍': ['Grace'] })

  const meta = await (await fetch(`${base}/b/${created.slug}/meta`, { method: 'POST', headers: auth, body: JSON.stringify({ tags: 'Architecture, Flow' }) })).json()
  assert.deepEqual(meta.tags, ['Architecture', 'Flow'])
  const listed = (await (await fetch(`${base}/b/api/boards`, { headers: auth })).json()).boards.find((b) => b.slug === created.slug)
  assert.deepEqual(listed.tags, ['Architecture', 'Flow'])
  const lib = await (await fetch(`${base}/b/api/library`)).json()
  assert.ok(lib.libraryItems.length >= 8 && lib.libraryItems.every((i) => i.elements.length))
})

test('the board reference (task) is free-form, up to 64 characters', async () => {
  const { body } = await create()
  const meta = (task) => fetch(`${base}/b/${body.slug}/meta`, { method: 'POST', headers: auth, body: JSON.stringify({ task }) })
  const ok = await (await meta('https://issues.example.com/PROJ-7')).json()
  assert.equal(ok.task, 'https://issues.example.com/PROJ-7')
  assert.equal((await meta('x'.repeat(65))).status, 400)
  assert.equal((await (await meta('')).json()).task, null)
})

test('a new sticky gets its author from the server, not from the client', async () => {
  const { body: created } = await create({ title: 'Stickies' })
  const state = await store.get(created.slug)
  store.apply(state, [{ id: 'st1', type: 'rectangle', version: 1, versionNonce: 1, x: 0, y: 0, width: 10, height: 10, index: 'a0', customData: { kind: 'sticky', author: 'Impostor', reactions: { '👍': ['everyone'] } } }], [], { by: 'Ada Lovelace' })
  const st = store.elements(state).find((el) => el.id === 'st1')
  assert.equal(st.customData.author, 'Ada Lovelace')
  assert.equal(st.customData.reactions, undefined)
  assert.deepEqual(store.notes(state).reactions, {})
})

let oidcApp
let issuerServer
let issuer

before(async () => {
  // A fake OpenID provider: discovery and a token endpoint. The id_token is unsigned — the service does not verify
  // the signature, the token arrives over the direct back channel.
  issuerServer = createServer((req, res) => {
    if (req.url.endsWith('/.well-known/openid-configuration')) {
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token` }))
    }
    if (req.url.endsWith('/token')) {
      const claims = { iss: issuer, aud: 'boards', exp: Math.floor(Date.now() / 1000) + 300, sub: 'u1', given_name: 'Ada', family_name: 'Lovelace', email: 'Ada@example.com', preferred_username: 'ada' }
      const idToken = `x.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.y`
      res.writeHead(200, { 'content-type': 'application/json' })
      return res.end(JSON.stringify({ id_token: idToken }))
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise((resolve) => issuerServer.listen(0, '127.0.0.1', resolve))
  issuer = `http://127.0.0.1:${issuerServer.address().port}/realms/demo`
  oidcApp = await startApp({ config: { auth: { mode: 'oidc', tokens: [TOKEN], sessionSecret: 'test-session-secret', oidc: { issuer, clientId: 'boards', clientSecret: 'secret', scopes: 'openid email profile' } } } })
})

after(async () => {
  await oidcApp.close()
  issuerServer.close()
})

test('OIDC sign-in: PKCE, back to the board, a session scoped to /b', async () => {
  const { status, body } = await oidcApp.createBoard()
  assert.equal(status, 201)
  const next = `/b/${body.slug}?k=${body.key}`
  const login = await fetch(`${oidcApp.base}/b/auth/login?next=${encodeURIComponent(next)}`, { redirect: 'manual' })
  assert.equal(login.status, 302)
  const target = new URL(login.headers.get('location'))
  assert.equal(target.origin + target.pathname, `${issuer}/auth`)
  assert.equal(target.searchParams.get('code_challenge_method'), 'S256')
  assert.equal(target.searchParams.get('redirect_uri'), 'http://boards.test/b/auth/callback')
  assert.equal(target.searchParams.get('scope'), 'openid email profile')
  const flowCookie = login.headers.get('set-cookie').split(';')[0]

  const callback = await fetch(`${oidcApp.base}/b/auth/callback?code=abc&state=${target.searchParams.get('state')}`, { headers: { cookie: flowCookie }, redirect: 'manual' })
  assert.equal(callback.status, 302)
  assert.equal(callback.headers.get('location'), next)
  const cookies = callback.headers.getSetCookie()
  const sessionCookie = cookies.find((c) => c.startsWith('boards_session='))
  assert.match(sessionCookie, /Path=\/b; HttpOnly; SameSite=Lax/)

  const page = await (await fetch(`${oidcApp.base}${next}`, { headers: { cookie: sessionCookie.split(';')[0] } })).text()
  assert.match(page, /"canEdit":true/)
  assert.match(page, /"name":"Ada Lovelace"/)
  assert.match(page, /"email":"ada@example.com"/)
})

test('OIDC: a forged state and a foreign return address do not pass', async () => {
  const login = await fetch(`${oidcApp.base}/b/auth/login?next=${encodeURIComponent('https://evil.example/')}`, { redirect: 'manual' })
  const flowCookie = login.headers.get('set-cookie').split(';')[0]
  const bad = await fetch(`${oidcApp.base}/b/auth/callback?code=abc&state=forged`, { headers: { cookie: flowCookie }, redirect: 'manual' })
  assert.equal(bad.status, 400)
  const good = await fetch(`${oidcApp.base}/b/auth/callback?code=abc&state=${new URL(login.headers.get('location')).searchParams.get('state')}`, { headers: { cookie: flowCookie }, redirect: 'manual' })
  assert.equal(good.headers.get('location'), '/b/')
})

test('large JSON answers are compressed for clients that accept it', async () => {
  const nodes = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, label: `Service number ${i}` }))
  const { body } = await t.createBoard({ title: 'Big board', graph: { nodes } })
  const k = new URL(body.url).searchParams.get('k')
  const res = await fetch(`${t.base}/b/${body.slug}/scene.excalidraw?k=${k}`, { headers: { 'accept-encoding': 'gzip' } })
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-encoding'), 'gzip')
  assert.equal((await res.json()).elements.filter((e) => e.type === 'rectangle').length, 30)
})
