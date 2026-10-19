/**
 * Fitting a scene into the embed frame (web/src/fit.ts).
 *
 * The embed view opens with the whole board visible. The rules pinned here: a small diagram is never blown up
 * past 100 %, a huge one stops at Excalidraw's minimum zoom, content is centred inside a margin, deleted elements
 * do not stretch the view, and lines/arrows are measured by their points rather than their (possibly stale) box.
 */
import { test, before, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'esbuild'

let fitScene
let sceneBounds
let debounce

before(async () => {
  const source = readFileSync(fileURLToPath(new URL('../web/src/fit.ts', import.meta.url)), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
  const file = join(mkdtempSync(join(tmpdir(), 'tb-fit-')), 'fit.mjs')
  writeFileSync(file, code)
  ;({ fitScene, sceneBounds, debounce } = await import(pathToFileURL(file).href))
})

const rect = (x, y, width, height, extra = {}) => ({ type: 'rectangle', x, y, width, height, ...extra })
const close = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${expected}, got ${actual}`)

/** Where a scene point lands on screen under Excalidraw's convention. */
const toScreen = (fit, x, y) => ({ x: (x + fit.scrollX) * fit.zoom, y: (y + fit.scrollY) * fit.zoom })

test('a small diagram is shown at 100 %, not blown up, and centred', () => {
  const fit = fitScene([rect(100, 200, 50, 40)], { width: 800, height: 600 })
  assert.equal(fit.zoom, 1)
  const center = toScreen(fit, 125, 220)
  close(center.x, 400, 'centre x')
  close(center.y, 300, 'centre y')
})

test('maxZoom is respected even when the content could be enlarged', () => {
  const fit = fitScene([rect(0, 0, 10, 10)], { width: 1000, height: 1000 }, { maxZoom: 2 })
  assert.equal(fit.zoom, 2)
})

test('a large scene is zoomed out to fit inside the default margin', () => {
  const viewport = { width: 800, height: 400 }
  const fit = fitScene([rect(0, 0, 2000, 500), rect(1500, 900, 500, 100)], viewport)
  // Default margin: 5 % of the smaller side (20 px) — above the 16 px floor.
  const margin = 20
  close(fit.zoom, Math.min((800 - 2 * margin) / 2000, (400 - 2 * margin) / 1000), 'limited by height')
  const topLeft = toScreen(fit, 0, 0)
  const bottomRight = toScreen(fit, 2000, 1000)
  close(topLeft.y, margin, 'top edge sits on the margin')
  close(400 - bottomRight.y, margin, 'bottom edge sits on the margin')
  close(topLeft.x, 800 - bottomRight.x, 'horizontally centred')
  assert.ok(topLeft.x >= margin)
})

test('the margin is at least 16 px on small frames', () => {
  const fit = fitScene([rect(0, 0, 1000, 1000)], { width: 200, height: 200 })
  // 5 % of 200 is 10 px, below the floor.
  close(fit.zoom, (200 - 32) / 1000)
  close(toScreen(fit, 0, 0).x, 16)
})

test('an explicit margin is honoured', () => {
  const fit = fitScene([rect(-500, -500, 1000, 1000)], { width: 600, height: 600 }, { margin: 50 })
  close(fit.zoom, 0.5)
  close(toScreen(fit, -500, -500).x, 50)
  close(toScreen(fit, 500, 500).y, 550)
})

test('fit never exceeds 100 % by default, whatever the frame', () => {
  for (const size of [10, 100, 1000, 10000]) {
    const fit = fitScene([rect(0, 0, size, size / 2)], { width: 1920, height: 1080 })
    assert.ok(fit.zoom <= 1, `size ${size}: zoom ${fit.zoom}`)
  }
})

test('zoom is clamped to the minimum (Excalidraw: 0.1) on enormous scenes, still centred', () => {
  const fit = fitScene([rect(0, 0, 100000, 100000)], { width: 800, height: 600 })
  assert.equal(fit.zoom, 0.1)
  const center = toScreen(fit, 50000, 50000)
  close(center.x, 400)
  close(center.y, 300)
  assert.equal(fitScene([rect(0, 0, 100000, 10)], { width: 800, height: 600 }, { minZoom: 0.25 }).zoom, 0.25)
})

test('empty scene: 100 %, scene origin in the middle of the frame', () => {
  for (const elements of [[], null, undefined]) {
    const fit = fitScene(elements, { width: 800, height: 600 })
    assert.equal(fit.zoom, 1)
    const origin = toScreen(fit, 0, 0)
    close(origin.x, 400)
    close(origin.y, 300)
  }
})

test('deleted elements are ignored', () => {
  const live = rect(0, 0, 100, 100)
  const withDeleted = fitScene([live, rect(5000, 5000, 3000, 3000, { isDeleted: true })], { width: 800, height: 600 })
  assert.deepEqual(withDeleted, fitScene([live], { width: 800, height: 600 }))
  // Only deleted elements: the same as an empty board.
  assert.deepEqual(fitScene([rect(5000, 5000, 10, 10, { isDeleted: true })], { width: 800, height: 600 }), fitScene([], { width: 800, height: 600 }))
})

test('lines and arrows are measured by their points, including negative ones', () => {
  // Width/height say 0x0 (stale), the points reach from (-300, -50) to (500, 150) relative to (1000, 1000).
  const arrow = { type: 'arrow', x: 1000, y: 1000, width: 0, height: 0, points: [[0, 0], [-300, -50], [500, 150]] }
  assert.deepEqual(sceneBounds([arrow]), { minX: 700, minY: 950, maxX: 1500, maxY: 1150 })
  const freedraw = { type: 'freedraw', x: 0, y: 0, width: 10, height: 10, points: [[0, 0], [40, -20], [80, 30]] }
  assert.deepEqual(sceneBounds([freedraw]), { minX: 0, minY: -20, maxX: 80, maxY: 30 })

  const fit = fitScene([arrow], { width: 800, height: 600 })
  const center = toScreen(fit, 1100, 1050)
  close(center.x, 400)
  close(center.y, 300)
})

test('a horizontal line (zero height) fits by its width alone', () => {
  const line = { type: 'line', x: 0, y: 0, width: 4000, height: 0, points: [[0, 0], [4000, 0]] }
  const fit = fitScene([line], { width: 1000, height: 500 })
  close(fit.zoom, (1000 - 50) / 4000)
  close(toScreen(fit, 2000, 0).y, 250)
})

test('rotation widens the bounds', () => {
  const b = sceneBounds([rect(0, 0, 100, 0, { angle: Math.PI / 2 })])
  close(b.minX, 50)
  close(b.maxX, 50)
  close(b.minY, -50)
  close(b.maxY, 50)
})

test('elements with broken geometry are skipped', () => {
  const fit = fitScene([rect(Number.NaN, 0, 10, 10), rect(0, 0, 100, 100)], { width: 800, height: 600 })
  assert.deepEqual(fit, fitScene([rect(0, 0, 100, 100)], { width: 800, height: 600 }))
})

test('debounce: one trailing call per burst, cancellable', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const calls = []
    const fn = debounce((x) => calls.push(x), 150)
    fn(1)
    mock.timers.tick(100)
    fn(2)
    mock.timers.tick(100)
    fn(3)
    assert.deepEqual(calls, [])
    mock.timers.tick(150)
    assert.deepEqual(calls, [3])
    fn(4)
    fn.cancel()
    mock.timers.tick(500)
    assert.deepEqual(calls, [3])
  } finally {
    mock.timers.reset()
  }
})
