// The islands change the board only through the editor's API: they read the scene and the selection, write changed
// copies of elements back with updateScene, and lay out bound text the way the editor does (its own measuring, through
// restoreElements with refreshDimensions). Nothing here keeps state of its own.
import { CaptureUpdateAction, restoreElements } from '@excalidraw/excalidraw'
import { stickyStroke } from '../../../shared/palette.mjs'
import type { StudioApi } from '../studio'

export type El = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  angle?: number
  version: number
  versionNonce?: number
  isDeleted?: boolean
  locked?: boolean
  opacity?: number
  strokeColor?: string
  backgroundColor?: string
  strokeWidth?: number
  strokeStyle?: string
  roughness?: number
  roundness?: { type: number; value?: number } | null
  fillStyle?: string
  groupIds?: string[]
  frameId?: string | null
  containerId?: string | null
  boundElements?: { id: string; type: string }[] | null
  text?: string
  originalText?: string
  fontSize?: number
  fontFamily?: number
  textAlign?: string
  verticalAlign?: string
  lineHeight?: number
  autoResize?: boolean
  link?: string | null
  name?: string | null
  elbowed?: boolean
  startArrowhead?: string | null
  endArrowhead?: string | null
  points?: number[][]
  customData?: Record<string, unknown>
  [key: string]: unknown
}

export type Kind = 'sticky' | 'shape' | 'arrow' | 'line' | 'text' | 'frame' | 'pen' | 'image' | 'site' | 'terminal' | 'multi'

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
export const isSticky = (el: El | undefined | null) => el?.customData?.kind === 'sticky'
export const isTerminal = (el: El | undefined | null) => el?.customData?.kind === 'terminal'

const nonce = () => Math.floor(Math.random() * 2 ** 31)

export function sceneOf(api: StudioApi) {
  return api.getSceneElements() as unknown as El[]
}

/** What is selected: whole objects, without the labels inside selected containers. */
export function selectedOf(api: StudioApi): El[] {
  const ids = (api.getAppState().selectedElementIds ?? {}) as Record<string, boolean>
  const picked = sceneOf(api).filter((el) => ids[el.id] && !el.isDeleted)
  const set = new Set(picked.map((el) => el.id))
  return picked.filter((el) => !(el.type === 'text' && el.containerId && set.has(el.containerId)))
}

export function kindOf(el: El): Exclude<Kind, 'multi'> | null {
  if (isSticky(el)) return 'sticky'
  if (isTerminal(el)) return 'terminal'
  if (el.type === 'embeddable' || el.type === 'iframe') return 'site'
  if (SHAPES.has(el.type)) return 'shape'
  if (el.type === 'arrow') return 'arrow'
  if (el.type === 'line') return 'line'
  if (el.type === 'text') return 'text'
  if (el.type === 'frame' || el.type === 'magicframe') return 'frame'
  if (el.type === 'freedraw') return 'pen'
  if (el.type === 'image') return 'image'
  return null
}

export function selectionKind(sel: readonly El[]): Kind | null {
  if (!sel.length) return null
  // One group selected as a whole counts as several objects.
  if (sel.length > 1) return 'multi'
  return kindOf(sel[0])
}

/** The label of a container (sticky, shape, arrow), or the text itself. */
export function textOf(api: StudioApi, el: El): El | null {
  if (el.type === 'text') return el
  const id = el.boundElements?.find((b) => b.type === 'text')?.id
  if (!id) return null
  return sceneOf(api).find((e) => e.id === id && !e.isDeleted) ?? null
}

/** Screen box of elements (CSS px relative to the editor). */
export function screenBox(api: StudioApi, els: readonly El[]) {
  if (!els.length) return null
  const st = api.getAppState() as { scrollX: number; scrollY: number; zoom: { value: number }; offsetLeft?: number; offsetTop?: number }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const el of els) {
    if (el.points && el.points.length) {
      for (const [px, py] of el.points) {
        x0 = Math.min(x0, el.x + px)
        y0 = Math.min(y0, el.y + py)
        x1 = Math.max(x1, el.x + px)
        y1 = Math.max(y1, el.y + py)
      }
      continue
    }
    x0 = Math.min(x0, el.x, el.x + el.width)
    y0 = Math.min(y0, el.y, el.y + el.height)
    x1 = Math.max(x1, el.x, el.x + el.width)
    y1 = Math.max(y1, el.y, el.y + el.height)
  }
  const z = st.zoom.value
  return { left: (x0 + st.scrollX) * z, top: (y0 + st.scrollY) * z, right: (x1 + st.scrollX) * z, bottom: (y1 + st.scrollY) * z }
}

// ── Bound text layout, as the editor does it ─────────────────────────────────

