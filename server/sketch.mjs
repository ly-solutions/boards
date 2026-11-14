/**
 * A board's sketch: a plain SVG drawn on the server from the scene's elements, for a board no browser has sent a
 * thumbnail of yet (a board an agent drew through the API). Shapes as outlines, arrows and lines as strokes, text as
 * text, all in one neutral ink, fitted into a 4:3 box. It is a hint of what the board holds, not its picture.
 */

const W = 400
const H = 300
const PAD = 16
const INK = '#7a7f87'
const TEXT_INK = '#3d4148'
const MAX_ELEMENTS = 400

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
const f = (v) => Math.round(v * 10) / 10

/** The box all the elements take, null for an empty board. */
function bounds(elements) {
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const e of elements) {
    const x = n(e.x)
    const y = n(e.y)
    const pts = Array.isArray(e.points) && e.points.length ? e.points : [[0, 0], [n(e.width), n(e.height)]]
    for (const p of pts) {
      const px = x + n(p?.[0])
      const py = y + n(p?.[1])
      x0 = Math.min(x0, px)
      y0 = Math.min(y0, py)
      x1 = Math.max(x1, px)
      y1 = Math.max(y1, py)
    }
  }
  return Number.isFinite(x0) ? { x0, y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) } : null
}

/** @param {any[]} all the scene's live elements */
export function sketchSvg(all) {
  const elements = (all ?? []).filter((e) => e && !e.isDeleted).slice(0, MAX_ELEMENTS)
  const box = bounds(elements)
  const head = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">`
  if (!box) return `${head}</svg>`
  const k = Math.min((W - 2 * PAD) / box.w, (H - 2 * PAD) / box.h, 1)
  const ox = (W - box.w * k) / 2 - box.x0 * k
  const oy = (H - box.h * k) / 2 - box.y0 * k
  const X = (v) => f(ox + v * k)
  const Y = (v) => f(oy + v * k)
  const sw = f(Math.max(0.75, 1.5 * Math.sqrt(k)))
  const out = []
  for (const e of elements) {
    const x = n(e.x)
    const y = n(e.y)
    const w = n(e.width)
    const h = n(e.height)
    if (e.type === 'rectangle' || e.type === 'frame' || e.type === 'image' || e.type === 'embeddable') {
      out.push(`<rect x="${X(x)}" y="${Y(y)}" width="${f(w * k)}" height="${f(h * k)}" rx="${f(Math.min(8, w * k / 6))}" fill="none" stroke="${INK}" stroke-width="${sw}"/>`)
    } else if (e.type === 'ellipse') {
      out.push(`<ellipse cx="${X(x + w / 2)}" cy="${Y(y + h / 2)}" rx="${f((w * k) / 2)}" ry="${f((h * k) / 2)}" fill="none" stroke="${INK}" stroke-width="${sw}"/>`)
    } else if (e.type === 'diamond') {
      out.push(`<polygon points="${X(x + w / 2)},${Y(y)} ${X(x + w)},${Y(y + h / 2)} ${X(x + w / 2)},${Y(y + h)} ${X(x)},${Y(y + h / 2)}" fill="none" stroke="${INK}" stroke-width="${sw}"/>`)
    } else if ((e.type === 'arrow' || e.type === 'line' || e.type === 'freedraw') && Array.isArray(e.points)) {
      const pts = e.points.map((p) => `${X(x + n(p?.[0]))},${Y(y + n(p?.[1]))}`).join(' ')
      out.push(`<polyline points="${pts}" fill="none" stroke="${INK}" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"/>`)
    } else if (e.type === 'text' && typeof e.text === 'string' && e.text.trim()) {
      const size = f(Math.max(6, n(e.fontSize) * k || 10))
      const line = e.text.split('\n')[0].slice(0, 60)
      out.push(`<text x="${X(x)}" y="${f(Y(y) + size)}" font-family="system-ui, sans-serif" font-size="${size}" fill="${TEXT_INK}">${esc(line)}</text>`)
    }
  }
  return `${head}${out.join('')}</svg>`
}
