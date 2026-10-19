/**
 * Agent edits to a board: add, change, delete.
 *
 * Agents don't think in coordinates: they think "service A calls service B", not
 * "rectangle at (420, 180)". So the main input is a graph (labelled nodes and
 * edges between them) laid out by dagre. For precise control there is a second
 * input: an Excalidraw element skeleton with coordinates.
 *
 * Both become real elements via the package's official converter
 * (`convertToExcalidrawElements`) bundled for Node, so the element format stays
 * Excalidraw's concern, not ours.
 *
 * Arrow-to-shape binding is done here rather than by the converter: it can only
 * bind to shapes from the same skeleton, while agents keep connecting new shapes
 * to ones already on the board.
 */
import dagre from '@dagrejs/dagre'
import { randomInt } from 'node:crypto'
import { INK, MUTED, STYLE, paint, toneById, toneForName } from '../shared/palette.mjs'

let enginePromise = null
/** The heavy bundle (jsdom + Excalidraw) loads on the first edit, not at startup. */
export function loadEngine() {
  enginePromise ??= import(new URL('../dist/engine.mjs', import.meta.url).href)
  return enginePromise
}

/**
 * A colour name maps to a tone of the board palette (shared/palette.mjs): it's
 * easier for an agent to say "red" than to remember the palette, and the board
 * doesn't turn into a rainbow of acid fills. A coloured shape gets the tone's
 * pastel fill and border, with dark text. An exact hex is still accepted as is.
 */
