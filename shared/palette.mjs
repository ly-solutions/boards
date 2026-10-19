/**
 * The board palette.
 *
 * Not a set of separate colors but tones: each tone has five matching roles.
 * People should pick "something nice from the palette" instead of choosing fill
 * and stroke one by one — what makes a board look good is consistency: a pastel
 * zone, a slightly darker zone border, a white card stroked in the same tone, a
 * bright heading badge, and text that reads on all of it.
 *
 * The look: one font (Nunito), straight lines, rounded corners, white cards with
 * pastel strokes, pastel section zones. Colors come from open-color, which
 * Excalidraw itself is built on, plus Excalidraw's primary violet (#6965db).
 *
 * Shared by the server (templates, agent graph layout) and the editor (palette
 * panel), so it has no imports.
 */

/** zone — section background, zoneBorder — its border, border — card stroke, strong — badge/accent, ink — text and arrows. */
export const TONES = [
  { id: 'purple', name: 'Purple', zone: '#f5f2ff', zoneBorder: '#e5dbff', border: '#b9a8ff', strong: '#6965db', ink: '#5f3dc4', onStrong: '#ffffff' },
  { id: 'blue', name: 'Blue', zone: '#f1f8ff', zoneBorder: '#d0ebff', border: '#a5d8ff', strong: '#1971c2', ink: '#1864ab', onStrong: '#ffffff' },
  { id: 'teal', name: 'Teal', zone: '#f0fcfd', zoneBorder: '#c5f6fa', border: '#99e9f2', strong: '#0c8599', ink: '#0b7285', onStrong: '#ffffff' },
  { id: 'green', name: 'Green', zone: '#f2fcf3', zoneBorder: '#d3f9d8', border: '#b2f2bb', strong: '#2f9e44', ink: '#2b8a3e', onStrong: '#ffffff' },
  { id: 'amber', name: 'Amber', zone: '#fffbeb', zoneBorder: '#ffec99', border: '#ffe066', strong: '#fab005', ink: '#e67700', onStrong: '#1e1e1e' },
  { id: 'orange', name: 'Orange', zone: '#fff6ef', zoneBorder: '#ffe8cc', border: '#ffc078', strong: '#e8590c', ink: '#d9480f', onStrong: '#ffffff' },
  { id: 'rose', name: 'Rose', zone: '#fff5f8', zoneBorder: '#ffdeeb', border: '#fcc2d7', strong: '#c2255c', ink: '#a61e4d', onStrong: '#ffffff' },
  { id: 'red', name: 'Red', zone: '#fff5f5', zoneBorder: '#ffe3e3', border: '#ffa8a8', strong: '#e03131', ink: '#c92a2a', onStrong: '#ffffff' },
  { id: 'slate', name: 'Slate', zone: '#f8f9fa', zoneBorder: '#e9ecef', border: '#ced4da', strong: '#343a40', ink: '#495057', onStrong: '#ffffff' },
]

export const INK = '#1e1e1e'
export const MUTED = '#868e96'

/**
 * Stickies use FigJam-style pastels: ten colors, yellow by default. A sticky's
 * color is not meaning but quick sorting ("pro", "con", "question"), hence a
 * separate palette rather than the tones above.
 */
export const STICKY_COLORS = [
  { id: 'yellow', name: 'Yellow', fill: '#ffe299' },
  { id: 'orange', name: 'Orange', fill: '#ffd3a8' },
  { id: 'salmon', name: 'Salmon', fill: '#ffb8a8' },
  { id: 'pink', name: 'Pink', fill: '#ffa8db' },
  { id: 'violet', name: 'Violet', fill: '#d3bdff' },
  { id: 'blue', name: 'Blue', fill: '#a8daff' },
  { id: 'teal', name: 'Teal', fill: '#b3f4ef' },
  { id: 'green', name: 'Green', fill: '#b3efbd' },
  { id: 'gray', name: 'Gray', fill: '#e6e6e6' },
  { id: 'white', name: 'White', fill: '#ffffff' },
]

/**
 * A sticky's stroke is the same paint, 10% darker. With stroke equal to fill,
 * two overlapping stickies of one color merged into a single blob and you could
 * not tell which one was on top.
 */
export function stickyStroke(fill) {
  if (!/^#[0-9a-f]{6}$/i.test(fill)) return fill
  if (fill.toLowerCase() === '#ffffff') return '#dee2e6'
  const shade = (i) => Math.round(parseInt(fill.slice(i, i + 2), 16) * 0.9).toString(16).padStart(2, '0')
  return `#${shade(1)}${shade(3)}${shade(5)}`
}

/** Shared style: straight lines, rounded corners, Nunito. Excalidraw FONT_FAMILY.Nunito = 6. */
export const STYLE = { roughness: 0, strokeWidth: 2, roundness: { type: 3 }, fontFamily: 6, strokeStyle: 'solid', fillStyle: 'solid', opacity: 100 }

/**
 * How a tone is applied to an element — three variants, like the rows in the
 * palette panel: card (white with a stroke), zone (pastel section background),
 * accent (badge).
 */
export const VARIANTS = [
  { id: 'card', name: 'Card' },
  { id: 'zone', name: 'Zone' },
  { id: 'strong', name: 'Accent' },
]

export function toneById(id) {
  return TONES.find((t) => t.id === id) ?? null
}

/** Element colors for a tone and variant: `{ strokeColor, backgroundColor, text }`. */
export function paint(tone, variant = 'card') {
  if (variant === 'zone') return { strokeColor: tone.zoneBorder, backgroundColor: tone.zone, text: tone.ink }
  if (variant === 'strong') return { strokeColor: tone.strong, backgroundColor: tone.strong, text: tone.onStrong }
  return { strokeColor: tone.border, backgroundColor: '#ffffff', text: INK }
}

/**
 * Plain color names an agent uses (`red`, `yellow`, `violet`…) map to palette
 * tones: an agent that writes `color: "blue"` gets the palette blue, not a raw
 * #1971c2 on a garish fill.
 */
const ALIASES = {
  red: 'red',
  green: 'green',
  blue: 'blue',
  yellow: 'amber', amber: 'amber',
  orange: 'orange',
  violet: 'purple', purple: 'purple',
  pink: 'rose', rose: 'rose',
  cyan: 'teal', teal: 'teal',
  gray: 'slate', grey: 'slate', slate: 'slate', black: 'slate',
}

export function toneForName(name) {
  const key = String(name ?? '').trim().toLowerCase()
  return ALIASES[key] ? toneById(ALIASES[key]) : null
}

/** All palette colors — for the "off-palette color" rule of the slop check. */
export function paletteColors() {
  const out = new Set([INK, MUTED, '#ffffff', 'transparent'])
  for (const t of TONES) for (const key of ['zone', 'zoneBorder', 'border', 'strong', 'ink', 'onStrong']) out.add(t[key])
  for (const s of STICKY_COLORS) out.add(s.fill)
  return [...out]
}
