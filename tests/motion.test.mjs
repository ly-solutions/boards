/**
 * Smooth board camera (web/src/motion.ts).
 *
 * The camera does not set the view; it eases it towards a target frame by frame.
 * These tests pin down what a user feels by hand: a wheel notch covers exactly the
 * same distance as before, just not in one jump; the point under the cursor stays
 * put while zooming; a thrown board coasts, a stopped one does not; trackpad
 * scrolling is left alone; and no glide loses or gains distance, even when the
 * editor applies state a frame late.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'esbuild'

let M

before(async () => {
  const source = readFileSync(fileURLToPath(new URL('../web/src/motion.ts', import.meta.url)), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
  const file = join(mkdtempSync(join(tmpdir(), 'tb-motion-')), 'motion.mjs')
  writeFileSync(file, code)
  M = await import(pathToFileURL(file).href)
})

/** Stub editor: setState queues patches, flush applies them — later, like React. */
function makeApp(state = {}) {
  const app = {
    state: { scrollX: 0, scrollY: 0, zoom: { value: 1 }, offsetLeft: 0, offsetTop: 0, width: 1600, height: 900, isLoading: false, ...state },
    queue: [],
    unfollowed: 0,
    cancelled: 0,
    setState(patch) {
      this.queue.push(patch)
    },
    flush(keep = 0) {
      while (this.queue.length > keep) this.state = { ...this.state, ...this.queue.shift() }
    },
    maybeUnfollowRemoteUser() {
      this.unfollowed += 1
    },
    cancelInProgressAnimation() {
      this.cancelled += 1
    },
  }
  return app
}

/** Clock and frames controlled by the test. */
function makeClock() {
  let now = 1000
  let seq = 0
  const frames = new Map()
  const timers = new Map()
  const fire = () => {
    for (const [id, t] of [...timers]) {
      if (t.at > now) continue
      timers.delete(id)
      t.cb()
    }
  }
  return {
    raf: (cb) => (frames.set((seq += 1), cb), seq),
    caf: (id) => frames.delete(id),
    now: () => now,
    later: (cb, ms) => (timers.set((seq += 1), { cb, at: now + ms }), seq),
    unlater: (id) => timers.delete(id),
    advance: (ms) => ((now += ms), fire()),
    /** One screen frame: time advances, frame callbacks run. */
    frame(ms = 1000 / 60) {
      now += ms
      const due = [...frames.values()]
      frames.clear()
      for (const cb of due) cb(now)
      fire()
      return due.length
    },
    get pending() {
      return frames.size
    },
  }
}

const notch = (over = {}) => ({ deltaX: 0, deltaY: 100, deltaMode: 0, wheelDeltaX: 0, wheelDeltaY: -120, ctrlKey: false, metaKey: false, shiftKey: false, clientX: 800, clientY: 450, timeStamp: 0, ...over })
const swipe = (dy, timeStamp, over = {}) => notch({ deltaY: dy, wheelDeltaY: Math.trunc(-dy * 3), timeStamp, ...over })

/** Run frames while the camera moves; state is applied after each frame, as in a browser. */
function settle(camera, clock, app, { lag = 0, limit = 600 } = {}) {
  const trail = []
  app.flush(lag)
  for (let i = 0; i < limit && camera.moving; i++) {
    clock.frame()
    app.flush(lag)
    trail.push({ x: app.state.scrollX, y: app.state.scrollY, z: app.state.zoom.value })
  }
  app.flush()
  assert.equal(camera.moving, false, 'camera should stop')
  return trail
}

test('mouse vs trackpad: notches are a mouse, small deltas a trackpad', () => {
  const device = new M.WheelDevice()
  assert.equal(device.isMouse(notch({ timeStamp: 0 })), true, 'Chrome wheel notch')
  assert.equal(device.isMouse(notch({ deltaY: 3, deltaMode: 1, wheelDeltaY: undefined, wheelDeltaX: undefined, timeStamp: 1000 })), true, 'Firefox lines')
  assert.equal(device.isMouse(swipe(4, 2000)), false, 'trackpad')
  // A notch-like delta in the middle of a trackpad gesture keeps it a trackpad.
  assert.equal(device.isMouse(swipe(40, 2016)), false)
  assert.equal(device.isMouse(swipe(7, 2032)), false)
  // Gesture over: the next notch is a mouse again.
  assert.equal(device.isMouse(notch({ timeStamp: 3000 })), true)
})

