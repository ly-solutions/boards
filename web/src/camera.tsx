/**
 * Camera for the overlay layers above the canvas.
 *
 * Sticky author/reaction badges, comment pins and their cards are DOM on top of
 * the Excalidraw canvas. Routing every scroll/zoom through React (onChange → Board
 * state → re-render of the whole page incl. the editor → layer effect → another
 * render) made the layer lag a frame behind the canvas, jitter, and steal frames
 * from the canvas itself.
 *
 * Instead the layer lives in scene coordinates and a single CSS transform, written
 * straight to the DOM in the same tick Excalidraw paints, applies scroll and zoom.
 * React does not know about scrolling at all.
 *
 * Inside the layer sizes are in scene pixels. Things that must keep a constant
 * on-screen size (pin, card) go into `.camera-fixed`, which has the inverse scale
 * `--camera-inv`. Sticky labels grow with zoom but are clamped to 0.7…1.25 via
 * `--camera-sticky`.
 */
import { useLayoutEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'

export type View = { scrollX: number; scrollY: number; zoom: number; offsetLeft: number; offsetTop: number; width: number; height: number }

/** Below this zoom sticky labels are unreadable and only get in the way. */
export const FAR_ZOOM = 0.4

let view: View = { scrollX: 0, scrollY: 0, zoom: 1, offsetLeft: 0, offsetTop: 0, width: 0, height: 0 }
const layers = new Set<HTMLElement>()
const listeners = new Set<() => void>()
let notifyFrame = 0

/**
 * While zooming, the layer is scaled as a ready bitmap (will-change) and the
 * constant-screen-size values (pins, labels) are not recomputed; otherwise the
 * browser re-laid-out and re-rasterized the whole layer's text and shadows on
 * every zoom step and zoom stuttered. After ZOOM_SETTLE_MS of quiet the sizes
 * snap back and the layer repaints sharp once.
 */
const ZOOM_SETTLE_MS = 300
let settledZoom = 1
let settleTimer: ReturnType<typeof setTimeout> | undefined

function paintSizes(layer: HTMLElement, zoom: number) {
  layer.style.setProperty('--camera-inv', String(1 / zoom))
  layer.style.setProperty('--camera-sticky', String(Math.min(1.25, Math.max(0.7, zoom)) / zoom))
  layer.classList.toggle('is-far', zoom < FAR_ZOOM)
}

function paint(layer: HTMLElement, zooming = false) {
  const { scrollX, scrollY, zoom } = view
  // Scene point p lands on screen at zoom·(p + scroll), exactly like the canvas.
  layer.style.transform = `matrix(${zoom}, 0, 0, ${zoom}, ${zoom * scrollX}, ${zoom * scrollY})`
  layer.classList.toggle('is-zooming', zooming)
  if (!zooming) paintSizes(layer, zoom)
}

function settle() {
  settleTimer = undefined
  settledZoom = view.zoom
  for (const layer of layers) paint(layer)
}

/** Called from the editor's onChange and onScrollChange. Cheap: compares a few numbers. */
export function setView(appState: Record<string, unknown>) {
  const next: View = {
    scrollX: appState.scrollX as number,
    scrollY: appState.scrollY as number,
    zoom: (appState.zoom as { value: number }).value,
    offsetLeft: appState.offsetLeft as number,
    offsetTop: appState.offsetTop as number,
    width: appState.width as number,
    height: appState.height as number,
  }
  if (
    next.scrollX === view.scrollX &&
    next.scrollY === view.scrollY &&
    next.zoom === view.zoom &&
    next.offsetLeft === view.offsetLeft &&
    next.offsetTop === view.offsetTop &&
    next.width === view.width &&
    next.height === view.height
  )
    return
  view = next
  const zooming = next.zoom !== settledZoom
  if (zooming) {
    clearTimeout(settleTimer)
    settleTimer = setTimeout(settle, ZOOM_SETTLE_MS)
  }
  for (const layer of layers) paint(layer, zooming)
  // React subscribers (card pinned to the screen edge) get notified at most once per frame.
  if (listeners.size && !notifyFrame) {
    notifyFrame = requestAnimationFrame(() => {
      notifyFrame = 0
      for (const listener of listeners) listener()
    })
  }
}

export const getView = () => view

/**
 * A layer in scene coordinates, moved by the camera rather than React. The outer
 * node is the editor viewport (clipped), the inner one is the scene.
 */
export function CameraLayer({ className, children }: { className: string; children?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const node = ref.current!
    layers.add(node)
    paint(node, Boolean(settleTimer))
    if (settleTimer) paintSizes(node, settledZoom)
    // Wheel over a pin or sticky label must still scroll/zoom the board. The layer
    // sits outside the editor, so without forwarding the wheel never reached the
    // canvas, and Ctrl+wheel over a pin zoomed the whole browser page.
    const onWheel = (event: WheelEvent) => {
      const canvas = document.querySelector<HTMLCanvasElement>('.excalidraw canvas.interactive')
      if (!canvas) return
      event.preventDefault()
      canvas.dispatchEvent(new WheelEvent('wheel', event))
    }
    node.addEventListener('wheel', onWheel, { passive: false })
    return () => {
      layers.delete(node)
      node.removeEventListener('wheel', onWheel)
    }
  }, [])
  return (
    <div className={`camera-viewport ${className}`}>
      <div ref={ref} className="camera-layer">
        {children}
      </div>
    </div>
  )
}

