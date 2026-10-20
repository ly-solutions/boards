/**
 * The example plugin (examples/plugin-example): it loads from disk like any plugin, and its parts work end to end.
 * GitHub is faked — nothing here touches the network.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createPluginHost } from '../server/plugins.mjs'
import { createFlags } from '../server/flags.mjs'
import { examplePlugin, githubResolver, parseIssue, stickiesToChecklist } from '../examples/plugin-example/index.mjs'
import { startApp, TOKEN } from './helpers/app.mjs'

const EXAMPLE = fileURLToPath(new URL('../examples/plugin-example/index.mjs', import.meta.url))

/** A fake GitHub REST API: one open issue, one merged pull request. */
function fakeGitHub() {
  const calls = []
  const fetchImpl = async (url, init) => {
    calls.push({ url, headers: init.headers })
    const m = /\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/.exec(url)
    const issues = {
      'acme/rockets/12': { title: 'Engine stalls on cold start', state: 'open', html_url: 'https://github.com/acme/rockets/issues/12', updated_at: '2026-10-01T10:00:00Z', labels: [{ name: 'bug' }, { name: 'p1' }], assignee: { login: 'ada' } },
      'acme/rockets/13': { title: 'Faster fuel pump', state: 'closed', html_url: 'https://github.com/acme/rockets/pull/13', updated_at: '2026-10-02T10:00:00Z', labels: [], pull_request: { merged_at: '2026-10-02T09:00:00Z' } },
    }
    const data = m && issues[`${m[1]}/${m[2]}/${m[3]}`]
    return data ? new Response(JSON.stringify(data), { status: 200 }) : new Response('{"message":"Not Found"}', { status: 404 })
  }
  return { calls, fetchImpl }
}

test('the example loads from disk as a real plugin would', async () => {
  const host = createPluginHost({ flags: createFlags() })
  const [plugin] = await host.load([EXAMPLE])
  assert.deepEqual([plugin.name, plugin.version, plugin.apiVersion], ['example', '1.0.0', '^1.0.0'])
  const view = host.clientView()
  assert.deepEqual(view.web, ['/b/_plugins/example/index.mjs'])
  assert.deepEqual(view.actions.map((a) => a.id), ['checklist'])
  assert.deepEqual(view.fields.map((f) => [f.id, f.type, f.home]), [['deadline', 'date', true]])
})

test('GitHub references: URLs of issues and pull requests, and owner/repo#123', () => {
  assert.deepEqual(parseIssue('https://github.com/acme/rockets/issues/12'), { owner: 'acme', repo: 'rockets', number: 12 })
  assert.deepEqual(parseIssue('https://github.com/acme/rockets/pull/13#discussion'), { owner: 'acme', repo: 'rockets', number: 13 })
  assert.deepEqual(parseIssue('acme/rockets#7'), { owner: 'acme', repo: 'rockets', number: 7 })
  assert.equal(parseIssue('https://github.com/acme/rockets'), null)
  assert.equal(parseIssue('https://gitlab.example/acme/rockets/issues/1'), null)
})

test('the GitHub resolver builds cards from the API, with a token when given', async () => {
  const { calls, fetchImpl } = fakeGitHub()
  const resolver = githubResolver({ token: 'gh-test-token', fetchImpl, t: (key) => key.replace('example.', '') })
  const signal = new AbortController().signal
  const { icon, ...card } = await resolver.resolve('https://github.com/acme/rockets/issues/12', { signal })
  assert.match(icon, /^data:image\/svg\+xml;base64,/)
  assert.deepEqual(card, {
    kind: 'github.issue',
    title: '#12 Engine stalls on cold start',
    site: 'acme/rockets',
    status: { label: 'open', tone: 'success' },
    url: 'https://github.com/acme/rockets/issues/12',
    updatedAt: '2026-10-01T10:00:00Z',
    subtitle: 'bug · p1',
    fields: [{ label: 'assignee', value: 'ada' }],
  })
  assert.equal(calls[0].url, 'https://api.github.com/repos/acme/rockets/issues/12')
  assert.equal(calls[0].headers.authorization, 'Bearer gh-test-token')
  const pr = await resolver.resolve('acme/rockets#13', { signal })
  assert.deepEqual([pr.site, pr.status], ['acme/rockets · PR', { label: 'merged', tone: 'info' }])
  assert.equal(await resolver.resolve('acme/rockets#99', { signal }), null)
  assert.ok(resolver.match('https://github.com/acme/rockets/issues/12'))
  assert.equal(resolver.match('https://github.com/acme/rockets'), null)
})

test('stickies become one checklist, top to bottom, left to right', () => {
  const sticky = (id, x, y, text) => ({ id, type: 'rectangle', x, y, width: 160, height: 160, text, customData: { kind: 'sticky' } })
  const result = stickiesToChecklist({
    selection: [sticky('c', 400, 10, 'Third\nline'), sticky('a', 0, 0, 'First'), sticky('b', 200, 5, 'Second'), sticky('d', 0, 300, 'Fourth'), { id: 'x', type: 'ellipse', x: 0, y: 0, width: 1, height: 1, text: 'not a sticky' }],
    t: (key, vars) => `${key}:${vars.count}`,
  })
  assert.deepEqual(result.edit, { add: [{ type: 'text', x: 0, y: 0, text: '☐ First\n☐ Second\n☐ Third line\n☐ Fourth', fontSize: 20 }], delete: ['a', 'b', 'c', 'd'] })
  assert.equal(result.toast, 'example.checklistDone:4')
})