test('a wheel notch covers the same distance as before, but over several frames', () => {
  const clock = makeClock()
  const app = makeApp({ scrollX: 40, scrollY: 300, zoom: { value: 0.5 } })
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  assert.equal(camera.wheel(notch(), app), true)
  assert.equal(app.unfollowed, 1, 'own scrolling stops following')
  const trail = settle(camera, clock, app)
  // The package moved by deltaY / zoom in one go.
  assert.ok(Math.abs(app.state.scrollY - (300 - 100 / 0.5)) < 1e-9)
  assert.equal(app.state.scrollX, 40)
  assert.ok(trail.length >= 8, `glides over several frames, not one jump: ${trail.length}`)
  // The first frame already moves, but not all the way; then only forward and slowing down.
  assert.ok(trail[0].y < 300 && trail[0].y > 300 - 200 * 0.5)
  for (let i = 1; i < trail.length; i++) assert.ok(trail[i].y <= trail[i - 1].y + 1e-9)
  const steps = trail.map((p, i) => (i ? trail[i - 1].y : 300) - p.y)
  assert.ok(steps[1] > steps[5] && steps[5] > steps[steps.length - 2] - 1e-9, 'decay')
  // Three time constants cover 95% of the distance.
  const at = Math.round((3 * M.WHEEL_TAU) / (1000 / 60))
  assert.ok(300 - trail[at].y > 200 * 0.93)
})

test('no distance is lost when the editor applies state a frame late', () => {
  const clock = makeClock()
  const app = makeApp({ scrollY: 0 })
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  for (let i = 0; i < 5; i++) {
    camera.wheel(notch({ timeStamp: i * 40 }), app)
    clock.frame()
    app.flush(1)
    clock.frame()
    app.flush(1)
  }
  settle(camera, clock, app, { lag: 1 })
  assert.ok(Math.abs(app.state.scrollY + 500) < 1e-6, `travelled ${app.state.scrollY}`)
})

test('Shift+wheel scrolls sideways, a runaway wheel is capped', () => {
  const clock = makeClock()
  const app = makeApp()
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  camera.wheel(notch({ shiftKey: true }), app)
  settle(camera, clock, app)
  assert.ok(Math.abs(app.state.scrollX + 100) < 1e-9)
  assert.equal(app.state.scrollY, 0)
  camera.wheel(notch({ deltaY: 5000, wheelDeltaY: -6000, timeStamp: 5000 }), app)
  settle(camera, clock, app)
  assert.ok(Math.abs(app.state.scrollY + M.MAX_WHEEL_DELTA) < 1e-9)
})

test('wheel zoom: the point under the cursor stays put, steps in and back return to 100%', () => {
  const clock = makeClock()
  const app = makeApp({ scrollX: 120, scrollY: -60, offsetLeft: 10, offsetTop: 20 })
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  const cursor = { clientX: 610, clientY: 320 }
  // Scene point under the cursor: (screen − offset) / zoom − scroll.
  const under = () => ({ x: (cursor.clientX - 10) / app.state.zoom.value - app.state.scrollX, y: (cursor.clientY - 20) / app.state.zoom.value - app.state.scrollY })
  const start = under()
  for (let i = 0; i < 3; i++) camera.wheel(notch({ ctrlKey: true, ...cursor, timeStamp: i * 60 }), app)
  app.flush()
  assert.equal(app.state.shouldCacheIgnoreZoom, true, 'while zooming, cached shapes are scaled, not re-rendered')
  const trail = settle(camera, clock, app)
  assert.ok(trail.length >= 8)
  for (const p of trail) {
    const x = (cursor.clientX - 10) / p.z - p.x
    const y = (cursor.clientY - 20) / p.z - p.y
    assert.ok(Math.abs(x - start.x) < 1e-6 && Math.abs(y - start.y) < 1e-6, 'point under the cursor moved')
  }
  assert.ok(Math.abs(app.state.zoom.value - 1 / M.ZOOM_PER_NOTCH ** 3) < 1e-5)
  // Shapes are re-rendered for the new zoom not right after stopping but once things go quiet:
  // the next wheel notch usually arrives sooner.
  assert.equal(app.state.shouldCacheIgnoreZoom, true)
  clock.advance(M.ZOOM_HOLD_MS + 1)
  app.flush()
  assert.equal(app.state.shouldCacheIgnoreZoom, false, 'after zooming, shapes are re-rendered at the new zoom')
  for (let i = 0; i < 3; i++) camera.wheel(notch({ ctrlKey: true, deltaY: -100, wheelDeltaY: 120, ...cursor, timeStamp: 5000 + i * 60 }), app)
  settle(camera, clock, app)
  assert.equal(app.state.zoom.value, 1, 'exactly 100%, not 100.0001%')
  assert.ok(Math.abs(app.state.scrollX - 120) < 1e-3 && Math.abs(app.state.scrollY + 60) < 1e-3)
})

