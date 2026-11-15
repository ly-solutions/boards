/**
 * An agent's edit, seen as it happens (HRN-1480).
 *
 * An agent's edit lands as one batch of elements. Applied at once it is a jump: the board is suddenly different and
 * nobody saw what moved. Here the batch is played out instead:
 *   · new objects appear one by one, each with a short glow, and a cursor named «Агент» goes from one to the next;
 *   · what the agent changed is outlined for a few seconds;
 *   · everything one agent did in a row (a turn: its edits less than two minutes apart) is one undo point —
 *     the bar «Агент изменил 6 объектов · Показать · Отменить» puts the board back as it was before the turn;
 *   · while the agent works (it looked at the board, it was asked in the chat) the islands say «Агент рисует…»;
 *     the canvas stays free.
 * The scene data is the server's: playing it out only delays when the browser shows elements it already has, and
 * nothing of that is sent back. Undo is an ordinary edit of the person who pressed it.
 */
import { useEffect, useState, useSyncExternalStore } from 'react'
import { CaptureUpdateAction, reconcileElements } from '@excalidraw/excalidraw'
import { CameraLayer } from './camera'
import { glow } from './islands/overlays'
import { Icon } from './islands/icons'
import { t } from './i18n'

type El = { id: string; version: number; versionNonce: number; isDeleted?: boolean; type: string; x?: number; y?: number; width?: number; height?: number; containerId?: string | null; points?: readonly (readonly number[])[]; index?: string | null; [key: string]: unknown }
type Api = {
  getSceneElementsIncludingDeleted(): readonly unknown[]
  getAppState(): Record<string, unknown>
  updateScene(scene: { elements?: readonly unknown[]; captureUpdate?: unknown }): void
  scrollToContent(target: readonly unknown[], opts?: { fitToContent?: boolean; animate?: boolean }): void
}

/** Edits of one agent closer than this are one turn: one bar, one undo. */
const TURN_GAP_MS = 120_000
/** Playing out a batch takes about this long, whatever its size: a step of 70–180 ms per object. */
const PLAY_MS = 1600
const STEP_MIN = 70
const STEP_MAX = 180
/** Above this many objects a batch is shown at once: a big diagram one by one would take too long. */
const PLAY_MAX = 40
/** The cursor stays this long after the last object appeared. */
const CURSOR_MS = 2600
/** Asked in the chat, the agent counts as at work until its edit or this long. */
const ASKED_MS = 120_000

export type Turn = { by: string; count: number; at: number }
type Snapshot = { turn: Turn | null; cursor: { x: number; y: number; name: string } | null; working: boolean; playing: boolean }

const rand = () => Math.floor(Math.random() * 2 ** 31)
function boxOf(el: El) {
  if (el.points?.length) {
    const xs = el.points.map((p) => (el.x ?? 0) + p[0])
    const ys = el.points.map((p) => (el.y ?? 0) + p[1])
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  }
  const x = el.x ?? 0
  const y = el.y ?? 0
  return { x1: Math.min(x, x + (el.width ?? 0)), y1: Math.min(y, y + (el.height ?? 0)), x2: Math.max(x, x + (el.width ?? 0)), y2: Math.max(y, y + (el.height ?? 0)) }
}

/** New objects as the order they appear in: frames, then shapes with their labels by rows, then free text, then arrows. */
function unitsOf(fresh: El[]): El[][] {
  const labels = new Map<string, El[]>()
  for (const el of fresh) if (el.containerId) labels.set(el.containerId, [...(labels.get(el.containerId) ?? []), el])
  const rank = (el: El) => (el.type === 'frame' || el.type === 'magicframe' ? 0 : el.type === 'arrow' || el.type === 'line' ? 3 : el.type === 'text' ? 2 : 1)
  const heads = fresh.filter((el) => !el.containerId || !fresh.some((x) => x.id === el.containerId))
  heads.sort((a, b) => rank(a) - rank(b) || Math.round(((a.y ?? 0) - (b.y ?? 0)) / 40) || (a.x ?? 0) - (b.x ?? 0))
  return heads.map((el) => [el, ...(labels.get(el.id) ?? [])])
}

export class AgentLive {
  private turnState: { by: string; at: number; before: Map<string, El | null>; ids: Set<string>; closed: boolean } | null = null
  private queue: El[][] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private cursorTimer: ReturnType<typeof setTimeout> | null = null
  private api: Api | null = null
  private onShown: ((els: El[]) => void) | null = null
  private names: string[] = []
  private askedAt = 0
  private snap: Snapshot = { turn: null, cursor: null, working: false, playing: false }
  private listeners = new Set<() => void>()

