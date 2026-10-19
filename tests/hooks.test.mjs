/** Outgoing webhook delivery: never blocks the caller, logs failures, sends nothing without a URL. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { COMMENT_EVENTS, createWebhook } from '../server/hooks.mjs'

test('event names are the documented five', () => {
  assert.deepEqual(COMMENT_EVENTS, ['thread.created', 'thread.replied', 'thread.resolved', 'thread.reopened', 'thread.removed'])
})

test('without a URL nothing is sent', () => {
  let called = false
  const hook = createWebhook({ fetchImpl: async () => (called = true) })
  assert.equal(hook.enabled, false)
  assert.equal(hook.emit({ event: 'thread.created' }), null)
  assert.equal(called, false)
})

test('emit returns at once; the POST carries JSON and the secret header', async () => {
  let release
  const gate = new Promise((resolve) => (release = resolve))
  const seen = []
  const hook = createWebhook({
    url: 'https://hooks.example/in',
    secret: 'abc',
    fetchImpl: async (url, init) => {
      seen.push({ url, init })
      await gate
      return new Response('', { status: 204 })
    },
  })
  const started = Date.now()
  hook.emit({ event: 'thread.created', slug: 's' })
  assert.ok(Date.now() - started < 50, 'the caller is not kept waiting')
  release()
  await hook.settle()
  assert.equal(seen[0].url, 'https://hooks.example/in')
  assert.equal(seen[0].init.method, 'POST')
  assert.equal(seen[0].init.headers['content-type'], 'application/json')
  assert.equal(seen[0].init.headers['x-boards-webhook-secret'], 'abc')
  assert.deepEqual(JSON.parse(seen[0].init.body), { event: 'thread.created', slug: 's' })
  assert.ok(seen[0].init.signal instanceof AbortSignal)
})

test('rejections and network errors are logged, not thrown', async () => {
  const logs = []
  const rejecting = createWebhook({ url: 'https://h', fetchImpl: async () => new Response('', { status: 500 }), log: (e) => logs.push(e) })
  const failing = createWebhook({ url: 'https://h', fetchImpl: async () => { throw new Error('ECONNREFUSED') }, log: (e) => logs.push(e) })
  rejecting.emit({ event: 'thread.replied', slug: 'a' })
  failing.emit({ event: 'thread.removed', slug: 'b' })
  await Promise.all([rejecting.settle(), failing.settle()])
  assert.deepEqual(logs.map((l) => [l.event, l.type, l.slug]), [['webhook_rejected', 'thread.replied', 'a'], ['webhook_failed', 'thread.removed', 'b']])
  assert.equal(logs[0].status, 500)
  assert.match(logs[1].error, /ECONNREFUSED/)
})

test('a slow receiver is cut off by the timeout', async () => {
  const logs = []
  const hook = createWebhook({
    url: 'https://h',
    timeoutMs: 30,
    fetchImpl: (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))),
    log: (e) => logs.push(e),
  })
  // AbortSignal.timeout does not keep the process alive on its own; hold it open while waiting.
  const keepAlive = setInterval(() => {}, 10)
  hook.emit({ event: 'thread.created', slug: 'slow' })
  await hook.settle()
  clearInterval(keepAlive)
  assert.equal(logs[0].event, 'webhook_failed')
})