let t
let board
let key
let github
const secret = 'example-webhook-secret'

before(async () => {
  github = fakeGitHub()
  const flags = createFlags()
  const host = createPluginHost({ flags, env: { GITHUB_WEBHOOK_SECRET: secret, EXAMPLE_BETA_DOMAIN: 'example.com' } })
  await host.use({ default: examplePlugin({ fetchImpl: github.fetchImpl }) }, { url: new URL('../examples/plugin-example/index.mjs', import.meta.url).href })
  t = await startApp({ appOptions: { plugins: host, flags } })
  const created = await t.createBoard({
    title: 'Planning',
    add: [
      { type: 'rectangle', id: 's1', x: 0, y: 0, width: 160, height: 160, label: { text: 'Write docs' }, customData: { kind: 'sticky' } },
      { type: 'rectangle', id: 's2', x: 200, y: 0, width: 160, height: 160, label: { text: 'Ship it' }, customData: { kind: 'sticky' } },
      { type: 'rectangle', id: 'gh', x: 0, y: 300, width: 288, height: 96, customData: { kind: 'card', ref: 'ref:github:acme/rockets#12' }, label: { text: 'acme/rockets#12' } },
      { type: 'rectangle', id: 'gh2', x: 300, y: 300, width: 264, height: 56, link: 'https://github.com/acme/rockets/pull/13', customData: { kind: 'card', url: 'https://github.com/acme/rockets/pull/13' }, label: { text: 'github.com/acme/rockets/pull/13' } },
    ],
  })
  board = created.body
  key = new URL(board.url).searchParams.get('k')
})

after(async () => {
  await t.close()
})

const b = (path) => `${t.base}/b/${board.slug}${path}?k=${key}`

test('end to end: cards, the checklist action, the stats route and the deadline', async () => {
  const links = await (await fetch(b('/links'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refs: ['ref:github:acme/rockets#12', 'link:https://github.com/acme/rockets/pull/13'] }) })).json()
  assert.equal(links.meta['ref:github:acme/rockets#12'].title, '#12 Engine stalls on cold start')
  assert.equal(links.meta['ref:github:acme/rockets#12'].status.label, 'open')
  assert.equal(links.meta['link:https://github.com/acme/rockets/pull/13'].status.label, 'merged')

  const stats = await (await fetch(b('/plugins/example/stats'))).json()
  assert.deepEqual(stats, { board: board.slug, stickies: 2, cards: 2, deadline: null })

  const action = await fetch(b('/actions/example/checklist'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie() }, body: JSON.stringify({ ids: ['s1', 's2'] }) })
  assert.equal(action.status, 200)
  assert.equal((await action.json()).toast, '2 stickies became a checklist')
  const md = await (await fetch(b('.md'))).text()
  assert.match(md, /☐ Write docs \/ ☐ Ship it/)
  assert.equal((await (await fetch(b('/plugins/example/stats'))).json()).stickies, 0)
  const notSticky = await fetch(b('/actions/example/checklist'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie() }, body: JSON.stringify({ ids: ['gh'] }) })
  assert.equal(notSticky.status, 400, 'the action is only for stickies')

  const meta = await fetch(b('/meta'), { method: 'POST', headers: { 'content-type': 'application/json', cookie: t.cookie() }, body: JSON.stringify({ fields: { deadline: '2026-11-30' } }) })
  assert.deepEqual((await meta.json()).fields, { deadline: '2026-11-30' })
  const home = await (await fetch(`${t.base}/b/`, { headers: { cookie: t.cookie() } })).text()
  assert.match(home, /data-field="deadline">Deadline: <b>30 Nov 2026<\/b>/)
})

test('the GitHub webhook refreshes cards; unsigned calls are refused', async () => {
  const before = github.calls.length
  await fetch(b('/links'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refs: ['ref:github:acme/rockets#12'] }) })
  assert.equal(github.calls.length, before, 'cached')
  const body = JSON.stringify({ action: 'edited', issue: { html_url: 'https://github.com/acme/rockets/issues/12' } })
  assert.equal((await fetch(`${t.base}/b/hooks/example/github`, { method: 'POST', body })).status, 401)
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
  const hook = await fetch(`${t.base}/b/hooks/example/github`, { method: 'POST', headers: { 'x-hub-signature-256': signature, 'content-type': 'application/json' }, body })
  assert.deepEqual(await hook.json(), { refreshed: 'https://github.com/acme/rockets/issues/12' })
  await fetch(b('/links'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refs: ['ref:github:acme/rockets#12'] }) })
  assert.equal(github.calls.length, before + 1, 'asked GitHub again after the webhook')
})

test('the beta flag reaches the editor of people in the beta domain only', async () => {
  const flagsOf = async (cookie) => JSON.parse(/id="board-config">(.*?)<\/script>/s.exec(await (await fetch(b(''), { headers: { cookie } })).text())[1]).flags
  assert.deepEqual(await flagsOf(t.cookie({ name: 'Ada', email: 'ada@example.com' })), { 'example-beta': true })
  assert.deepEqual(await flagsOf(t.cookie({ name: 'Bob', email: 'bob@elsewhere.org' })), { 'example-beta': false })
  const listed = await (await fetch(`${t.base}/b/api/plugins`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.deepEqual(listed.patterns.map((p) => p.resolver), ['github'])
})