test('zoom stops at the zoom limits', () => {
  const clock = makeClock()
  const app = makeApp({ zoom: { value: 0.12 } })
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  for (let i = 0; i < 6; i++) camera.wheel(notch({ ctrlKey: true, timeStamp: i * 50 }), app)
  settle(camera, clock, app)
  assert.equal(app.state.zoom.value, M.MIN_ZOOM)
})

test('trackpad pinch scales zoom proportionally — the same at 20%, 100% and 500%', () => {
  // The package subtracted deltaY/100 from zoom: at 20% a 5-unit move gave 15% — a quarter gone
  // at once — and 10 units hit the floor. Now it is the same ~5% at any zoom.
  for (const zoom of [0.2, 1, 5]) {
    const clock = makeClock()
    const app = makeApp({ zoom: { value: zoom } })
    const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
    assert.equal(camera.wheel(swipe(5, 0, { ctrlKey: true }), app), true, 'camera handles the pinch')
    assert.equal(clock.pending, 0, 'no glide: the finger drives the board, not chases it')
    app.flush()
    assert.ok(Math.abs(app.state.zoom.value / zoom - Math.exp(-5 * M.PINCH_RATE)) < 1e-5, `at ${zoom * 100}% got ${app.state.zoom.value}`)
  }
})

test('pinch: the point under the fingers stays put, in and back restores zoom, shape re-render waits for the gesture to end', () => {
  const clock = makeClock()
  const app = makeApp({ scrollX: 300, scrollY: -120, zoom: { value: 0.25 }, offsetLeft: 10, offsetTop: 20 })
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  const cursor = { clientX: 910, clientY: 420 }
  const under = () => ({ x: (cursor.clientX - 10) / app.state.zoom.value - app.state.scrollX, y: (cursor.clientY - 20) / app.state.zoom.value - app.state.scrollY })
  const start = under()
  const deltas = [0.8, 2.5, 4.1, 6.3, 5.2, 3.3, 1.4]
  let at = 0
  let lowered = 0
  const pinch = (dy) => {
    camera.wheel(swipe(dy, (at += 12), { ctrlKey: true, ...cursor }), app)
    clock.advance(12)
    app.flush()
    if (app.state.shouldCacheIgnoreZoom === false) lowered += 1
    const p = under()
    assert.ok(Math.abs(p.x - start.x) < 1e-6 && Math.abs(p.y - start.y) < 1e-6, 'point under the fingers moved')
  }
  for (const dy of deltas) pinch(dy)
  assert.ok(app.state.zoom.value < 0.25 * 0.8, 'pinched in — board zoomed out')
  for (const dy of deltas) pinch(-dy)
  assert.ok(Math.abs(app.state.zoom.value - 0.25) < 1e-5, `returned to ${app.state.zoom.value}`)
  assert.equal(lowered, 0, 'shapes are not re-rendered mid-gesture')
  clock.advance(M.ZOOM_HOLD_MS + 1)
  app.flush()
  assert.equal(app.state.shouldCacheIgnoreZoom, false)
})

test('a pinch that Chrome marks as a wheel notch stays a pinch', () => {
  // This is how it arrives: a fractional delta of a couple of units, but ±120 in legacy wheelDelta, like a mouse.
  // Such a pinch used to get the wheel step: 0.4% per event instead of 2.3% — the board ignored the fingers.
  const clock = makeClock()
  const app = makeApp({ zoom: { value: 0.3 } })
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  assert.equal(camera.wheel(notch({ deltaY: 2.3, wheelDeltaY: -120, ctrlKey: true }), app), true)
  assert.equal(clock.pending, 0)
  app.flush()
  assert.ok(Math.abs(app.state.zoom.value / 0.3 - Math.exp(-2.3 * M.PINCH_RATE)) < 1e-5)
  // A real Ctrl+wheel notch is still a wheel step with a glide.
  camera.wheel(notch({ ctrlKey: true, timeStamp: 5000 }), app)
  assert.equal(camera.moving, true)
  settle(camera, clock, app)
  assert.ok(Math.abs(app.state.zoom.value / (0.3 * Math.exp(-2.3 * M.PINCH_RATE)) - 1 / M.ZOOM_PER_NOTCH) < 1e-4)
})

