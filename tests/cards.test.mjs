/**
 * The card registry (server/cards.mjs): which resolver takes a ref, caching, timeouts, deduplication, and the
 * normalisation that keeps whatever a plugin returns safe to draw.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createCards, normalizeCard, validateResolver } from '../server/cards.mjs'

const issue = (calls, extra = {}) => ({
  id: 'tracker',
  match: (url) => (/^https:\/\/tracker\.example\/issue\/\d+$/.test(url) ? url : null),
  pattern: /[A-Z]{2,5}-\d+/,
  async resolve(input, ctx) {
    calls.push({ input, kind: ctx.kind })
    return { title: `Issue ${input}`, status: { label: 'open', tone: 'success' }, url: 'https://tracker.example/issue/1' }
  },
  ...extra,
})

test('resolvers claim URLs in registration order; unclaimed URLs stay plain bookmarks', async () => {
  const calls = []
  const cards = createCards({ resolvers: [issue(calls), { id: 'catch-all', match: () => true, resolve: async () => ({ title: 'second' }) }] })
  const card = await cards.meta('link:https://tracker.example/issue/7')
  assert.deepEqual(card, { kind: 'tracker', title: 'Issue https://tracker.example/issue/7', status: { label: 'open', tone: 'success' }, url: 'https://tracker.example/issue/1' })
  assert.equal((await cards.meta('link:https://elsewhere.example/')).title, 'second', 'the next resolver gets what the first does not claim')
  const plain = createCards({ resolvers: [issue([])] })
  assert.equal(await plain.meta('link:https://elsewhere.example/'), null)
  assert.equal(plain.claimsLinks(), true)
  assert.equal(createCards().claimsLinks(), false)
})

test('text references: `ref:<resolver>:<text>` reaches that resolver only when its pattern matches the whole text', async () => {
  const calls = []
  const cards = createCards({ resolvers: [issue(calls)] })
  assert.equal((await cards.meta('ref:tracker:ABC-12')).title, 'Issue ABC-12')
  assert.deepEqual(calls.at(-1), { input: 'ABC-12', kind: 'ref' })
  assert.equal(await cards.meta('ref:tracker:see ABC-12 please'), null, 'a reference inside a sentence is not a reference')
  assert.equal(await cards.meta('ref:nobody:ABC-12'), null, 'an unknown resolver')
  assert.deepEqual(cards.patterns(), [{ resolver: 'tracker', source: '[A-Z]{2,5}-\\d+', flags: '' }])
  assert.equal(await cards.meta('issue:ABC-12'), null, 'anything else is not a ref at all')
})

test('answers are cached per resolver TTL, misses briefly, and concurrent lookups share one call', async () => {
  let clock = 0
  const calls = []
  let known = true
  const cards = createCards({
    now: () => clock,
    resolvers: [{ id: 'slow', ttlMs: 1000, missTtlMs: 100, match: () => true, resolve: async (input) => { calls.push(input); await new Promise((r) => setTimeout(r, 20)); return known ? { title: 'T' } : null } }],
  })
  await Promise.all([cards.meta('link:https://a.example/'), cards.meta('link:https://a.example/'), cards.meta('link:https://a.example/')])
  assert.equal(calls.length, 1, 'three cards for one link: one lookup')
  clock = 999
  await cards.meta('link:https://a.example/')
  assert.equal(calls.length, 1)
  clock = 1001
  known = false
  assert.equal(await cards.meta('link:https://a.example/'), null)
  assert.equal(calls.length, 2)
  clock = 1050
  await cards.meta('link:https://a.example/')
  assert.equal(calls.length, 2, 'a miss is remembered for missTtlMs')
  clock = 1200
  await cards.meta('link:https://a.example/')
  assert.equal(calls.length, 3)
  cards.invalidate('link:https://a.example/')
  await cards.meta('link:https://a.example/')
  assert.equal(calls.length, 4, 'invalidate drops one ref')
  cards.invalidate((ref) => ref.startsWith('link:https://a.'))
  await cards.meta('link:https://a.example/')
  assert.equal(calls.length, 5, 'or every ref a predicate accepts')
})

test('a slow resolver is cut off by its timeout and aborted; a failing one keeps the last good card', async () => {
  const events = []
  let aborted = false
  const slow = createCards({
    log: (e) => events.push(e),
    resolvers: [{ id: 'slow', timeoutMs: 50, match: () => true, resolve: (input, { signal }) => new Promise((resolve) => { signal.addEventListener('abort', () => { aborted = true }); setTimeout(() => resolve({ title: 'late' }), 1000).unref() }) }],
  })
  const started = Date.now()
  assert.equal(await slow.meta('link:https://slow.example/'), null)
  assert.ok(Date.now() - started < 500, 'the editor is not held up')
  assert.ok(aborted, 'the resolver was told to stop')
  assert.match(events[0].error, /timed out/)

  let clock = 0
  let fail = false
  const flaky = createCards({ now: () => clock, log: () => {}, resolvers: [{ id: 'flaky', ttlMs: 10, match: () => true, resolve: async () => { if (fail) throw new Error('API down'); return { title: 'Good' } } }] })
  assert.equal((await flaky.meta('link:https://f.example/')).title, 'Good')
  fail = true
  clock = 100
  assert.equal((await flaky.meta('link:https://f.example/')).title, 'Good', 'an outage does not turn cards back into links')
})

test('card data is normalised: no script URLs, bounded text, known tones only', () => {
  const card = normalizeCard(
    {
      title: '  A title  ',
      kind: 'x.issue',
      url: 'javascript:alert(1)',
      icon: 'javascript:alert(1)',
      image: 'http://insecure.example/i.png',
      status: { label: 'Blocked', tone: 'rainbow' },
      fields: [{ label: 'Owner', value: 'Ada' }, { label: '', value: 'x' }, { label: 'n', value: 3 }],
      secret: 'never forwarded',
      subtitle: 'x'.repeat(1000),
    },
    { kind: 'fallback', url: 'https://ok.example/' },
  )
  assert.equal(card.title, 'A title')
  assert.equal(card.kind, 'x.issue')
  assert.equal(card.url, 'https://ok.example/', 'a bad URL falls back to the pasted one')
  assert.equal(card.icon, undefined)
  assert.equal(card.image, undefined)
  assert.deepEqual(card.status, { label: 'Blocked', tone: 'neutral' })
  assert.deepEqual(card.fields, [{ label: 'Owner', value: 'Ada' }, { label: 'n', value: '3' }])
  assert.equal(card.secret, undefined)
  assert.equal(card.subtitle.length, 300)
  assert.equal(normalizeCard({ title: '' }), null)
  assert.equal(normalizeCard({ title: 'T', icon: '🐞' }).icon, '🐞')
  assert.equal(normalizeCard({ title: 'T', icon: 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=' }).icon, 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=')
  assert.equal(normalizeCard({ title: 'T', icon: 'data:text/html;base64,PHN2Zz48L3N2Zz4=' }).icon, undefined)
  assert.equal(normalizeCard({ title: 'T', status: 'done' }).status.label, 'done')
})

test('resolver definitions are checked when they register', () => {
  assert.throws(() => validateResolver({ id: 'Bad Id', match: () => 1, resolve: () => null }), /id/)
  assert.throws(() => validateResolver({ id: 'x', resolve: () => null }), /match\(url\), pattern, or both/)
  assert.throws(() => validateResolver({ id: 'x', match: () => 1 }), /resolve/)
  assert.throws(() => validateResolver({ id: 'x', pattern: 'ABC-1', resolve: () => null }), /RegExp/)
  const cards = createCards()
  cards.add({ id: 'one', match: () => null, resolve: () => null })
  assert.throws(() => cards.add({ id: 'one', match: () => null, resolve: () => null }), /twice/)
})
