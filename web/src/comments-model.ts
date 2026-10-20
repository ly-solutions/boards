/**
 * Pure logic behind the comment pins, thread cards and the comments panel.
 *
 * Nothing here touches React, the DOM or the editor API, so the rules that are
 * easy to get subtly wrong (where a pin sits, which shape a click lands on, the
 * order of the list, what counts as "new") are unit-tested on their own
 * (tests/comments-model.test.mjs).
 */

export type Message = { id: string; author: string; authorKind?: 'person' | 'agent'; text: string; at: string; replyTo?: string }
export type Thread = {
  id: string
  x: number
  y: number
  elementId: string | null
  dx: number
  dy: number
  author: string
  createdAt: string
  resolved: boolean
  resolvedBy?: string | null
  messages: Message[]
}
/** Where a new thread will go: a scene point, attached to a shape when one is under it. */
export type Draft = { x: number; y: number; elementId: string | null }

/** The subset of an Excalidraw element this module reads. */
export type SceneEl = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  isDeleted?: boolean
  containerId?: string | null
  text?: string
  originalText?: string
  points?: readonly (readonly [number, number])[]
  customData?: Record<string, unknown>
}

export type Point = { x: number; y: number }

// ── Pin position ────────────────────────────────────────────────────────────

/**
 * Where a thread's pin sits in scene coordinates. An anchored thread keeps its
 * offset from the shape, so the pin follows the shape when someone drags it;
 * once the shape is gone the pin falls back to the stored point.
 */
export function pinPoint(thread: Pick<Thread, 'x' | 'y' | 'elementId' | 'dx' | 'dy'>, byId: ReadonlyMap<string, SceneEl>): Point {
  const el = thread.elementId ? byId.get(thread.elementId) : undefined
  if (el && !el.isDeleted) return { x: el.x + (thread.dx ?? 0), y: el.y + (thread.dy ?? 0) }
  return { x: thread.x, y: thread.y }
}

// ── Hit testing ─────────────────────────────────────────────────────────────

/** How close (scene px) to a line or arrow a point must be to count as "on" it. */
const LINE_SLOP = 8

const LINEAR = new Set(['arrow', 'line'])

function distanceToSegment(p: Point, a: Point, b: Point) {
  const vx = b.x - a.x
  const vy = b.y - a.y
  const len = vx * vx + vy * vy
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len)) : 0
  return Math.hypot(p.x - (a.x + t * vx), p.y - (a.y + t * vy))
}

/** Does the scene point land on the element? Rotation, ellipses and diamonds count; lines need to be near the stroke. */
export function hits(el: SceneEl, x: number, y: number): boolean {
  if (LINEAR.has(el.type) && el.points?.length) {
    // An arrow's bounding box is mostly empty canvas; only the stroke itself is a target.
    const pts = el.points.map(([px, py]) => ({ x: el.x + px, y: el.y + py }))
    if (pts.length === 1) return Math.hypot(x - pts[0].x, y - pts[0].y) <= LINE_SLOP
    for (let i = 1; i < pts.length; i++) if (distanceToSegment({ x, y }, pts[i - 1], pts[i]) <= LINE_SLOP) return true
    return false
  }
  // Excalidraw allows negative sizes while drawing; normalise the box.
  const left = Math.min(el.x, el.x + el.width)
  const top = Math.min(el.y, el.y + el.height)
  const w = Math.abs(el.width)
  const h = Math.abs(el.height)
  const cx = left + w / 2
  const cy = top + h / 2
  // Undo the rotation around the centre, then test against the axis-aligned shape.
  const angle = el.angle ?? 0
  let px = x
  let py = y
  if (angle) {
    const cos = Math.cos(-angle)
    const sin = Math.sin(-angle)
    px = cx + (x - cx) * cos - (y - cy) * sin
    py = cy + (x - cx) * sin + (y - cy) * cos
  }
  if (px < left || px > left + w || py < top || py > top + h) return false
  if (el.type === 'ellipse' && w && h) return ((px - cx) / (w / 2)) ** 2 + ((py - cy) / (h / 2)) ** 2 <= 1
  if (el.type === 'diamond' && w && h) return Math.abs(px - cx) / (w / 2) + Math.abs(py - cy) / (h / 2) <= 1
  return true
}