test('Ctrl + two-finger scroll does not shrink the board to a dot: pinch step is capped', () => {
  const clock = makeClock()
  const app = makeApp()
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  camera.wheel(swipe(85, 0, { ctrlKey: true }), app)
  app.flush()
  assert.ok(Math.abs(app.state.zoom.value - Math.exp(-M.PINCH_MAX_DELTA * M.PINCH_RATE)) < 1e-5)
})

test('the package handles trackpad scroll: the camera skips the event and finishes any pending glide', () => {
  const clock = makeClock()
  const app = makeApp()
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  assert.equal(camera.wheel(swipe(6, 0), app), false)
  assert.equal(app.queue.length, 0)
  camera.wheel(notch({ timeStamp: 1000 }), app)
  clock.frame()
  assert.equal(camera.moving, true)
  assert.equal(camera.wheel(swipe(6, 1400), app), false)
  app.flush()
  assert.equal(camera.moving, false)
  assert.ok(Math.abs(app.state.scrollY + 100) < 1e-9, 'remaining wheel scroll is not lost')
})

test('a thrown board coasts at hand speed, a stopped one stays put', () => {
  const clock = makeClock()
  const app = makeApp()
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  const drag = (dx, dy, n) => {
    for (let i = 0; i < n; i++) {
      clock.advance(16)
      camera.drag(dx, dy)
    }
  }
  camera.grab(app)
  drag(32, -16, 10) // 2 px/ms right and up, in wheel terms
  camera.release(app)
  assert.equal(camera.moving, true)
  settle(camera, clock, app)
  assert.ok(Math.abs(app.state.scrollX + 2 * M.THROW_TAU) < 2 * M.THROW_TAU * 0.02, `coasted ${app.state.scrollX}`)
  assert.ok(Math.abs(app.state.scrollY - 1 * M.THROW_TAU) < 1 * M.THROW_TAU * 0.02)

  // The hand stopped and held the board — no throw.
  const before = { ...app.state }
  camera.grab(app)
  drag(32, 0, 10)
  clock.advance(M.THROW_STALE_MS + 40)
  camera.release(app)
  assert.equal(camera.moving, false)
  // A slow drag — no throw either.
  camera.grab(app)
  drag(2, 0, 10)
  camera.release(app)
  assert.equal(camera.moving, false)
  app.flush()
  assert.equal(app.state.scrollX, before.scrollX)
})

test('grabbing or pressing the board stops coasting on the spot', () => {
  const clock = makeClock()
  const app = makeApp()
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  camera.wheel(notch(), app)
  clock.frame()
  clock.frame()
  app.flush()
  const at = app.state.scrollY
  assert.ok(at < 0 && at > -100)
  camera.grab(app)
  assert.equal(camera.moving, false)
  assert.equal(clock.pending, 0)
  clock.frame()
  app.flush()
  assert.equal(app.state.scrollY, at)
})

test('zoom button: the view glides to the action target instead of jumping in state', () => {
  const clock = makeClock()
  const app = makeApp({ scrollX: 100, scrollY: 50 })
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  const zoomIn = (state) => {
    const z = state.zoom.value + M.ZOOM_STEP
    return { ...state, scrollX: state.scrollX + 800 / z - 800 / state.zoom.value, scrollY: state.scrollY + 450 / z - 450 / state.zoom.value, zoom: { value: z }, userToFollow: null }
  }
  const target = zoomIn(app.state)
  const next = camera.action(target, app)
  assert.equal(next.zoom.value, 1, 'state keeps the old zoom for now')
  assert.equal(next.scrollX, 100)
  assert.equal(next.userToFollow, null, 'the rest of the action passes through unchanged')
  app.setState(next)
  const trail = settle(camera, clock, app)
  assert.ok(trail.length >= 8)
  assert.equal(app.state.zoom.value, target.zoom.value)
  assert.equal(app.state.scrollX, target.scrollX)
  assert.equal(app.state.scrollY, target.scrollY)
  // The screen centre is the fixed point of the whole glide.
  for (const p of trail) assert.ok(Math.abs(800 / p.z - p.x - (800 / 1 - 100)) < 1e-6)
})

