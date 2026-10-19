/**
 * Smooth board camera.
 *
 * Excalidraw sets the view instantly: a wheel notch jumps 100px and stops dead,
 * a zoom step jumps 10%, a released board stops on the spot. Here input sets a
 * target instead, and the view eases towards it over a few frames:
 *
 * - the mouse wheel accumulates remaining scroll, which the view covers with decay;
 * - Ctrl+wheel multiplies the target zoom, keeping the point under the cursor fixed;
 * - a board thrown by hand (space, middle button, hand tool, view mode) keeps
 *   coasting at the release speed;
 * - zoom buttons, "zoom to fit" and zoom reset glide instead of jumping.
 *
 * Trackpad scrolling is left alone: it has its own OS inertia and arrives in small
 * steps, so smoothing on top would only add lag. Trackpad pinch is handled here,
 * though: the package changed zoom by percentage points of 100%, so at low zoom
 * one pinch could halve it. Now zoom is multiplied — the same at any scale, as in
 * Miro and FigJam — and applied immediately, no glide: the finger should drive
 * the board, not chase it.
 *
 * The package calls the camera through hooks patched in at build time
 * (scripts/excalidraw-patches.mjs, motion-* patches). No camera — hooks are no-ops.
 */

/**
 * Glide time constants, ms: one covers 63% of the remainder, three cover 95%.
 * The first values (85, 95, 260) felt like too much glide: the board kept
 * floating for a quarter second after the hand stopped. These are ~1.5x shorter:
 * still not a jump, but the view settles almost right behind the hand.
 */
export const WHEEL_TAU = 55
export const ZOOM_TAU = 65
export const THROW_TAU = 160
/** Zoom factor per wheel notch (delta 100). */
export const ZOOM_PER_NOTCH = 1.2
/**
 * Trackpad pinch: zoom change per unit of delta. 0.01 is 1% per unit, as in
 * Figma and tldraw; a typical pinch adds up to 100–200 units.
 */
export const PINCH_RATE = 0.01
/**
 * Max delta taken from one pinch event. A real pinch sends up to ~10 units per
 * event; more means Ctrl + two-finger scroll, whose deltas are an order of
 * magnitude larger — without a cap the board would shrink to a dot.
 */
export const PINCH_MAX_DELTA = 15
/**
 * Notch zoom applies only when the event really is a wheel notch: delta at least
 * this. Chrome sends a trackpad pinch as Ctrl+wheel with a fractional delta of a
 * couple of units, but marks it in the legacy `wheelDelta` as ±120, like a mouse
 * notch. Judged by that alone, a pinch passed for a wheel and got the wheel step:
 * a fraction of a percent per event, with a glide on top. A real notch is
 * 50–120 units; a pinch never sends that much per event.
 */
export const NOTCH_MIN_DELTA = 40
/** For this long after the last zoom step, cached shape bitmaps are scaled instead of re-rendered. */
export const ZOOM_HOLD_MS = 250
/** A zoom target this close to 100% snaps to exactly 100%. */
export const ZOOM_SNAP = 0.004
/** Max delta taken from one wheel event: a free-spinning wheel must not fly off. */
export const MAX_WHEEL_DELTA = 400
/** Below this speed (screen px per ms) a released board does not coast. */
export const THROW_MIN_SPEED = 0.25
/** Throw speed is measured over this window before release. */
export const THROW_WINDOW_MS = 90
/** If the hand held still longer than this before release, there is no throw. */
export const THROW_STALE_MS = 60
/** Glide for actions: zoom buttons, "zoom to fit". */
export const GLIDE_MS = 180
/** Zoom step of the package's zoom buttons and keys. */
export const ZOOM_STEP = 0.1
export const MIN_ZOOM = 0.1
export const MAX_ZOOM = 30
/** One wheel line in pixels: Firefox reports mouse scroll in lines. */
const LINE_PX = 100 / 3
const KEY = 'boards-motion'