// ── Scene version ───────────────────────────────────────────────────────────
// Layers need to know shapes moved, but the rest of the page does not. The
// counter lives here so only its subscribers re-render.

let sceneVersion = 0
const sceneListeners = new Set<() => void>()
let sceneFrame = 0

/** Several edits can land in one frame; one layer re-render before paint is enough. */
export function bumpScene() {
  if (sceneFrame) return
  sceneFrame = requestAnimationFrame(() => {
    sceneFrame = 0
    sceneVersion += 1
    for (const listener of sceneListeners) listener()
  })
}

function subscribeScene(listener: () => void) {
  sceneListeners.add(listener)
  return () => sceneListeners.delete(listener)
}

export function useSceneVersion() {
  return useSyncExternalStore(subscribeScene, () => sceneVersion)
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The view for the few React consumers that need it, e.g. a card hugging the screen edge. */
export function useView() {
  return useSyncExternalStore(subscribe, getView)
}

/**
 * Scene window worth keeping layer nodes for: the viewport plus one viewport of
 * margin on each side, snapped to a coarse grid. It changes rarely (after
 * scrolling a screen or two, or zooming 2×), so layers that cull far-off nodes by
 * it barely re-render.
 */
export type SceneWindow = { x1: number; y1: number; x2: number; y2: number }
function windowKey() {
  const v = view
  if (!v.width || !v.height) return ''
  const z = 2 ** Math.round(Math.log2(v.zoom))
  const cell = Math.max(v.width, v.height) / z
  const cx = Math.floor(-v.scrollX / cell)
  const cy = Math.floor(-v.scrollY / cell)
  return `${cell}:${cx}:${cy}`
}
export function useSceneWindow(): SceneWindow | null {
  const key = useSyncExternalStore(subscribe, windowKey)
  if (!key) return null
  const [cell, cx, cy] = key.split(':').map(Number)
  return { x1: (cx - 1) * cell, y1: (cy - 1) * cell, x2: (cx + 3) * cell, y2: (cy + 3) * cell }
}
export const inWindow = (w: SceneWindow | null, x1: number, y1: number, x2: number, y2: number) => !w || (x2 >= w.x1 && x1 <= w.x2 && y2 >= w.y1 && y1 <= w.y2)

/** Scene point → screen point relative to the editor. */
export function toScreen(x: number, y: number, v: View = view) {
  return { left: (x + v.scrollX) * v.zoom, top: (y + v.scrollY) * v.zoom }
}