export function resolveColor(color, variant = 'zone') {
  if (!color) return null
  const raw = String(color).trim().toLowerCase()
  if (/^#[0-9a-f]{6}$/.test(raw)) return { stroke: raw, fill: raw, text: INK }
  const tone = toneForName(raw) ?? toneById(raw)
  if (!tone) return null
  const p = paint(tone, variant === 'zone' ? 'zone' : variant)
  return { stroke: variant === 'zone' ? tone.border : p.strokeColor, fill: p.backgroundColor, text: variant === 'strong' ? p.text : INK, ink: tone.ink }
}

/** An uncoloured node is a white card with a grey border: colour is reserved for meaning. */
const NEUTRAL = { stroke: '#ced4da', fill: '#ffffff', text: INK }
const LABEL_FONT = { fontFamily: STYLE.fontFamily }
const SHAPE_STYLE = { roughness: STYLE.roughness, strokeWidth: STYLE.strokeWidth, fillStyle: 'solid' }

export class EditError extends Error {}

const SHAPE_TYPES = new Set(['rectangle', 'ellipse', 'diamond'])
const FONT_SIZE = 20

function bbox(el) {
  return { x: Math.min(el.x, el.x + el.width), y: Math.min(el.y, el.y + el.height), w: Math.abs(el.width), h: Math.abs(el.height) }
}

/** Point on the box border towards the target: where the arrow ends. */
export function borderPoint(box, toward, gap = 8) {
  const cx = box.x + box.w / 2
  const cy = box.y + box.h / 2
  const dx = toward.x - cx
  const dy = toward.y - cy
  if (dx === 0 && dy === 0) return { x: cx, y: cy }
  const scale = Math.min(
    dx === 0 ? Infinity : (box.w / 2 + gap) / Math.abs(dx),
    dy === 0 ? Infinity : (box.h / 2 + gap) / Math.abs(dy),
  )
  return { x: cx + dx * scale, y: cy + dy * scale }
}

/** Geometry of a straight arrow between two shapes. */
export function arrowGeometry(fromBox, toBox) {
  const fromCenter = { x: fromBox.x + fromBox.w / 2, y: fromBox.y + fromBox.h / 2 }
  const toCenter = { x: toBox.x + toBox.w / 2, y: toBox.y + toBox.h / 2 }
  const start = borderPoint(fromBox, toCenter)
  const end = borderPoint(toBox, fromCenter)
  return { x: start.x, y: start.y, points: [[0, 0], [end.x - start.x, end.y - start.y]] }
}

const nonce = () => randomInt(1, 2 ** 31 - 1)

/** New element version: every edit must bump `version`, or the merge will drop it. */
function bump(el, changes, now) {
  return { ...el, ...changes, version: (el.version ?? 1) + 1, versionNonce: nonce(), updated: now }
}

function sceneBounds(elements) {
  const live = elements.filter((el) => !el.isDeleted)
  if (!live.length) return null
  let x1 = Infinity
  let y1 = Infinity
  let x2 = -Infinity
  let y2 = -Infinity
  for (const el of live) {
    const b = bbox(el)
    x1 = Math.min(x1, b.x)
    y1 = Math.min(y1, b.y)
    x2 = Math.max(x2, b.x + b.w)
    y2 = Math.max(y2, b.y + b.h)
  }
  return { x1, y1, x2, y2 }
}

/** Whether a segment crosses a box (with a small padding around it). */
export function segmentHitsBox(a, b, box, pad = 6) {
  const x1 = box.x - pad
  const y1 = box.y - pad
  const x2 = box.x + box.w + pad
  const y2 = box.y + box.h + pad
  let t0 = 0
  let t1 = 1
  const dx = b.x - a.x
  const dy = b.y - a.y
  for (const [p, q] of [[-dx, a.x - x1], [dx, x2 - a.x], [-dy, a.y - y1], [dy, y2 - a.y]]) {
    if (p === 0) {
      if (q < 0) return false
    } else {
      const r = q / p
      if (p < 0) t0 = Math.max(t0, r)
      else t1 = Math.min(t1, r)
      if (t0 > t1) return false
    }
  }
  return true
}

/**
 * Best place for a block connected to existing shapes: four candidates around
 * the board, each scored by how many other shapes the arrows from the anchors
 * would cross. Ties go to the first one, below the board, the natural reading order.
 */
function bestOrigin({ g, nodes, edges, existing, anchors, bounds, block }) {
  const width = block.maxX - block.minX
  const height = block.maxY - block.minY
  const anchorBox = sceneBounds(anchors)
  const cx = (anchorBox.x1 + anchorBox.x2) / 2
  const cy = (anchorBox.y1 + anchorBox.y2) / 2
  const gap = 140
  const candidates = [
    { x: cx - width / 2, y: bounds.y2 + gap },
    { x: bounds.x2 + gap, y: cy - height / 2 },
    { x: cx - width / 2, y: bounds.y1 - gap - height - 40 },
    { x: bounds.x1 - gap - width, y: cy - height / 2 },
  ]
  const obstacles = existing.filter((el) => !el.isDeleted && SHAPE_TYPES.has(el.type)).map((el) => ({ id: el.id, box: bbox(el) }))
  const center = (el) => {
    const b = bbox(el)
    return { x: b.x + b.w / 2, y: b.y + b.h / 2 }
  }
  let best = candidates[0]
  let bestScore = Infinity
  for (const candidate of candidates) {
    let score = 0
    for (const edge of edges) {
      const oldId = anchors.some((a) => a.id === edge.from) ? edge.from : anchors.some((a) => a.id === edge.to) ? edge.to : null
      const newId = oldId === edge.from ? edge.to : edge.from
      if (!oldId || !g.node(newId)) continue
      const n = g.node(newId)
      const a = center(anchors.find((el) => el.id === oldId))
      const b = { x: candidate.x + n.x - block.minX, y: candidate.y + n.y - block.minY }
      for (const obstacle of obstacles) if (obstacle.id !== oldId && segmentHitsBox(a, b, obstacle.box)) score += 1
    }
    if (score < bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return { x: Math.round(best.x), y: Math.round(best.y) }
}

/** Node size from its label: text plus padding, never narrower than the minimum. */
function nodeSize(label, measureLine, shape) {
  const lines = String(label ?? '').split('\n')
  const textWidth = Math.max(...lines.map((line) => measureLine(line, FONT_SIZE)))
  const widen = shape === 'diamond' ? 1.8 : shape === 'ellipse' ? 1.4 : 1
  const width = Math.max(140, Math.ceil((textWidth + 48) * widen))
  const height = Math.max(shape === 'diamond' ? 100 : 70, Math.ceil((lines.length * FONT_SIZE * 1.25 + 36) * (shape === 'rectangle' ? 1 : 1.3)))
  return { width, height }
}

/**
 * Graph → skeleton with coordinates.
 *
 * Nodes sharing a `group` are laid out as a cluster and wrapped in a frame with
 * that name, like mermaid's `subgraph`. The layout is placed beside what's
 * already on the board so additions never land on top of existing work.
 */
export function layoutGraph(graph, { measureLine, existing = [], at } = {}) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph?.edges) ? graph.edges : []
  if (nodes.length === 0 && edges.length === 0) throw new EditError('graph: nodes and/or edges are required')

  const existingIds = new Set(existing.filter((el) => !el.isDeleted).map((el) => el.id))
  const g = new dagre.graphlib.Graph({ compound: true, multigraph: true })
  const direction = String(graph.direction ?? 'LR').toUpperCase()
  g.setGraph({
    rankdir: ['LR', 'RL', 'TB', 'BT'].includes(direction) ? direction : 'LR',
    nodesep: 60,
    ranksep: 110,
    marginx: 0,
    marginy: 0,
  })
  g.setDefaultEdgeLabel(() => ({}))

  const groups = new Map()
  for (const node of nodes) {
    if (!node || typeof node.id !== 'string' || !node.id) throw new EditError('graph.nodes: every node needs a string id')
    if (existingIds.has(node.id)) throw new EditError(`graph.nodes: id "${node.id}" is already on the board; to connect to it, reference it in edges only`)
    const shape = SHAPE_TYPES.has(node.shape) ? node.shape : 'rectangle'
    const size = nodeSize(node.label ?? node.id, measureLine, shape)
    g.setNode(node.id, { ...size, width: node.width ?? size.width, height: node.height ?? size.height })
    if (node.group) {
      const groupId = `group:${node.group}`
      if (!groups.has(groupId)) {
        groups.set(groupId, node.group)
        g.setNode(groupId, {})
      }
      g.setParent(node.id, groupId)
    }
  }
  const newIds = new Set(nodes.map((n) => n.id))
  edges.forEach((edge, i) => {
    if (!edge || !edge.from || !edge.to) throw new EditError(`graph.edges[${i}]: from and to are required`)
    for (const end of [edge.from, edge.to]) {
      if (!newIds.has(end) && !existingIds.has(end)) throw new EditError(`graph.edges[${i}]: "${end}" is neither a new node nor on the board`)
    }
    // Only edges between new nodes take part in the layout: existing shapes stay
    // where a person put them, and we have no right to move them.
    // The edge label is a "node" on the edge: without its width dagre packs ranks
    // so tightly that the label swallows the whole arrow.
    const label = edge.label ? { width: Math.ceil(measureLine(String(edge.label), 16) + 40), height: 24, labelpos: 'c' } : {}
    if (newIds.has(edge.from) && newIds.has(edge.to)) g.setEdge(edge.from, edge.to, { minlen: 1, ...label }, `e${i}`)
  })
  dagre.layout(g)

  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const node of nodes) {
    const n = g.node(node.id)
    minX = Math.min(minX, n.x - n.width / 2)
    minY = Math.min(minY, n.y - n.height / 2)
    maxX = Math.max(maxX, n.x + n.width / 2)
    maxY = Math.max(maxY, n.y + n.height / 2)
  }

  // Where to put the new block. Unconnected to existing shapes: right of
  // everything, so it doesn't overlap. Connected: on the side where arrows to the
  // existing shapes cross the fewest other shapes. Always placing it on the right
  // made arrows stretch across the whole board, cutting through labels.
  const bounds = sceneBounds(existing)
  const anchors = existing.filter((el) => !el.isDeleted && edges.some((e) => e.from === el.id || e.to === el.id))
  let origin
  if (at && Number.isFinite(at.x) && Number.isFinite(at.y)) origin = { x: at.x, y: at.y }
  else if (bounds && anchors.length) {
    origin = bestOrigin({ g, nodes, edges, existing, anchors, bounds, block: { minX, minY, maxX, maxY } })
  } else if (bounds) origin = { x: bounds.x2 + 160, y: bounds.y1 }
  else origin = { x: 0, y: 0 }
  // Room for the frame title, if any: otherwise it overlaps the nodes.
  const shiftY = graph.frame || groups.size ? 40 : 0

  const skeleton = []
  for (const node of nodes) {
    const n = g.node(node.id)
    const shape = SHAPE_TYPES.has(node.shape) ? node.shape : 'rectangle'
    const variant = ['card', 'zone', 'strong'].includes(node.style) ? node.style : 'zone'
    const color = resolveColor(node.color, variant) ?? NEUTRAL
    skeleton.push({
      type: shape,
      id: node.id,
      x: Math.round(origin.x + n.x - n.width / 2 - minX),
      y: Math.round(origin.y + shiftY + n.y - n.height / 2 - minY),
      width: Math.round(n.width),
      height: Math.round(n.height),
      label: { text: String(node.label ?? node.id), fontSize: FONT_SIZE, strokeColor: color.text, ...LABEL_FONT },
      ...SHAPE_STYLE,
      ...(shape === 'rectangle' ? { roundness: STYLE.roundness } : {}),
      strokeColor: color.stroke,
      backgroundColor: color.fill,
      ...(node.link ? { link: String(node.link) } : {}),
      ...(node.dashed ? { strokeStyle: 'dashed' } : {}),
    })
  }
  edges.forEach((edge, i) => {
    const color = resolveColor(edge.color)
    skeleton.push({
      type: 'arrow',
      roughness: STYLE.roughness,
      strokeWidth: STYLE.strokeWidth,
      strokeColor: color ? color.ink ?? color.stroke : MUTED,
      id: typeof edge.id === 'string' && edge.id ? edge.id : undefined,
      start: { id: edge.from },
      end: { id: edge.to },
      ...(edge.label ? { label: { text: String(edge.label), fontSize: 16, ...LABEL_FONT } } : {}),
      ...(edge.dashed ? { strokeStyle: 'dashed' } : {}),
      ...(edge.bidirectional ? { startArrowhead: 'arrow' } : {}),
      _order: i,
    })
  })
  for (const [groupId, name] of groups) {
    skeleton.push({ type: 'frame', name, children: nodes.filter((n) => `group:${n.group}` === groupId).map((n) => n.id) })
  }
  // Excalidraw frames don't nest. If nodes are already grouped into frames, the
  // overall name becomes a heading above the diagram instead of another frame.
  if (graph.frame && groups.size === 0) {
    skeleton.push({ type: 'frame', name: String(graph.frame), children: nodes.map((n) => n.id), _outer: true })
  } else if (graph.frame) {
    skeleton.push({ type: 'text', x: Math.round(origin.x), y: Math.round(origin.y - 30), text: String(graph.frame), fontSize: 28, strokeColor: INK, ...LABEL_FONT })
  }
  return skeleton
}

