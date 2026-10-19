/**
 * A minimal browser for Excalidraw under Node.
 *
 * The package targets the browser: on module load it touches `window`,
 * `document` and immediately asks a canvas for a 2D context. On the server we
 * need just one thing from it — `convertToExcalidrawElements`, which turns a
 * skeleton ("a rectangle with a label, an arrow from A to B") into real elements
 * with all fields and bindings. Writing that converter ourselves would mean
 * chasing every version of the format.
 *
 * No canvas: node-canvas is a native build for a single text-measuring
 * function. Text width is approximated by character classes; the browser
 * re-measures labels with the real font the first time the board is opened (see
 * the `customData.remeasure` flag in the editor), so the approximation lives
 * for seconds.
 */
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost/',
})

const g = globalThis
for (const key of [
  'window', 'document', 'HTMLElement', 'Element', 'Node', 'DOMParser', 'getComputedStyle',
  'location', 'HTMLCanvasElement', 'HTMLImageElement', 'Image', 'requestAnimationFrame',
  'cancelAnimationFrame', 'devicePixelRatio', 'SVGElement', 'CustomEvent', 'Event',
]) {
  if (key in g) continue
  Object.defineProperty(g, key, { value: dom.window[key], configurable: true, writable: true })
}
// Node has its own navigator without the userAgent the package reads on load.
Object.defineProperty(g, 'navigator', { value: dom.window.navigator, configurable: true, writable: true })

/**
 * Character width as a fraction of the font size — rough, but within 10% for
 * Excalifont. The Cyrillic ranges are intentional: wide and capital Cyrillic
 * letters are measured like their Latin counterparts.
 */
export function charWidth(ch) {
  if (ch === ' ') return 0.3
  if (/[ilj.,:;'|!]/.test(ch)) return 0.3
  if (/[mwMWШЩЖМЮшщжмю]/.test(ch)) return 0.85
  if (/[A-ZА-ЯЁ]/.test(ch)) return 0.66
  if (/[0-9]/.test(ch)) return 0.56
  return 0.56
}

export function measureLine(text, fontSize) {
  let width = 0
  for (const ch of String(text)) width += charWidth(ch)
  return width * fontSize
}

const fontSizeOf = (font) => parseFloat(/(\d+(?:\.\d+)?)px/.exec(font ?? '')?.[1] ?? '20')

g.HTMLCanvasElement.prototype.getContext = function getContext() {
  return {
    font: '20px Excalifont',
    measureText(text) {
      const size = fontSizeOf(this.font)
      return {
        width: measureLine(text, size),
        actualBoundingBoxAscent: size * 0.8,
        actualBoundingBoxDescent: size * 0.2,
      }
    },
    fillText() {}, strokeText() {}, save() {}, restore() {}, scale() {}, translate() {},
    beginPath() {}, closePath() {}, moveTo() {}, lineTo() {}, fill() {}, stroke() {},
    setTransform() {}, clearRect() {}, fillRect() {}, drawImage() {}, rotate() {},
  }
}

if (!g.FontFace) {
  g.FontFace = class FontFace {
    constructor(family) { this.family = family; this.status = 'loaded' }
    load() { return Promise.resolve(this) }
  }
}
if (!g.document.fonts) {
  g.document.fonts = {
    add() {}, delete() {}, check() { return true }, load() { return Promise.resolve([]) },
    ready: Promise.resolve(), addEventListener() {}, removeEventListener() {},
    *[Symbol.iterator]() {},
  }
}