  subscribe = (fn: () => void) => {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
  get = () => this.snap
  private set(patch: Partial<Snapshot>) {
    this.snap = { ...this.snap, ...patch }
    for (const fn of this.listeners) fn()
  }
  private refreshWorking() {
    const working = this.names.length > 0 || Date.now() - this.askedAt < ASKED_MS
    if (working !== this.snap.working) this.set({ working })
  }

  /** Agents at work, from the board's presence (rows of kind "agent"). */
  setAgents(names: string[]) {
    this.names = names
    this.refreshWorking()
  }
  /** The person asked the agent in the chat: it is at work from now on. */
  asked() {
    this.askedAt = Date.now()
    this.refreshWorking()
    setTimeout(() => this.refreshWorking(), ASKED_MS + 50)
  }

  /** Shows whatever is still waiting to appear at once: another change must not land on a half-played scene. */
  flush() {
    if (!this.queue.length || !this.api) return
    const rest = this.queue.flat()
    this.queue = []
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.put(rest)
    this.set({ playing: false })
  }

  /**
   * An agent's batch arrives. Remembers what it replaces (for undo) and returns what to apply now; the new objects
   * beyond the first are played out afterwards. `onShown` marks elements as the server's once they are in the scene.
   */
  incoming(api: Api, by: string, incoming: El[], onShown: (els: El[]) => void): El[] {
    this.flush()
    this.api = api
    this.onShown = onShown
    this.askedAt = 0
    const current = new Map((api.getSceneElementsIncludingDeleted() as El[]).map((el) => [el.id, el]))
    const now = Date.now()
    let turn = this.turnState
    if (!turn || turn.closed || turn.by !== by || now - turn.at > TURN_GAP_MS) turn = { by, at: now, before: new Map(), ids: new Set(), closed: false }
    turn.at = now
    for (const el of incoming) {
      if (!turn.before.has(el.id)) turn.before.set(el.id, current.get(el.id) ?? null)
      turn.ids.add(el.id)
    }
    this.turnState = turn
    const fresh = incoming.filter((el) => !el.isDeleted && !current.has(el.id))
    // What the agent drew is out of view: the camera goes there first, then the objects appear.
    const seen = fresh.length ? fresh : incoming.filter((el) => !el.isDeleted && !el.containerId)
    const away = seen.length > 0 && !inView(api, seen)
    if (away) api.scrollToContent(seen, { fitToContent: seen.length > 1, animate: true })
    const units = unitsOf(fresh)
    if (units.length < 2 || units.length > PLAY_MAX || !motionAllowed()) {
      this.showTurn()
      this.pointAt(fresh.length ? fresh : incoming.filter((el) => !el.isDeleted))
      return incoming
    }
    const later = new Set(units.slice(1).flat().map((el) => el.id))
    this.queue = units.slice(1)
    const step = Math.max(STEP_MIN, Math.min(STEP_MAX, PLAY_MS / units.length))
    const tick = () => {
      const unit = this.queue.shift()
      if (!unit) {
        this.timer = null
        this.set({ playing: false })
        this.showTurn()
        return
      }
      this.put(unit)
      this.timer = setTimeout(tick, step)
    }
    this.set({ playing: true })
    this.pointAt(units[0])
    glow(units[0] as never)
    this.timer = setTimeout(tick, away ? step + 420 : step)
    return incoming.filter((el) => !later.has(el.id))
  }

  private put(els: El[]) {
    const api = this.api
    if (!api || !els.length) return
    const merged = reconcileElements(api.getSceneElementsIncludingDeleted() as never, els as never, api.getAppState() as never)
    api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER })
    this.onShown?.(els)
    glow(els as never)
    this.pointAt(els)
  }

  private pointAt(els: El[]) {
    const shapes = els.filter((el) => !el.containerId)
    if (!shapes.length || !this.turnState) return
    const b = boxOf(shapes[shapes.length - 1])
    this.set({ cursor: { x: b.x2 - 6, y: b.y2 - 6, name: this.turnState.by } })
    if (this.cursorTimer) clearTimeout(this.cursorTimer)
    this.cursorTimer = setTimeout(() => this.set({ cursor: null }), CURSOR_MS)
  }

  private visible(ids: Iterable<string>) {
    const byId = new Map((this.api?.getSceneElementsIncludingDeleted() as El[] | undefined)?.map((el) => [el.id, el]) ?? [])
    return [...ids].map((id) => byId.get(id)).filter((el): el is El => Boolean(el && !el.isDeleted && !el.containerId))
  }

  private showTurn() {
    const turn = this.turnState
    if (!turn) return
    // Objects, not elements: a shape and its label are one; something deleted counts too.
    const count = [...turn.before.entries()].filter(([id, was]) => {
      const now = this.visible([id])[0]
      return now ? true : Boolean(was && !was.isDeleted && !was.containerId)
    }).length
    this.set({ turn: count ? { by: turn.by, count, at: turn.at } : null })
  }

  /** Brings the view to what the turn changed and outlines it again. */
  show() {
    const turn = this.turnState
    const api = this.api
    if (!turn || !api) return
    const els = this.visible(turn.ids)
    if (!els.length) return
    api.scrollToContent(els, { fitToContent: els.length > 1, animate: true })
    glow(els as never)
  }

  /** Puts back what the turn changed, as one edit of the person; the bar goes away. */
  undo() {
    const turn = this.turnState
    const api = this.api
    if (!turn || !api) return
    this.flush()
    const now = Date.now()
    const replaced = new Map<string, El>()
    const all = api.getSceneElementsIncludingDeleted() as El[]
    const byId = new Map(all.map((el) => [el.id, el]))
    for (const [id, was] of turn.before) {
      const cur = byId.get(id)
      if (!cur) continue
      const back = was ? { ...was } : { ...cur, isDeleted: true }
      replaced.set(id, { ...back, version: cur.version + 1, versionNonce: rand(), updated: now })
    }
    api.updateScene({ elements: all.map((el) => replaced.get(el.id) ?? el), captureUpdate: CaptureUpdateAction.IMMEDIATELY })
    turn.closed = true
    this.set({ turn: null, cursor: null })
  }

  dismiss() {
    if (this.turnState) this.turnState.closed = true
    this.set({ turn: null })
  }
}

