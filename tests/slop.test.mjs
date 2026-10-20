import { test } from 'node:test'
import assert from 'node:assert/strict'
import { analyzeSlop, hueFamily } from '../shared/slop.mjs'
import { summarize } from '../server/summary.mjs'

const base = { version: 1, versionNonce: 1, isDeleted: false, strokeColor: '#1e1e1e', backgroundColor: 'transparent', fillStyle: 'solid', strokeWidth: 2, roughness: 0, strokeStyle: 'solid' }
const rect = (id, x, y, over = {}) => ({ ...base, id, type: 'rectangle', x, y, width: 160, height: 80, boundElements: [], ...over })
const label = (id, containerId, text, over = {}) => ({ ...base, id, type: 'text', x: 0, y: 0, width: 10, height: 10, text, originalText: text, containerId, fontFamily: 5, fontSize: 20, ...over })
const free = (id, x, y, text, over = {}) => ({ ...base, id, type: 'text', x, y, width: 120, height: 25, text, originalText: text, fontFamily: 5, fontSize: 20, ...over })
const arrow = (id, x1, y1, x2, y2, from, to, over = {}) => ({
  ...base,
  id,
  type: 'arrow',
  x: x1,
  y: y1,
  width: x2 - x1,
  height: y2 - y1,
  points: [[0, 0], [x2 - x1, y2 - y1]],
  startBinding: from ? { elementId: from } : null,
  endBinding: to ? { elementId: to } : null,
  endArrowhead: 'arrow',
  ...over,
})
/** A card with a label: text bound inside the shape. */
const card = (id, x, y, text, over = {}) => [rect(id, x, y, over), label(`${id}-t`, id, text, { x: x + 20, y: y + 25, width: 120, height: 25 })]

const ids = (result, issue) => result.issues.find((i) => i.id === issue)?.elementIds ?? []
const has = (result, issue) => result.issues.some((i) => i.id === issue)

test('a tidy diagram of five cards and arrows is clean', () => {
  const blue = { backgroundColor: '#e7f5ff', strokeColor: '#1971c2' }
  const scene = [
    ...card('a', 0, 0, 'Customer', blue),
    ...card('b', 260, 0, 'Storefront', blue),
    ...card('c', 520, 0, 'Gateway', blue),
    ...card('d', 780, 0, 'Orders', { backgroundColor: '#f3f0ff', strokeColor: '#6965db' }),
    ...card('e', 520, 200, 'Payments', { backgroundColor: '#fff4e6', strokeColor: '#e8590c' }),
    arrow('ab', 160, 40, 260, 40, 'a', 'b'),
    arrow('bc', 420, 40, 520, 40, 'b', 'c'),
    arrow('cd', 680, 40, 780, 40, 'c', 'd'),
    arrow('ce', 600, 80, 600, 200, 'c', 'e'),
    free('title', 0, -80, 'Checkout path', { fontSize: 28 }),
  ]
  const result = analyzeSlop(scene)
  assert.equal(result.level, 'clean', JSON.stringify(result.issues))
  assert.equal(result.score, 0)
})

test('a rainbow board with emoji, mixed fonts and dangling arrows is slop', () => {
  const colors = ['#e03131', '#f08c00', '#2f9e44', '#1971c2', '#9c36b5', '#0c8599', '#e64980']
  const scene = colors.flatMap((c, i) =>
    card(`k${i}`, i * 220, 0, `🚀 Step ${i}`, { backgroundColor: c, strokeColor: c }).map((el) =>
      el.type === 'text' ? { ...el, fontFamily: (i % 3) + 1, fontSize: 14 + i * 3 } : el,
    ),
  )
  scene.push(arrow('x1', 0, 200, 100, 300), arrow('x2', 300, 200, 400, 300), arrow('x3', 600, 200, 700, 300))
  const result = analyzeSlop(scene)
  assert.equal(result.level, 'slop')
  for (const id of ['rainbow', 'emoji', 'font-families', 'font-sizes', 'dangling-arrows']) assert.ok(has(result, id), id)
})

test('rainbow: a fourth bright fill counts, shades of one color and pastel zones do not', () => {
  const shades = ['#e7f5ff', '#a5d8ff', '#1971c2', '#1864ab', '#74c0fc', '#d0ebff'].map((c, i) => rect(`s${i}`, i * 200, 0, { backgroundColor: c }))
  assert.ok(!has(analyzeSlop(shades), 'rainbow'))
  const five = ['#e03131', '#f08c00', '#2f9e44', '#1971c2', '#9c36b5'].map((c, i) => rect(`r${i}`, i * 200, 0, { backgroundColor: c }))
  const result = analyzeSlop(five)
  assert.ok(has(result, 'rainbow'))
  assert.equal(ids(result, 'rainbow').length, 2)
  // Pastel zones of different colors are color coding, not a rainbow.
  const zones = ['#e7f5ff', '#fff4e6', '#ebfbee', '#f3f0ff', '#fff0f6'].map((c, i) => rect(`z${i}`, i * 200, 0, { backgroundColor: c }))
  assert.ok(!has(analyzeSlop(zones), 'rainbow'))
  // A bright heading badge on a large board is an accent, not a rainbow.
  const accents = [rect('big', 0, 0, { width: 3000, height: 2000, backgroundColor: '#f8f9fa' }), ...['#e03131', '#f08c00', '#2f9e44', '#1971c2', '#9c36b5'].map((c, i) => rect(`h${i}`, i * 200, 0, { width: 120, height: 24, backgroundColor: c }))]
  assert.ok(!has(analyzeSlop(accents), 'rainbow'))
})