type AppState = {
  scrollX: number
  scrollY: number
  zoom: { value: number }
  offsetLeft: number
  offsetTop: number
  width: number
  height: number
  isLoading?: boolean
}
/** The part of the Excalidraw editor the camera touches. */
export type MotionApp = {
  state: AppState
  unmounted?: boolean
  setState(patch: Record<string, unknown>): void
  cancelInProgressAnimation?: (() => void) | null
  maybeUnfollowRemoteUser(): void
}
export type Camera = { scrollX: number; scrollY: number; zoom: number }
type WheelLike = { deltaX: number; deltaY: number; deltaMode: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; clientX: number; clientY: number; wheelDeltaX?: number; wheelDeltaY?: number; timeStamp: number }

export const normalizeZoom = (zoom: number) => Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, Math.round(zoom * 1e6) / 1e6))
const easeOut = (t: number) => 1 - (1 - t) ** 3

/**
 * Mouse wheel or trackpad. A mouse scrolls in notches: lines (Firefox) or
 * multiples of 120 in the legacy `wheelDelta`. Trackpads and smooth wheels send
 * small arbitrary deltas. A burst of events with at least one non-notch is a
 * trackpad until the burst ends; otherwise a stray 40px delta mid-gesture would
 * pass for a mouse.
 */
export class WheelDevice {
  private lastAt = -Infinity
  private smooth = false
  isMouse(e: WheelLike): boolean {
    if (e.timeStamp - this.lastAt > 150) this.smooth = false
    this.lastAt = e.timeStamp
    let notch: boolean
    if (e.deltaMode !== 0) notch = true
    else if (e.wheelDeltaY === undefined && e.wheelDeltaX === undefined) notch = false
    else {
      const raw = Math.abs(e.wheelDeltaY || e.wheelDeltaX || 0)
      notch = raw >= 120 && raw % 120 === 0
    }
    if (!notch) this.smooth = true
    return notch && !this.smooth
  }
}

type Glide = { from: Camera; to: Camera; startedAt: number; duration: number }
const same = (a: Camera, b: Camera) => a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.zoom === b.zoom

export class CameraMotion {
  /** Off for this user: their menu choice or the OS "reduce motion" setting. */
  off = false
  private app: MotionApp | null = null
  private device = new WheelDevice()
  /** Remaining scroll in screen pixels, same sign as wheel deltas. */
  private panX = 0
  private panY = 0
  private tau = WHEEL_TAU
  private zoomTo: number | null = null
  private anchorX = 0
  private anchorY = 0
  /** Zooming: the package is told to scale cached shape bitmaps instead of re-rendering them every frame. */
  private scaling = false
  private glide: Glide | null = null
  /**
   * Where the camera is by our own count. Editor state lags by a frame: React
   * applies setState later, so reading the view from state each time would
   * sometimes step from a stale position. So we track the view ourselves and
   * compare state with what we sent: an unknown value means someone else moved
   * the view (scrollbar, keys), and we continue from there.
   */
  private cam: Camera | null = null
  private sent: Camera[] = []
  private frame = 0
  private frameAt = 0
  private hold: unknown
  private samples: { dx: number; dy: number; at: number }[] = []

