/**
 * HTTP surface added for the standalone server: board JSON, the members API, search, oEmbed, sign-in hand-off,
 * CORS and CSRF rules, frame-ancestors, history and restore, the boards list page, token-mode sign-in and
 * auth-less local mode.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, PUBLIC_URL, TOKEN } from './helpers/app.mjs'

let t
let base

before(async () => {
  t = await startApp({ config: { corsOrigins: ['https://app.example'], frameAncestors: "'self' https://workspace.example" } })
  base = t.base
})

after(async () => {
  await t.close()
})

const json = (response) => response.json()

test('GET /b/<slug>.json returns metadata, links and text; a wrong key is 404', async () => {
  const { body } = await t.createBoard({ title: 'Release plan', description: 'What ships when', tags: ['plan'], graph: { nodes: [{ id: 'a', label: 'Freeze' }] } })
  const response = await fetch(`${base}/b/${body.slug}.json?k=${body.key}`)
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /application\/json/)
  const board = await response.json()
  assert.equal(board.slug, body.slug)
  assert.equal(board.title, 'Release plan')
  assert.equal(board.description, 'What ships when')
  assert.deepEqual(board.tags, ['plan'])
  assert.equal(board.access, 'team')
  assert.equal(board.url, `${PUBLIC_URL}/b/${body.slug}?k=${body.key}`)
  assert.equal(board.markdown, `${PUBLIC_URL}/b/${body.slug}.md?k=${body.key}`)
  assert.equal(board.embed, `${PUBLIC_URL}/b/${body.slug}?k=${body.key}&embed=1`)
  assert.equal(board.live, `ws://boards.test/b/${body.slug}/live?k=${body.key}`)
  assert.equal(board.stats.shapes, 1)
  assert.equal(board.preview, null)
  assert.match(board.text, /\[a\] rectangle "Freeze"/)
  assert.equal((await fetch(`${base}/b/${body.slug}.json?k=AAAAAAAAAAAAAAAAAAAAAA`)).status, 404)
})

test('GET /b/api/boards/<slug>: a member needs no key, an anonymous caller gets 401', async () => {
  const { body } = await t.createBoard({ title: 'Members only' })
  const member = await fetch(`${base}/b/api/boards/${body.slug}`, { headers: { cookie: t.cookie() } })
  assert.equal(member.status, 200)
  const board = await member.json()
  assert.equal(board.key, body.key)
  assert.equal(board.title, 'Members only')
  const agent = await fetch(`${base}/b/api/boards/${body.slug}`, { headers: t.agent })
  assert.equal(agent.status, 200)
  assert.equal((await fetch(`${base}/b/api/boards/${body.slug}`)).status, 401)
  assert.equal((await fetch(`${base}/b/api/boards/${body.slug}?k=${body.key}`)).status, 401)
  assert.equal((await fetch(`${base}/b/api/boards/no-such-board-000000000000`, { headers: t.agent })).status, 404)
})

test('?q= filters the list by title, description and tags; ?tag= by exact tag', async () => {
  const marker = `zebra${Date.now()}`
  const { body: a } = await t.createBoard({ title: `Zebra crossing ${marker}` })
  const { body: b } = await t.createBoard({ title: 'Other', description: `mentions ${marker.toUpperCase()}` })
  const { body: c } = await t.createBoard({ title: 'Tagged', tags: [marker] })
  await t.createBoard({ title: 'Unrelated' })
  const list = async (query) => (await json(await fetch(`${base}/b/api/boards?${query}`, { headers: t.agent }))).boards.map((x) => x.slug).sort()
  assert.deepEqual(await list(`q=${marker}`), [a.slug, b.slug, c.slug].sort())
  assert.deepEqual(await list(`tag=${marker}`), [c.slug])
  const listed = (await json(await fetch(`${base}/b/api/boards?q=${marker}`, { headers: t.agent }))).boards.find((x) => x.slug === a.slug)
  assert.equal(listed.url, `${PUBLIC_URL}/b/${a.slug}?k=${a.key}`)
  assert.equal(listed.preview, null)
  assert.equal((await fetch(`${base}/b/api/boards`)).status, 401)
})

test('oEmbed: a board URL unfurls into an embed iframe; a wrong key or a foreign origin is 404', async () => {
  const { body } = await t.createBoard({ title: 'Unfurl <me>' })
  const ask = (url, extra = '') => fetch(`${base}/b/api/oembed?url=${encodeURIComponent(url)}${extra}`)
  const ok = await ask(body.url, '&maxwidth=640&maxheight=9999')
  assert.equal(ok.status, 200)
  const embed = await ok.json()
  assert.equal(embed.version, '1.0')
  assert.equal(embed.type, 'rich')
  assert.equal(embed.provider_name, 'boards')
  assert.equal(embed.title, 'Unfurl <me>')
  assert.equal(embed.author_name, 'agent')
  assert.equal(embed.width, 640)
  assert.equal(embed.height, 1200)
  assert.ok(embed.html.includes(`src="${PUBLIC_URL}/b/${body.slug}?k=${body.key}&amp;embed=1"`), embed.html)
  assert.match(embed.html, /^<iframe /)
  assert.doesNotMatch(embed.html, /title="[^"]*[<>]/)
  assert.equal((await ask(`${PUBLIC_URL}/b/${body.slug}?k=AAAAAAAAAAAAAAAAAAAAAA`)).status, 404)
  assert.equal((await ask(`https://elsewhere.example/b/${body.slug}?k=${body.key}`)).status, 404)
  assert.equal((await ask(`${PUBLIC_URL}/b/${body.slug}/scene.excalidraw?k=${body.key}`)).status, 404)
  assert.equal((await ask('not a url')).status, 400)
  // The editor page advertises oEmbed discovery.
  const page = await (await fetch(`${base}/b/${body.slug}?k=${body.key}`)).text()
  assert.match(page, /<link rel="alternate" type="application\/json\+oembed" href="\/b\/api\/oembed\?url=/)
})

test('hand-off: an agent mints a one-time sign-in link; it sets the session and redirects once', async () => {
  const { body: board } = await t.createBoard({ title: 'Handed off' })
  const next = `/b/${board.slug}?k=${board.key}`
  const minted = await fetch(`${base}/b/api/handoff`, { method: 'POST', headers: t.agent, body: JSON.stringify({ user: { id: 'u-7', name: 'Grace Hopper', email: 'grace@example.com' }, next }) })
  assert.equal(minted.status, 201)
  const { url } = await minted.json()
  assert.ok(url.startsWith(`${PUBLIC_URL}/b/auth/handoff?t=`), url)
  const path = url.slice(PUBLIC_URL.length)

  const first = await fetch(`${base}${path}`, { redirect: 'manual' })
  assert.equal(first.status, 302)
  assert.equal(first.headers.get('location'), next)
  const cookie = first.headers.getSetCookie().find((c) => c.startsWith('boards_session='))
  assert.ok(cookie, 'a session cookie is set')
  const page = await (await fetch(`${base}${next}`, { headers: { cookie: cookie.split(';')[0] } })).text()
  assert.match(page, /"name":"Grace Hopper"/)
  assert.match(page, /"canEdit":true/)

  const second = await fetch(`${base}${path}`, { redirect: 'manual' })
  assert.equal(second.status, 400)
  assert.equal((await fetch(`${base}/b/auth/handoff?t=garbage`, { redirect: 'manual' })).status, 400)

  // Only API tokens may mint links, and a name is required.
  assert.equal((await fetch(`${base}/b/api/handoff`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie() }, body: JSON.stringify({ user: { name: 'Mallory' } }) })).status, 401)
  assert.equal((await fetch(`${base}/b/api/handoff`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ user: { name: 'Mallory' } }) })).status, 401)
  assert.equal((await fetch(`${base}/b/api/handoff`, { method: 'POST', headers: t.agent, body: JSON.stringify({ user: {} }) })).status, 400)
  // A foreign `next` falls back to the boards list.
  const foreign = await json(await fetch(`${base}/b/api/handoff`, { method: 'POST', headers: t.agent, body: JSON.stringify({ user: { name: 'Grace Hopper' }, next: 'https://evil.example/' }) }))
  assert.equal((await fetch(`${base}${foreign.url.slice(PUBLIC_URL.length)}`, { redirect: 'manual' })).headers.get('location'), '/b/')
})

test('CORS: an allowed origin gets access-control headers, others do not; OPTIONS preflight is 204', async () => {
  const { body } = await t.createBoard({ title: 'Cross origin' })
  const allowed = await fetch(`${base}/b/${body.slug}.json?k=${body.key}`, { headers: { origin: 'https://app.example' } })
  assert.equal(allowed.status, 200)
  assert.equal(allowed.headers.get('access-control-allow-origin'), 'https://app.example')
  assert.match(allowed.headers.get('access-control-expose-headers'), /x-board-rev/)
  assert.match(allowed.headers.get('vary'), /origin/i)

  const other = await fetch(`${base}/b/${body.slug}.json?k=${body.key}`, { headers: { origin: 'https://other.example' } })
  assert.equal(other.headers.get('access-control-allow-origin'), null)

  const preflight = await fetch(`${base}/b/api/boards`, { method: 'OPTIONS', headers: { origin: 'https://app.example', 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization, content-type' } })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://app.example')
  assert.match(preflight.headers.get('access-control-allow-methods'), /POST/)
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/)

  // An allowed origin may use a bearer token...
  const created = await fetch(`${base}/b/api/boards`, { method: 'POST', headers: { ...t.agent, origin: 'https://app.example' }, body: JSON.stringify({ title: 'From the app' }) })
  assert.equal(created.status, 201)
  // ...but never the visitor's session: from another origin the cookie does not count.
  const withCookie = await fetch(`${base}/b/api/boards`, { headers: { cookie: t.cookie(), origin: 'https://app.example' } })
  assert.equal(withCookie.status, 401)
})

test('CSRF: a cross-site POST carrying a session is refused; the same request from our origin passes', async () => {
  const { body } = await t.createBoard({ title: 'Guarded' })
  const post = (origin) => fetch(`${base}/b/${body.slug}/meta?k=${body.key}`, { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie(), origin }, body: JSON.stringify({ title: 'Renamed' }) })
  const evil = await post('https://evil.example')
  assert.equal(evil.status, 403)
  assert.match((await evil.json()).error, /cross-origin/)
  assert.equal((await t.store.get(body.slug)).meta.title, 'Guarded')
  const same = await post(PUBLIC_URL)
  assert.equal(same.status, 200)
  assert.equal((await same.json()).title, 'Renamed')
  // An allowed CORS origin may POST, but its cookie does not make it a member.
  assert.equal((await post('https://app.example')).status, 403)
})

test('frame-ancestors from config is in the editor CSP and absent in ?embed=1', async () => {
  const { body } = await t.createBoard({ title: 'Framed' })
  const editor = await fetch(`${base}/b/${body.slug}?k=${body.key}`)
  assert.match(editor.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/workspace\.example(;|$)/)
  const embed = await fetch(`${base}/b/${body.slug}?k=${body.key}&embed=1`)
  assert.doesNotMatch(embed.headers.get('content-security-policy'), /frame-ancestors/)
  // The list and sign-in pages use the same setting.
  const login = await fetch(`${base}/b/auth/login`)
  assert.match(login.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/workspace\.example/)
})

test('history: list snapshots, read one, restore brings back a deleted shape; a guest cannot restore', async () => {
  const { body } = await t.createBoard({ title: 'With history', access: 'link', graph: { nodes: [{ id: 'keep', label: 'Keep' }, { id: 'lost', label: 'Lost' }] } })
  const k = `?k=${body.key}`
  const list = await json(await fetch(`${base}/b/${body.slug}/history${k}`))
  assert.ok(list.snapshots.length >= 1, 'the first write is snapshotted')
  const snap = list.snapshots.at(-1)
  assert.equal(snap.source, 'auto')
  assert.equal(snap.elements > 0, true)

  const scene = await json(await fetch(`${base}/b/${body.slug}/history/${snap.id}${k}`))
  assert.equal(scene.id, snap.id)
  assert.ok(scene.elements.some((el) => el.id === 'lost' && !el.isDeleted))
  assert.equal((await fetch(`${base}/b/${body.slug}/history/20000101T000000000Z${k}`)).status, 404)
  assert.equal((await fetch(`${base}/b/${body.slug}/history/..%2Fmeta${k}`)).status, 404)
  assert.equal((await fetch(`${base}/b/${body.slug}/history${'?k=AAAAAAAAAAAAAAAAAAAAAA'}`)).status, 404)

  const deleted = await fetch(`${base}/b/${body.slug}/edit${k}`, { method: 'POST', headers: t.agent, body: JSON.stringify({ delete: ['lost'] }) })
  assert.equal(deleted.status, 200)
  const state = await t.store.get(body.slug)
  assert.equal(t.store.elements(state).some((el) => el.id === 'lost'), false)

  const restore = (headers, extra = {}) => fetch(`${base}/b/${body.slug}/history/${snap.id}/restore${k}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(extra) })
  const guest = await restore({}, { guest: 'Kate' })
  assert.equal(guest.status, 403)
  assert.equal(t.store.elements(state).some((el) => el.id === 'lost'), false)

  const restored = await restore({ cookie: t.cookie() })
  assert.equal(restored.status, 200)
  const result = await restored.json()
  assert.ok(result.changed > 0)
  assert.ok(t.store.elements(state).some((el) => el.id === 'lost'))
  assert.match(t.store.text(state), /\[lost\] rectangle "Lost"/)
  assert.equal((await fetch(`${base}/b/${body.slug}/history/20000101T000000000Z/restore${k}`, { method: 'POST', headers: t.agent, body: '{}' })).status, 404)
  // The restore leaves a marker in history (written in the background).
  let marker = null
  for (let i = 0; i < 100 && !marker; i++) {
    marker = (await json(await fetch(`${base}/b/${body.slug}/history${k}`))).snapshots.find((s) => s.source === 'restore') ?? null
    if (!marker) await new Promise((resolve) => setTimeout(resolve, 50))
  }
  assert.ok(marker, 'a restore snapshot is listed')
  assert.equal(marker.by, 'Ada Lovelace')
})

test('the boards list page: anonymous visitors go to sign-in, members see their boards', async () => {
  const { body } = await t.createBoard({ title: 'Listed on home' })
  const anonymous = await fetch(`${base}/b/`, { redirect: 'manual' })
  assert.equal(anonymous.status, 302)
  assert.ok(anonymous.headers.get('location').startsWith('/b/auth/login'), anonymous.headers.get('location'))
  const root = await fetch(`${base}/`, { redirect: 'manual' })
  assert.equal(root.headers.get('location'), '/b/')

  const page = await fetch(`${base}/b/`, { headers: { cookie: t.cookie() } })
  assert.equal(page.status, 200)
  assert.match(page.headers.get('content-type'), /text\/html/)
  const html = await page.text()
  assert.ok(html.includes('Listed on home'))
  assert.ok(html.includes(`/b/${body.slug}?k=${body.key}`))
  assert.ok(html.includes('Ada Lovelace'))
  const filtered = await (await fetch(`${base}/b/?q=nothing-matches-this`, { headers: { cookie: t.cookie() } })).text()
  assert.ok(!filtered.includes('Listed on home'))
  assert.match(filtered, /No boards match/)
})

test('token-mode sign-in: the right token and a name give a session; a wrong token is 401', async () => {
  const form = await fetch(`${base}/b/auth/login?next=/b/`)
  assert.equal(form.status, 200)
  assert.match(await form.text(), /<form method="post" action="\/b\/auth\/login">/)

  const submit = (fields) => fetch(`${base}/b/auth/login`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString(), redirect: 'manual' })
  const ok = await submit({ token: TOKEN, name: 'Ada Lovelace', next: '/b/' })
  assert.equal(ok.status, 302)
  assert.equal(ok.headers.get('location'), '/b/')
  const cookie = ok.headers.getSetCookie().find((c) => c.startsWith('boards_session='))
  assert.match(cookie, /Path=\/b; HttpOnly; SameSite=Lax/)
  const home = await fetch(`${base}/b/`, { headers: { cookie: cookie.split(';')[0] } })
  assert.equal(home.status, 200)

  const wrong = await submit({ token: 'not-the-token', name: 'Ada Lovelace', next: '/b/' })
  assert.equal(wrong.status, 401)
  assert.match(await wrong.text(), /That token is not valid/)
  assert.equal(wrong.headers.getSetCookie().length, 0)
  const nameless = await submit({ token: TOKEN, name: '  ', next: '/b/' })
  assert.equal(nameless.status, 401)

  const logout = await fetch(`${base}/b/auth/logout?next=/b/`, { redirect: 'manual' })
  assert.equal(logout.status, 302)
  assert.match(logout.headers.getSetCookie()[0], /^boards_session=; .*Max-Age=0/)
})

test('auth none: everyone is the signed-in user "local" and can list and create boards', async () => {
  const local = await startApp({ config: { auth: { mode: 'none', tokens: [] } } })
  try {
    const created = await fetch(`${local.base}/b/api/boards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Local board' }) })
    assert.equal(created.status, 201)
    const board = await created.json()
    const list = await json(await fetch(`${local.base}/b/api/boards`))
    assert.ok(list.boards.some((b) => b.slug === board.slug && b.author === 'local'))
    const page = await (await fetch(`${local.base}/b/${board.slug}?k=${board.key}`)).text()
    assert.match(page, /"user":\{"name":"local"/)
    assert.match(page, /"canEdit":true/)
    assert.match(page, /"authEnabled":false/)
    const home = await fetch(`${local.base}/b/`)
    assert.equal(home.status, 200)
    assert.doesNotMatch(await home.text(), /Sign out/)
    const login = await fetch(`${local.base}/b/auth/login?next=/b/`, { redirect: 'manual' })
    assert.equal(login.headers.get('location'), '/b/')
  } finally {
    await local.close()
  }
})

test('API help, templates and probes are public', async () => {
  const help = await fetch(`${base}/b/api`)
  assert.equal(help.status, 200)
  assert.match(help.headers.get('content-type'), /text\/markdown/)
  const health = await json(await fetch(`${base}/healthz`))
  assert.equal(health.ok, true)
  assert.equal(health.epoch, t.store.epoch)
  assert.equal((await fetch(`${base}/readyz`)).status, 200)
  assert.equal((await fetch(`${base}/nowhere`)).status, 404)
})
