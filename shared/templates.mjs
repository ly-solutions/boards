/**
 * Board templates and the component library.
 *
 * Without them a nice-looking board only happened when someone asked an agent
 * to "make it pretty"; by hand people started from a blank sheet and grey
 * rectangles. These are ready starts in one consistent style: pastel zones with
 * a colored rule next to the heading, white cards stroked in the zone's tone,
 * one font (Nunito), straight lines, whitespace.
 *
 * A template is an Excalidraw skeleton (same format as an agent edit); the
 * server turns it into elements with its engine, both when a board is created
 * from a template and when a template is inserted into an open editor. A
 * library component is the same kind of skeleton, just small.
 *
 * Templates follow the same rules the slop check enforces: at most three bright
 * colors, one font, a 36/22/18/14 type scale, an 8px grid, no emoji or decor.
 */
import { INK, MUTED, STICKY_COLORS, STYLE, paint, stickyStroke, toneById } from './palette.mjs'

const FONT = STYLE.fontFamily
const SIZE = { title: 36, section: 22, body: 18, note: 14 }

// ── Building blocks ─────────────────────────────────────────────────────────

const shape = { roughness: STYLE.roughness, strokeWidth: STYLE.strokeWidth, fillStyle: 'solid', strokeStyle: 'solid' }

function text(id, x, y, value, { size = SIZE.body, color = INK, align = 'left' } = {}) {
  return { type: 'text', id, x, y, text: value, fontSize: size, fontFamily: FONT, strokeColor: color, textAlign: align }
}

/** Board title with a one-line subtitle. */
function heading(prefix, x, y, title, subtitle) {
  const out = [text(`${prefix}-title`, x, y, title, { size: SIZE.title })]
  if (subtitle) out.push(text(`${prefix}-subtitle`, x, y + 52, subtitle, { size: SIZE.body, color: MUTED }))
  return out
}

/** Section zone: pastel tone background, slightly darker border, a colored rule by the heading. */
function zone(id, x, y, w, h, title, toneId, { note } = {}) {
  const tone = toneById(toneId)
  const p = paint(tone, 'zone')
  const out = [
    { type: 'rectangle', id, x, y, width: w, height: h, ...shape, roundness: STYLE.roundness, strokeColor: p.strokeColor, backgroundColor: p.backgroundColor },
    { type: 'rectangle', id: `${id}-bar`, x: x + 24, y: y + 26, width: 5, height: 26, ...shape, strokeWidth: 1, roundness: null, strokeColor: tone.strong, backgroundColor: tone.strong },
    text(`${id}-title`, x + 40, y + 24, title, { size: SIZE.section, color: tone.ink }),
  ]
  if (note) out.push(text(`${id}-note`, x + 40, y + 56, note, { size: SIZE.note, color: MUTED }))
  return out
}

/** Card: white, stroked in the tone (or grey), dark centered label. */
function card(id, x, y, label, toneId, { w = 200, h = 72, variant = 'card', dashed = false, shapeType = 'rectangle' } = {}) {
  const tone = toneId ? toneById(toneId) : null
  const p = tone ? paint(tone, variant) : { strokeColor: '#ced4da', backgroundColor: '#ffffff', text: INK }
  return {
    type: shapeType,
    id,
    x,
    y,
    width: w,
    height: h,
    ...shape,
    ...(shapeType === 'rectangle' ? { roundness: STYLE.roundness } : {}),
    ...(dashed ? { strokeStyle: 'dashed' } : {}),
    strokeColor: p.strokeColor,
    backgroundColor: p.backgroundColor,
    label: { text: label, fontSize: SIZE.body, fontFamily: FONT, strokeColor: p.text },
  }
}

/** Column header badge: bright tone fill, light label. */
function header(id, x, y, w, label, toneId) {
  return card(id, x, y, label, toneId, { w, h: 44, variant: 'strong' })
}

/** Sticky: a FigJam-style pastel square with centered text, same as one created in the editor; author and reactions live in customData. */
export function sticky(id, x, y, label, colorId = 'yellow', { author = null, size = 176 } = {}) {
  const color = STICKY_COLORS.find((c) => c.id === colorId) ?? STICKY_COLORS[0]
  return {
    type: 'rectangle',
    id,
    x,
    y,
    width: size,
    height: size,
    ...shape,
    strokeWidth: 1,
    roundness: { type: 3, value: 12 },
    strokeColor: stickyStroke(color.fill),
    backgroundColor: color.fill,
    customData: { kind: 'sticky', ...(author ? { author } : {}), reactions: {} },
    label: { text: label, fontSize: SIZE.body, fontFamily: FONT, strokeColor: INK },
  }
}