/**
 * The shape a comment at (x, y) belongs to: the topmost live element under the
 * point. A label is a separate text element bound to its shape; the comment is
 * about the shape, so the label resolves to its container.
 */
export function elementAt(elements: readonly SceneEl[], x: number, y: number): SceneEl | null {
  const byId = new Map<string, SceneEl>()
  for (const el of elements) if (!el.isDeleted) byId.set(el.id, el)
  // Scene order is z-order: the last element is drawn on top.
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]
    if (el.isDeleted || !hits(el, x, y)) continue
    if (el.type === 'text' && el.containerId) {
      const container = byId.get(el.containerId)
      if (container) return container
    }
    return el
  }
  return null
}

export function draftFrom(elements: readonly SceneEl[], x: number, y: number): Draft {
  return { x, y, elementId: elementAt(elements, x, y)?.id ?? null }
}

// ── Language ────────────────────────────────────────────────────────────────

/** The editor's translator (web/src/i18n.ts); passed in so this module stays import-free and testable in Node. */
export type Translate = (key: string, vars?: Record<string, unknown>) => string

/**
 * English for the words this module produces, keyed like the catalog (shared/locales/en/comments.mjs, which must
 * hold the same text — tests/comments-model.test.mjs checks). Used when no translator is passed.
 */
export const MODEL_EN: Record<string, string> = {
  'comments.canvas': 'Canvas',
  'comments.quoted': '“{text}”',
  'comments.sticky': 'Sticky',
  'comments.linkCard': 'Link card',
  'comments.shape': 'Shape',
  'comments.kindRectangle': 'Rectangle',
  'comments.kindEllipse': 'Ellipse',
  'comments.kindDiamond': 'Diamond',
  'comments.kindArrow': 'Arrow',
  'comments.kindLine': 'Line',
  'comments.kindText': 'Text',
  'comments.kindDrawing': 'Drawing',
  'comments.kindImage': 'Image',
  'comments.kindFrame': 'Frame',
  'comments.kindEmbed': 'Embed',
  'comments.justNow': 'just now',
  'comments.minutesShort': '{count} min',
  'comments.hoursShort': '{count} h',
}

export const english: Translate = (key, vars) => (MODEL_EN[key] ?? key).replace(/\{(\w+)\}/g, (whole, name) => (vars?.[name] === undefined ? whole : String(vars[name])))

// ── Labels ──────────────────────────────────────────────────────────────────

/** Element type → catalog key of its name. */
const KIND: Record<string, string> = {
  rectangle: 'comments.kindRectangle',
  ellipse: 'comments.kindEllipse',
  diamond: 'comments.kindDiamond',
  arrow: 'comments.kindArrow',
  line: 'comments.kindLine',
  text: 'comments.kindText',
  freedraw: 'comments.kindDrawing',
  image: 'comments.kindImage',
  frame: 'comments.kindFrame',
  magicframe: 'comments.kindFrame',
  embeddable: 'comments.kindEmbed',
  iframe: 'comments.kindEmbed',
}

/** The text a shape shows, as the board text for agents reads it: its bound label, or a text element's own text. */
export function labelOf(elements: readonly SceneEl[], id: string): string | null {
  let el: SceneEl | undefined
  for (const e of elements) {
    if (e.isDeleted) continue
    if (e.id === id) el = e
    else if (e.type === 'text' && e.containerId === id) {
      const text = (e.originalText ?? e.text ?? '').trim()
      if (text) return text
    }
  }
  if (el?.type === 'text') return (el.originalText ?? el.text ?? '').trim() || null
  return null
}