/**
 * Skeleton → elements attached to the current scene.
 *
 * Returns new elements and changed existing ones (a shape that gets an arrow
 * bound to it changes its `boundElements`, and therefore its version).
 */
export async function materialize(skeleton, existing, { now = Date.now() } = {}) {
  const engine = await loadEngine()
  const live = existing.filter((el) => !el.isDeleted)
  const byId = new Map(live.map((el) => [el.id, el]))

  const plain = []
  const arrows = []
  for (const item of skeleton) {
    if (!item || typeof item !== 'object') throw new EditError('skeleton item must be an object')
    if (item.id && byId.has(item.id)) throw new EditError(`id "${item.id}" is already on the board`)
    if (item.type === 'arrow' && (item.start?.id || item.end?.id)) arrows.push(item)
    else if (item.type !== 'frame') plain.push(item)
  }
  const frames = skeleton.filter((item) => item.type === 'frame')

  const cleaned = (item) => {
    const { _order, _outer, start, end, ...rest } = item
    return rest
  }
  const created = engine.convertToExcalidrawElements(plain.map(cleaned), { regenerateIds: false })
  const createdById = new Map(created.map((el) => [el.id, el]))
  const lookup = (id) => createdById.get(id) ?? byId.get(id)

  // Arrows: shape-to-shape geometry, bindings set by hand.
  const arrowSkeletons = arrows.map((item) => {
    const from = item.start?.id ? lookup(item.start.id) : null
    const to = item.end?.id ? lookup(item.end.id) : null
    if (item.start?.id && !from) throw new EditError(`arrow: start "${item.start.id}" is not on the board`)
    if (item.end?.id && !to) throw new EditError(`arrow: end "${item.end.id}" is not on the board`)
    let geometry
    if (from && to) geometry = arrowGeometry(bbox(from), bbox(to))
    else {
      const anchor = from ?? to
      const b = bbox(anchor)
      const x = Number.isFinite(item.x) ? item.x : b.x + b.w + 8
      const y = Number.isFinite(item.y) ? item.y : b.y + b.h / 2
      geometry = { x, y, points: [[0, 0], [Number(item.width) || 120, Number(item.height) || 0]] }
    }
    const base = cleaned(item)
    return { skeleton: { ...base, x: geometry.x, y: geometry.y, width: geometry.points[1][0], height: geometry.points[1][1], points: geometry.points }, from, to }
  })
  const createdArrows = engine.convertToExcalidrawElements(arrowSkeletons.map((a) => a.skeleton), { regenerateIds: false })

  const touched = new Map()
  const attach = (shape, entry) => {
    if (createdById.has(shape.id)) {
      const el = createdById.get(shape.id)
      el.boundElements = [...(el.boundElements ?? []), entry]
    } else {
      const current = touched.get(shape.id) ?? shape
      touched.set(shape.id, bump(current, { boundElements: [...(current.boundElements ?? []), entry] }, now))
    }
  }
  const arrowElements = createdArrows.filter((el) => el.type === 'arrow')
  arrowElements.forEach((arrow, i) => {
    const { from, to } = arrowSkeletons[i]
    if (from) {
      arrow.startBinding = { elementId: from.id, focus: 0, gap: 8 }
      attach(from, { id: arrow.id, type: 'arrow' })
    }
    if (to) {
      arrow.endBinding = { elementId: to.id, focus: 0, gap: 8 }
      attach(to, { id: arrow.id, type: 'arrow' })
    }
  })

  // Frames last: they need their children ready.
  const all = [...created, ...createdArrows]
  for (const frame of frames) {
    const children = (frame.children ?? []).map((id) => all.find((el) => el.id === id)).filter(Boolean)
    if (!children.length) continue
    let x1 = Infinity
    let y1 = Infinity
    let x2 = -Infinity
    let y2 = -Infinity
    for (const child of children) {
      const b = bbox(child)
      x1 = Math.min(x1, b.x)
      y1 = Math.min(y1, b.y)
      x2 = Math.max(x2, b.x + b.w)
      y2 = Math.max(y2, b.y + b.h)
    }
    const pad = frame._outer ? 60 : 30
    const [frameEl] = engine.convertToExcalidrawElements([
      { type: 'frame', name: frame.name, x: x1 - pad, y: y1 - pad, width: x2 - x1 + pad * 2, height: y2 - y1 + pad * 2, children: [] },
    ])
    for (const child of children) {
      if (child.frameId) continue
      child.frameId = frameEl.id
      // A shape's label lives in the same frame as the shape.
      for (const bound of child.boundElements ?? []) {
        const label = all.find((el) => el.id === bound.id && el.type === 'text')
        if (label) label.frameId = frameEl.id
      }
    }
    // A frame must come before its children in order, or Excalidraw draws it on
    // top of the content instead of as a border.
    all.unshift(frameEl)
  }

  // Labels are measured approximately: the browser re-measures them with the real font.
  for (const el of all) {
    if (el.type === 'text') el.customData = { ...(el.customData ?? {}), remeasure: true }
    el.updated = now
  }

  // Order: new elements go on top of everything already on the board.
  const maxIndex = live.reduce((max, el) => (el.index && (!max || el.index > max) ? el.index : max), null)
  const keys = engine.generateNKeysBetween(maxIndex, null, all.length)
  all.forEach((el, i) => {
    el.index = keys[i]
  })

  return { created: all, changed: [...touched.values()] }
}

