/**
 * A board as text: the reason this service exists.
 *
 * An agent given a screenshot of a diagram spends thousands of tokens decoding
 * the picture and still confuses which arrow goes where. The Excalidraw scene
 * already holds the answer in structured form: a shape has a label, an arrow is
 * bound to shapes at both ends. This module folds the scene into compact
 * markdown: what is drawn, how it's labelled, what connects to what, and where.
 *
 * Raw JSON won't do: each shape carries thirty-odd render fields (roughness,
 * seed, stroke width), and a board of twenty rectangles weighs a hundred
 * kilobytes. The text below for the same board is a couple of kilobytes, and it
 * includes every element id so the agent can refer to it in an edit.
 */

import { analyzeSlop } from '../shared/slop.mjs'
import { classify } from '../shared/links.mjs'

const SHAPES = { rectangle: 'rectangle', ellipse: 'ellipse', diamond: 'diamond' }

/** An unbound arrow end closer than this to a shape counts as touching it. */
const SNAP = 24

const round = (n) => Math.round(Number(n) || 0)

/** "1 shape", "3 shapes"; pass `many` for irregular plurals. */
export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * Colour name from its hue.
 *
 * The Excalidraw palette has a dozen fixed colours, but people can pick any.
 * A hue-based name reads the same to an agent in both cases: "red" on a diagram
 * almost always means "problem", and saying so in a word is cheaper than making
 * the agent match `#e03131` against the palette.
 */
export function colorName(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex ?? '').trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d < 0.08) return l > 0.85 ? 'white' : l < 0.2 ? 'black' : 'grey'
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = (h * 60 + 360) % 360
  const light = l > 0.75 ? 'light ' : ''
  if (h < 15 || h >= 345) return `${light}red`
  if (h < 40) return `${light}orange`
  if (h < 65) return `${light}yellow`
  if (h < 160) return `${light}green`
  if (h < 200) return `${light}teal`
  if (h < 250) return `${light}blue`
  if (h < 290) return `${light}violet`
  return `${light}pink`
}

const oneLine = (text) => String(text ?? '').replace(/\s*\n\s*/g, ' / ').trim()
const quote = (text) => `"${oneLine(text)}"`

function bounds(el) {
  const x1 = Math.min(el.x, el.x + el.width)
  const y1 = Math.min(el.y, el.y + el.height)
  return { x1, y1, x2: x1 + Math.abs(el.width), y2: y1 + Math.abs(el.height) }
}

function distanceToBox(px, py, box) {
  const dx = Math.max(box.x1 - px, 0, px - box.x2)
  const dy = Math.max(box.y1 - py, 0, py - box.y2)
  return Math.hypot(dx, dy)
}

function arrowEnds(el) {
  const points = Array.isArray(el.points) && el.points.length ? el.points : [[0, 0]]
  const first = points[0]
  const last = points[points.length - 1]
  return {
    start: { x: el.x + first[0], y: el.y + first[1] },
    end: { x: el.x + last[0], y: el.y + last[1] },
  }
}

/**
 * What an arrow end points at.
 *
 * An arrow drawn by an agent or a careful person is bound to a shape
 * (`startBinding`). But by hand an arrow is often dropped "roughly at the
 * rectangle": no binding, yet the connection is meant. Such ends snap to the
 * nearest shape within a couple dozen pixels, or half of human-drawn
 * connections would be missing from the text.
 */
function endpointTarget(binding, point, shapes) {
  if (binding?.elementId) {
    const bound = shapes.find((s) => s.id === binding.elementId)
    if (bound) return bound
  }
  let best = null
  let bestDistance = SNAP
  for (const shape of shapes) {
    const d = distanceToBox(point.x, point.y, bounds(shape))
    if (d <= bestDistance) {
      best = shape
      bestDistance = d
    }
  }
  return best
}

