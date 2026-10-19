/**
 * Test harness: a real HTTP server around createApp() with fs storage in a temporary directory.
 *
 *   const t = await startApp()                       // token auth, TOKEN accepted, public URL http://boards.test
 *   await fetch(`${t.base}/b/api/boards`, { headers: t.agent, … })
 *   t.cookie({ name: 'Ada' })                        // session cookie header value for a signed-in user
 *   await t.close()
 */
import { createServer } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createApp } from '../../server/index.mjs'
import { createStore } from '../../server/store.mjs'
import { createAuth } from '../../server/auth.mjs'
import { testConfig } from '../../server/config.mjs'
import { createBoardStorage } from '../../server/storage/boards.mjs'
import { fsObjects } from '../../server/storage/objects.mjs'

export const TOKEN = 'test-token-0123456789abcdef'
export const PUBLIC_URL = 'http://boards.test'

export async function startApp({ config: overrides = {}, storage, objects, fetchImpl, appOptions = {}, flushDelayMs = 50 } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'boards-test-'))
  const config = testConfig({ publicUrl: PUBLIC_URL, ...overrides, auth: { mode: 'token', tokens: [TOKEN], sessionSecret: 'test-session-secret', ...overrides.auth } })
  const boardStorage = storage ?? createBoardStorage({ objects: objects ?? fsObjects({ dir }) })
  const store = createStore({ storage: boardStorage, flushDelayMs, baseUrl: config.publicUrl, log: () => {} })
  const auth = createAuth(config.auth, { publicUrl: config.publicUrl, ...(fetchImpl ? { fetchImpl } : {}) })
  const app = createApp({ store, config, auth, ...appOptions })
  const server = createServer(app)
  server.on('upgrade', app.upgrade)
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    dir,
    store,
    storage: boardStorage,
    app,
    auth,
    config,
    server,
    agent: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    cookie: (user = { name: 'Ada Lovelace', email: 'ada@example.com' }) => `${auth.sessionCookieName}=${auth._session(user)}`,
    async createBoard(body = {}) {
      const response = await fetch(`${base}/b/api/boards`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'Payment flow', ...body }) })
      return { status: response.status, body: await response.json() }
    },
    async close() {
      app.live.close()
      await new Promise((resolve) => server.close(resolve))
      await store.flushAll()
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    },
  }
}
