/**
 * Plugins (server/plugins.mjs): loading and versioning, and everything a plugin can add, end to end through HTTP —
 * routes, card resolvers, block actions, board properties, webhooks, events, web modules.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createPluginHost, satisfies, PLUGIN_API_VERSION } from '../server/plugins.mjs'
import { createTranslator } from '../shared/i18n.mjs'
import { CATALOGS } from '../shared/locales/index.mjs'
import { loadConfig } from '../server/config.mjs'
import { startApp, TOKEN } from './helpers/app.mjs'

test('semver ranges', () => {
  const yes = [['1.0.0', '^1.0.0'], ['1.4.2', '^1.2'], ['1.4.2', '~1.4.0'], ['1.4.2', '1.x'], ['1.4.2', '*'], ['1.4.2', '>=1.1 <2'], ['2.0.0', '^1 || ^2'], ['0.2.5', '^0.2.1'], ['1.0.0', '1.0.0'], ['1.9.9', '1']]
  const no = [['2.0.0', '^1.0.0'], ['1.1.0', '^1.2'], ['1.5.0', '~1.4.0'], ['0.3.0', '^0.2.1'], ['1.0.1', '1.0.0'], ['2.0.0', '>=1.1 <2']]
  for (const [v, r] of yes) assert.equal(satisfies(v, r), true, `${v} ∈ ${r}`)
  for (const [v, r] of no) assert.equal(satisfies(v, r), false, `${v} ∉ ${r}`)
  assert.throws(() => satisfies('1.0.0', 'banana'), /not a version range/)
  assert.match(PLUGIN_API_VERSION, /^\d+\.\d+\.\d+$/)
})

test('a plugin must name itself, register, and state a compatible apiVersion — or the server refuses to start', async () => {
  const host = createPluginHost()
  await assert.rejects(host.use({ register() {}, apiVersion: '^1.0.0' }), /export a name/)
  await assert.rejects(host.use({ name: 'x', apiVersion: '^1.0.0' }), /register\(api\)/)
  await assert.rejects(host.use({ name: 'x', register() {} }), /export apiVersion/)
  await assert.rejects(host.use({ name: 'x', apiVersion: '^2.0.0', register() {} }), /needs plugin API \^2\.0\.0; this server provides 1\./)
  await assert.rejects(host.use({ name: 'x', apiVersion: 'soon', register() {} }), /apiVersion/)
  await host.use({ name: 'x', apiVersion: '^1.0.0', register() {} })
  await assert.rejects(host.use({ name: 'x', apiVersion: '^1.0.0', register() {} }), /loaded twice/)
  // A default-exported function counts as register, with name and apiVersion as named exports.
  await host.use({ default: () => {}, name: 'fn-style', apiVersion: '1.x' })
  assert.deepEqual(host.list().map((p) => p.name), ['x', 'fn-style'])
})

test('what a plugin registers is checked at registration, with the plugin named in the error', async () => {
  const host = createPluginHost()
  const bad = (register) => host.use({ name: `p${Math.random().toString(36).slice(2, 8)}`, apiVersion: '^1.0.0', register })
  await assert.rejects(bad((api) => api.addRoute({ path: 'no-slash', handler() {} })), /route: route path "no-slash" must start with \//)
  await assert.rejects(bad((api) => api.addRoute({ method: 'TRACE', handler() {} })), /method TRACE/)
  await assert.rejects(bad((api) => api.addRoute({ scope: 'global', access: 'editor', handler() {} })), /access for a global route/)
  await assert.rejects(bad((api) => api.addBlockAction({ id: 'a', label: 'A' })), /run\(ctx\) is required/)
  await assert.rejects(bad((api) => api.addBlockAction({ id: 'a', label: 'A', icon: '<svg onload="x()">', run() {} })), /icon must be an inline <svg> without scripts/)
  await assert.rejects(bad((api) => api.addMetaField({ id: 'title', label: 'T' })), /built-in property/)
  await assert.rejects(bad((api) => api.addMetaField({ id: 'level', label: 'L', type: 'select' })), /needs options/)
  await assert.rejects(bad((api) => api.addWebhook({ handler() {} })), /give secret or verify/)
  await assert.rejects(bad((api) => api.addCardResolver({ id: 'c', resolve() {} })), /match\(url\), pattern, or both/)
  await assert.rejects(bad((api) => api.addMessages('ru', null)), /messages must be an object/)
})

test('loading from disk: paths, file: URLs; web files must live apart from server code', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'boards-plugin-'))
  try {
    await mkdir(join(dir, 'good', 'web'), { recursive: true })
    await writeFile(join(dir, 'good', 'index.mjs'), "export default { name: 'good', version: '2.1.0', apiVersion: '^1.0.0', web: './web/main.mjs', register(api) { api.addRoute({ path: '/hi', handler: () => ({ hi: api.plugin.name }) }) } }\n")
    await writeFile(join(dir, 'good', 'web', 'main.mjs'), 'export function register() {}\n')
    await mkdir(join(dir, 'mixed'), { recursive: true })
    await writeFile(join(dir, 'mixed', 'index.mjs'), "export const name = 'mixed'\nexport const apiVersion = '^1.0.0'\nexport const web = './web.mjs'\nexport function register() {}\n")
    await writeFile(join(dir, 'broken.mjs'), 'export default {\n')

    const host = createPluginHost()
    const loaded = await host.load(['./good/index.mjs'], { cwd: dir })
    assert.deepEqual(loaded.map((p) => [p.name, p.version]), [['good', '2.1.0']])
    assert.deepEqual(host.clientView().web, ['/b/_plugins/good/main.mjs'])
    assert.equal(host.webDir('good'), join(dir, 'good', 'web'))

    await assert.rejects(createPluginHost().load([pathToFileURL(join(dir, 'mixed', 'index.mjs')).href]), /put web files in their own folder/)
    await assert.rejects(createPluginHost().load([join(dir, 'broken.mjs')]), /plugin .*broken\.mjs: cannot import/)
    await assert.rejects(createPluginHost().load(['./missing.mjs'], { cwd: dir }), /cannot import/)

    // BOARDS_WEB_PLUGINS: https URLs go to the CSP, plain http is refused.
    host.addWeb('https://cdn.example.com/boards/plugin.js')
    assert.deepEqual(host.scriptOrigins(), ['https://cdn.example.com'])
    assert.throws(() => host.addWeb('http://cdn.example.com/x.js'), /use https/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('BOARDS_PLUGINS and BOARDS_WEB_PLUGINS are lists', () => {
  const config = loadConfig({ BOARDS_AUTH: 'none', BOARDS_PLUGINS: '/plugins/a/index.mjs, @acme/boards-plugin', BOARDS_WEB_PLUGINS: 'https://cdn.example.com/x.js' })
  assert.deepEqual(config.plugins, ['/plugins/a/index.mjs', '@acme/boards-plugin'])
  assert.deepEqual(config.webPlugins, ['https://cdn.example.com/x.js'])
  assert.deepEqual(loadConfig({ BOARDS_AUTH: 'none' }).plugins, [])
})

// ---- End to end -------------------------------------------------------------------------------------------------

let t
let board
let key
const events = []
const webhookSecret = 'hook-secret-0123456789'
let webDir

before(async () => {
  webDir = await mkdtemp(join(tmpdir(), 'boards-web-'))
  await mkdir(join(webDir, 'web'))
  await writeFile(join(webDir, 'web', 'index.mjs'), 'export function register(api) {}\n')
  await writeFile(join(webDir, 'server.mjs'), '// server code: never served\n')
  const config = loadConfig({ BOARDS_AUTH: 'none', BOARDS_LOCALE: 'ru' })
  const tr = createTranslator('ru', CATALOGS)
  const host = createPluginHost({ config, t: tr })
  await host.use(
    {
      name: 'demo',
      version: '1.2.3',
      apiVersion: '^1.0.0',
      web: './web/index.mjs',
      register(api) {
        api.addMessages('en', { 'demo.done': 'Mark done', 'demo.marked': { one: '{count} block marked', other: '{count} blocks marked' } })
        api.addMessages('ru', { 'demo.done': 'Отметить готовым', 'demo.marked': { one: 'Отмечен {count} блок', few: 'Отмечено {count} блока', many: 'Отмечено {count} блоков', other: 'Отмечено {count} блока' } })
        api.addRoute({ path: '/echo/:id', method: 'POST', access: 'editor', handler: async (ctx) => ({ id: ctx.params.id, body: await ctx.json(), who: ctx.who, board: ctx.board.slug, title: ctx.board.title }) })
        api.addRoute({ path: '/text', handler: (ctx) => api.reply(201, ctx.board.text().split('\n')[0], { 'x-demo': '1' }) })
        api.addRoute({ path: '/teapot', handler: () => { throw new api.HttpError(418, 'short and stout') } })
        api.addRoute({ path: '/crash', handler: () => { throw new Error('bug in the plugin') } })
        api.addRoute({ path: '/nothing', handler: () => undefined })
        api.addRoute({ scope: 'global', path: '/status', handler: (ctx) => ({ ok: true, who: ctx.who?.kind }) })
        api.addRoute({ scope: 'global', path: '/open', access: 'public', handler: () => ({ open: true }) })
        api.addRoute({ scope: 'global', path: '/agents', access: 'token', handler: async () => ({ boards: (await api.boards.list()).length }) })
        api.addCardResolver({ id: 'demo', pattern: /DEMO-\d+/, match: (url) => url.startsWith('https://demo.example/'), resolve: async (input) => ({ title: `Demo ${input}`, status: { label: 'open', tone: 'success' } }) })
        api.addBlockAction({
          id: 'done',
          label: 'demo.done',
          when: { types: ['rectangle'], min: 1 },
          run: (ctx) => ({
            edit: { update: ctx.selection.map((el) => ({ id: el.id, color: 'green' })) },
            toast: ctx.t('demo.marked', { count: ctx.selection.length }),
            select: ctx.selection.map((el) => el.id),
          }),
        })
        api.addBlockAction({ id: 'boom', label: { en: 'Boom', ru: 'Бум' }, run: () => { throw new api.HttpError(409, 'not now') } })
        api.addMetaField({ id: 'deadline', label: { en: 'Deadline', ru: 'Дедлайн' }, type: 'date', home: true })
        api.addMetaField({ id: 'level', label: 'Level', type: 'select', options: [{ value: 'low', label: { en: 'Low', ru: 'Низкий' } }, { value: 'high' }] })
        api.addMetaField({ id: 'code', label: 'Code', validate: (v) => { if (!/^[A-Z]+$/.test(v)) throw new Error('capital letters only'); return v } })
        api.addWebhook({ path: '/incoming', secret: webhookSecret, handler: async (ctx) => { events.push({ hook: await ctx.json() }); return { received: true } } })
        api.addWebhook({ path: '/signed', verify: api.hmacVerifier({ secret: webhookSecret }), handler: async (ctx) => ({ len: (await ctx.rawBody()).length }) })
        for (const name of ['board.created', 'board.meta', 'board.changed', 'thread.created']) api.on(name, (payload) => events.push({ name, slug: payload.slug }))
        api.on('board.created', () => { throw new Error('a listener bug never breaks a request') })
      },
    },
    { url: pathToFileURL(join(webDir, 'server.mjs')).href },
  )
  t = await startApp({ appOptions: { plugins: host, t: tr }, config: { locale: 'ru' } })
  const created = await t.createBoard({ add: [{ type: 'rectangle', id: 'box', x: 0, y: 0, width: 200, height: 80, label: { text: 'Gateway' } }, { type: 'ellipse', id: 'round', x: 300, y: 0, width: 80, height: 80 }] })
  board = created.body
  key = new URL(board.url).searchParams.get('k')
})

after(async () => {
  await t.close()
  await rm(webDir, { recursive: true, force: true })
})

const url = (path) => `${t.base}${path}`
const b = (path) => url(`/b/${board.slug}${path}${path.includes('?') ? '&' : '?'}k=${key}`)

test('board routes: params, JSON body, who is calling, the board; editor access enforced', async () => {
  const noKey = await fetch(url(`/b/${board.slug}/plugins/demo/text`))
  assert.equal(noKey.status, 404, 'without the key the board does not exist, plugin routes included')
  const viewer = await fetch(b('/plugins/demo/echo/7'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' })
  assert.equal(viewer.status, 403, 'a viewer by key may not use an editor route')
  const asUser = await fetch(b('/plugins/demo/echo/7'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie() }, body: '{"a":1}' })
  assert.equal(asUser.status, 200)
  assert.deepEqual(await asUser.json(), { id: '7', body: { a: 1 }, who: { kind: 'user', name: 'Ada Lovelace', email: 'ada@example.com' }, board: board.slug, title: 'Payment flow' })
  const text = await fetch(b('/plugins/demo/text'))
  assert.equal(text.status, 201)
  assert.equal(text.headers.get('x-demo'), '1')
  assert.match(await text.text(), /Payment flow/)
  assert.equal((await fetch(b('/plugins/demo/nothing'))).status, 204)
  assert.equal((await fetch(b('/plugins/demo/text'), { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })).status, 405)
  assert.equal((await fetch(b('/plugins/demo/unknown'))).status, 404)
  assert.equal((await fetch(b('/plugins/nobody/text'))).status, 404)
  const teapot = await fetch(b('/plugins/demo/teapot'))
  assert.equal(teapot.status, 418)
  assert.deepEqual(await teapot.json(), { error: 'short and stout' })
  const crash = await fetch(b('/plugins/demo/crash'))
  assert.equal(crash.status, 500)
  assert.deepEqual(await crash.json(), { error: 'internal error in plugin demo' })
})

test('global routes: member by default, token-only and public when asked', async () => {
  assert.equal((await fetch(url('/b/plugins/demo/status'))).status, 401)
  assert.deepEqual(await (await fetch(url('/b/plugins/demo/status'), { headers: { cookie: t.cookie() } })).json(), { ok: true, who: 'user' })
  assert.deepEqual(await (await fetch(url('/b/plugins/demo/open'))).json(), { open: true })
  assert.equal((await fetch(url('/b/plugins/demo/agents'), { headers: { cookie: t.cookie() } })).status, 401)
  const agents = await (await fetch(url('/b/plugins/demo/agents'), { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.ok(agents.boards >= 1, 'plugins can list boards')
})

test('card resolvers answer for URLs and text references on the board, and only those', async () => {
  const add = await fetch(b('/edit'), {
    method: 'POST',
    headers: t.agent,
    body: JSON.stringify({ add: [
      { type: 'rectangle', id: 'c1', x: 0, y: 200, width: 260, height: 56, link: 'https://demo.example/9', customData: { kind: 'card', url: 'https://demo.example/9' }, label: { text: 'demo.example/9' } },
      { type: 'rectangle', id: 'c2', x: 300, y: 200, width: 260, height: 96, customData: { kind: 'card', ref: 'ref:demo:DEMO-42' }, label: { text: 'DEMO-42' } },
    ] }),
  })
  assert.equal(add.status, 200, await add.clone().text())
  const answer = await (await fetch(b('/links'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refs: ['link:https://demo.example/9', 'ref:demo:DEMO-42', 'ref:demo:DEMO-1', 'link:https://demo.example/other'] }) })).json()
  assert.equal(answer.meta['link:https://demo.example/9'].title, 'Demo https://demo.example/9')
  assert.deepEqual(answer.meta['ref:demo:DEMO-42'], { kind: 'demo', title: 'Demo DEMO-42', status: { label: 'open', tone: 'success' } })
  assert.equal(answer.meta['ref:demo:DEMO-1'], null, 'not on this board → no answer')
  assert.equal(answer.meta['link:https://demo.example/other'], null)
})

test('block actions run on the server, edit the board as the person, and answer with a toast in the interface language', async () => {
  const run = (id, ids, headers = { 'content-type': 'application/json', cookie: t.cookie() }) => fetch(b(`/actions/demo/${id}`), { method: 'POST', headers, body: JSON.stringify({ ids }) })
  assert.equal((await run('done', ['box'], { 'content-type': 'application/json' })).status, 403, 'viewers cannot run actions')
  assert.equal((await run('done', ['round'])).status, 400, 'an ellipse does not fit `types: rectangle`')
  assert.equal((await run('done', [])).status, 400, 'nothing selected')
  assert.equal((await run('missing', ['box'])).status, 404)
  const response = await run('done', ['box'])
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.toast, 'Отмечен 1 блок')
  assert.deepEqual(body.select, ['box'])
  assert.ok(body.rev > 0)
  const scene = await (await fetch(b('/scene.excalidraw'))).json()
  const box = scene.elements.find((el) => el.id === 'box')
  assert.notEqual(box.strokeColor, '#1e1e1e', 'the edit landed')
  const boom = await run('boom', ['box'])
  assert.equal(boom.status, 409)
  // A label counts as its shape: selecting the text inside the box selects the box.
  const label = scene.elements.find((el) => el.containerId === 'box')
  assert.equal((await run('done', [label.id])).status, 200)
})

test('board properties from plugins: validated, stored, sent to the editor and shown on the boards list', async () => {
  const meta = (body) => fetch(b('/meta'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie() }, body: JSON.stringify(body) })
  assert.equal((await meta({ fields: { deadline: '2026-02-30' } })).status, 400)
  assert.equal((await meta({ fields: { level: 'medium' } })).status, 400)
  assert.equal((await meta({ fields: { nope: 1 } })).status, 400)
  const badCode = await meta({ fields: { code: 'abc' } })
  assert.equal(badCode.status, 400)
  assert.match((await badCode.json()).error, /capital letters only/)
  const ok = await meta({ fields: { deadline: '2020-01-15', level: 'low', code: 'ABC' } })
  assert.equal(ok.status, 200)
  assert.deepEqual((await ok.json()).fields, { deadline: '2020-01-15', level: 'low', code: 'ABC' })
  assert.deepEqual((await (await meta({ fields: { code: null } })).json()).fields, { deadline: '2020-01-15', level: 'low' }, 'null removes a value')

  const json = await (await fetch(b('.json'))).json()
  assert.deepEqual(json.fields, { deadline: '2020-01-15', level: 'low' })
  const page = await (await fetch(b(''), { headers: { cookie: t.cookie() } })).text()
  const config = JSON.parse(/id="board-config">(.*?)<\/script>/s.exec(page)[1])
  assert.deepEqual(config.fields, { deadline: '2020-01-15', level: 'low' })
  assert.equal(config.locale, 'ru')
  assert.deepEqual(config.plugins.fields.map((f) => [f.id, f.label]), [['deadline', 'Дедлайн'], ['level', 'Level'], ['code', 'Code']])
  assert.deepEqual(config.plugins.fields[1].options, [{ value: 'low', label: 'Низкий' }, { value: 'high', label: 'high' }])
  assert.deepEqual(config.plugins.actions.map((a) => [a.id, a.label]), [['done', 'Отметить готовым'], ['boom', 'Бум']])
  assert.deepEqual(config.plugins.patterns, [{ resolver: 'demo', source: 'DEMO-\\d+', flags: '' }])
  assert.equal(config.plugins.cardsForLinks, true)
  assert.deepEqual(config.plugins.web, ['/b/_plugins/demo/index.mjs'])
  assert.match(page, /<html lang="ru">/)

  const home = await (await fetch(url('/b/'), { headers: { cookie: t.cookie() } })).text()
  assert.match(home, /data-field="deadline">Дедлайн: <b>15 янв\. 2020 г\.<\/b>/)
  assert.match(home, /class="field overdue" data-field="deadline"/, 'a date in the past is marked overdue')
  assert.doesNotMatch(home, /data-field="level"/, 'only fields marked home are listed')

  // Stored with the board: a fresh read from storage keeps them.
  await t.store.flushAll()
  const listed = (await (await fetch(url('/b/api/boards'), { headers: { authorization: `Bearer ${TOKEN}` } })).json()).boards.find((x) => x.slug === board.slug)
  assert.deepEqual(listed.fields, { deadline: '2020-01-15', level: 'low' })
})

test('webhooks: a shared secret or an HMAC signature; anything else is refused', async () => {
  const post = (path, body, headers = {}) => fetch(url(`/b/hooks/demo${path}`), { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example', ...headers }, body })
  assert.equal((await post('/incoming', '{"x":1}')).status, 401)
  assert.equal((await post('/incoming', '{"x":1}', { 'x-boards-webhook-secret': 'wrong' })).status, 401)
  const ok = await post('/incoming', '{"x":1}', { 'x-boards-webhook-secret': webhookSecret })
  assert.equal(ok.status, 200)
  assert.deepEqual(await ok.json(), { received: true })
  assert.deepEqual(events.find((e) => e.hook)?.hook, { x: 1 })
  const raw = '{"action":"opened","текст":"ü"}'
  const signature = `sha256=${createHmac('sha256', webhookSecret).update(Buffer.from(raw)).digest('hex')}`
  assert.equal((await post('/signed', raw, { 'x-hub-signature-256': 'sha256=00' })).status, 401)
  const signed = await post('/signed', raw, { 'x-hub-signature-256': signature })
  assert.equal(signed.status, 200)
  assert.deepEqual(await signed.json(), { len: Buffer.byteLength(raw) })
  assert.equal((await fetch(url('/b/hooks/demo/incoming'))).status, 405)
  assert.equal((await post('/nope', '{}')).status, 404)
})

test('events reach plugin listeners; a throwing listener breaks nothing', async () => {
  const created = await t.createBoard({ title: 'Events board' })
  assert.equal(created.status, 201)
  const k = new URL(created.body.url).searchParams.get('k')
  await fetch(url(`/b/${created.body.slug}/comments?k=${k}`), { method: 'POST', headers: t.agent, body: JSON.stringify({ text: 'hello', x: 1, y: 2 }) })
  await fetch(url(`/b/${created.body.slug}/meta?k=${k}`), { method: 'POST', headers: t.agent, body: JSON.stringify({ description: 'changed' }) })
  const names = events.filter((e) => e.slug === created.body.slug).map((e) => e.name)
  assert.ok(names.includes('board.created'), names.join())
  assert.ok(names.includes('thread.created'), names.join())
  assert.ok(names.includes('board.meta'), names.join())
})

test('web plugin files are served from their own folder only, and the API lists plugins', async () => {
  const js = await fetch(url('/b/_plugins/demo/index.mjs'))
  assert.equal(js.status, 200)
  assert.match(js.headers.get('content-type'), /javascript/)
  assert.equal((await fetch(url('/b/_plugins/demo/../server.mjs'))).status, 404)
  assert.equal((await fetch(url('/b/_plugins/demo/%2e%2e/server.mjs'))).status, 404)
  assert.equal((await fetch(url('/b/_plugins/nobody/index.mjs'))).status, 404)
  assert.equal((await fetch(url('/b/api/plugins'))).status, 401)
  const listed = await (await fetch(url('/b/api/plugins'), { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.equal(listed.apiVersion, PLUGIN_API_VERSION)
  assert.deepEqual(listed.plugins.map((p) => [p.name, p.version]), [['demo', '1.2.3']])
})

test('a server without plugins behaves as before: no plugin routes, nothing extra in the page', async () => {
  const plain = await startApp()
  try {
    const { body } = await plain.createBoard()
    const k = new URL(body.url).searchParams.get('k')
    assert.equal((await fetch(`${plain.base}/b/${body.slug}/plugins/demo/text?k=${k}`)).status, 404)
    assert.equal((await fetch(`${plain.base}/b/${body.slug}/actions/demo/done?k=${k}`, { method: 'POST', headers: plain.agent, body: '{}' })).status, 404)
    const page = await (await fetch(`${plain.base}/b/${body.slug}?k=${k}`)).text()
    const config = JSON.parse(/id="board-config">(.*?)<\/script>/s.exec(page)[1])
    assert.deepEqual(config.plugins, { web: [], actions: [], fields: [], patterns: [], cardsForLinks: false, apiVersion: PLUGIN_API_VERSION })
    assert.deepEqual(config.flags, {})
    assert.equal(config.locale, 'en')
    const csp = (await fetch(`${plain.base}/b/${body.slug}?k=${k}`)).headers.get('content-security-policy')
    assert.match(csp, /script-src 'self' 'wasm-unsafe-eval';/)
  } finally {
    await plain.close()
  }
})

test('remote web plugins are allowed by the editor CSP, and only those origins', async () => {
  const host = createPluginHost()
  host.addWeb('https://cdn.example.com/boards/plugin.js')
  const remote = await startApp({ appOptions: { plugins: host } })
  try {
    const { body } = await remote.createBoard()
    const k = new URL(body.url).searchParams.get('k')
    const response = await fetch(`${remote.base}/b/${body.slug}?k=${k}`)
    assert.match(response.headers.get('content-security-policy'), /script-src 'self' 'wasm-unsafe-eval' https:\/\/cdn\.example\.com;/)
    const config = JSON.parse(/id="board-config">(.*?)<\/script>/s.exec(await response.text())[1])
    assert.deepEqual(config.plugins.web, ['https://cdn.example.com/boards/plugin.js'])
  } finally {
    await remote.close()
  }
})