/** Splits the scene into what the text needs: labelled shapes, connections, free text. */
export function describeScene(elements) {
  const live = elements.filter((el) => el && !el.isDeleted)
  const byId = new Map(live.map((el) => [el.id, el]))

  const labelOf = new Map()
  for (const el of live) {
    if (el.type === 'text' && el.containerId && byId.has(el.containerId)) {
      labelOf.set(el.containerId, el.originalText ?? el.text)
    }
  }

  const frames = live.filter((el) => el.type === 'frame' || el.type === 'magicframe')
  const shapes = live.filter((el) => el.type in SHAPES || el.type === 'image' || el.type === 'embeddable' || el.type === 'iframe')
  const connectors = live.filter((el) => el.type === 'arrow' || (el.type === 'line' && labelOf.has(el.id)))
  const texts = live.filter((el) => el.type === 'text' && !(el.containerId && byId.has(el.containerId)))
  const freedraw = live.filter((el) => el.type === 'freedraw')
  const lines = live.filter((el) => el.type === 'line' && !labelOf.has(el.id))
  const images = live.filter((el) => el.type === 'image')

  const edges = connectors.map((el) => {
    const ends = arrowEnds(el)
    const from = endpointTarget(el.startBinding, ends.start, shapes)
    const to = endpointTarget(el.endBinding, ends.end, shapes)
    return { el, from, to, ends, label: labelOf.get(el.id) }
  })

  return { live, byId, labelOf, frames, shapes, edges, texts, freedraw, lines, images }
}

function nodeRef(shape, labelOf) {
  const label = labelOf.get(shape.id)
  const name = label ? quote(label) : shape.type === 'image' ? 'image' : SHAPES[shape.type] ?? shape.type
  return `${name} [${shape.id}]`
}

/** Sticky reactions as one line: "👍 2 (Alice, Bob) · ❤️ 1 (Carol)". */
export function reactionsLine(reactions) {
  return Object.entries(reactions ?? {})
    .filter(([, names]) => Array.isArray(names) && names.length)
    .map(([emoji, names]) => `${emoji} ${names.length} (${names.join(', ')})`)
    .join(' · ')
}

const isSticky = (el) => el.customData?.kind === 'sticky'
const isCard = (el) => el.customData?.kind === 'card' && typeof (el.customData.url ?? el.link) === 'string'

function stickyLine(shape, labelOf, reactions = shape.customData?.reactions) {
  const label = labelOf.get(shape.id)
  const parts = [`- [${shape.id}] sticky ${label ? quote(label) : '(empty)'} (${round(shape.x)},${round(shape.y)})`]
  const color = colorName(shape.backgroundColor)
  if (color) parts.push(` — ${color}`)
  if (shape.customData?.author) parts.push(` · by ${shape.customData.author}`)
  const votes = reactionsLine(reactions)
  if (votes) parts.push(` · ${votes}`)
  return parts.join('')
}

/**
 * A link card is drawn as a plain rectangle with a fallback label, so in the
 * text it is a link, not a box: board card for another board on this server,
 * bookmark for any other URL.
 */
function cardLine(shape, labelOf, boardOrigin) {
  const url = shape.customData.url ?? shape.link
  const target = classify(url, { boardOrigin })
  const kind = target?.kind === 'board' ? 'board card' : 'bookmark'
  const label = labelOf.get(shape.id)
  const parts = [`- [${shape.id}] ${kind}${label ? ` ${quote(label)}` : ''} (${round(shape.x)},${round(shape.y)}) — ${url}`]
  if (shape.customData?.editedBy) parts.push(` · edited by ${shape.customData.editedBy}`)
  return parts.join('')
}

function shapeLine(shape, labelOf, boardOrigin) {
  if (isSticky(shape)) return stickyLine(shape, labelOf)
  if (isCard(shape)) return cardLine(shape, labelOf, boardOrigin)
  const kind = SHAPES[shape.type] ?? shape.type
  const label = labelOf.get(shape.id)
  const parts = [`- [${shape.id}] ${kind}${label ? ` ${quote(label)}` : ''} (${round(shape.x)},${round(shape.y)} ${round(shape.width)}×${round(shape.height)})`]
  const fill = shape.backgroundColor && shape.backgroundColor !== 'transparent' ? colorName(shape.backgroundColor) : null
  const stroke = shape.strokeColor && !/^#1e1e1e$|^#000000$/i.test(shape.strokeColor) ? colorName(shape.strokeColor) : null
  const colors = [fill && `fill ${fill}`, stroke && `stroke ${stroke}`, shape.strokeStyle && shape.strokeStyle !== 'solid' ? 'dashed' : null].filter(Boolean)
  if (colors.length) parts.push(` — ${colors.join(', ')}`)
  if (shape.link) parts.push(` — link ${shape.link}`)
  if (shape.customData?.editedBy) parts.push(` · edited by ${shape.customData.editedBy}`)
  return parts.join('')
}