const PAD = 5
function containerCoords(c: El) {
  let ox = PAD
  let oy = PAD
  if (c.type === 'ellipse') {
    ox += (c.width / 2) * (1 - Math.SQRT2 / 2)
    oy += (c.height / 2) * (1 - Math.SQRT2 / 2)
  }
  if (c.type === 'diamond') {
    ox += c.width / 4
    oy += c.height / 4
  }
  return { x: c.x + ox, y: c.y + oy }
}
export function maxTextWidth(c: El) {
  if (c.type === 'ellipse') return Math.round((c.width / 2) * Math.SQRT2) - PAD * 2
  if (c.type === 'diamond') return Math.round(c.width / 2) - PAD * 2
  return c.width - PAD * 2
}
export function maxTextHeight(c: El) {
  if (c.type === 'ellipse') return Math.round((c.height / 2) * Math.SQRT2) - PAD * 2
  if (c.type === 'diamond') return Math.round(c.height / 2) - PAD * 2
  return c.height - PAD * 2
}
function containerHeightFor(textHeight: number, type: string) {
  const h = Math.ceil(textHeight)
  if (type === 'ellipse') return Math.round(((h + PAD * 2) / Math.SQRT2) * 2)
  if (type === 'diamond') return 2 * (h + PAD * 2)
  return h + PAD * 2
}

/** The text measured by the editor itself: wrapped to the container from its original text. */
export function measure(text: El, container: El | null): { text: string; width: number; height: number } {
  const copy = { ...text, text: text.originalText ?? text.text }
  const [out] = restoreElements(container ? ([copy, container] as never) : ([copy] as never), null, { refreshDimensions: true, repairBindings: true } as never) as unknown as El[]
  return { text: out.text ?? '', width: out.width, height: out.height }
}

/** Puts a label back into its container: wrapped, aligned, and the container grown when the text needs more room. */
export function layoutBound(text: El, container: El): { text: El; container: El } {
  const m = measure(text, container)
  let c = container
  if (container.type !== 'arrow' && m.height > maxTextHeight(container)) {
    c = { ...container, height: containerHeightFor(m.height, container.type) }
  }
  if (container.type === 'arrow') {
    // An arrow label stays centred where it was.
    const cx = text.x + text.width / 2
    const cy = text.y + text.height / 2
    return { text: { ...text, text: m.text, width: m.width, height: m.height, x: cx - m.width / 2, y: cy - m.height / 2 }, container: c }
  }
  const at = containerCoords(c)
  const mw = maxTextWidth(c)
  const mh = maxTextHeight(c)
  const t = { ...text, text: m.text, width: m.width, height: m.height }
  t.y = t.verticalAlign === 'top' ? at.y : t.verticalAlign === 'bottom' ? at.y + mh - m.height : at.y + (mh / 2 - m.height / 2)
  t.x = t.textAlign === 'left' ? at.x : t.textAlign === 'right' ? at.x + mw - m.width : at.x + (mw / 2 - m.width / 2)
  return { text: t, container: c }
}

// ── Writing changes ───────────────────────────────────────────────────────────

type Patch = Partial<El>

/**
 * Applies changes to elements by id, as one undo step. `relayout` lists the text elements whose size may have
 * changed: they are measured again and re-centred in their containers (free text keeps its left top corner).
 */
export function apply(api: StudioApi, changes: Map<string, Patch>, { relayout = [] as string[], capture = true } = {}) {
  if (!changes.size) return
  const all = api.getSceneElementsIncludingDeleted() as unknown as El[]
  const byId = new Map(all.map((el) => [el.id, el]))
  const next = new Map<string, El>()
  for (const [id, patch] of changes) {
    const el = byId.get(id)
    if (!el) continue
    next.set(id, { ...el, ...patch })
  }
  for (const id of relayout) {
    const text = next.get(id) ?? byId.get(id)
    if (!text || text.type !== 'text') continue
    const containerId = text.containerId
    const container = containerId ? (next.get(containerId) ?? byId.get(containerId)) : null
    if (container) {
      const out = layoutBound(text, container)
      next.set(text.id, out.text)
      if (out.container !== container) next.set(container.id, out.container)
    } else {
      const m = measure(text, null)
      next.set(text.id, { ...text, text: m.text, width: text.autoResize === false ? text.width : m.width, height: m.height })
    }
  }
  const now = Date.now()
  const elements = all.map((el) => {
    const n = next.get(el.id)
    return n ? { ...n, version: el.version + 1, versionNonce: nonce(), updated: now } : el
  })
  api.updateScene({ elements, captureUpdate: capture ? CaptureUpdateAction.IMMEDIATELY : CaptureUpdateAction.EVENTUALLY })
}

/** The same change for the selected objects. */
export function patchSelected(api: StudioApi, fn: (el: El) => Patch | null) {
  const changes = new Map<string, Patch>()
  for (const el of selectedOf(api)) {
    const p = fn(el)
    if (p) changes.set(el.id, p)
  }
  apply(api, changes)
}

/**
 * A text change for the selection: on free text itself, on the label of a sticky, shape or arrow. `measure` — the
 * size of the text may change (font, size, words).
 */