  constructor(
    private raf: (cb: (now: number) => void) => number = (cb) => requestAnimationFrame(cb),
    private caf: (id: number) => void = (id) => cancelAnimationFrame(id),
    private now: () => number = () => performance.now(),
    private later: (cb: () => void, ms: number) => unknown = (cb, ms) => setTimeout(cb, ms),
    private unlater: (id: unknown) => void = (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
  ) {}

  get moving() {
    return this.panX !== 0 || this.panY !== 0 || this.zoomTo !== null || this.glide !== null
  }

  // ── package hooks ─────────────────────────────────────────────────────────

  mount(app: MotionApp) {
    this.app = app
  }

  /** Wheel over the canvas. True means the camera handled it and the package should do nothing. */
  wheel(e: WheelLike, app: MotionApp): boolean {
    if (this.off) return false
    this.app = app
    const zooming = e.ctrlKey || e.metaKey
    const mouse = this.device.isMouse(e)
    if (!mouse && !zooming) {
      // The package handles trackpad scroll. Any pending mouse glide finishes at once so the two drivers do not fight.
      this.finish()
      return false
    }
    app.cancelInProgressAnimation?.()
    app.maybeUnfollowRemoteUser()
    this.glide = null
    // The wheel replaces a throw's coasting rather than adding to it.
    if (this.tau === THROW_TAU) this.panX = this.panY = 0
    const cam = this.camera(app)
    const lines = e.deltaMode === 1 ? LINE_PX : e.deltaMode === 2 ? app.state.height : 1
    if (zooming && !(mouse && Math.abs(e.deltaY * lines) >= NOTCH_MIN_DELTA)) {
      // Pinch: zoom is multiplied and applied at once, the point under the fingers stays put.
      const pinch = Math.max(-PINCH_MAX_DELTA, Math.min(PINCH_MAX_DELTA, e.deltaY * lines))
      this.zoomTo = normalizeZoom((this.zoomTo ?? cam.zoom) * Math.exp(-pinch * PINCH_RATE))
      this.anchorX = e.clientX - app.state.offsetLeft
      this.anchorY = e.clientY - app.state.offsetTop
      if (this.frame) this.caf(this.frame)
      this.frame = 0
      this.step(Infinity)
      return true
    }
    const clamp = (v: number) => Math.max(-MAX_WHEEL_DELTA, Math.min(MAX_WHEEL_DELTA, v * lines))
    const dx = clamp(e.deltaX)
    const dy = clamp(e.deltaY)
    if (zooming) {
      const to = normalizeZoom((this.zoomTo ?? cam.zoom) * ZOOM_PER_NOTCH ** (-dy / 100))
      // Rounding would make steps in and back out land on 100.0001% rather than 100%,
      // and cached shape bitmaps would be drawn slightly scaled instead of 1:1.
      this.zoomTo = Math.abs(to - 1) < ZOOM_SNAP ? 1 : to
      this.anchorX = e.clientX - app.state.offsetLeft
      this.anchorY = e.clientY - app.state.offsetTop
    } else if (e.shiftKey) {
      this.panX += dy || dx
      this.tau = WHEEL_TAU
    } else {
      this.panX += dx
      this.panY += dy
      this.tau = WHEEL_TAU
    }
    // First step right in the event, so the view responds to the wheel on the next frame.
    if (!this.frame) {
      this.step(1000 / 60)
      this.start()
    }
    return true
  }

  /** Board grabbed by hand: whatever was moving stops under the finger. */
  grab(app: MotionApp) {
    this.app = app
    this.samples = []
    this.stop()
  }

  /** The hand moved the board by (dx, dy) screen pixels this frame. */
  drag(dx: number, dy: number) {
    const at = this.now()
    this.samples.push({ dx, dy, at })
    while (this.samples.length > 1 && at - this.samples[0].at > THROW_WINDOW_MS * 2) this.samples.shift()
  }

  /** Board released: if the hand was moving, keep coasting at its speed. */
  release(app: MotionApp) {
    const samples = this.samples
    this.samples = []
    if (this.off || samples.length < 2) return
    this.app = app
    const at = this.now()
    const lastAt = samples[samples.length - 1].at
    if (at - lastAt > THROW_STALE_MS) return
    let dx = 0
    let dy = 0
    let since = lastAt
    for (let i = samples.length - 1; i > 0 && lastAt - samples[i].at <= THROW_WINDOW_MS; i--) {
      dx += samples[i].dx
      dy += samples[i].dy
      since = samples[i - 1].at
    }
    const span = lastAt - since
    if (span <= 0) return
    const vx = dx / span
    const vy = dy / span
    if (Math.hypot(vx, vy) < THROW_MIN_SPEED) return
    // Exponential decay from initial speed v covers distance v·τ.
    const reach = 2.5 * Math.max(app.state.width, app.state.height)
    const cap = (v: number) => Math.max(-reach, Math.min(reach, v * THROW_TAU))
    this.panX = cap(vx)
    this.panY = cap(vy)
    this.tau = THROW_TAU
    this.start()
  }

  /**
   * An editor action returned new state. If it changes the view, the camera glides
   * there itself and the state keeps the current view for now.
   */
  action<T extends Record<string, unknown>>(next: T, app: MotionApp): T {
    if (this.off || app.state.isLoading || !app.state.width) return next
    const zoom = (next.zoom as { value: number } | undefined)?.value
    if (typeof next.scrollX !== 'number' && typeof next.scrollY !== 'number' && typeof zoom !== 'number') return next
    const s = app.state
    const live: Camera = { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value }
    const heading = this.glide?.to
    let to: Camera = {
      scrollX: typeof next.scrollX === 'number' ? next.scrollX : live.scrollX,
      scrollY: typeof next.scrollY === 'number' ? next.scrollY : live.scrollY,
      zoom: typeof zoom === 'number' ? zoom : live.zoom,
    }
    if (same(to, live)) return next
    // A button/key zoom step is computed from the in-flight view. If the previous step
    // is still gliding, apply the new one to its target — otherwise a held key would
    // zoom ~3x slower than without smoothing, each repeat starting from halfway.
    const cx = s.width / 2
    const cy = s.height / 2
    const centred = (a: Camera, b: Camera) => Math.abs(a.scrollX + cx / b.zoom - cx / a.zoom - b.scrollX) < 1e-6 && Math.abs(a.scrollY + cy / b.zoom - cy / a.zoom - b.scrollY) < 1e-6
    if (heading && Math.abs(Math.abs(to.zoom - live.zoom) - ZOOM_STEP) < 1e-6 && centred(live, to)) {
      const z = normalizeZoom(heading.zoom + (to.zoom - live.zoom))
      to = { zoom: z, scrollX: heading.scrollX + cx / z - cx / heading.zoom, scrollY: heading.scrollY + cy / z - cy / heading.zoom }
    }
    this.app = app
    this.glideTo(to)
    // State keeps exactly the current view; the glide starts on the next frame.
    return { ...next, scrollX: live.scrollX, scrollY: live.scrollY, zoom: s.zoom }
  }

  // ── for the board itself ──────────────────────────────────────────────────

  /** Glide to a view: following a participant, jumping to an edit. */
  glideTo(to: Camera, duration = GLIDE_MS) {
    const app = this.app
    if (!app || app.unmounted) return false
    if (this.off) {
      app.setState({ scrollX: to.scrollX, scrollY: to.scrollY, zoom: { value: to.zoom } })
      return true
    }
    app.cancelInProgressAnimation?.()
    this.panX = this.panY = 0
    this.zoomTo = null
    this.glide = { from: { ...this.camera(app) }, to: { ...to, zoom: normalizeZoom(to.zoom) }, startedAt: this.now(), duration }
    this.start()
    return true
  }

  /** Stop where we are, no glide. */
  stop() {
    this.panX = this.panY = 0
    this.zoomTo = null
    this.glide = null
    if (this.frame) this.caf(this.frame)
    this.frame = 0
    this.rest()
  }

  /** Jump straight to the target. */
  finish() {
    const app = this.app
    if (!app || app.unmounted || !this.moving) return
    if (this.frame) this.caf(this.frame)
    this.frame = 0
    this.step(Infinity)
  }

  // ── frame ─────────────────────────────────────────────────────────────────

  /** The view by our count, reconciled with editor state. */
  private camera(app: MotionApp): Camera {
    const s = app.state
    const live = { scrollX: s.scrollX, scrollY: s.scrollY, zoom: s.zoom.value }
    if (this.cam && this.sent.some((c) => same(c, live))) return this.cam
    // Someone else moved the view: a pending action glide no longer applies.
    if (this.cam && this.sent.length) this.glide = null
    this.cam = live
    this.sent = [live]
    return live
  }

  private start() {
    if (this.frame) return
    this.frameAt = 0
    this.frame = this.raf(this.tick)
  }

  /**
   * Motion ended. Shape bitmaps are re-rendered for the new zoom only after
   * ZOOM_HOLD_MS of quiet: a pinch or a run of wheel notches is dozens of stops
   * in a row, and re-rendering after each would eat the gesture's frames.
   */
  private rest() {
    this.sent = this.sent.slice(-2)
    if (!this.scaling) return
    this.unlater(this.hold)
    this.hold = this.later(() => {
      this.hold = undefined
      const app = this.app
      if (this.moving || !this.scaling) return
      this.scaling = false
      if (app && !app.unmounted) app.setState({ shouldCacheIgnoreZoom: false })
    }, ZOOM_HOLD_MS)
  }

  private tick = (at: number) => {
    this.frame = 0
    const app = this.app
    if (!app || app.unmounted) return this.stop()
    const dt = this.frameAt ? Math.min(50, at - this.frameAt) : 1000 / 60
    this.frameAt = at
    if (this.moving) this.step(dt)
    if (this.moving) this.frame = this.raf(this.tick)
  }

  private step(dt: number) {
    const app = this.app!
    const from = this.camera(app)
    let { scrollX: x, scrollY: y, zoom: z } = from

    if (this.glide) {
      const g = this.glide
      const t = dt === Infinity ? 1 : Math.min(1, (this.now() - g.startedAt) / g.duration)
      if (t >= 1) {
        ;({ scrollX: x, scrollY: y, zoom: z } = g.to)
        this.glide = null
      } else {
        const e = easeOut(t)
        z = g.from.zoom * (g.to.zoom / g.from.zoom) ** e
        // Scene point p is on screen at z·(p + scroll). Interpolating z·scroll linearly
        // in zoom makes every point travel in a straight line, not an arc.
        const u = g.to.zoom === g.from.zoom ? e : (z - g.from.zoom) / (g.to.zoom - g.from.zoom)
        x = (g.from.scrollX * g.from.zoom + (g.to.scrollX * g.to.zoom - g.from.scrollX * g.from.zoom) * u) / z
        y = (g.from.scrollY * g.from.zoom + (g.to.scrollY * g.to.zoom - g.from.scrollY * g.from.zoom) * u) / z
      }
    } else {
      if (this.zoomTo !== null) {
        const ratio = this.zoomTo / z
        const next = dt === Infinity || Math.abs(Math.log(ratio)) < 0.002 ? this.zoomTo : z * ratio ** (1 - Math.exp(-dt / ZOOM_TAU))
        if (next === this.zoomTo) this.zoomTo = null
        // The scene point under the cursor stays under the cursor.
        x += this.anchorX / next - this.anchorX / z
        y += this.anchorY / next - this.anchorY / z
        z = next
      }
      if (this.panX || this.panY) {
        const k = dt === Infinity || Math.hypot(this.panX, this.panY) < 0.5 ? 1 : 1 - Math.exp(-dt / this.tau)
        const sx = this.panX * k
        const sy = this.panY * k
        this.panX = k === 1 ? 0 : this.panX - sx
        this.panY = k === 1 ? 0 : this.panY - sy
        x -= sx / z
        y -= sy / z
      }
    }

    this.cam = { scrollX: x, scrollY: y, zoom: z }
    const patch: Record<string, unknown> = {}
    if (z !== from.zoom) {
      patch.zoom = { value: z }
      if (!this.scaling) {
        this.scaling = true
        patch.shouldCacheIgnoreZoom = true
      }
    }
    patch.scrollX = x
    patch.scrollY = y
    const cam = { scrollX: x, scrollY: y, zoom: z }
    this.sent.push(cam)
    if (this.sent.length > 4) this.sent.shift()
    app.setState(patch)
    if (!this.moving) this.rest()
  }
}

/**
 * Remote cursors arrive ~30 times a second and used to be drawn that way — in
 * jumps. Here each cursor has a target, and the shown position chases it every
 * frame: the cursor flows instead of teleporting.
 */
export const POINTER_TAU = 45
export class PointerGlide {
  private shown = new Map<string, { x: number; y: number }>()
  private goal = new Map<string, { x: number; y: number }>()
  private frame = 0
  private frameAt = 0