/** What a thread is about, for the card header and the composer: the shape's label, its kind, or "Canvas". */
export function placeName(elements: readonly SceneEl[], elementId: string | null, t: Translate = english): string {
  if (!elementId) return t('comments.canvas')
  const el = elements.find((e) => e.id === elementId && !e.isDeleted)
  if (!el) return t('comments.canvas')
  const label = labelOf(elements, elementId)
  if (label) return t('comments.quoted', { text: excerpt(label, 48) })
  if (el.customData?.kind === 'sticky') return t('comments.sticky')
  if (el.customData?.kind === 'card') return t('comments.linkCard')
  return t(KIND[el.type] ?? 'comments.shape')
}

// ── Text helpers ────────────────────────────────────────────────────────────

/** One line, at most `max` characters, with an ellipsis when cut. */
export function excerpt(text: string, max = 80): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line
}

/** Guests are stored as "guest: Name"; people see the name and a "guest" badge instead. */
export const isGuest = (name: string) => /^guest:\s*/i.test(name)
export const displayName = (name: string) => name.replace(/^guest:\s*/i, '').trim() || name

/** First letter of the shown name, surrogate-pair safe ("🙂" stays whole). */
export function initialOf(name: string): string {
  const first = Array.from(displayName(name).trim())[0]
  return first ? first.toLocaleUpperCase() : '?'
}

/**
 * Avatar colours: saturated enough to tell people apart, dark enough for a
 * white initial to stay readable in both themes.
 */
export const PIN_COLORS = ['#e03131', '#c2255c', '#9c36b5', '#6741d9', '#3b5bdb', '#1971c2', '#0c8599', '#099268', '#2f9e44', '#d9480f', '#5f3dc4', '#a61e4d']