export function patchText(api: StudioApi, fn: (text: El, host: El) => Patch | null, { remeasure = true } = {}) {
  const changes = new Map<string, Patch>()
  const relayout: string[] = []
  for (const el of selectedOf(api)) {
    const text = textOf(api, el)
    if (!text) continue
    const p = fn(text, el)
    if (!p) continue
    changes.set(text.id, p)
    if (remeasure) relayout.push(text.id)
  }
  apply(api, changes, { relayout })
}

export function paintSticky(fill: string): Patch {
  return { backgroundColor: fill, strokeColor: stickyStroke(fill) }
}

// ── Sticky text that fits (FigJam) ───────────────────────────────────────────

export const STICKY_FONT_MIN = 10
export const STICKY_FONT_MAX = 28

const words = (s: string) => s.split(/\s+/).filter(Boolean).length

/**
 * The largest font at which a sticky's text fits its box without breaking words, between STICKY_FONT_MIN and
 * STICKY_FONT_MAX. Null when even the smallest does not fit: then the sticky grows at the smallest size.
 */
export function fitStickyFont(text: El, sticky: El): number | null {
  const original = text.originalText ?? text.text ?? ''
  const mh = maxTextHeight(sticky) - 18 // room for the author line at the bottom
  const fits = (size: number) => {
    const m = measure({ ...text, fontSize: size }, sticky)
    return m.height <= mh && words(m.text) <= words(original)
  }
  if (!original.trim()) return STICKY_FONT_MAX > 24 ? 24 : STICKY_FONT_MAX
  let lo = STICKY_FONT_MIN
  let hi = STICKY_FONT_MAX
  if (!fits(lo)) return null
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2)
    if (fits(mid)) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** Whether a sticky's font follows its text (on by default; a size picked by hand turns it off). */
export const autoFont = (text: El | null) => text?.customData?.fontAuto !== false

// ── The editor's own actions, by their shortcuts ─────────────────────────────

const MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)

/**
 * Runs one of the editor's actions through its keyboard shortcut: layers, duplicate, delete, group, align, copy and
 * paste styles, zoom, undo. Excalidraw has no public API for them, and a shortcut runs exactly what its menu runs.
 */
export function press(key: string, code: string, { mod = false, shift = false, alt = false } = {}) {
  const target = document.querySelector('.excalidraw') ?? document
  const init: KeyboardEventInit = { key, code, bubbles: true, cancelable: true, shiftKey: shift, altKey: alt, ctrlKey: mod && !MAC, metaKey: mod && MAC }
  target.dispatchEvent(new KeyboardEvent('keydown', init))
  target.dispatchEvent(new KeyboardEvent('keyup', init))
}

export const ACTIONS = {
  undo: () => press('z', 'KeyZ', { mod: true }),
  redo: () => press('z', 'KeyZ', { mod: true, shift: true }),
  zoomIn: () => press('=', 'Equal', { mod: true }),
  zoomOut: () => press('-', 'Minus', { mod: true }),
  zoomReset: () => press('0', 'Digit0', { mod: true }),
  fit: () => press('!', 'Digit1', { shift: true }),
  duplicate: () => press('d', 'KeyD', { mod: true }),
  remove: () => press('Delete', 'Delete'),
  forward: () => press(']', 'BracketRight', { mod: true }),
  backward: () => press('[', 'BracketLeft', { mod: true }),
  front: () => press(']', 'BracketRight', { mod: true, shift: true }),
  back: () => press('[', 'BracketLeft', { mod: true, shift: true }),
  copyStyle: () => press('c', 'KeyC', { mod: true, alt: true }),
  pasteStyle: () => press('v', 'KeyV', { mod: true, alt: true }),
  group: () => press('g', 'KeyG', { mod: true }),
  ungroup: () => press('g', 'KeyG', { mod: true, shift: true }),
  alignLeft: () => press('ArrowLeft', 'ArrowLeft', { mod: true, shift: true }),
  alignTop: () => press('ArrowUp', 'ArrowUp', { mod: true, shift: true }),
  alignCenterX: () => {
    // No shortcut for centring: the hidden properties panel still has the editor's own button.
    ;(document.querySelector('[data-testid="align-horizontal-center"]') as HTMLElement | null)?.click()
  },
  distributeX: () => press('h', 'KeyH', { alt: true }),
  distributeY: () => press('v', 'KeyV', { alt: true }),
  toggleLock: () => press('l', 'KeyL', { mod: true, shift: true }),
}

/** A native control of the hidden properties panel, by its test id: true when it was there to click. */
export function clickNative(testId: string): boolean {
  const node = document.querySelector(`[data-testid="${testId}"]`) as HTMLElement | null
  if (!node) return false
  const input = node.matches('input') ? node : (node.querySelector('input') as HTMLElement | null)
  ;(input ?? node).click()
  return true
}
