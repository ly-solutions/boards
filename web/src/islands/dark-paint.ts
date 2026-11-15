// Dark theme without darkening colour (HRN-1480). Excalidraw paints a dark board by inverting the whole canvas
// (`invert(93%) hue-rotate(180deg)` in CSS), so a yellow sticky turns muddy brown. Here the static canvas is not
// inverted; each element is drawn with its own filter instead (the drawImage of its cached canvas, see the
// `dark-paint` patch in scripts/excalidraw-patches.mjs):
//   · colourless things — black and grey strokes, text on the canvas, near-white tints — get the old inversion;
//   · colour fills (stickies, shapes, column headers) keep their light-theme colour, 6% dimmer, with dark text;
//   · a sticky with a white, grey or no fill becomes a raised surface, like an island, with a shadow.
// The scene data does not change: a board drawn in the light theme looks right in the dark one as it is.

export type DarkEl = El
type El = {
  id: string
  type: string
  backgroundColor?: string
  strokeColor?: string
  containerId?: string | null
  customData?: Record<string, unknown>
}
type Ctx = CanvasRenderingContext2D
type AppState = { zoom: { value: number } }

const INVERT = 'invert(93%) hue-rotate(180deg)'
const SURFACE = 'invert(84%) hue-rotate(180deg)'
const KEEP = 'brightness(0.94)'

type Rgb = { r: number; g: number; b: number; a: number }
const parsed = new Map<string, Rgb | null>()

function parse(color: string | undefined): Rgb | null {
  if (!color || color === 'transparent') return null
  const hit = parsed.get(color)
  if (hit !== undefined) return hit
  let out: Rgb | null = null
  const c = color.trim().toLowerCase()
  let m = /^#([0-9a-f]{3,8})$/.exec(c)
  if (m) {
    let h = m[1]
    if (h.length === 3 || h.length === 4) h = [...h].map((x) => x + x).join('')
    if (h.length === 6 || h.length === 8) {
      out = { r: parseInt(h.slice(0, 2), 16) / 255, g: parseInt(h.slice(2, 4), 16) / 255, b: parseInt(h.slice(4, 6), 16) / 255, a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 }
    }
  } else if ((m = /^rgba?\(([^)]+)\)$/.exec(c))) {
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number)
    if (p.length >= 3 && p.every((x) => Number.isFinite(x))) out = { r: p[0] / 255, g: p[1] / 255, b: p[2] / 255, a: p.length > 3 ? p[3] : 1 }
  }
  if (out && out.a < 0.05) out = null
  parsed.set(color, out)
  return out
}

/** HSL saturation and lightness of a colour, or null for no colour at all. */
function hsl(color: string | undefined): { s: number; l: number } | null {
  const c = parse(color)
  if (!c) return null
  const max = Math.max(c.r, c.g, c.b)
  const min = Math.min(c.r, c.g, c.b)
  const l = (max + min) / 2
  const d = max - min
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return { s, l }
}

const isSticky = (el: El) => el.customData?.kind === 'sticky'

/** A colour fill that keeps its colour in the dark: saturated, and not a near-white tint behind a column. */
export function keepsColour(fill: string | undefined, sticky = false): boolean {
  const c = hsl(fill)
  if (!c || c.s < 0.18) return false
  return sticky || c.l <= 0.9
}

/** A coloured line that stays itself on the dark stage (very dark ones are inverted to stay readable). */
function colouredStroke(stroke: string | undefined): boolean {
  const c = hsl(stroke)
  return Boolean(c && c.s >= 0.25 && c.l >= 0.35 && c.l <= 0.8)
}

export type DarkKind = 'invert' | 'keep' | 'surface' | 'raw'

export function darkKind(el: El, container: El | null): DarkKind {
  if (el.type === 'image') return 'raw'
  if (el.type === 'text') {
    if (!container) return colouredStroke(el.strokeColor) ? 'keep' : 'invert'
    const host = darkKind(container, null)
    return host === 'keep' ? 'keep' : 'invert'
  }
  const fill = el.backgroundColor
  if (isSticky(el)) return keepsColour(fill, true) ? 'keep' : 'surface'
  if (keepsColour(fill)) return 'keep'
  if (!parse(fill) && colouredStroke(el.strokeColor)) return 'keep'
  return 'invert'
}

const kinds = new WeakMap<object, { key: string; kind: DarkKind }>()

function kindOf(el: El, map: Map<string, El>): DarkKind {
  const container = el.containerId ? (map.get(el.containerId) ?? null) : null
  const key = `${el.backgroundColor}|${el.strokeColor}|${el.type}|${String(el.customData?.kind ?? '')}|${container ? `${container.backgroundColor}|${container.strokeColor}|${String(container.customData?.kind ?? '')}` : ''}`
  const was = kinds.get(el)
  if (was && was.key === key) return was.kind
  const kind = darkKind(el, container)
  kinds.set(el, { key, kind })
  return kind
}

/**
 * Called by the patched renderer before an element's canvas is drawn on the static canvas in the dark theme;
 * the caller restores the context afterwards. (x1, y1)–(x2, y2) are the element's bounds in scene coordinates;
 * `unit` is how many context units a scene unit is before the zoom (1, or devicePixelRatio on the full path).
 */
function paint(el: El, ctx: Ctx, appState: AppState & { scrollX: number; scrollY: number }, map: Map<string, El>, x1: number, y1: number, x2: number, y2: number, unit = 1) {
  const kind = kindOf(el, map)
  if (kind === 'raw') return
  if (kind === 'invert') {
    ctx.filter = INVERT
    return
  }
  const dpr = window.devicePixelRatio || 1
  if (isSticky(el)) {
    const z = appState.zoom.value
    ctx.shadowColor = 'rgba(0, 0, 0, 0.45)'
    ctx.shadowBlur = 14 * z * dpr
    ctx.shadowOffsetY = 4 * z * dpr
  }
  if (kind === 'keep') {
    ctx.filter = KEEP
    return
  }
  // A surface: a white or grey sticky turns into a raised dark card; with no fill at all it gets one.
  ctx.filter = SURFACE
  if (!parse(el.backgroundColor) && ctx.roundRect) {
    const r = 8 * unit
    ctx.save()
    ctx.filter = 'none'
    ctx.fillStyle = '#2a2a2f'
    ctx.beginPath()
    ctx.roundRect((x1 + appState.scrollX) * unit, (y1 + appState.scrollY) * unit, (x2 - x1) * unit, (y2 - y1) * unit, r)
    ctx.fill()
    ctx.restore()
    ctx.shadowColor = 'transparent'
  }
}

/** Whether this browser applies `filter` to a 2D canvas; without it the old whole-canvas inversion stays. */
function canvasFilters(): boolean {
  try {
    const c = document.createElement('canvas')
    c.width = 1
    c.height = 1
    const x = c.getContext('2d')
    if (!x || !('filter' in x)) return false
    x.filter = 'invert(100%)'
    x.fillStyle = '#ffffff'
    x.fillRect(0, 0, 1, 1)
    return x.getImageData(0, 0, 1, 1).data[0] < 128
  } catch {
    return false
  }
}

let installed: boolean | null = null

/** Turns the per-element dark paint on (once); false when the browser cannot. */
export function installDarkPaint(): boolean {
  if (installed !== null) return installed
  installed = canvasFilters()
  if (installed) {
    ;(window as unknown as { __tbDark: typeof paint }).__tbDark = paint
    document.documentElement.classList.add('isl-dark-paint')
  }
  return installed
}