  constructor(
    private paint: () => void,
    private raf: (cb: (now: number) => void) => number = (cb) => requestAnimationFrame(cb),
  ) {}

  /** New cursor position. Returns the position to show now. */
  set(id: string, x: number, y: number) {
    this.goal.set(id, { x, y })
    let shown = this.shown.get(id)
    // First time, or a huge jump (switched tabs and came back): place it at once.
    if (!shown || Math.hypot(shown.x - x, shown.y - y) > 4000) {
      shown = { x, y }
      this.shown.set(id, shown)
    } else if (!this.frame) {
      this.frameAt = 0
      this.frame = this.raf(this.tick)
    }
    return shown
  }

  at(id: string) {
    return this.shown.get(id)
  }

  drop(id: string) {
    this.shown.delete(id)
    this.goal.delete(id)
  }

  private tick = (at: number) => {
    this.frame = 0
    const dt = this.frameAt ? Math.min(50, at - this.frameAt) : 1000 / 60
    this.frameAt = at
    const k = 1 - Math.exp(-dt / POINTER_TAU)
    let moving = false
    for (const [id, goal] of this.goal) {
      const shown = this.shown.get(id)
      if (!shown) continue
      const dx = goal.x - shown.x
      const dy = goal.y - shown.y
      if (Math.abs(dx) < 0.25 && Math.abs(dy) < 0.25) {
        if (dx || dy) this.shown.set(id, { x: goal.x, y: goal.y })
        continue
      }
      this.shown.set(id, { x: shown.x + dx * k, y: shown.y + dy * k })
      moving = true
    }
    this.paint()
    if (moving) this.frame = this.raf(this.tick)
  }
}

// ── setup ───────────────────────────────────────────────────────────────────

function readChoice() {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

let installed: CameraMotion | null = null
let chosen = true
let reduced = false

/**
 * Install the camera before Excalidraw creates the editor. Smoothing is a
 * per-user setting: turning it off in the menu sticks, and the OS
 * "reduce motion" setting turns it off without asking.
 */
export function installMotion() {
  if (installed) return installed
  installed = new CameraMotion()
  chosen = readChoice()
  const media = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  reduced = Boolean(media?.matches)
  media?.addEventListener?.('change', (e) => {
    reduced = e.matches
    apply()
  })
  ;(globalThis as unknown as { __tbMotion?: CameraMotion }).__tbMotion = installed
  // Pressing the board stops any motion under the pointer; otherwise a shape would slide out from under the mouse.
  window.addEventListener('pointerdown', () => installed?.moving && installed.stop(), { capture: true, passive: true })
  apply()
  return installed
}

function apply() {
  if (!installed) return
  const on = chosen && !reduced
  if (!on) installed.stop()
  installed.off = !on
  document.documentElement.classList.toggle('board-motion', on)
}

export const motion = () => installed
/** Smoothing is on for this user right now. */
export const motionOn = () => Boolean(installed && !installed.off)
export const motionChosen = () => chosen
export function setMotionChosen(on: boolean) {
  chosen = on
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
  } catch {
    // Storage unavailable: the choice lasts until the tab closes.
  }
  apply()
}