test('off-palette colors are reported only when a palette is given', () => {
  const scene = [rect('a', 0, 0, { backgroundColor: '#123456' }), rect('b', 300, 0, { backgroundColor: '#e7f5ff' })]
  assert.ok(!has(analyzeSlop(scene), 'off-palette'))
  const result = analyzeSlop(scene, { palette: ['#1e1e1e', '#E7F5FF'] })
  assert.deepEqual(ids(result, 'off-palette'), ['a'])
})

test('neutral colors are not families', () => {
  assert.equal(hueFamily('#1e1e1e'), null)
  assert.equal(hueFamily('#ffffff'), null)
  assert.equal(hueFamily('#868e96'), null)
  assert.equal(hueFamily('transparent'), null)
  assert.equal(hueFamily('#e7f5ff'), hueFamily('#1971c2'))
})

test('emoji: one icon is an accent, emoji bullets are a sign', () => {
  const one = [free('a', 0, 0, '⚠️ Important'), free('b', 0, 100, 'Text'), free('c', 0, 200, 'More'), free('d', 0, 300, 'And more')]
  assert.ok(!has(analyzeSlop(one), 'emoji'))
  const bullets = [free('l', 0, 0, '✅ Fast\n✅ Reliable\n✅ Cheap')]
  assert.deepEqual(ids(analyzeSlop(bullets), 'emoji'), ['l'])
  // Arrows and the copyright sign are not emoji.
  const arrows = [free('x', 0, 0, 'A ↔ B'), free('y', 0, 100, '© Acme → login'), free('z', 0, 200, 'C ↕ D')]
  assert.ok(!has(analyzeSlop(arrows), 'emoji'))
})

test('fonts: three families and six sizes', () => {
  const scene = [1, 2, 3].map((f, i) => free(`f${i}`, 0, i * 100, 'x', { fontFamily: f }))
  assert.ok(has(analyzeSlop(scene), 'font-families'))
  const sizes = [12, 16, 20, 28, 36, 48].map((s, i) => free(`s${i}`, 0, i * 100, 'x', { fontSize: s }))
  const result = analyzeSlop(sizes)
  assert.ok(has(result, 'font-sizes'))
  assert.ok(!has(result, 'font-families'))
})

test('style mix: hand-drawn mixed with straight', () => {
  const scene = [0, 0, 0, 1, 1].map((r, i) => rect(`r${i}`, i * 200, 0, { roughness: r }))
  assert.deepEqual(ids(analyzeSlop(scene), 'style-mix').sort(), ['r3', 'r4'])
  const single = [0, 0, 0, 0, 1].map((r, i) => rect(`q${i}`, i * 200, 0, { roughness: r }))
  assert.ok(!has(analyzeSlop(single), 'style-mix'))
})

test('almost aligned: a column off by 3 px', () => {
  const scene = [rect('a', 0, 0), rect('b', 3, 120), rect('c', -2, 240)]
  const result = analyzeSlop(scene)
  assert.ok(has(result, 'near-miss'))
  const exact = [rect('a', 0, 0), rect('b', 0, 120), rect('c', 0, 240)]
  assert.ok(!has(analyzeSlop(exact), 'near-miss'))
})

test('a row of cards with different heights', () => {
  const scene = [...card('a', 0, 0, 'A'), ...card('b', 220, -20, 'B', { height: 120 }), ...card('c', 440, 0, 'C')]
  assert.deepEqual(ids(analyzeSlop(scene), 'uneven-siblings'), ['b'])
})

test('an arrow through another shape', () => {
  const scene = [rect('a', 0, 0), rect('m', 250, 0), rect('b', 500, 0), arrow('ab', 160, 40, 500, 40, 'a', 'b')]
  const result = analyzeSlop(scene)
  assert.deepEqual(ids(result, 'crossing-arrows'), ['ab'])
  assert.ok(!has(result, 'dangling-arrows'))
})

test('an arrow leaving a group zone does not cross it', () => {
  const scene = [rect('zone', -20, -20, { width: 420, height: 140 }), rect('a', 0, 0), rect('b', 220, 0), rect('c', 600, 0), arrow('ac', 160, 40, 600, 40, 'a', 'c', { points: [[0, 0], [60, 0], [60, 120], [440, 120], [440, 0]] })]
  assert.ok(!has(analyzeSlop(scene), 'crossing-arrows'))
})

test('an arrow dropped right next to a shape is not dangling', () => {
  const scene = [rect('a', 0, 0), rect('b', 300, 0), arrow('ab', 163, 40, 297, 40, null, null)]
  assert.ok(!has(analyzeSlop(scene), 'dangling-arrows'))
})