const readingOrder = (a, b) => (Math.abs(a.y - b.y) > 20 ? a.y - b.y : a.x - b.x)

/**
 * Markdown for agents.
 *
 * `url` is the board's own address: an agent that gets the text second-hand
 * must know where to send an edit. `task` is a free-form reference (an issue
 * key, a URL) shown as is.
 */
export function summarize(elements, { title, description, url, updatedAt, author, access, tags, task, notes } = {}) {
  const scene = describeScene(elements)
  const { labelOf, frames, shapes, edges, texts, freedraw, lines, images } = scene
  const boardOrigin = originOf(url)

  const out = []
  out.push(`# Board ${quote(title ?? 'Untitled')}`)
  if (description) out.push('', oneLine(description))
  const counts = [
    plural(shapes.length - images.length, 'shape'),
    plural(edges.length, 'connection'),
    plural(texts.length, 'text'),
    freedraw.length ? plural(freedraw.length, 'freehand drawing') : null,
    images.length ? plural(images.length, 'image') : null,
  ].filter(Boolean)
  out.push('', [url ? `URL: ${url}` : null, updatedAt ? `updated ${updatedAt}` : null, counts.join(', ')].filter(Boolean).join(' · '))
  const who = [author ? `Author: ${author}` : null, access === 'link' ? 'anyone with the link can edit' : access ? 'only signed-in members can edit' : null].filter(Boolean)
  if (who.length) out.push(who.join(' · '))
  const about = [task ? `Reference: ${task}` : null, Array.isArray(tags) && tags.length ? `Tags: ${tags.join(', ')}` : null].filter(Boolean)
  if (about.length) out.push(about.join(' · '))
  out.push('', 'Ids in [brackets] are for edits via the API; coordinates (x,y) and size w×h are canvas pixels.')

  if (scene.live.length === 0) {
    out.push('', 'The board is empty.')
    return `${out.join('\n')}\n`
  }

  const inFrame = new Map(frames.map((f) => [f.id, []]))
  const loose = []
  // Stickies get their own section: they are people's remarks, not diagram
  // nodes, and an agent reads them best in a row, with authors and votes.
  const stickies = shapes.filter(isSticky).sort(readingOrder)
  for (const shape of [...shapes].filter((el) => !isSticky(el)).sort(readingOrder)) {
    if (shape.frameId && inFrame.has(shape.frameId)) inFrame.get(shape.frameId).push(shape)
    else loose.push(shape)
  }

  for (const frame of [...frames].sort(readingOrder)) {
    out.push('', `## Frame ${quote(frame.name ?? 'Untitled')} [${frame.id}] (${round(frame.x)},${round(frame.y)} ${round(frame.width)}×${round(frame.height)})`)
    const members = inFrame.get(frame.id)
    if (members.length === 0) out.push('- empty')
    for (const shape of members) out.push(shapeLine(shape, labelOf, boardOrigin))
  }

  if (loose.length) {
    out.push('', frames.length ? '## Shapes outside frames' : '## Shapes')
    for (const shape of loose) out.push(shapeLine(shape, labelOf, boardOrigin))
  }

  if (stickies.length) {
    out.push('', '## Stickies')
    for (const shape of stickies) out.push(stickyLine(shape, labelOf, notes?.reactions?.[shape.id] ?? shape.customData?.reactions))
  }

  out.push(...commentsSection(notes?.comments ?? [], labelOf))

  if (edges.length) {
    out.push('', '## Connections')
    for (const { el, from, to, ends, label } of edges) {
      const a = from ? nodeRef(from, labelOf) : `point (${round(ends.start.x)},${round(ends.start.y)})`
      const b = to ? nodeRef(to, labelOf) : `point (${round(ends.end.x)},${round(ends.end.y)})`
      const both = el.startArrowhead && el.endArrowhead
      const arrow = el.type === 'line' || (!el.startArrowhead && !el.endArrowhead) ? '—' : both ? '↔' : el.startArrowhead ? '←' : '→'
      const style = el.strokeStyle && el.strokeStyle !== 'solid' ? ' (dashed)' : ''
      out.push(`- [${el.id}] ${a} ${arrow} ${b}${label ? ` — ${quote(label)}` : ''}${style}`)
    }
  }

  if (texts.length) {
    out.push('', '## Text')
    for (const t of [...texts].sort(readingOrder)) {
      const frame = t.frameId ? frames.find((f) => f.id === t.frameId) : null
      out.push(`- [${t.id}] ${quote(t.originalText ?? t.text)} (${round(t.x)},${round(t.y)})${frame ? ` in frame ${quote(frame.name ?? '')}` : ''}`)
    }
  }

  const rest = []
  if (freedraw.length) rest.push(plural(freedraw.length, 'freehand drawing'))
  if (lines.length) rest.push(plural(lines.length, 'unlabelled line'))
  if (rest.length) out.push('', `Also: ${rest.join(', ')} (no meaning in text, visible only in the editor).`)

  out.push('', ...slopSection(elements))

  return `${out.join('\n')}\n`
}

