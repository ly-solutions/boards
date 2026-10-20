/**
 * Feature flags (server/flags.mjs): static flags from the environment, per-person providers from plugins, and
 * editor features switched off per person.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanFlags, createFlags, parseFlags, staticFlags } from '../server/flags.mjs'
import { loadConfig } from '../server/config.mjs'
import { createPluginHost } from '../server/plugins.mjs'
import { startApp } from './helpers/app.mjs'

test('BOARDS_FLAGS: names, booleans, variants, and malformed entries refused at start-up', () => {
  assert.deepEqual(parseFlags('beta, live=false, layout=compact, !motion, cards=on'), { beta: true, live: false, layout: 'compact', motion: false, cards: true })
  assert.deepEqual(parseFlags(''), {})
  assert.throws(() => parseFlags('bad flag'), /not a flag/)
  assert.deepEqual(loadConfig({ BOARDS_AUTH: 'none', BOARDS_FLAGS: 'beta' }).flags, { beta: true })
  assert.throws(() => loadConfig({ BOARDS_AUTH: 'none', BOARDS_FLAGS: 'a b' }), /BOARDS_FLAGS/)
  assert.deepEqual(cleanFlags({ ok: true, v: 'x', n: 2, obj: {}, 'bad name': true, long: 'x'.repeat(65) }), { ok: true, v: 'x', n: '2' })
})

test('providers are merged in order, later ones win; a failing or slow one is skipped', async () => {
  const events = []
  const flags = createFlags({ providers: [staticFlags({ beta: false, layout: 'wide' })], timeoutMs: 50, log: (e) => events.push(e) })
  flags.add({ id: 'people', flags: (user) => ({ beta: user.email === 'ada@example.com' }) })
  flags.add({ id: 'broken', flags: () => { throw new Error('down') } })
  flags.add({ id: 'slow', flags: () => new Promise((resolve) => setTimeout(() => resolve({ layout: 'never' }), 1000).unref()) })
  assert.deepEqual(await flags.forUser({ kind: 'user', name: 'Ada', email: 'ada@example.com' }), { beta: true, layout: 'wide' })
  assert.deepEqual(await flags.forUser(null), { beta: false, layout: 'wide' })
  assert.deepEqual(events.map((e) => e.provider).sort(), ['broken', 'broken', 'slow', 'slow'])
})

test('a flag can switch an editor feature off for a person, never on against the operator', () => {
  const flags = createFlags()
  assert.deepEqual(flags.features({ live: true, studio: true, snap: false }, { live: false, snap: true }), { live: false, studio: true, snap: false })
})

test('providers see who is asking, not their session', async () => {
  const seen = []
  const flags = createFlags({ providers: [{ id: 'spy', flags: (user) => (seen.push(user), {}) }] })
  await flags.forUser({ kind: 'user', name: 'Ada', email: 'ada@example.com', token: 'secret' })
  await flags.forUser(null)
  assert.deepEqual(seen, [{ kind: 'user', name: 'Ada', email: 'ada@example.com' }, { kind: 'anonymous', name: null, email: null }])
})

test('the editor page carries the person\'s flags and the features they narrow', async () => {
  const flags = createFlags({ providers: [staticFlags({ beta: true })] })
  const host = createPluginHost({ flags })
  await host.use({ name: 'gate', apiVersion: '^1.0.0', register: (api) => api.addFlags({ flags: (user) => ({ live: user.name !== 'Ada Lovelace', 'gate-on': true }) }) })
  const t = await startApp({ appOptions: { flags, plugins: host } })
  try {
    const { body } = await t.createBoard()
    const html = await (await fetch(body.url.replace('http://boards.test', t.base), { headers: { cookie: t.cookie() } })).text()
    const config = JSON.parse(/<script type="application\/json" id="board-config">(.*?)<\/script>/s.exec(html)[1])
    assert.deepEqual(config.flags, { beta: true, live: false, 'gate-on': true })
    assert.equal(config.live, false, 'live collaboration is off for this person')
    assert.equal(config.studio, true)
    const other = await (await fetch(body.url.replace('http://boards.test', t.base), { headers: { cookie: t.cookie({ name: 'Grace Hopper', email: 'grace@example.com' }) } })).text()
    assert.equal(JSON.parse(/id="board-config">(.*?)<\/script>/s.exec(other)[1]).live, true)
  } finally {
    await t.close()
  }
})