/**
 * Targeted edits: label, position, colour, link.
 *
 * Moving a shape moves its label and the ends of bound arrows; otherwise arrows
 * would hang in mid-air after an agent edit until someone touched them.
 */
export function applyUpdates(updates, existing, { now = Date.now() } = {}) {
  const current = new Map(existing.map((el) => [el.id, el]))
  const changed = new Map()
  const get = (id) => changed.get(id) ?? current.get(id)
  const put = (el) => changed.set(el.id, el)

  for (const [i, update] of updates.entries()) {
    const el = update && typeof update.id === 'string' ? get(update.id) : null
    if (!el || el.isDeleted) throw new EditError(`update[${i}]: element "${update?.id}" is not on the board`)

    const changes = {}
    if (Number.isFinite(update.x)) changes.x = update.x
    if (Number.isFinite(update.y)) changes.y = update.y
    if (Number.isFinite(update.width) && update.width > 0) changes.width = update.width
    if (Number.isFinite(update.height) && update.height > 0) changes.height = update.height
    if (update.link !== undefined) changes.link = update.link ? String(update.link) : null
    if (update.color !== undefined) {
      const color = resolveColor(update.color)
      if (!color) throw new EditError(`update[${i}]: unknown colour "${update.color}"`)
      changes.strokeColor = color.stroke
      if (SHAPE_TYPES.has(el.type)) {
        changes.backgroundColor = color.fill
        changes.fillStyle = 'solid'
      }
    }
    if (update.name !== undefined && (el.type === 'frame' || el.type === 'magicframe')) changes.name = String(update.name)
    put(bump(el, changes, now))

    const text = update.label ?? update.text
    if (text !== undefined) {
      const target = el.type === 'text'
        ? get(el.id)
        : [...current.values(), ...changed.values()].find((t) => t.type === 'text' && t.containerId === el.id && !t.isDeleted)
      if (!target) throw new EditError(`update[${i}]: "${el.id}" has no label; add one as a new element`)
      put(bump(get(target.id), { text: String(text), originalText: String(text), customData: { ...(target.customData ?? {}), remeasure: true } }, now))
    }

    const dx = changes.x !== undefined ? changes.x - el.x : 0
    const dy = changes.y !== undefined ? changes.y - el.y : 0
    if (dx || dy) {
      for (const bound of el.boundElements ?? []) {
        const child = get(bound.id)
        if (child?.type === 'text' && !child.isDeleted) put(bump(child, { x: child.x + dx, y: child.y + dy }, now))
      }
    }
  }

  // Re-route arrows whose ends moved.
  const moved = new Set([...changed.values()].filter((el) => SHAPE_TYPES.has(el.type) || el.type === 'image').map((el) => el.id))
  for (const el of [...current.values()]) {
    if (el.type !== 'arrow' || el.isDeleted) continue
    const fromId = el.startBinding?.elementId
    const toId = el.endBinding?.elementId
    if (!moved.has(fromId) && !moved.has(toId)) continue
    const from = fromId ? get(fromId) : null
    const to = toId ? get(toId) : null
    if (!from || !to) continue
    const geometry = arrowGeometry(bbox(from), bbox(to))
    const arrow = get(el.id)
    put(bump(arrow, { x: geometry.x, y: geometry.y, points: geometry.points, width: Math.abs(geometry.points[1][0]), height: Math.abs(geometry.points[1][1]) }, now))
  }

  return [...changed.values()]
}