test('held zoom key: steps add up instead of restarting from halfway', () => {
  const clock = makeClock()
  const app = makeApp()
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  const zoomIn = (state) => {
    const z = state.zoom.value + M.ZOOM_STEP
    return { ...state, scrollX: state.scrollX + 800 / z - 800 / state.zoom.value, scrollY: state.scrollY + 450 / z - 450 / state.zoom.value, zoom: { value: z } }
  }
  for (let i = 0; i < 3; i++) {
    app.setState(camera.action(zoomIn(app.state), app))
    app.flush()
    clock.frame(30)
    app.flush()
  }
  settle(camera, clock, app)
  assert.ok(Math.abs(app.state.zoom.value - 1.3) < 1e-6, `three steps should be +30%, got ${app.state.zoom.value}`)
})

test('an action without a view change leaves the camera alone; no glide while the board loads', () => {
  const clock = makeClock()
  const app = makeApp()
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  const same = { ...app.state, currentItemStrokeColor: '#e03131' }
  assert.equal(camera.action(same, app), same)
  assert.equal(camera.moving, false)
  app.state.isLoading = true
  const jump = { ...app.state, scrollX: 900, zoom: { value: 0.4 } }
  assert.equal(camera.action(jump, app), jump)
  assert.equal(camera.moving, false)
})

test('if someone else moves the view, the action glide is cancelled and their position stays', () => {
  const clock = makeClock()
  const app = makeApp()
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  camera.glideTo({ scrollX: 1000, scrollY: 0, zoom: 1 })
  assert.equal(camera.moving, false, 'nowhere to glide without an editor')
  camera.mount(app)
  assert.equal(camera.glideTo({ scrollX: 1000, scrollY: 0, zoom: 1 }), true)
  clock.frame()
  clock.frame()
  app.flush()
  assert.ok(app.state.scrollX > 0 && app.state.scrollX < 1000)
  // Scrollbar or keys: the package set the view itself.
  app.state = { ...app.state, scrollX: -777 }
  clock.frame()
  app.flush()
  clock.frame()
  app.flush()
  assert.equal(camera.moving, false)
  assert.equal(app.state.scrollX, -777)
})

test('smoothing off: hooks are no-ops, the view is set immediately', () => {
  const clock = makeClock()
  const app = makeApp()
  const camera = new M.CameraMotion(clock.raf, clock.caf, clock.now, clock.later, clock.unlater)
  camera.off = true
  assert.equal(camera.wheel(notch(), app), false)
  const jump = { ...app.state, scrollX: 900 }
  assert.equal(camera.action(jump, app), jump)
  camera.grab(app)
  clock.advance(16)
  camera.drag(40, 0)
  clock.advance(16)
  camera.drag(40, 0)
  camera.release(app)
  assert.equal(camera.moving, false)
  camera.glideTo({ scrollX: 5, scrollY: 6, zoom: 2 })
  app.flush()
  assert.deepEqual([app.state.scrollX, app.state.scrollY, app.state.zoom.value], [5, 6, 2])
  assert.equal(clock.pending, 0)
})

test('a remote cursor chases its reported position instead of jumping', () => {
  const clock = makeClock()
  let paints = 0
  const glide = new M.PointerGlide(() => (paints += 1), clock.raf)
  assert.deepEqual(glide.set('a', 100, 100), { x: 100, y: 100 }, 'first position is immediate')
  const shown = glide.set('a', 160, 100)
  assert.deepEqual(shown, { x: 100, y: 100 }, 'a new position is a target, not a jump')
  clock.frame()
  const mid = glide.at('a')
  assert.ok(mid.x > 100 && mid.x < 160)
  for (let i = 0; i < 60 && clock.pending; i++) clock.frame()
  assert.deepEqual(glide.at('a'), { x: 160, y: 100 })
  assert.ok(paints >= 5)
  // Back from another tab at the far end of the board — jump straight there.
  assert.deepEqual(glide.set('a', 9000, 100), { x: 9000, y: 100 })
  glide.drop('a')
  assert.equal(glide.at('a'), undefined)
})
