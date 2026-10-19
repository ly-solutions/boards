/**
 * Browser-side live channel watchdog (web/src/live.ts).
 *
 * A channel can die silently: the socket reports open but no data flows. Until
 * the editor notices, it thinks it's live, doesn't poll and sends edits into the
 * void — someone types into a sticky and nobody else sees it. The test pins the
 * deadline by which a drop must be detected and checks that a slow but live
 * channel is not dropped.
 */
import { test, mock, before, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'esbuild'

/** Fake socket: remembers what was sent; the test feeds replies. */
class FakeSocket {
  static OPEN = 1
  static all = []
  readyState = 0
  sent = []
  constructor(url) {
    this.url = url
    FakeSocket.all.push(this)
  }
  send(data) {
    this.sent.push(JSON.parse(data))
  }
  close() {
    this.readyState = 3
  }
  open() {
    this.readyState = FakeSocket.OPEN
    this.onopen?.()
  }
  receive(message) {
    this.onmessage?.({ data: JSON.stringify(message) })
  }
  pings() {
    return this.sent.filter((m) => m.t === 'ping').length
  }
}

let LiveChannel

before(async () => {
  const source = readFileSync(fileURLToPath(new URL('../web/src/live.ts', import.meta.url)), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
  const file = join(mkdtempSync(join(tmpdir(), 'tb-live-')), 'live.mjs')
  writeFileSync(file, code)
  globalThis.WebSocket = FakeSocket
  globalThis.window = { addEventListener() {}, removeEventListener() {} }
  globalThis.document = { addEventListener() {}, removeEventListener() {}, visibilityState: 'visible' }
  ;({ LiveChannel } = await import(pathToFileURL(file).href))
})

let channel
let closes
let stalls

/** An open channel and its socket. */
function connect() {
  closes = 0
  stalls = 0
  channel = new LiveChannel(() => 'ws://boards.test/b/x/live', { onOpen() {}, onMessage() {}, onClose: () => (closes += 1), onStall: () => (stalls += 1) })
  channel.start()
  const socket = FakeSocket.all.at(-1)
  socket.open()
  return socket
}

beforeEach(() => {
  FakeSocket.all = []
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: 1_000_000 })
})

afterEach(() => {
  channel?.stop()
  mock.timers.reset()
})

test('unanswered edit: channel probed after 2 s and dropped after 6 s, not half a minute', () => {
  const socket = connect()
  channel.send({ t: 'push', seq: 1, elements: [] })
  mock.timers.tick(1_900)
  assert.equal(socket.pings(), 0, 'no probe while waiting for the edit ack')
  mock.timers.tick(200)
  assert.equal(socket.pings(), 1, 'no reply for 2 s — probe')
  assert.equal(stalls, 1, 'and edits are duplicated via polling right away')
  mock.timers.tick(3_800)
  assert.equal(closes, 0)
  mock.timers.tick(300)
  assert.equal(closes, 1, 'probe unanswered for 4 s — channel is dead')
  assert.equal(channel.connected, false)
  assert.equal(channel.lastDrop.reason, 'no-reply')
  // Reconnect right away, without waiting for the old socket to close.
  mock.timers.tick(700)
  assert.equal(FakeSocket.all.length, 2)
})

test('acked edit: no needless probe', () => {
  const socket = connect()
  channel.send({ t: 'push', seq: 1, elements: [] })
  mock.timers.tick(60)
  socket.receive({ t: 'ack', seq: 1 })
  mock.timers.tick(2_500)
  assert.equal(socket.pings(), 0)
  assert.equal(stalls, 0)
  assert.equal(closes, 0)
})

test('slow but live channel is kept: any server message clears the probe', () => {
  const socket = connect()
  channel.send({ t: 'push', seq: 1, elements: [] })
  mock.timers.tick(2_100)
  assert.equal(socket.pings(), 1)
  // The ack took three and a half seconds — a bad channel, but a working one.
  mock.timers.tick(1_400)
  socket.receive({ t: 'ack', seq: 1 })
  mock.timers.tick(10_000)
  socket.receive({ t: 'pong' })
  assert.equal(closes, 0)
  assert.equal(channel.connected, true)
})

test('viewer: a silently dead channel is detected within 11 s', () => {
  const socket = connect()
  mock.timers.tick(4_900)
  assert.equal(socket.pings(), 0, 'five seconds of silence is not enough yet')
  mock.timers.tick(2_200)
  assert.equal(socket.pings(), 1)
  mock.timers.tick(4_000)
  assert.equal(closes, 1)
  assert.equal(channel.lastDrop.reason, 'no-reply')
})

test('viewer on a live channel: a quiet board does not drop the channel', () => {
  const socket = connect()
  socket.pongs = 0
  for (let i = 0; i < 20; i++) {
    mock.timers.tick(1_000)
    // The server answers every probe.
    if (socket.pings() > socket.pongs) {
      socket.pongs = socket.pings()
      socket.receive({ t: 'pong' })
    }
  }
  assert.ok(socket.pings() >= 2, 'the channel was probed during twenty seconds of silence')
  assert.equal(closes, 0)
  assert.equal(FakeSocket.all.length, 1)
})
