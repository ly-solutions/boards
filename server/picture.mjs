/**
 * A board as a picture: PNG of the whole board or of a few objects with what is around them (HRN-1480).
 *
 * An agent that edits a board by its text does not see what it drew: overlaps, a column that ran off, a label that
 * does not fit. This is its eyes. The SVG is the package's own export (`exportToSvg`, the server-side bundle in
 * dist/engine.mjs), so the picture is the board as people see it in the light theme; resvg (WebAssembly, no native
 * build) turns it into PNG with the editor's fonts, which scripts/build-engine.mjs merged into TTF at build time.
 * Text in a font that could not be merged (Nunito is a variable font) falls back to Liberation Sans.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadEngine } from './engine.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const FONTS = join(here, '../dist/fonts')
/** The longest side of the picture, px: enough to read sticky text, small enough for a model's eyes. */
const MAX_SIDE = 1600
const MAX_SCALE = 2
/** Around a selection: this much of the board is shown too, so the agent sees what the objects touch. */
const AROUND = 160
const MAX_ELEMENTS = 3000

let ready = null
function resvg() {
  ready ??= (async () => {
    const require = createRequire(import.meta.url)
    const mod = await import('@resvg/resvg-wasm')
    await mod.initWasm(readFileSync(require.resolve('@resvg/resvg-wasm/index_bg.wasm')))
    const fontBuffers = existsSync(FONTS) ? readdirSync(FONTS).filter((f) => f.endsWith('.ttf')).sort().map((f) => readFileSync(join(FONTS, f))) : []
    // The build writes each font as <its family name>.ttf.
    const families = new Set(existsSync(FONTS) ? readdirSync(FONTS).filter((f) => f.endsWith('.ttf')).map((f) => f.replace(/\.ttf$/, '')) : [])
    return { Resvg: mod.Resvg, fontBuffers, families }
  })()
  return ready
}

/** The export names each text's font first; Nunito (a variable font we could not merge) reads as a plain sans. */
function fixFonts(svg, families) {
  return svg.replace(/font-family="([^"]*)"/g, (_, list) => {
    const first = list.split(',')[0].trim()
    return `font-family="${families.has(first) ? first : 'Liberation Sans'}, Liberation Sans"`
  })
}

const box = (e) => {
  if (Array.isArray(e.points) && e.points.length) {
    const xs = e.points.map((p) => e.x + p[0])
    const ys = e.points.map((p) => e.y + p[1])
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  }
  return { x1: e.x, y1: e.y, x2: e.x + (e.width ?? 0), y2: e.y + (e.height ?? 0) }
}

/**
 * Which elements to draw: all, or the asked-for ones with their labels and whatever lies within AROUND of them.
 * Returns null when none of the ids is on the board.
 */
export function pick(elements, ids) {
  const live = elements.filter((e) => !e.isDeleted)
  if (!ids?.length) return live
  const want = new Set(ids)
  const chosen = live.filter((e) => want.has(e.id) || (e.containerId && want.has(e.containerId)))
  if (!chosen.length) return null
  const b = chosen.map(box)
  const area = { x1: Math.min(...b.map((x) => x.x1)) - AROUND, y1: Math.min(...b.map((x) => x.y1)) - AROUND, x2: Math.max(...b.map((x) => x.x2)) + AROUND, y2: Math.max(...b.map((x) => x.y2)) + AROUND }
  const inside = (e) => {
    const x = box(e)
    return x.x2 >= area.x1 && x.x1 <= area.x2 && x.y2 >= area.y1 && x.y1 <= area.y2
  }
  const near = new Set(live.filter(inside).map((e) => e.id))
  // A label goes with its shape, a shape with its label.
  for (const e of live) if (e.containerId && near.has(e.containerId)) near.add(e.id)
  for (const e of live) if (near.has(e.id) && e.containerId) near.add(e.containerId)
  return live.filter((e) => near.has(e.id))
}

/** PNG bytes of the board (or of the given objects and their surroundings), null when the ids are not on it. */
export async function renderPicture(elements, files = {}, { ids = [] } = {}) {
  const chosen = pick(elements, ids)
  if (!chosen) return null
  const engine = await loadEngine()
  const { Resvg, fontBuffers, families } = await resvg()
  const svgEl = await engine.exportToSvg({
    elements: chosen.slice(0, MAX_ELEMENTS),
    appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false, exportPadding: 24 },
    files,
    skipInliningFonts: true,
  })
  const svg = fixFonts(svgEl.outerHTML, families)
  const w = Number(svgEl.getAttribute('width')) || 800
  const h = Number(svgEl.getAttribute('height')) || 600
  const scale = Math.min(MAX_SCALE, MAX_SIDE / Math.max(w, h))
  const out = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.max(1, Math.round(w * scale)) },
    font: { fontBuffers, defaultFontFamily: 'Liberation Sans', loadSystemFonts: false },
    background: '#ffffff',
  })
  return Buffer.from(out.render().asPng())
}