function arrow(id, from, to, { label, dashed = false, color = MUTED } = {}) {
  return {
    type: 'arrow',
    id,
    start: { id: from },
    end: { id: to },
    roughness: STYLE.roughness,
    strokeWidth: STYLE.strokeWidth,
    strokeColor: color,
    ...(dashed ? { strokeStyle: 'dashed' } : {}),
    ...(label ? { label: { text: label, fontSize: SIZE.note, fontFamily: FONT, strokeColor: MUTED } } : {}),
  }
}

/** Legend: marker and label in a row. */
function legend(prefix, x, y, items) {
  const out = []
  let cx = x
  items.forEach(([label, fill, stroke = fill, dashed = false], i) => {
    // A line marker is a segment, a color marker is a square: the legend shows what it explains.
    if (fill === 'line') out.push({ type: 'line', id: `${prefix}-m${i}`, x: cx, y: y + 11, width: 28, height: 0, points: [[0, 0], [28, 0]], roughness: STYLE.roughness, strokeWidth: STYLE.strokeWidth, strokeColor: stroke, ...(dashed ? { strokeStyle: 'dashed' } : {}) })
    else out.push({ type: 'rectangle', id: `${prefix}-m${i}`, x: cx, y: y + 3, width: 16, height: 16, ...shape, strokeWidth: 1, roundness: { type: 3, value: 4 }, strokeColor: stroke, backgroundColor: fill })
    const gap = fill === 'line' ? 36 : 24
    out.push(text(`${prefix}-l${i}`, cx + gap, y, label, { size: SIZE.note, color: MUTED }))
    cx += gap + label.length * 8 + 32
  })
  return out
}

// ── Templates ───────────────────────────────────────────────────────────────

function architecture() {
  const lanes = [
    ['arch-clients', 'Clients', 'blue', ['Website', 'Mobile app']],
    ['arch-edge', 'Edge', 'purple', ['Gateway', 'BFF']],
    ['arch-services', 'Services', 'teal', ['Service A', 'Service B']],
    ['arch-data', 'Data', 'slate', ['PostgreSQL', 'Kafka']],
  ]
  const out = heading('arch', 0, 0, 'Architecture', 'Who calls whom and where the data lives. Solid line — synchronous, dashed — via a queue')
  lanes.forEach(([id, title, tone, cards], i) => {
    const x = i * 296
    out.push(...zone(id, x, 120, 272, 312, title, tone))
    cards.forEach((label, j) => out.push(card(`${id}-c${j}`, x + 24, 208 + j * 104, label, tone, { w: 224, dashed: id === 'arch-data' && j === 1 })))
  })
  out.push(
    arrow('arch-a1', 'arch-clients-c0', 'arch-edge-c0'),
    arrow('arch-a2', 'arch-clients-c1', 'arch-edge-c1'),
    arrow('arch-a3', 'arch-edge-c0', 'arch-services-c0', { label: 'REST' }),
    arrow('arch-a4', 'arch-edge-c1', 'arch-services-c1'),
    arrow('arch-a5', 'arch-services-c0', 'arch-data-c0'),
    arrow('arch-a6', 'arch-services-c1', 'arch-data-c1', { dashed: true, label: 'event' }),
    ...legend('arch-legend', 0, 464, [['synchronous call', 'line', MUTED], ['async, via a queue', 'line', MUTED, true]]),
  )
  return out
}

function flow() {
  const out = heading('flow', 0, 0, 'User journey', 'Steps left to right; diamond — a branch, red border — where people drop off')
  out.push(...zone('flow-zone', 0, 120, 1336, 344, 'Checkout', 'purple', { note: 'from opening the page to the receipt in the inbox' }))
  const steps = [['flow-s1', 'Opened the page'], ['flow-s2', 'Picked a plan'], ['flow-s3', 'Paid']]
  steps.forEach(([id, label], i) => out.push(card(id, 40 + i * 248, 216, label, 'purple')))
  out.push(card('flow-d', 784, 200, 'Payment OK?', 'amber', { shapeType: 'diamond', w: 200, h: 104, variant: 'zone' }))
  out.push(card('flow-ok', 1080, 216, 'Receipt in inbox', 'green', { variant: 'zone' }))
  out.push(card('flow-fail', 784, 360, 'Left without buying', 'red', { w: 200 }))
  out.push(
    arrow('flow-a1', 'flow-s1', 'flow-s2'),
    arrow('flow-a2', 'flow-s2', 'flow-s3'),
    arrow('flow-a3', 'flow-s3', 'flow-d'),
    arrow('flow-a4', 'flow-d', 'flow-ok', { label: 'yes' }),
    arrow('flow-a5', 'flow-d', 'flow-fail', { label: 'no' }),
  )
  return out
}

