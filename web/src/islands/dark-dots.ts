// The stage's dot grid in the dark theme with dark paint on (dark-paint.ts, HRN-1515). It used to be a CSS
// radial-gradient background on the static canvas whose position followed the camera: the browser repainted that
// full-screen layer on every frame of a pan. Now the patched static renderer draws it into the canvas itself, under
// the elements, with one pattern fill (the `dark-paint-dots` patch in scripts/excalidraw-patches.mjs).

type Ctx = CanvasRenderingContext2D

type Dots = { key: string; ctx: Ctx; pattern: CanvasPattern | null }
let dots: Dots | null = null

/**
 * The stage's dot grid in the dark theme, drawn by the patched static renderer into its canvas before the elements:
 * one pattern fill per frame. `ctx` is in CSS pixels (scaled by `scale`); a dot every 24 scene units, its spacing
 * doubled while it would be under 12 CSS pixels, following the camera.
 */
function paintDots(ctx: Ctx, appState: { scrollX: number; scrollY: number; zoom: { value: number } }, width: number, height: number, scale: number) {
  const zoom = appState.zoom.value
  let g = 24 * zoom
  while (g < 12) g *= 2
  const tile = Math.max(4, Math.ceil(g * scale))
  const key = `${tile}|${g}`
  if (!dots || dots.key !== key || dots.ctx !== ctx) {
    const c = document.createElement('canvas')
    c.width = tile
    c.height = tile
    const x = c.getContext('2d')
    let pattern: CanvasPattern | null = null
    if (x) {
      const k = tile / g // tile pixels per CSS pixel
      const grad = x.createRadialGradient(tile / 2, tile / 2, 0, tile / 2, tile / 2, 1.4 * k)
      grad.addColorStop(0, 'rgba(255, 255, 255, 0.14)')
      grad.addColorStop(1 / 1.4, 'rgba(255, 255, 255, 0.14)')
      grad.addColorStop(1, 'rgba(255, 255, 255, 0)')
      x.fillStyle = grad
      x.fillRect(0, 0, tile, tile)
      pattern = ctx.createPattern(c, 'repeat')
    }
    dots = { key, ctx, pattern }
  }
  const pattern = dots.pattern
  if (!pattern) return
  const at = (v: number) => (((v * zoom) % g) + g) % g
  pattern.setTransform(new DOMMatrix().translate(at(appState.scrollX), at(appState.scrollY)).scale(g / tile))
  ctx.save()
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

/** Lets the renderer draw the dots; called where dark paint is installed. */
export function installDarkDots() {
  ;(window as unknown as { __tbDots?: typeof paintDots }).__tbDots = paintDots
}