/** Whether these elements are all within the visible part of the board. */
function inView(api: Api, els: El[]) {
  const st = api.getAppState() as { scrollX: number; scrollY: number; width: number; height: number; zoom: { value: number } }
  const z = st.zoom?.value || 1
  const x1 = -st.scrollX
  const y1 = -st.scrollY
  const x2 = x1 + st.width / z
  const y2 = y1 + st.height / z
  return els.every((el) => {
    const b = boxOf(el)
    return b.x1 >= x1 && b.y1 >= y1 && b.x2 <= x2 && b.y2 <= y2
  })
}

function motionAllowed() {
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** The agent's cursor with its name, where it last drew. */
export function AgentCursor({ live }: { live: AgentLive }) {
  const { cursor } = useSyncExternalStore(live.subscribe, live.get)
  if (!cursor) return null
  return (
    <CameraLayer className="agent-cursors">
      <div className="agent-cursor" style={{ left: cursor.x, top: cursor.y }}>
        <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
          <path d="M4 2.5l15.5 8.2-6.6 1.9-3.3 6.4z" />
        </svg>
        <span>{t('islands.agentCursor')}</span>
      </div>
    </CameraLayer>
  )
}

/** «Агент изменил 6 объектов · Показать · Отменить» after the agent's turn. */
export function AgentBar({ live, canEdit }: { live: AgentLive; canEdit: boolean }) {
  const { turn, playing } = useSyncExternalStore(live.subscribe, live.get)
  const [closing, setClosing] = useState(false)
  const [shown, setShown] = useState<Turn | null>(null)
  useEffect(() => {
    if (turn && !playing) {
      setShown(turn)
      setClosing(false)
      const hide = setTimeout(() => setClosing(true), 14_000)
      return () => clearTimeout(hide)
    }
    if (!turn) setClosing(true)
  }, [turn, playing])
  useEffect(() => {
    if (!closing) return
    const gone = setTimeout(() => {
      setShown(null)
      live.dismiss()
    }, 180)
    return () => clearTimeout(gone)
  }, [closing, live])
  if (!shown) return null
  return (
    <div className={`agent-bar${closing ? ' is-out' : ''}`} role="status">
      <span className="agent-bar__orb" aria-hidden="true" />
      <span className="agent-bar__text">{t('islands.agentChanged', { count: shown.count })}</span>
      <button type="button" className="agent-bar__btn" onClick={() => live.show()}>
        {t('islands.agentShow')}
      </button>
      {canEdit && (
        <button type="button" className="agent-bar__btn" onClick={() => live.undo()}>
          {t('islands.agentUndo')}
        </button>
      )}
      <button type="button" className="agent-bar__x" aria-label={t('islands.close')} onClick={() => setClosing(true)}>
        <Icon name="x" size={14} />
      </button>
    </div>
  )
}

/** «Агент рисует…» for the islands. */
export function useAgentWorking(live: AgentLive) {
  const { working, playing } = useSyncExternalStore(live.subscribe, live.get)
  return working || playing
}