function columns(prefix, title, subtitle, cols, { stickies = [] } = {}) {
  const out = heading(prefix, 0, 0, title, subtitle)
  cols.forEach(([id, name, tone], i) => {
    const x = i * 272
    out.push(header(`${prefix}-${id}`, x, 120, 248, name, tone))
    out.push({ type: 'rectangle', id: `${prefix}-${id}-lane`, x, y: 180, width: 248, height: 520, ...shape, strokeWidth: 1, roundness: STYLE.roundness, strokeColor: toneById(tone).zoneBorder, backgroundColor: toneById(tone).zone })
  })
  for (const [col, row, label, color] of stickies) out.push(sticky(`${prefix}-st-${col}-${row}`, col * 272 + 36, 204 + row * 200, label, color))
  return out
}

function retro() {
  return columns('retro', 'Retro', 'One sticky per thought, then vote with reactions', [
    ['good', 'What went well', 'green'],
    ['bad', 'What got in the way', 'rose'],
    ['try', 'What we try next', 'blue'],
  ], { stickies: [[0, 0, 'Example: shipped with zero rollbacks', 'green'], [1, 0, 'Example: waited two days for review', 'pink'], [2, 0, 'Example: a flag for every feature', 'blue']] })
}

function weekly() {
  const out = columns('week', 'Weekly plan', 'One sticky — one commitment. On Friday recolor it: done, partly, missed', [
    ['a', 'Person A', 'green'],
    ['b', 'Person B', 'purple'],
    ['c', 'Person C', 'blue'],
    ['team', 'Team', 'rose'],
  ], { stickies: [[0, 0, '', 'white'], [1, 0, '', 'white'], [2, 0, '', 'white'], [3, 0, '', 'white']] })
  out.push(...legend('week-legend', 0, 732, [['done', STICKY_COLORS.find((c) => c.id === 'green').fill], ['partly', STICKY_COLORS.find((c) => c.id === 'yellow').fill], ['missed', STICKY_COLORS.find((c) => c.id === 'salmon').fill]]))
  return out
}

function brainstorm() {
  const out = heading('idea', 0, 0, 'Brainstorm', 'Question on top, ideas as stickies, best ones by reactions')
  out.push(card('idea-q', 0, 112, 'Question: what do we want to come up with?', 'purple', { w: 752, h: 88, variant: 'zone' }))
  out.push(...zone('idea-zone', 0, 232, 752, 456, 'Ideas', 'amber', { note: 'one thought — one sticky' }))
  const colors = ['yellow', 'yellow', 'orange', 'yellow', 'green', 'yellow', 'blue', 'yellow']
  colors.slice(0, 6).forEach((c, i) => out.push(sticky(`idea-st${i}`, 40 + (i % 3) * 232, 312 + Math.floor(i / 3) * 192, '', c, { size: 168 })))
  return out
}

function incident() {
  const out = heading('inc', 0, 0, 'Incident review', 'What happened, why, what we change. Blameless')
  out.push(...zone('inc-time', 0, 120, 1112, 208, 'Timeline', 'slate', { note: 'times in UTC' }))
  ;['Alert', 'Noticed', 'Found the cause', 'Fixed'].forEach((label, i) => out.push(card(`inc-t${i}`, 40 + i * 264, 208, `${label}\n00:00`, i === 0 ? 'red' : 'slate', { w: 224, h: 88 })))
  for (let i = 0; i < 3; i += 1) out.push(arrow(`inc-ta${i}`, `inc-t${i}`, `inc-t${i + 1}`))
  out.push(...zone('inc-cause', 0, 360, 544, 264, 'Cause', 'rose'))
  out.push(card('inc-c0', 40, 448, 'What broke', 'rose', { w: 464, h: 72 }))
  out.push(card('inc-c1', 40, 536, 'Why we did not catch it earlier', 'rose', { w: 464, h: 72 }))
  out.push(...zone('inc-fix', 568, 360, 544, 264, 'What we change', 'green'))
  out.push(card('inc-f0', 608, 448, 'Action — owner', 'green', { w: 464, h: 72 }))
  out.push(card('inc-f1', 608, 536, 'Action — owner', 'green', { w: 464, h: 72 }))
  return out
}

