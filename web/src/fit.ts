/**
 * Pure geometry for the read-only embed view: fit a scene into a viewport.
 *
 * Kept free of Excalidraw and DOM imports so it can be unit-tested in Node (tests/fit.test.mjs).
 *
 * The result follows Excalidraw's appState convention: `scrollX`/`scrollY` are in scene units and a scene point
 * lands on screen at `(scene + scroll) * zoom`, relative to the canvas' top-left corner.
 */

/** The subset of an Excalidraw element that matters for its extent. */
export type FitElement = {
  x: number
  y: number
  width: number
  height: number
  angle?: number
  isDeleted?: boolean
  /** Lines, arrows and freedraw: points relative to (x, y). */
  points?: readonly (readonly [number, number])[]
}

export type Viewport = { width: number; height: number }

export type FitOptions = {
  /** Gap kept free around the content, in screen pixels. Default: 5 % of the smaller side, at least 16 px. */
  margin?: number
  /** Upper zoom bound. 1 means a small diagram is shown at its real size instead of being blown up. */
  maxZoom?: number
  /** Lower zoom bound; Excalidraw does not go below 0.1. */
  minZoom?: number
}

export type Fit = { zoom: number; scrollX: number; scrollY: number }

export type Bounds = { minX: number; minY: number; maxX: number; maxY: number }

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n)

/** Default margin: proportional so large frames get some air, but never so thin that content touches the edge. */
export function defaultMargin(viewport: Viewport): number {
  return Math.max(16, Math.min(viewport.width, viewport.height) * 0.05)
}

/**
 * Axis-aligned scene bounds of one element, or null if it has no usable geometry.
 *
 * Linear elements (line, arrow, freedraw) are measured by their points: their width/height may lag behind the
 * points or be zero for a straight horizontal line, and a point may sit left of / above (x, y). Rotation is
 * applied around the element's centre, which is how Excalidraw rotates both boxes and point-based shapes.
 */
export function elementBounds(element: FitElement): Bounds | null {
  if (!finite(element.x) || !finite(element.y)) return null
  let minX: number
  let minY: number
  let maxX: number
  let maxY: number
  const points = Array.isArray(element.points) ? element.points.filter((p) => p && finite(p[0]) && finite(p[1])) : []
  if (points.length > 0) {
    minX = Math.min(...points.map((p) => p[0]))
    maxX = Math.max(...points.map((p) => p[0]))
    minY = Math.min(...points.map((p) => p[1]))
    maxY = Math.max(...points.map((p) => p[1]))
  } else {
    const width = finite(element.width) ? element.width : 0
    const height = finite(element.height) ? element.height : 0
    // Negative sizes can appear in hand-made scenes; treat them as boxes extending the other way.
    minX = Math.min(0, width)
    maxX = Math.max(0, width)
    minY = Math.min(0, height)
    maxY = Math.max(0, height)
  }
  minX += element.x
  maxX += element.x
  minY += element.y
  maxY += element.y

  const angle = finite(element.angle) ? element.angle : 0
  if (angle % (2 * Math.PI) === 0) return { minX, minY, maxX, maxY }

  const cx = (minX + maxX) / 2
  const cy = (minY + maxY) / 2
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const corners: [number, number][] = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]]
  const rotated = corners.map(([px, py]) => [cx + (px - cx) * cos - (py - cy) * sin, cy + (px - cx) * sin + (py - cy) * cos])
  return {
    minX: Math.min(...rotated.map((p) => p[0])),
    maxX: Math.max(...rotated.map((p) => p[0])),
    minY: Math.min(...rotated.map((p) => p[1])),
    maxY: Math.max(...rotated.map((p) => p[1])),
  }
}

/** Bounds of all live elements, or null for an empty scene (deleted elements do not count). */
export function sceneBounds(elements: readonly FitElement[]): Bounds | null {
  let result: Bounds | null = null
  for (const element of elements ?? []) {
    if (!element || element.isDeleted) continue
    const b = elementBounds(element)
    if (!b) continue
    if (!result) result = { ...b }
    else {
      result.minX = Math.min(result.minX, b.minX)
      result.minY = Math.min(result.minY, b.minY)
      result.maxX = Math.max(result.maxX, b.maxX)
      result.maxY = Math.max(result.maxY, b.maxY)
    }
  }
  return result
}

/** Zoom and scroll that show every live element, centred, inside the margin, within [minZoom, maxZoom]. */
export function fitScene(elements: readonly FitElement[], viewport: Viewport, options: FitOptions = {}): Fit {
  const width = Math.max(0, finite(viewport.width) ? viewport.width : 0)
  const height = Math.max(0, finite(viewport.height) ? viewport.height : 0)
  const maxZoom = options.maxZoom ?? 1
  const minZoom = Math.min(options.minZoom ?? 0.1, maxZoom)
  const clamp = (z: number) => Math.min(maxZoom, Math.max(minZoom, z))

  const bounds = sceneBounds(elements)
  if (!bounds) {
    // Nothing to show: real size, scene origin in the middle of the frame — where a first shape would appear.
    const zoom = clamp(1)
    return { zoom, scrollX: width / 2 / zoom, scrollY: height / 2 / zoom }
  }

  const margin = Math.max(0, options.margin ?? defaultMargin({ width, height }))
  // A frame smaller than twice the margin would leave no room at all; then use the whole frame.
  const availableWidth = width - 2 * margin > 0 ? width - 2 * margin : width
  const availableHeight = height - 2 * margin > 0 ? height - 2 * margin : height
  const contentWidth = bounds.maxX - bounds.minX
  const contentHeight = bounds.maxY - bounds.minY
  // A zero extent (a single point, a straight line) does not constrain that axis.
  const zoomX = contentWidth > 0 ? availableWidth / contentWidth : Infinity
  const zoomY = contentHeight > 0 ? availableHeight / contentHeight : Infinity
  const raw = Math.min(zoomX, zoomY)
  const zoom = clamp(Number.isFinite(raw) && raw > 0 ? raw : maxZoom)

  const centerX = (bounds.minX + bounds.maxX) / 2
  const centerY = (bounds.minY + bounds.maxY) / 2
  return { zoom, scrollX: width / 2 / zoom - centerX, scrollY: height / 2 / zoom - centerY }
}

/** Trailing-edge debounce with `cancel`, so a pending call can be dropped on unmount. */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number): ((...args: A) => void) & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const debounced = (...args: A) => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      fn(...args)
    }, wait)
  }
  debounced.cancel = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }
  return debounced
}

/** Below this width the editor counts as a narrow pane (a side panel, a phone): the whole board is fitted on load. */
export const NARROW_PANE_PX = 1024

/**
 * Whether the editor should zoom to fit the board when it first opens.
 *
 * On a wide screen the editor opens at 100 % around the content, as people expect. Embedded in a narrow pane — an
 * iframe in another app's side panel, a hand-off link opened next to a chat — that view shows a corner of the board,
 * so the board is fitted instead (never above 100 %). `?fit=1` forces it, `?fit=0` turns it off.
 */
export function shouldFitOnLoad({ framed, width, param }: { framed: boolean; width: number; param?: string | null }): boolean {
  if (param === '0' || param === 'false') return false
  if (param === '1' || param === 'true') return true
  return framed || (Number.isFinite(width) && width > 0 && width < NARROW_PANE_PX)
}