/** Stable colour per author name: the same person has the same colour on every board and in every browser. */
export function pinColor(name: string): string {
  // FNV-1a: tiny, deterministic, and spreads similar names ("Ann", "Anna") apart.
  let hash = 0x811c9dc5
  const key = (name ?? '').trim()
  for (let i = 0; i < key.length; i++) {
    hash ^= key.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return PIN_COLORS[(hash >>> 0) % PIN_COLORS.length]
}

// ── Time ────────────────────────────────────────────────────────────────────

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

/** Compact relative time for rows and messages: "just now", "5 min", "2 h", then a date ("Oct 5"). */
export function relativeTime(iso: string, now: number = Date.now(), t: Translate = english, locale?: string): string {
  const at = Date.parse(iso)
  if (Number.isNaN(at)) return ''
  const ago = now - at
  // Clock skew between server and browser can put a fresh message slightly in the future.
  if (ago < MINUTE) return t('comments.justNow')
  if (ago < HOUR) return t('comments.minutesShort', { count: Math.floor(ago / MINUTE) })
  if (ago < DAY) return t('comments.hoursShort', { count: Math.floor(ago / HOUR) })
  const date = new Date(at)
  const sameYear = date.getFullYear() === new Date(now).getFullYear()
  return date.toLocaleString(locale, sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' })
}

/** Full timestamp for tooltips. */
export function fullTime(iso: string, locale?: string): string {
  const at = Date.parse(iso)
  return Number.isNaN(at) ? '' : new Date(at).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short' })
}

// ── Ordering ────────────────────────────────────────────────────────────────

/** Latest activity: the newest message, or the creation time of an empty thread. */
export function lastActivity(thread: Thread): number {
  let latest = Date.parse(thread.createdAt) || 0
  for (const m of thread.messages ?? []) {
    const at = Date.parse(m.at)
    if (at > latest) latest = at
  }
  return latest
}

/** Panel order: open threads first, newest activity on top; resolved ones apart, in the same order. */
export function sortThreads(threads: readonly Thread[]): { open: Thread[]; resolved: Thread[] } {
  const byActivity = (a: Thread, b: Thread) => lastActivity(b) - lastActivity(a) || a.id.localeCompare(b.id)
  return {
    open: threads.filter((t) => !t.resolved).sort(byActivity),
    resolved: threads.filter((t) => t.resolved).sort(byActivity),
  }
}

export const replyCount = (thread: Thread) => Math.max(0, (thread.messages?.length ?? 0) - 1)

// ── Seen state ──────────────────────────────────────────────────────────────

/** Per browser and board: thread id → id of the last message this browser has seen. */
export type Seen = Record<string, string>

export const seenKey = (slug: string) => `boards-seen:${slug}`

export function parseSeen(raw: string | null): Seen {
  if (!raw) return {}
  try {
    const data = JSON.parse(raw)
    if (!data || typeof data !== 'object' || Array.isArray(data)) return {}
    const out: Seen = {}
    for (const [k, v] of Object.entries(data)) if (typeof v === 'string') out[k] = v
    return out
  } catch {
    return {}
  }
}

/**
 * A thread is "new" when its last message is neither seen here nor written by
 * me. The last message id (not a count) is remembered, so a deleted message
 * followed by a new one still lights the dot.
 */
export function isUnseen(thread: Thread, seen: Seen, me: string | null): boolean {
  const last = thread.messages?.[thread.messages.length - 1]
  if (!last) return false
  if (me && last.author === me) return false
  return seen[thread.id] !== last.id
}

/** Mark a thread as read; ids of threads that no longer exist are dropped so storage does not grow forever. */
export function markSeen(seen: Seen, thread: Thread, alive?: readonly Thread[]): Seen {
  const last = thread.messages?.[thread.messages.length - 1]
  const next: Seen = {}
  const keep = alive ? new Set(alive.map((t) => t.id)) : null
  for (const [id, mid] of Object.entries(seen)) if (!keep || keep.has(id)) next[id] = mid
  if (last) next[thread.id] = last.id
  return next
}

// ── Rights ──────────────────────────────────────────────────────────────────

/** Team members (and agents, server-side) may delete anything; everyone else only their own messages. */
export function canDelete(message: Pick<Message, 'author'>, me: string | null, isTeam: boolean): boolean {
  return isTeam || Boolean(me && message.author === me)
}

// ── Geometry for the overlay ────────────────────────────────────────────────

/** A small move is still a click: fingers and trackpads jitter a few pixels while tapping. */
export const DRAG_THRESHOLD = 4
export const isDrag = (dx: number, dy: number, threshold = DRAG_THRESHOLD) => Math.hypot(dx, dy) > threshold

/**
 * Where to put a thread card relative to its pin, in screen px. The pin's tip
 * is at `pin` (relative to the editor); the pin itself is `pinSize` px tall
 * and wide, above and to the right of the tip. The card goes to the right of
 * the pin, flips to the left when it would leave the screen, and slides
 * vertically to stay inside the viewport.
 */
export function cardOffset(
  pin: { left: number; top: number },
  card: { width: number; height: number },
  viewport: { width: number; height: number },
  { pinSize = 32, gap = 8, margin = 12 }: { pinSize?: number; gap?: number; margin?: number } = {},
): { dx: number; dy: number } {
  let dx = pinSize + gap
  if (pin.left + dx + card.width > viewport.width - margin && pin.left - gap - card.width >= margin) dx = -(gap + card.width)
  let dy = -pinSize
  const top = pin.top + dy
  const maxTop = viewport.height - margin - card.height
  if (top > maxTop) dy = maxTop - pin.top
  if (pin.top + dy < margin) dy = margin - pin.top
  return { dx, dy }
}

/**
 * The scene point to centre the view on so a thread opened from the panel is
 * in sight together with its card. On desktop the pin goes left of centre so
 * the card (`card` px wide, to its right) fits beside it, and the panel
 * (`right` px) is not counted as visible; on a phone the pin goes to the upper
 * quarter, above the bottom sheet.
 */
export function focusPoint(p: Point, v: { width: number; height: number; zoom: number }, { right = 0, card = 0, sheet = false }: { right?: number; card?: number; sheet?: boolean } = {}): Point {
  const zoom = v.zoom || 1
  const xs = sheet ? v.width / 2 : Math.max(48, (v.width - right - card) / 2)
  const ys = sheet ? v.height / 4 : v.height / 2
  return { x: p.x + (v.width / 2 - xs) / zoom, y: p.y + (v.height / 2 - ys) / zoom }
}
