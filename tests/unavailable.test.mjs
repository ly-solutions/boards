/**
 * A dependency that is down — the board storage or the harnessly hub — answers 503 with Retry-After and a clear
 * message, not an internal error and not 401; MCP tools say the same in words.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, TOKEN } from './helpers/app.mjs'
import { s3Objects } from '../server/storage/s3.mjs'
import { StorageUnavailableError } from '../server/storage/objects.mjs'

const s3Error = (name, status, extra = {}) => Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status }, ...extra })
const failing = (error) => s3Objects({ bucket: 'b', client: { send: async () => { throw error } } })

test('S3: network failures, 5xx and 429 become StorageUnavailableError; 404 is still "missing", 403 and 501 stay as they are', async () => {
  await assert.rejects(failing(s3Error('ServiceUnavailable', 503)).get('k'), StorageUnavailableError)
  await assert.rejects(failing(s3Error('SlowDown', 429)).list('boards/'), StorageUnavailableError)
  await assert.rejects(failing(Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })).head('k'), StorageUnavailableError)
  await assert.rejects(failing(s3Error('TimeoutError', 0)).put('k', 'x'), StorageUnavailableError)
  assert.equal(await failing(s3Error('NoSuchKey', 404)).get('k'), null)
  await assert.rejects(failing(s3Error('AccessDenied', 403)).get('k'), (error) => !(error instanceof StorageUnavailableError) && error.name === 'AccessDenied')
  await assert.rejects(failing(s3Error('NotImplemented', 501)).get('k'), (error) => !(error instanceof StorageUnavailableError))
})

test('storage down: HTTP answers 503 with Retry-After, an MCP tool answers a clear error', async () => {
  const t = await startApp({ objects: failing(s3Error('ServiceUnavailable', 503)) })
  try {
    const page = await fetch(`${t.base}/b/api/boards`, { headers: t.agent })
    assert.equal(page.status, 503)
    assert.equal(page.headers.get('retry-after'), '60')
    assert.match((await page.json()).error, /storage is unavailable.*boards are intact/)

    const response = await fetch(`${t.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'board_list', arguments: {} } }),
    })
    assert.equal(response.status, 200)
    const { result } = await response.json()
    assert.equal(result.isError, true)
    assert.match(result.content[0].text, /storage is unavailable/)
    assert.doesNotMatch(result.content[0].text, /internal error/)
  } finally {
    await t.close()
  }
})

test('hub down: a platform token in /mcp gets 503, not 401', async () => {
  const t = await startApp({ config: { auth: { harnessly: { issuer: 'http://127.0.0.1:9', orgs: ['*'] } } } })
  try {
    const enc = (o) => Buffer.from(JSON.stringify(o)).toString('base64url')
    const token = `${enc({ alg: 'EdDSA', typ: 'harnessly-app+jwt', kid: 'k1' })}.${enc({ sub: 'u' })}.${Buffer.from('sig').toString('base64url')}`
    const response = await fetch(`${t.base}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    })
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('retry-after'), '60')
    assert.equal(response.headers.get('www-authenticate'), null)
    assert.match((await response.json()).error, /hub is unavailable/)
  } finally {
    await t.close()
  }
})
