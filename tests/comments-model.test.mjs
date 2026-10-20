/**
 * Comment pins and the comments panel: the pure rules (web/src/comments-model.ts).
 *
 * These are the parts a user notices when they break: a pin that stays behind
 * when its shape moves, a click on a label that attaches the comment to the
 * text instead of the shape, an arrow's empty bounding box swallowing comments
 * meant for the canvas, a list in the wrong order, a "new" dot that never goes
 * away or never lights up, and a card that opens off screen.
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
  const source = readFileSync(fileURLToPath(new URL('../web/src/comments-model.ts', import.meta.url)), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
  const file = join(mkdtempSync(join(tmpdir(), 'tb-comments-')), 'comments-model.mjs')
  writeFileSync(file, code)
  M = await import(pathToFileURL(file).href)
})

const rect = (id, x, y, width, height, extra = {}) => ({ id, type: 'rectangle', x, y, width, height, ...extra })
const thread = (id, extra = {}) => ({ id, x: 0, y: 0, elementId: null, dx: 0, dy: 0, author: 'Ann', createdAt: '2026-10-01T10:00:00.000Z', resolved: false, messages: [], ...extra })
const msg = (id, author, at, extra = {}) => ({ id, author, text: `text ${id}`, at, ...extra })

test('a canvas pin sits at its stored point', () => {
  assert.deepEqual(M.pinPoint(thread('t', { x: 40, y: -12 }), new Map()), { x: 40, y: -12 })
})

test('an anchored pin follows its shape by the stored offset', () => {
  const t = thread('t', { x: 110, y: 120, elementId: 'r', dx: 10, dy: 20 })
  const moved = new Map([['r', rect('r', 500, 300, 100, 50)]])
  assert.deepEqual(M.pinPoint(t, moved), { x: 510, y: 320 })
})

test('a pin whose shape is gone or deleted falls back to the stored point', () => {
  const t = thread('t', { x: 110, y: 120, elementId: 'r', dx: 10, dy: 20 })
  assert.deepEqual(M.pinPoint(t, new Map()), { x: 110, y: 120 })
  assert.deepEqual(M.pinPoint(t, new Map([['r', rect('r', 500, 300, 100, 50, { isDeleted: true })]])), { x: 110, y: 120 })
})

test('draft lands on the topmost live shape under the point', () => {
  const scene = [rect('bottom', 0, 0, 200, 200), rect('top', 50, 50, 100, 100), rect('gone', 60, 60, 20, 20, { isDeleted: true })]
  assert.deepEqual(M.draftFrom(scene, 70, 70), { x: 70, y: 70, elementId: 'top' })
  assert.equal(M.draftFrom(scene, 10, 10).elementId, 'bottom')
  assert.equal(M.draftFrom(scene, 500, 500).elementId, null)
})

test('a click on a shape label attaches to the shape, not the text', () => {
  const scene = [rect('box', 0, 0, 200, 100), { id: 'label', type: 'text', x: 60, y: 40, width: 80, height: 20, containerId: 'box', text: 'Hello' }]
  assert.equal(M.draftFrom(scene, 70, 45).elementId, 'box')
})

test('a free text element is a target of its own', () => {
  const scene = [{ id: 'note', type: 'text', x: 0, y: 0, width: 80, height: 20, containerId: null, text: 'Free' }]
  assert.equal(M.draftFrom(scene, 10, 10).elementId, 'note')
})

test('an orphaned label (container deleted) stays a text target', () => {
  const scene = [rect('box', 0, 0, 200, 100, { isDeleted: true }), { id: 'label', type: 'text', x: 60, y: 40, width: 80, height: 20, containerId: 'box', text: 'Hi' }]
  assert.equal(M.draftFrom(scene, 70, 45).elementId, 'label')
})

test('an arrow is hit only near its stroke, not across its bounding box', () => {
  const arrow = { id: 'a', type: 'arrow', x: 0, y: 0, width: 200, height: 200, points: [[0, 0], [200, 200]] }
  assert.equal(M.draftFrom([arrow], 100, 103).elementId, 'a')
  assert.equal(M.draftFrom([arrow], 180, 20).elementId, null)
})

test('ellipses and diamonds use their real outline', () => {
  const ellipse = { id: 'e', type: 'ellipse', x: 0, y: 0, width: 100, height: 100 }
  assert.equal(M.hits(ellipse, 50, 50), true)
  assert.equal(M.hits(ellipse, 3, 3), false)
  const diamond = { id: 'd', type: 'diamond', x: 0, y: 0, width: 100, height: 100 }
  assert.equal(M.hits(diamond, 50, 10), true)
  assert.equal(M.hits(diamond, 10, 10), false)
})

test('rotation is taken into account', () => {
  // A 200×20 bar turned 90° around its centre (100, 10) stands vertically.
  const bar = rect('bar', 0, 0, 200, 20, { angle: Math.PI / 2 })
  assert.equal(M.hits(bar, 100, 80), true)
  assert.equal(M.hits(bar, 180, 10), false)
})

test('negative sizes (drawn right-to-left) still hit', () => {
  assert.equal(M.hits(rect('r', 100, 100, -50, -50), 75, 75), true)
})

test('place name: label, kind, or Canvas', () => {
  const scene = [
    rect('box', 0, 0, 10, 10),
    { id: 't', type: 'text', x: 0, y: 0, width: 1, height: 1, containerId: 'box', text: 'wrapped\nline', originalText: 'Payments  API' },
    rect('bare', 0, 0, 10, 10),
    rect('stick', 0, 0, 10, 10, { customData: { kind: 'sticky' } }),
  ]
  assert.equal(M.labelOf(scene, 'box'), 'Payments  API')
  assert.equal(M.placeName(scene, 'box'), '“Payments API”')
  assert.equal(M.placeName(scene, 'bare'), 'Rectangle')
  assert.equal(M.placeName(scene, 'stick'), 'Sticky')
  assert.equal(M.placeName(scene, null), 'Canvas')
  assert.equal(M.placeName(scene, 'missing'), 'Canvas')
})

test('pinColor is stable, from the palette, and spreads names apart', () => {
  assert.equal(M.pinColor('Ann'), M.pinColor('Ann'))
  assert.equal(M.pinColor(' Ann '), M.pinColor('Ann'))
  assert.ok(M.PIN_COLORS.includes(M.pinColor('Ann')))
  assert.ok(M.PIN_COLORS.includes(M.pinColor('')))
  const names = ['Ann', 'Bob', 'Carol', 'Dave', 'Eve', 'Frank', 'Grace', 'Heidi', 'Ivan', 'Judy', 'agent: planner', 'guest: Kim']
  assert.ok(new Set(names.map(M.pinColor)).size >= 6, 'a dozen names should not collapse onto a couple of colours')
})

test('initials and display names handle guests and emoji', () => {
  assert.equal(M.initialOf('ann'), 'A')
  assert.equal(M.initialOf('guest: bob'), 'B')
  assert.equal(M.initialOf('🙂 smile'), '🙂')
  assert.equal(M.initialOf(''), '?')
  assert.equal(M.displayName('guest: Bob'), 'Bob')
  assert.equal(M.isGuest('guest: Bob'), true)
  assert.equal(M.isGuest('Bob'), false)
})

test('relative time: just now, minutes, hours, then a date', () => {
  const now = Date.parse('2026-10-19T12:00:00.000Z')
  assert.equal(M.relativeTime('2026-10-19T11:59:30.000Z', now), 'just now')
  // A server clock slightly ahead must not produce "-1 min".
  assert.equal(M.relativeTime('2026-10-19T12:00:05.000Z', now), 'just now')
  assert.equal(M.relativeTime('2026-10-19T11:55:00.000Z', now), '5 min')
  assert.equal(M.relativeTime('2026-10-19T10:00:00.000Z', now), '2 h')
  const old = '2026-10-05T09:00:00.000Z'
  assert.equal(M.relativeTime(old, now), new Date(old).toLocaleString(undefined, { month: 'short', day: 'numeric' }))
  const lastYear = '2025-03-01T09:00:00.000Z'
  assert.equal(M.relativeTime(lastYear, now), new Date(lastYear).toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }))
  assert.equal(M.relativeTime('not a date', now), '')
})

test('panel order: open by newest activity first, resolved apart', () => {
  const threads = [
    thread('old', { messages: [msg('1', 'Ann', '2026-10-01T10:00:00Z')] }),
    thread('fresh-reply', { createdAt: '2026-09-01T00:00:00Z', messages: [msg('2', 'Ann', '2026-09-01T00:00:00Z'), msg('3', 'Bob', '2026-10-10T00:00:00Z')] }),
    thread('done', { resolved: true, messages: [msg('4', 'Ann', '2026-10-15T00:00:00Z')] }),
    thread('mid', { messages: [msg('5', 'Ann', '2026-10-05T00:00:00Z')] }),
    thread('done-old', { resolved: true, messages: [msg('6', 'Ann', '2026-01-01T00:00:00Z')] }),
  ]
  const { open, resolved } = M.sortThreads(threads)
  assert.deepEqual(open.map((t) => t.id), ['fresh-reply', 'mid', 'old'])
  assert.deepEqual(resolved.map((t) => t.id), ['done', 'done-old'])
  // The input is not reordered in place: it is React state.
  assert.equal(threads[0].id, 'old')
})

test('reply count excludes the first message', () => {
  assert.equal(M.replyCount(thread('t', { messages: [msg('1', 'A', '2026-10-01T00:00:00Z')] })), 0)
  assert.equal(M.replyCount(thread('t', { messages: [msg('1', 'A', 'x'), msg('2', 'B', 'x'), msg('3', 'C', 'x')] })), 2)
  assert.equal(M.replyCount(thread('t')), 0)
})

test('"new" dot: lit by others, cleared by reading, relit by a later message', () => {
  const t = thread('t', { messages: [msg('m1', 'Bob', '2026-10-01T00:00:00Z')] })
  assert.equal(M.isUnseen(t, {}, 'Ann'), true)
  const seen = M.markSeen({}, t)
  assert.equal(M.isUnseen(t, seen, 'Ann'), false)
  const replied = { ...t, messages: [...t.messages, msg('m2', 'Bob', '2026-10-02T00:00:00Z')] }
  assert.equal(M.isUnseen(replied, seen, 'Ann'), true)
  // My own message never counts as new for me.
  const mine = { ...t, messages: [...t.messages, msg('m3', 'Ann', '2026-10-02T00:00:00Z')] }
  assert.equal(M.isUnseen(mine, seen, 'Ann'), false)
  assert.equal(M.isUnseen(thread('empty'), {}, 'Ann'), false)
})

test('a deleted message followed by a new one still lights the dot', () => {
  const before = thread('t', { messages: [msg('m1', 'Bob', 'x'), msg('m2', 'Bob', 'x')] })
  const seen = M.markSeen({}, before)
  const after = thread('t', { messages: [msg('m1', 'Bob', 'x'), msg('m3', 'Bob', 'x')] })
  assert.equal(M.isUnseen(after, seen, 'Ann'), true)
})

test('seen state survives junk in storage and drops threads that are gone', () => {
  assert.deepEqual(M.parseSeen(null), {})
  assert.deepEqual(M.parseSeen('{oops'), {})
  assert.deepEqual(M.parseSeen('[1,2]'), {})
  assert.deepEqual(M.parseSeen('{"a":"m1","b":3}'), { a: 'm1' })
  const alive = [thread('a', { messages: [msg('m9', 'Bob', 'x')] })]
  assert.deepEqual(M.markSeen({ a: 'm1', gone: 'm2' }, alive[0], alive), { a: 'm9' })
  assert.equal(M.seenKey('my-board'), 'boards-seen:my-board')
})

test('delete rights: team deletes anything, others only their own', () => {
  assert.equal(M.canDelete({ author: 'Bob' }, 'Ann', true), true)
  assert.equal(M.canDelete({ author: 'guest: Kim' }, 'guest: Kim', false), true)
  assert.equal(M.canDelete({ author: 'Bob' }, 'guest: Kim', false), false)
  assert.equal(M.canDelete({ author: 'Bob' }, null, false), false)
})

test('excerpt is one line and cut with an ellipsis', () => {
  assert.equal(M.excerpt('a\n  b\tc'), 'a b c')
  assert.equal(M.excerpt('abcdefghij', 5), 'abcd…')
  assert.equal(M.excerpt('abcde', 5), 'abcde')
})

test('a few pixels of jitter is a click, more is a drag', () => {
  assert.equal(M.isDrag(2, 2), false)
  assert.equal(M.isDrag(3, 3), true)
  assert.equal(M.isDrag(0, 10, 12), false)
})

test('card opens right of the pin, flips left at the edge, slides to stay on screen', () => {
  const card = { width: 320, height: 300 }
  const viewport = { width: 1200, height: 800 }
  assert.deepEqual(M.cardOffset({ left: 100, top: 400 }, card, viewport), { dx: 40, dy: -32 })
  // Near the right edge: to the left of the tip instead.
  assert.deepEqual(M.cardOffset({ left: 1000, top: 400 }, card, viewport), { dx: -328, dy: -32 })
  // Near the bottom: lifted so its bottom stays 12 px inside.
  const low = M.cardOffset({ left: 100, top: 780 }, card, viewport)
  assert.equal(780 + low.dy + card.height, 800 - 12)
  // Near the top: pushed down.
  const high = M.cardOffset({ left: 100, top: 10 }, card, viewport)
  assert.equal(10 + high.dy, 12)
  // No room on either side (narrow window): stays right rather than going off the left edge.
  assert.equal(M.cardOffset({ left: 100, top: 400 }, card, { width: 380, height: 800 }).dx, 40)
})

test('focus point keeps the pin and its card in sight', () => {
  const v = { width: 1400, height: 900, zoom: 2 }
  const p = { x: 1000, y: 500 }
  // Desktop with the panel open: the pin lands left of centre, card and panel fit to its right.
  const desk = M.focusPoint(p, v, { right: 352, card: 368 })
  const pinScreenX = v.width / 2 - (desk.x - p.x) * v.zoom
  assert.equal(pinScreenX, (1400 - 352 - 368) / 2)
  assert.equal(desk.y, p.y)
  // Phone: pin in the upper quarter, above the bottom sheet.
  const phone = M.focusPoint(p, v, { sheet: true })
  assert.equal(phone.x, p.x)
  assert.equal(v.height / 2 - (phone.y - p.y) * v.zoom, v.height / 4)
})

test('the model speaks the interface language: its English matches the catalog, Russian comes through the translator', async () => {
  const { CATALOGS, translator } = await import('../shared/locales/index.mjs')
  for (const [key, value] of Object.entries(M.MODEL_EN)) assert.equal(CATALOGS.en[key], value, `${key}: comments-model.ts and shared/locales/en/comments.mjs disagree`)
  const ru = translator('ru')
  const scene = [rect('box', 0, 0, 100, 50), { id: 'label', type: 'text', x: 10, y: 10, width: 80, height: 20, containerId: 'box', text: 'Платежи' }, rect('bare', 200, 0, 100, 50), rect('stick', 400, 0, 100, 100, { customData: { kind: 'sticky' } })]
  assert.equal(M.placeName(scene, 'box', ru), '«Платежи»')
  assert.equal(M.placeName(scene, 'bare', ru), 'Прямоугольник')
  assert.equal(M.placeName(scene, 'stick', ru), 'Стикер')
  assert.equal(M.placeName(scene, null, ru), 'Холст')
  const now = Date.parse('2026-10-19T12:00:00.000Z')
  assert.equal(M.relativeTime('2026-10-19T11:59:30.000Z', now, ru), 'только что')
  assert.equal(M.relativeTime('2026-10-19T11:55:00.000Z', now, ru), '5 мин')
  assert.equal(M.relativeTime('2026-10-19T10:00:00.000Z', now, ru), '2 ч')
  assert.equal(ru('comments.replies', { count: 1 }), '1 ответ')
  assert.equal(ru('comments.replies', { count: 3 }), '3 ответа')
  assert.equal(ru('comments.replies', { count: 11 }), '11 ответов')
})
