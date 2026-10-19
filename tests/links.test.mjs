/**
 * Link cards: board metadata for links to other boards on this server, and the rule that a board only answers
 * about links it actually contains. URL classification itself is covered by links-shared.test.mjs.
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createLinks } from '../server/links.mjs'
import { startApp, PUBLIC_URL } from './helpers/app.mjs'

test('board metadata: only board refs are looked up, answers are cached for a minute, misses briefly', async () => {
  const calls = []
  let clock = 1_000_000
  const links = createLinks({
    now: () => clock,
    boardMeta: async (slug) => {
      calls.push(slug)
      return slug === 'roadmap-abc' ? { title: 'Roadmap', updatedAt: '2026-10-04T18:51:57Z', key: 'secret', author: 'Ada' } : null
    },
  })
  // The other board's key and anything else in its metadata never leave the server.
  assert.deepEqual(await links.meta('board:roadmap-abc'), { kind: 'board', slug: 'roadmap-abc', title: 'Roadmap', updatedAt: '2026-10-04T18:51:57Z' })
  await links.meta('board:roadmap-abc')
  assert.deepEqual(calls, ['roadmap-abc'], 'a repeat within the minute comes from memory')
  assert.equal(await links.meta('board:missing-abc'), null)
  await links.meta('board:missing-abc')
  assert.equal(calls.length, 2, 'a miss is remembered too')
  clock += 20_000
  await links.meta('board:missing-abc')
  assert.equal(calls.length, 3, 'but not for long')
  await links.meta('board:roadmap-abc')
  assert.equal(calls.length, 3, 'a hit is still fresh after 20 s')
  clock += 60_000
  await links.meta('board:roadmap-abc')
  assert.equal(calls.length, 4, 'and is asked again after a minute')
  // Bookmarks and anything that is not a board are never fetched: the server does not open arbitrary URLs.
  assert.equal(await links.meta('link:https://example.com/'), null)
  assert.equal(await links.meta('issue:PROJ-1'), null)
  assert.equal(calls.length, 4)
  links.forget('board:roadmap-abc')
  await links.meta('board:roadmap-abc')
  assert.equal(calls.length, 5)
})

test('a failing lookup is a miss, not an error', async () => {
  const events = []
  const links = createLinks({ boardMeta: async () => { throw new Error('storage down') }, log: (event) => events.push(event) })
  assert.equal(await links.meta('board:any-board'), null)
  assert.equal(events[0].event, 'link_meta_failed')
})

test('a missing title falls back to the slug', async () => {
  const links = createLinks({ boardMeta: async () => ({ updatedAt: null }) })
  assert.deepEqual(await links.meta('board:untitled-abc'), { kind: 'board', slug: 'untitled-abc', title: 'untitled-abc', updatedAt: null })
})

let t, base, store

before(async () => {
  t = await startApp()
  base = t.base
  store = t.store
})

after(async () => {
  await t.close()
})

test('a board answers only about boards it links to; bookmarks and foreign hosts get null', async () => {
  const { body: target } = await t.createBoard({ title: 'Roadmap' })
  const { body: other } = await t.createBoard({ title: 'Secret plans' })
  const { body: created } = await t.createBoard({ title: 'Cards' })
  await store.flushAll()
  const state = await store.get(created.slug)
  store.apply(state, [
    { id: 'c', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, link: `${PUBLIC_URL}/b/${target.slug}?k=${target.key}`, customData: { kind: 'card', url: `${PUBLIC_URL}/b/${target.slug}?k=${target.key}` }, version: 1, versionNonce: 1, index: 'a0' },
    { id: 'l', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, link: 'https://example.com/docs', customData: { kind: 'card', url: 'https://example.com/docs' }, version: 1, versionNonce: 1, index: 'a1' },
    { id: 'f', type: 'rectangle', x: 0, y: 0, width: 10, height: 10, link: `https://elsewhere.example/b/${other.slug}`, version: 1, versionNonce: 1, index: 'a2' },
    { id: 't', type: 'text', x: 0, y: 0, width: 10, height: 10, text: `see ${PUBLIC_URL}/b/${other.slug}`, version: 1, versionNonce: 1, index: 'a3' },
  ])
  const ask = (refs, key = created.key) => fetch(`${base}/b/${created.slug}/links?k=${key}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refs }) })
  const response = await ask([`board:${target.slug}`, `board:${other.slug}`, 'link:https://example.com/docs', `board:${created.slug}`, 42])
  assert.equal(response.status, 200)
  const { meta } = await response.json()
  assert.equal(meta[`board:${target.slug}`].kind, 'board')
  assert.equal(meta[`board:${target.slug}`].title, 'Roadmap')
  assert.equal(meta[`board:${target.slug}`].key, undefined, "the other board's key is not handed out")
  // Mentioned only in text or on another host: not a link this board holds, so nothing is said about it.
  assert.equal(meta[`board:${other.slug}`], null)
  assert.equal(meta['link:https://example.com/docs'], null)
  assert.equal(meta[`board:${created.slug}`], null)
  assert.deepEqual(Object.keys(meta).sort(), [`board:${created.slug}`, `board:${other.slug}`, `board:${target.slug}`, 'link:https://example.com/docs'].sort())
  assert.equal((await ask([], 'wrong')).status, 404)
})