function decision() {
  const out = heading('rfc', 0, 0, 'Decision', 'Question, options with pros and cons, outcome with a date')
  out.push(card('rfc-q', 0, 112, 'What we decide and by when', 'purple', { w: 872, h: 88, variant: 'zone' }))
  ;[['a', 'Option A', 'blue'], ['b', 'Option B', 'teal'], ['c', 'Option C', 'slate']].forEach(([id, name, tone], i) => {
    const x = i * 296
    out.push(...zone(`rfc-${id}`, x, 232, 280, 304, name, tone))
    out.push(card(`rfc-${id}-plus`, x + 32, 312, '+ pro', 'green', { w: 216, h: 88 }))
    out.push(card(`rfc-${id}-minus`, x + 32, 416, '− con', 'red', { w: 216, h: 88 }))
  })
  out.push(card('rfc-result', 0, 568, 'Decided: … — because …', 'purple', { w: 872, h: 88, variant: 'strong' }))
  return out
}

export const TEMPLATES = [
  { id: 'blank', title: 'Blank board', description: 'A clean sheet in the board style', build: () => [] },
  { id: 'architecture', title: 'Architecture', description: 'Clients, edge, services, data — zones left to right', build: architecture },
  { id: 'flow', title: 'User journey', description: 'Steps, a branch, where people drop off', build: flow },
  { id: 'weekly', title: 'Weekly plan', description: 'A column per person, commitment stickies, Friday outcome', build: weekly },
  { id: 'retro', title: 'Retro', description: 'Went well, got in the way, try next — stickies and reactions', build: retro },
  { id: 'brainstorm', title: 'Brainstorm', description: 'A question and a field for idea stickies', build: brainstorm },
  { id: 'incident', title: 'Incident review', description: 'Timeline, cause, what we change', build: incident },
  { id: 'decision', title: 'Decision', description: 'Options with pros and cons, and the outcome', build: decision },
]

export function templateById(id) {
  return TEMPLATES.find((t) => t.id === id) ?? null
}

// ── Component library ───────────────────────────────────────────────────────

/** Components for the Excalidraw library panel: each is a small skeleton. */
export const COMPONENTS = [
  { id: 'lib-card', name: 'Card', build: () => [card('c', 0, 0, 'Service', 'purple')] },
  { id: 'lib-card-zone', name: 'Filled card', build: () => [card('c', 0, 0, 'Service', 'blue', { variant: 'zone' })] },
  { id: 'lib-external', name: 'External system', build: () => [card('c', 0, 0, 'Payment provider', 'slate', { dashed: true })] },
  { id: 'lib-decision', name: 'Branch', build: () => [card('c', 0, 0, 'Condition?', 'amber', { shapeType: 'diamond', w: 200, h: 104, variant: 'zone' })] },
  { id: 'lib-person', name: 'Role', build: () => [card('c', 0, 0, 'Customer', 'rose', { shapeType: 'ellipse', w: 184, h: 72, variant: 'zone' })] },
  { id: 'lib-header', name: 'Column header', build: () => [header('c', 0, 0, 248, 'Column', 'purple')] },
  { id: 'lib-zone', name: 'Zone', build: () => zone('z', 0, 0, 480, 280, 'Section', 'teal') },
  { id: 'lib-heading', name: 'Board heading', build: () => heading('h', 0, 0, 'Heading', 'One line on what this board is for') },
  { id: 'lib-sticky', name: 'Sticky', build: () => [sticky('s', 0, 0, '', 'yellow')] },
  { id: 'lib-legend', name: 'Legend', build: () => legend('l', 0, 0, [['done', '#b3efbd'], ['partly', '#ffe299'], ['missed', '#ffb8a8']]) },
  { id: 'lib-flow', name: 'Two steps', build: () => [card('a', 0, 0, 'Step 1', 'purple'), card('b', 296, 0, 'Step 2', 'purple'), arrow('ab', 'a', 'b')] },
]