test('overlap is a sign, nesting is not', () => {
  const overlap = [rect('a', 0, 0), rect('b', 100, 40)]
  assert.deepEqual(ids(analyzeSlop(overlap), 'overlap').sort(), ['a', 'b'])
  const nested = [rect('bg', 0, 0, { width: 600, height: 300 }), rect('a', 40, 40), rect('b', 300, 40)]
  assert.ok(!has(analyzeSlop(nested), 'overlap'))
})

test('a wall of text in a card and a label past the edge', () => {
  const long = 'A very long description of the service, '.repeat(8)
  const result = analyzeSlop([...card('a', 0, 0, long), rect('b', 400, 0), label('bt', 'b', 'x', { x: 380, y: 20, width: 200, height: 25 })])
  assert.deepEqual(ids(result, 'text-walls').sort(), ['a', 'b'])
  // An arrow label sits on the line and always sticks out of its box.
  const onArrow = analyzeSlop([rect('p', 0, 0), rect('q', 400, 0), arrow('pq', 160, 40, 400, 40, 'p', 'q'), label('pql', 'pq', 'HTTP', { x: 250, y: 28, width: 60, height: 25 })])
  assert.ok(!has(onArrow, 'text-walls'))
})

test('decor: scattered small meaningless shapes', () => {
  const dots = [0, 1, 2, 3, 4].map((i) => ({ ...base, id: `d${i}`, type: 'ellipse', x: i * 50, y: 0, width: 16, height: 16, boundElements: [] }))
  assert.equal(ids(analyzeSlop(dots), 'decor').length, 5)
  assert.ok(!has(analyzeSlop(dots.slice(0, 3)), 'decor'))
})

test('crowding: shapes densely fill the board', () => {
  const tight = []
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) tight.push(rect(`t${r}${c}`, c * 162, r * 82))
  assert.ok(has(analyzeSlop(tight), 'crowded'))
  const airy = []
  for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) airy.push(rect(`t${r}${c}`, c * 300, r * 200))
  assert.ok(!has(analyzeSlop(airy), 'crowded'))
})

test('deleted elements do not count', () => {
  const scene = [0, 1, 2, 3, 4, 5].map((i) => rect(`r${i}`, i * 200, 0, { backgroundColor: ['#e03131', '#f08c00', '#2f9e44', '#1971c2', '#9c36b5', '#0c8599'][i], isDeleted: i > 1 }))
  assert.ok(!has(analyzeSlop(scene), 'rainbow'))
})

test('the board text for agents carries the slop check', () => {
  const clean = summarize([...card('a', 0, 0, 'A'), ...card('b', 300, 0, 'B'), arrow('ab', 160, 40, 300, 40, 'a', 'b')], { title: 'Clean' })
  assert.match(clean, /Slop check: clean, 0\/100\./)
  const messy = summarize([free('l', 0, 0, '✅ Fast\n✅ Reliable\n✅ Cheap'), arrow('x', 0, 200, 100, 300), arrow('y', 300, 200, 400, 300)], { title: 'Slop' })
  assert.match(messy, /## Slop check — \d+\/100/)
  assert.match(messy, /Emoji instead of meaning: .*\[l\]/)
  assert.match(messy, /Arrows to nowhere: .*\[x, y\]/)
})

test('checking a large board takes a fraction of a second, not seconds', () => {
  // A 30×30 grid of cards with arrows — about 2,700 elements. Comparing all pairs
  // took over a second here and froze both the server and the editor.
  const elements = []
  for (let i = 0; i < 30; i += 1) {
    for (let j = 0; j < 30; j += 1) {
      elements.push(...card(`c${i}-${j}`, j * 260, i * 180, `Node ${i}-${j}`))
      if (j > 0) elements.push(arrow(`a${i}-${j}`, (j - 1) * 260 + 160, i * 180 + 40, j * 260, i * 180 + 40, `c${i}-${j - 1}`, `c${i}-${j}`))
    }
  }
  analyzeSlop(elements)
  const started = performance.now()
  const result = analyzeSlop(elements)
  const spent = performance.now() - started
  assert.equal(result.metrics.elements, elements.length)
  assert.ok(spent < 1500, `the check took ${Math.round(spent)} ms`)
})

test('issues come in the requested locale; the scores and offending ids do not depend on it', () => {
  const elements = []
  for (let i = 0; i < 5; i += 1) elements.push({ id: `a${i}`, type: 'arrow', x: i * 300, y: 0, width: 100, height: 0, points: [[0, 0], [100, 0]] })
  const en = analyzeSlop(elements)
  const ru = analyzeSlop(elements, { locale: 'ru' })
  assert.equal(ru.score, en.score)
  assert.deepEqual(ru.issues.map((i) => [i.id, i.elementIds]), en.issues.map((i) => [i.id, i.elementIds]))
  const dangling = ru.issues.find((i) => i.id === 'dangling-arrows')
  assert.equal(dangling.title, 'Стрелки в никуда')
  assert.match(dangling.detail, /^5 стрелок не привязаны/)
  assert.equal(en.issues.find((i) => i.id === 'dangling-arrows').title, 'Arrows to nowhere')
})