/** Delete: the element, its label, and arrow bindings to it. */
export function applyDeletes(ids, existing, { now = Date.now() } = {}) {
  const current = new Map(existing.map((el) => [el.id, el]))
  const changed = new Map()
  const doomed = new Set()
  for (const [i, id] of ids.entries()) {
    const el = current.get(id)
    if (!el || el.isDeleted) throw new EditError(`delete[${i}]: element "${id}" is not on the board`)
    doomed.add(id)
    for (const bound of el.boundElements ?? []) {
      const child = current.get(bound.id)
      if (child?.type === 'text' && child.containerId === id) doomed.add(child.id)
    }
    // Deleting a frame removes only the border: its content stays on the board.
    if (el.type === 'frame') {
      for (const child of current.values()) {
        if (child.frameId === id) changed.set(child.id, bump(child, { frameId: null }, now))
      }
    }
  }
  for (const id of doomed) changed.set(id, bump(changed.get(id) ?? current.get(id), { isDeleted: true }, now))
  for (const el of current.values()) {
    if (el.type !== 'arrow' || el.isDeleted || doomed.has(el.id)) continue
    const unbind = {}
    if (doomed.has(el.startBinding?.elementId)) unbind.startBinding = null
    if (doomed.has(el.endBinding?.elementId)) unbind.endBinding = null
    if (Object.keys(unbind).length) changed.set(el.id, bump(changed.get(el.id) ?? el, unbind, now))
  }
  return [...changed.values()]
}