function originOf(url) {
  try {
    return url ? new URL(url).origin : undefined
  } catch {
    return undefined
  }
}

/**
 * Comments are the discussion on top of the board: open threads in full,
 * resolved ones as a count. The agent needs them to reply where it was asked.
 */
function commentsSection(comments, labelOf) {
  const open = comments.filter((t) => !t.resolved)
  const resolved = comments.length - open.length
  if (!comments.length) return []
  const out = ['', `## Comments — ${plural(open.length, 'open thread')}${resolved ? `, ${resolved} resolved` : ''}`]
  open.forEach((t) => {
    const where = t.elementId ? `on ${labelOf.get(t.elementId) ? quote(labelOf.get(t.elementId)) : 'shape'} [${t.elementId}]` : `at (${round(t.x)},${round(t.y)})`
    const [first, ...replies] = t.messages ?? []
    out.push(`- [${t.id}] ${where} — ${first?.author ?? '?'}: ${quote(oneLine(first?.text ?? ''))}`)
    for (const r of replies) {
      // A reply to a specific message: the agent sees who is being answered.
      const target = r.replyTo ? (t.messages ?? []).find((m) => m.id === r.replyTo) : null
      out.push(`  - ${r.author}${target ? ` (replying to ${target.author}: ${quote(oneLine(target.text))})` : ''}: ${quote(oneLine(r.text))}`)
    }
  })
  return out
}

const SLOP_LEVEL = { warn: 'some signs', slop: 'looks like AI slop' }
const SLOP_MAX_ISSUES = 5
const SLOP_MAX_IDS = 8

/**
 * The slop check goes last, so that right after its edit the agent sees what to
 * fix and can fix it by element id. A clean board is one line: nothing to read.
 */
function slopSection(elements) {
  const { score, level, issues } = analyzeSlop(elements)
  if (level === 'clean') return [`Slop check: clean, ${score}/100.`]
  const lines = [`## Slop check — ${score}/100, ${SLOP_LEVEL[level]}`]
  for (const issue of issues.slice(0, SLOP_MAX_ISSUES)) {
    const shown = issue.elementIds.slice(0, SLOP_MAX_IDS)
    const more = issue.elementIds.length - shown.length
    const refs = shown.length ? ` [${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}]` : ''
    lines.push(`- ${issue.title}: ${issue.detail}${refs}`)
  }
  if (issues.length > SLOP_MAX_ISSUES) lines.push(`- and ${plural(issues.length - SLOP_MAX_ISSUES, 'more sign')}, visible in the editor`)
  return lines
}
