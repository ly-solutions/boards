import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  CaptureUpdateAction,
  Excalidraw,
  convertToExcalidrawElements,
  FONT_FAMILY,
  MainMenu,
  WelcomeScreen,
  exportToSvg,
  getNonDeletedElements,
  getSceneVersion,
  getVisibleSceneBounds,
  newElementWith,
  reconcileElements,
  restoreElements,
  zoomToFitBounds,
} from '@excalidraw/excalidraw'
import '@excalidraw/excalidraw/index.css'
import './editor.css'
import './motion.css'
import { LiveChannel, type LiveMessage } from './live'
import { BAR_ICONS, BarButton, BarMenu, CheckpointsIcon, Dock, PalettePanel, PropertiesDialog, STUDIO_APP_STATE, SlopBadge, StickyOverlay, TemplatesPanel, ToolbarTools, addSticky, loadLibrary, setStudioTool, useBarMode, useToolbarSlot, type BoardMeta, type StudioApi, type StudioTool } from './studio'
import { STICKY_COLORS } from '../../shared/palette.mjs'
import { Comments, CommentsButton, draftAt, type Change, type Draft, type Thread } from './comments'
import { CheckpointView, Checkpoints, type Checkpoint } from './checkpoints'
import { TimerTool, type TimerAction, type TimerState } from './timer'
import { LinkLayer, addCard, addRefCard, hostOf, linkToBlock } from './links'
import { BoardMenu, type MenuState, type PluginMenuItem } from './menu'
import { classify as classifyUrl, singleUrl } from '../../shared/links.mjs'
import { createPortal } from 'react-dom'
import { bumpScene, setView } from './camera'
import { PointerGlide, installMotion, motion, motionChosen, motionOn, setMotionChosen } from './motion'
import { PulseLayer, pulse } from './motion-fx'
import { excalidrawLang, t } from './i18n'
import { fitsSelection, loadWebPlugins, matchReference, pluginApi, toolbarButtons, usePluginRegistry, webActions, type EditorBridge, type PluginConfig, type SceneElement } from './plugins'
import { fitScene, shouldFitOnLoad } from './fit'

type Element = { id: string; version: number; versionNonce: number; isDeleted?: boolean; type: string; x?: number; y?: number; width?: number; height?: number; containerId?: string | null; customData?: Record<string, unknown>; fontSize?: number; fontFamily?: number; text?: string }
type FileData = { id: string; mimeType: string; dataURL: string; created: number }
type Viewer = { id: string; name: string | null; kind: string; live?: boolean; state?: 'active' | 'idle' | 'away' }
type Edit = { rev: number; by: string; count: number; note: string | null }
/** The poll response, the live channel's hello reply and its edit broadcasts share one shape. */
type Remote = {
  epoch?: string
  rev?: number
  full?: boolean
  elements?: Element[]
  files?: FileData[]
  /** Shared timer and the server clock at response time. */
  timer?: TimerState
  now?: number
  viewers?: Viewer[]
  edits?: Edit[]
  title?: string
  access?: 'team' | 'link'
  notes?: Notes
}
/** Reactions and comments — a layer above the scene, always sent whole. */
type Notes = { reactions: Record<string, Record<string, string[]>>; comments: Thread[] }
type Scene = { elements: Element[]; appState: Record<string, unknown>; files?: Record<string, FileData>; rev: number; epoch: string; notes?: Notes }
type Peer = {
  username: string
  color: { background: string; stroke: string }
  userState: 'active' | 'idle' | 'away'
  pointer?: { x: number; y: number; tool: 'pointer' | 'laser' }
  button?: 'up' | 'down'
  selectedElementIds?: Record<string, true>
}
type Api = {
  getSceneElementsIncludingDeleted(): readonly Element[]
  getSceneElements(): readonly Element[]
  getAppState(): Record<string, unknown>
  getFiles(): Record<string, FileData>
  onScrollChange(callback: () => void): () => void
  onUserFollow(callback: (payload: { userToFollow: { socketId: string }; action: 'FOLLOW' | 'UNFOLLOW' }) => void): () => void
  updateScene(scene: { elements?: readonly Element[]; captureUpdate?: unknown; appState?: Record<string, unknown>; collaborators?: Map<string, unknown> }): void
  addFiles(files: FileData[]): void
  setToast(toast: { message: string; closable?: boolean; duration?: number } | null): void
  scrollToContent(target?: readonly Element[], opts?: { fitToContent?: boolean; animate?: boolean }): void
}

const config = JSON.parse(document.getElementById('board-config')?.textContent ?? '{}') as {
  slug: string
  key: string
  title: string
  author: string | null
  access: 'team' | 'link'
  user: { name: string; email: string | null } | null
  canEdit: boolean
  canManage: boolean
  /** Sign-in is available. */
  authEnabled: boolean
  loginUrl?: string
  logoutUrl?: string
  /** The boards list page. */
  homeUrl?: string
  hasPreview: boolean
  previewStale: boolean
  agentUrl: string
  staticBase: string
  /** Live mode: cursors and instant edits over WebSocket. */
  live: boolean
  /** Stickies, palette, templates, slop check, properties. */
  studio?: boolean
  /** Smart guides while dragging. */
  snap?: boolean
  /** Working board: checkpoints, timer, right-click menu, link cards. */
  workboard?: boolean
  /** Smooth camera and motion in the UI. */
  motion?: boolean
  /** The board opened "as it was" at a checkpoint: read-only. */
  at?: { id: string; title: string; by: string | null; at: string } | null
  canCopy?: boolean
  description?: string
  tags?: string[]
  task?: string | null
  reactions?: string[]
  /** Full board URL. */
  boardUrl?: string
  /** Board properties added by plugins (e.g. a deadline). */
  fields?: Record<string, unknown>
  /** The signed-in person's feature flags (server/flags.mjs). */
  flags?: Record<string, boolean | string>
  /** What plugins add: web modules, block actions, board properties, reference patterns. */
  plugins?: PluginConfig
}

// The camera is installed before the editor: Excalidraw looks it up on creation.
if (config.motion) installMotion()

const base = `/b/${config.slug}`
const q = `?k=${encodeURIComponent(config.key)}`
const clientId = Math.random().toString(36).slice(2, 12)
const here = () => `${location.pathname}${location.search}`
const loginUrl = () => `${config.loginUrl ?? '/b/auth/login'}?next=${encodeURIComponent(here())}`
const logoutUrl = () => `${config.logoutUrl ?? '/b/auth/logout'}?next=${encodeURIComponent(here())}`
const homeUrl = config.homeUrl ?? '/b/'
/** Origin of this boards server: links to `/b/<slug>` on it become board cards. */
const boardOrigin = (() => {
  try {
    return new URL(config.boardUrl ?? location.href, location.href).origin
  } catch {
    return location.origin
  }
})()

/** How often to exchange edits. More often is load for nothing; less often makes others' edits lag. */
const SYNC_MS = 1500
/** Live channel: edits are batched for 40 ms — a frame or two, not a hundred messages per stroke. */
const PUSH_MS = 40
const POINTER_MS = 33
const VIEWPORT_MS = 80
/** Glide to the leader's view in follow mode: slightly longer than the gap between two of their messages. */
const FOLLOW_GLIDE_MS = 200
/** How long other people's cursors linger after the live channel drops before they fade. */
const PEERS_GRACE_MS = 6_000
/** A minute without mouse movement — the participant is idle, and the avatar shows it. */
const IDLE_MS = 60_000
/**
 * The preview for the boards list is an SVG export of the whole scene. On a big
 * board that is a second of main-thread work that cannot move to a worker: the
 * canvas freezes meanwhile. So the preview is drawn when nobody is looking: the
 * tab went to the background, or the board is left alone — no edits, no mouse
 * movement. If we miss the chance, the server remembers the preview is stale
 * and the next person to open the board draws it.
 */
const PREVIEW_QUIET_MS = 15_000
const PREVIEW_STILL_MS = 4_000
const PREVIEW_CHECK_MS = 2_000
const GUEST_KEY = 'boards-guest'
const SNAP_KEY = 'boards-snap'

const FONT_NAMES: Record<number, string> = Object.fromEntries(Object.entries(FONT_FAMILY).map(([name, id]) => [id as number, name]))

/** Participant colour by name: one person, one colour on every board. */
const PALETTE = ['#6965db', '#e8590c', '#2f9e44', '#1971c2', '#c2255c', '#0c8599', '#f08c00', '#862e9c']
function colorFor(name: string) {
  let h = 0
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  const background = PALETTE[h % PALETTE.length]
  return { background, stroke: background }
}

function readGuest() {
  try {
    return localStorage.getItem(GUEST_KEY) ?? ''
  } catch {
    return ''
  }
}

/**
 * Snap to objects is on by default: in Excalidraw it hides behind Alt+S and is
 * off. Whoever turns it off keeps it off: the choice is personal and lives in
 * the browser, not in the scene.
 */
function readSnap() {
  try {
    return localStorage.getItem(SNAP_KEY) !== '0'
  } catch {
    return true
  }
}
function writeSnap(on: boolean) {
  try {
    localStorage.setItem(SNAP_KEY, on ? '1' : '0')
  } catch {
    // Storage is blocked — snapping simply turns back on next time.
  }
}

type Status = 'loading' | 'saved' | 'saving' | 'offline' | 'readonly' | 'live'

const STATUS_TEXT: Record<Status, string> = {
  loading: t('editor.statusLoading'),
  saved: t('editor.statusSaved'),
  saving: t('editor.statusSaving'),
  offline: t('editor.statusOffline'),
  readonly: t('editor.statusReadonly'),
  live: t('editor.statusLive'),
}
/** Constant editor props — one reference, otherwise Excalidraw's memo does not kick in. */
const UI_OPTIONS = { canvasActions: { loadScene: false, saveToActiveFile: false, export: { saveFileToDisk: true } } }
const REACTIONS = config.reactions ?? ['👍', '👎', '❤️']
/** Icon of a plugin toolbar button that brings none: a puzzle piece. */
const PLUGIN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 4a2 2 0 1 1 4 0v2h4a1 1 0 0 1 1 1v4h-2a2 2 0 1 0 0 4h2v4a1 1 0 0 1-1 1h-4v-2a2 2 0 1 0-4 0v2H6a1 1 0 0 1-1-1v-4h2a2 2 0 1 0 0-4H5V7a1 1 0 0 1 1-1h4z"/></svg>'

/**
 * Text drawn by an agent is measured approximately on the server — it has no
 * real font. The browser does: wait for the font, re-measure, and the fixed
 * elements go back to the server through regular sync.
 */
async function remeasure(api: Api) {
  const all = api.getSceneElementsIncludingDeleted()
  const flagged = all.filter((el) => el.type === 'text' && el.customData?.remeasure && !el.isDeleted)
  if (!flagged.length) return
  await Promise.all(
    flagged.map((el) => document.fonts.load(`${el.fontSize ?? 20}px "${FONT_NAMES[el.fontFamily ?? 5] ?? 'Excalifont'}"`, el.text ?? '').catch(() => null)),
  )
  const current = api.getSceneElementsIncludingDeleted()
  const restored = restoreElements(current as never, null, { refreshDimensions: true, repairBindings: true }) as unknown as Element[]
  const byId = new Map(restored.map((el) => [el.id, el]))
  const next = current.map((el) => {
    if (!(el.type === 'text' && el.customData?.remeasure)) return el
    const fixed = byId.get(el.id) ?? el
    const { remeasure: _drop, ...customData } = fixed.customData ?? {}
    return newElementWith(fixed as never, { customData } as never) as unknown as Element
  })
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.NEVER })
}

function Brand() {
  return (
    <a className="board-brand" href={homeUrl} title={t('editor.allBoards')}>
      <img src={`${config.staticBase}/logo-mark.svg`} alt="" />
      <span className="board-brand__name">boards</span>
    </a>
  )
}

function ShareDialog({ access, onAccess, onClose }: { access: 'team' | 'link'; onAccess: (a: 'team' | 'link') => void; onClose: () => void }) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(config.agentUrl)
      setCopied(true)
    } catch {
      window.prompt(t('editor.copyTheLink'), config.agentUrl)
    }
  }
  return (
    <div className="board-dialog__backdrop" onClick={onClose}>
      <div className="board-dialog" role="dialog" aria-label={t('editor.shareBoard')} onClick={(e) => e.stopPropagation()}>
        <div className="board-dialog__head">
          <img src={`${config.staticBase}/logo-mark.svg`} alt="" />
          <h2>{t('editor.shareBoard')}</h2>
          <button type="button" className="board-dialog__close" onClick={onClose} aria-label={t('editor.close')}>×</button>
        </div>
        <p className="board-dialog__hint">
          {t('editor.shareHint')}
        </p>
        <div className="board-dialog__link">
          <input readOnly value={config.agentUrl} onFocus={(e) => e.currentTarget.select()} />
          <button type="button" className="board-button" onClick={copy}>{copied ? t('editor.copied') : t('editor.copy')}</button>
        </div>
        <fieldset className="board-dialog__access" disabled={!config.canManage}>
          <legend>{t('editor.whoCanEdit')}</legend>
          <label>
            <input type="radio" name="access" checked={access === 'team'} onChange={() => onAccess('team')} />
            <span><strong>{t('editor.teamOnly')}</strong>{t('editor.teamOnlyHint')}</span>
          </label>
          <label>
            <input type="radio" name="access" checked={access === 'link'} onChange={() => onAccess('link')} />
            <span><strong>{t('editor.anyoneWithLink')}</strong>{t('editor.anyoneWithLinkHint')}</span>
          </label>
          {!config.canManage && <p className="board-dialog__hint">{t('editor.onlyTeamChangesAccess')}</p>}
        </fieldset>
        <div className="board-dialog__foot">
          <a href={`${base}.md${q}`} target="_blank" rel="noopener">{t('editor.howAgentsSee')}</a>
          {config.author && <span>{t('editor.author', { name: config.author })}</span>}
        </div>
      </div>
    </div>
  )
}

/** Magnet: filled when snapping is on, outlined and struck through when off. */
function SnapIcon({ on }: { on: boolean }) {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M6 4v8a6 6 0 0 0 12 0V4h-4v8a2 2 0 0 1-4 0V4z M6 8h4 M14 8h4" fill={on ? 'currentColor' : 'none'} fillOpacity={on ? 0.18 : 0} />
      {!on && <path d="M4 20 20 4" />}
    </svg>
  )
}

function Board() {
  const [initial, setInitial] = useState<{ elements: Element[]; appState: Record<string, unknown>; files: Record<string, FileData> } | null>(null)
  /**
   * What to show in the corner. "Saving…" appears only if saving takes longer
   * than a second: the live channel acks an edit in tens of milliseconds, and
   * while dragging the status used to change every frame — the label flickered
   * and pushed its neighbours. The status itself lives in a ref: every send and
   * every ack (each 40 ms while dragging) used to re-render the whole page; only
   * what is visible goes into state.
   */
  const [shownStatus, setShownStatus] = useState<Status>(config.canEdit ? 'loading' : 'readonly')
  const statusRef = useRef<{ value: Status; timer: ReturnType<typeof setTimeout> | undefined }>({ value: shownStatus, timer: undefined })
  const setStatus = useCallback((value: Status) => {
    const st = statusRef.current
    if (st.value === value) return
    st.value = value
    clearTimeout(st.timer)
    if (value === 'saving') st.timer = setTimeout(() => setShownStatus('saving'), 1000)
    else setShownStatus(value)
  }, [])
  const status = shownStatus
  const [notes, setNotes] = useState<Notes>({ reactions: {}, comments: [] })
  const [commentDraft, setCommentDraft] = useState<Draft | null>(null)
  const [commentsPanel, setCommentsPanelRaw] = useState(false)
  const [commentsHidden, setCommentsHidden] = useState(false)
  const [title, setTitle] = useState(config.title)
  const [access, setAccess] = useState<'team' | 'link'>(config.access)
  const [guest, setGuest] = useState(readGuest)
  const [guestDraft, setGuestDraft] = useState('')
  const [sharing, setSharing] = useState(false)
  const [panel, setPanel] = useState<string | null>(null)
  const [checkpoints, setCheckpoints] = useState<Checkpoint[] | null>(null)
  // The timer comes with every poll; update state only when it actually changed.
  const [timer, setTimerState] = useState<{ value: TimerState; offset: number }>({ value: null, offset: 0 })
  const setTimer = useCallback((value: TimerState, serverNow?: number) => {
    setTimerState((prev) => {
      const offset = typeof serverNow === 'number' ? serverNow - Date.now() : prev.offset
      if (JSON.stringify(prev.value) === JSON.stringify(value) && Math.abs(prev.offset - offset) < 500) return prev
      return { value, offset }
    })
  }, [])
  // The comments and checkpoints panels share one spot on the right — opening one closes the other.
  const setCommentsPanel = useCallback((on: boolean) => {
    setCommentsPanelRaw(on)
    if (on) setPanel((p) => (p === 'checkpoints' ? null : p))
  }, [])
  const openPanel = useCallback((p: string | null) => {
    setPanel(p)
    if (p === 'checkpoints') setCommentsPanelRaw(false)
  }, [])
  const [properties, setProperties] = useState(false)
  const [stickyColor, setStickyColor] = useState(STICKY_COLORS[0].fill)
  const [meta, setMeta] = useState<BoardMeta>({ title: config.title, description: config.description ?? '', tags: config.tags ?? [], task: config.task ?? null, fields: config.fields ?? {} })
  /** The studio tool lives in state: toolbar buttons highlight from it. */
  const [tool, setTool] = useState<StudioTool>(null)
  // A checkpoint snapshot is read-only for everyone, even those who can edit the board.
  const canEdit = !config.at && (Boolean(config.user) || access === 'link')
  const apiRef = useRef<Api | null>(null)
  /** The same API, but in state: studio panels must appear as soon as the editor is ready. */
  const [studioApi, setStudioApi] = useState<StudioApi | null>(null)
  const sync = useRef({ rev: 0, epoch: '', sent: new Map<string, number>(), sentFiles: new Set<string>(), inFlight: false, previewDue: false, previewBusy: false, editedAt: 0 })
  const live = useRef({ canEdit, guest })
  live.current = { canEdit, guest }

  useEffect(() => {
    document.title = `${title} · boards`
  }, [title])

  useEffect(() => {
    let cancelled = false
    // boot.ts has usually started fetching the scene while the editor was loading.
    const early = (window as unknown as { __boardScene?: Promise<Scene> }).__boardScene
    // A checkpoint opens its own snapshot, not the current scene.
    ;(early ?? fetch(config.at ? `${base}/checkpoints/${config.at.id}/scene${q}` : `${base}/scene.excalidraw${q}`).then((r) => {
      if (!r.ok) throw new Error(String(r.status))
      return r.json() as Promise<Scene>
    }))
      .then((scene) => {
        if (cancelled) return
        const s = sync.current
        s.rev = scene.rev
        s.epoch = scene.epoch
        if (scene.notes) setNotes(scene.notes)
        for (const el of scene.elements) s.sent.set(el.id, el.version)
        for (const id of Object.keys(scene.files ?? {})) s.sentFiles.add(id)
        const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches
        setInitial({ elements: scene.elements, appState: { ...(config.studio ? STUDIO_APP_STATE : {}), ...scene.appState, ...(config.snap ? { objectsSnapModeEnabled: readSnap() } : {}), theme: dark ? 'dark' : 'light' }, files: scene.files ?? {} })
        setStatus(config.canEdit ? 'saved' : 'readonly')
        document.body.classList.add('ready')
      })
      .catch(() => setStatus('offline'))
    return () => {
      cancelled = true
    }
  }, [])

  const guestParam = () => (live.current.guest ? `&guest=${encodeURIComponent(live.current.guest)}` : '')

  const uploadPreview = useCallback(async () => {
    const api = apiRef.current
    if (!api || !live.current.canEdit) return
    const elements = getNonDeletedElements(api.getSceneElements() as never)
    if (!elements.length) return
    const appState = { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false, exportEmbedScene: false }
    const make = (skipInliningFonts: boolean) =>
      exportToSvg({ elements, appState: appState as never, files: api.getFiles() as never, exportPadding: 24, skipInliningFonts } as never)
    try {
      let svg = (await make(false)).outerHTML
      // Inlined fonts with Cyrillic and CJK glyphs can bloat the file: then go without them.
      if (svg.length > 2_500_000) svg = (await make(true)).outerHTML
      await fetch(`${base}/preview${q}${guestParam()}`, { method: 'POST', headers: { 'content-type': 'image/svg+xml' }, body: svg })
    } catch {
      // The preview only decorates the list; if it fails now, the next edit will retry.
    }
  }, [])

  const schedulePreview = useCallback(() => {
    const s = sync.current
    s.previewDue = true
    s.editedAt = Date.now()
  }, [])

  /**
   * Who is on the board, as native Excalidraw collaborators: avatars in the
   * corner, named cursors, others' selection in their colour. Cursors arrive
   * dozens of times a second, so the scene repaints at most once per frame.
   */
  const peers = useRef(new Map<string, Peer>())
  const selfId = useRef(clientId)
  const peersFrame = useRef(0)
  const paintPeers = useCallback(() => {
    const api = apiRef.current
    if (!api) return
    const collaborators = new Map<string, unknown>()
    for (const [id, peer] of peers.current) collaborators.set(id, { ...peer, id, socketId: id, isCurrentUser: id === selfId.current })
    api.updateScene({ collaborators, captureUpdate: CaptureUpdateAction.NEVER })
  }, [])
  const renderPeers = useCallback(() => {
    if (peersFrame.current) return
    peersFrame.current = requestAnimationFrame(() => {
      peersFrame.current = 0
      paintPeers()
    })
  }, [paintPeers])
  /**
   * A remote cursor arrives every 33 ms and used to be drawn that way — in jumps.
   * With motion on it eases towards the reported position every frame.
   */
  const pointerGlide = useRef<PointerGlide | null>(null)
  const glidePointer = useCallback(
    (id: string, x: number, y: number) => {
      if (!motionOn()) return { x, y }
      pointerGlide.current ??= new PointerGlide(() => {
        for (const [peerId, peer] of peers.current) {
          const at = pointerGlide.current?.at(peerId)
          if (at && peer.pointer && (peer.pointer.x !== at.x || peer.pointer.y !== at.y)) peers.current.set(peerId, { ...peer, pointer: { ...peer.pointer, x: at.x, y: at.y } })
        }
        paintPeers()
      })
      return pointerGlide.current.set(id, x, y)
    },
    [paintPeers],
  )

  const setPresence = useCallback(
    (viewers: Viewer[]) => {
      const next = new Map<string, Peer>()
      for (const v of viewers) {
        // No name — someone viewing without signing in. A guest is "guest: Kate"
        // in edit captions, but on the cursor and avatar the name goes first:
        // Excalidraw draws the avatar from the first letter.
        const username = v.name === null ? t('editor.anonymousViewer') : v.name.startsWith('guest: ') ? t('editor.guestName', { name: v.name.slice(7) }) : v.name
        next.set(v.id, { ...peers.current.get(v.id), username, color: colorFor(v.name ?? v.id), userState: v.state ?? 'active' })
      }
      for (const id of peers.current.keys()) if (!next.has(id)) pointerGlide.current?.drop(id)
      peers.current = next
      // The person we followed left — nobody to follow any more.
      const api = apiRef.current
      const following = api?.getAppState().userToFollow as { socketId: string } | null | undefined
      if (api && following && !next.has(following.socketId)) api.updateScene({ appState: { userToFollow: null }, captureUpdate: CaptureUpdateAction.NEVER })
      renderPeers()
    },
    [renderPeers],
  )

  const showEdit = useCallback((edit: Edit, fresh: Element[]) => {
    const api = apiRef.current
    if (!api) return
    api.setToast({ message: `${edit.by}: ${edit.note ?? t('editor.editedElements', { count: edit.count })}`, closable: true, duration: 6000 })
    if (fresh.length) api.scrollToContent(fresh, { fitToContent: false, animate: true })
    // Show where exactly something was added — a ring around new blocks; labels are ringed with their shape.
    pulse(fresh.filter((el) => !el.containerId && el.type !== 'arrow' && el.type !== 'line').map((el) => ({ x: el.x ?? 0, y: el.y ?? 0, width: el.width ?? 0, height: el.height ?? 0 })))
  }, [])

  /** Remote edits — from the poll response, the hello reply and live channel broadcasts. */
  const applyRemote = useCallback(
    (data: Remote) => {
      const api = apiRef.current
      const s = sync.current
      if (!api) return
      if (data.epoch !== undefined) {
        if (data.full && s.epoch && data.epoch !== s.epoch) {
          // The server restarted and may have lost the last few seconds: resend
          // everything our version has that its response lacks.
          s.sent.clear()
          s.sentFiles.clear()
        }
        s.epoch = data.epoch
      }
      if (typeof data.rev === 'number') s.rev = data.rev
      if (data.title) setTitle(data.title)
      if (data.access) setAccess(data.access)
      if (data.viewers) setPresence(data.viewers)
      if (data.notes) setNotes(data.notes)
      if (data.timer !== undefined) setTimer(data.timer, data.now)
      if (data.files?.length) {
        api.addFiles(data.files)
        for (const f of data.files) s.sentFiles.add(f.id)
      }
      const incoming = data.elements ?? []
      if (incoming.length) {
        const current = api.getSceneElementsIncludingDeleted()
        const merged = reconcileElements(current as never, incoming as never, api.getAppState() as never) as unknown as Element[]
        const byId = new Map(merged.map((el) => [el.id, el]))
        // No need to send back what came from the server.
        for (const remote of incoming) {
          if (byId.get(remote.id)?.version === remote.version) s.sent.set(remote.id, remote.version)
        }
        api.updateScene({ elements: merged, captureUpdate: CaptureUpdateAction.NEVER })
        if (live.current.canEdit && incoming.some((el) => el.type === 'text' && el.customData?.remeasure)) remeasure(api)
        // A remote edit changes the list preview too: redraw it.
        if (live.current.canEdit) schedulePreview()
      }
      for (const edit of data.edits ?? []) showEdit(edit, incoming.filter((el) => !el.isDeleted && el.version <= 2))
    },
    [schedulePreview, setPresence, showEdit],
  )

  const channel = useRef<LiveChannel | null>(null)
  const rt = useRef({
    seq: 0,
    pending: new Map<number, { elements: [string, number][]; files: string[] }>(),
    inflight: new Map<string, number>(),
    inflightFiles: new Set<string>(),
    pushTimer: 0 as unknown as ReturnType<typeof setTimeout> | 0,
    peersTimer: undefined as ReturnType<typeof setTimeout> | undefined,
    sceneVersion: -1,
    selection: '',
    pointer: null as null | { x: number; y: number; tool: string; button: string },
    pointerTimer: 0 as unknown as ReturnType<typeof setTimeout> | 0,
    pointerAt: 0,
    viewportTimer: 0 as unknown as ReturnType<typeof setTimeout> | 0,
    activityAt: Date.now(),
    userState: 'active',
  })
  const isLive = () => Boolean(channel.current?.connected)
  /** Polling is declared below the channel, but the channel needs it when it drops. */
  const syncNowRef = useRef<(force?: boolean) => void>(() => {})

  /** Push to the live channel everything that changed and is neither acked nor in flight. */
  const pushLive = useCallback(() => {
    const api = apiRef.current
    const s = sync.current
    const r = rt.current
    r.pushTimer = 0
    if (!api || !isLive() || !live.current.canEdit) return
    const changed = api.getSceneElementsIncludingDeleted().filter((el) => s.sent.get(el.id) !== el.version && r.inflight.get(el.id) !== el.version)
    const files = Object.values(api.getFiles()).filter((f) => !s.sentFiles.has(f.id) && !r.inflightFiles.has(f.id))
    if (!changed.length && !files.length) return
    r.seq += 1
    if (!channel.current!.send({ t: 'push', seq: r.seq, elements: changed, files })) return
    r.pending.set(r.seq, { elements: changed.map((el) => [el.id, el.version]), files: files.map((f) => f.id) })
    for (const el of changed) r.inflight.set(el.id, el.version)
    for (const f of files) r.inflightFiles.add(f.id)
    setStatus('saving')
  }, [])

  const schedulePush = useCallback(() => {
    const r = rt.current
    if (r.pushTimer || !isLive()) return
    r.pushTimer = setTimeout(pushLive, PUSH_MS)
  }, [pushLive])

  const sendViewport = useCallback(() => {
    const r = rt.current
    if (r.viewportTimer) return
    r.viewportTimer = setTimeout(() => {
      r.viewportTimer = 0
      const api = apiRef.current
      if (!api) return
      const appState = api.getAppState() as { followedBy?: Set<string> }
      if (!appState.followedBy?.size) return
      channel.current?.sendVolatile({ t: 'viewport', bounds: getVisibleSceneBounds(appState as never) })
    }, VIEWPORT_MS)
  }, [])

  const setUserState = useCallback((value: 'active' | 'idle' | 'away') => {
    const r = rt.current
    if (r.userState === value) return
    r.userState = value
    channel.current?.send({ t: 'state', state: value })
  }, [])

  const onLive = useCallback(
    (m: LiveMessage) => {
      const api = apiRef.current
      const s = sync.current
      const r = rt.current
      if (!api) return
      switch (m.t) {
        case 'welcome':
          selfId.current = String(m.id)
          return
        case 'sync':
          applyRemote(m as unknown as Remote)
          // Where the others are — right away, not after they first move the mouse.
          for (const p of (m.pointers as { id: string; x: number; y: number; tool: 'pointer' | 'laser'; button: 'up' | 'down' }[] | undefined) ?? []) {
            const peer = peers.current.get(p.id)
            if (peer) peers.current.set(p.id, { ...peer, pointer: { x: p.x, y: p.y, tool: p.tool }, button: p.button })
          }
          renderPeers()
          // Everything drawn while the channel was down goes right after.
          pushLive()
          if (!r.pending.size) setStatus(live.current.canEdit ? 'live' : 'readonly')
          return
        case 'elements':
          applyRemote(m as unknown as Remote)
          return
        case 'edit': {
          const ids = new Set((m.ids as string[]) ?? [])
          const fresh = api.getSceneElements().filter((el) => ids.has(el.id) && el.version <= 2)
          showEdit(m.edit as Edit, fresh)
          return
        }
        case 'ack': {
          const entry = r.pending.get(m.seq as number)
          r.pending.delete(m.seq as number)
          if (entry) {
            for (const [id, version] of entry.elements) {
              s.sent.set(id, version)
              if (r.inflight.get(id) === version) r.inflight.delete(id)
            }
            for (const id of entry.files) {
              s.sentFiles.add(id)
              r.inflightFiles.delete(id)
            }
          }
          if (typeof m.error === 'string') api.setToast({ message: m.error, closable: true, duration: 6000 })
          if (!r.pending.size) setStatus(live.current.canEdit ? 'live' : 'readonly')
          if (entry && !m.error) schedulePreview()
          return
        }
        case 'notes':
          setNotes(m.notes as Notes)
          return
        case 'checkpoints':
          setCheckpoints(m.checkpoints as Checkpoint[])
          return
        case 'timer':
          setTimer(m.timer as TimerState, m.now as number)
          return
        case 'presence':
          setPresence(m.viewers as Viewer[])
          return
        case 'pointer': {
          const peer = peers.current.get(String(m.id))
          if (!peer) return
          const at = glidePointer(String(m.id), m.x as number, m.y as number)
          peers.current.set(String(m.id), { ...peer, pointer: { x: at.x, y: at.y, tool: m.tool as 'pointer' | 'laser' }, button: m.button as 'up' | 'down' })
          renderPeers()
          return
        }
        case 'select': {
          const peer = peers.current.get(String(m.id))
          if (!peer) return
          peers.current.set(String(m.id), { ...peer, selectedElementIds: Object.fromEntries(((m.ids as string[]) ?? []).map((id) => [id, true])) })
          renderPeers()
          return
        }
        case 'followers': {
          const ids = (m.ids as string[]) ?? []
          api.updateScene({ appState: { followedBy: new Set(ids) }, captureUpdate: CaptureUpdateAction.NEVER })
          if (ids.length) sendViewport()
          return
        }
        case 'viewport': {
          const appState = api.getAppState() as { userToFollow?: { socketId: string } | null; followedBy?: Set<string> }
          if (appState.userToFollow?.socketId !== m.id) return
          // Following each other — stay put, or the two screens would rock each other.
          if (appState.followedBy?.has(String(m.id))) return
          const { appState: next } = zoomToFitBounds({ appState: appState as never, bounds: m.bounds as never, fitToViewport: true, viewportZoomFactor: 1 }) as { appState: { scrollX: number; scrollY: number; zoom: { value: number } } }
          // The leader's view arrives every 80 ms: with motion on the screen glides after it instead of jumping.
          if (motionOn() && motion()?.glideTo({ scrollX: next.scrollX, scrollY: next.scrollY, zoom: next.zoom.value }, FOLLOW_GLIDE_MS)) return
          api.updateScene({ appState: next, captureUpdate: CaptureUpdateAction.NEVER })
          return
        }
        case 'meta':
          if (m.title) setTitle(String(m.title))
          if (m.access) setAccess(m.access as 'team' | 'link')
          if (Array.isArray(m.tags)) setMeta((prev) => ({ ...prev, description: String(m.description ?? prev.description), tags: m.tags as string[], task: (m.task as string | null) ?? null, fields: (m.fields as Record<string, unknown>) ?? prev.fields }))
          return
        default:
      }
    },
    [applyRemote, glidePointer, pushLive, renderPeers, schedulePreview, sendViewport, setPresence, showEdit],
  )

  const startLive = useCallback(() => {
    if (!config.live || channel.current) return
    const url = () => {
      const params = new URLSearchParams({ k: config.key, client: clientId })
      if (live.current.guest) params.set('guest', live.current.guest)
      return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}/live?${params}`
    }
    const ch = new LiveChannel(url, {
      onOpen: () => {
        const s = sync.current
        const r = rt.current
        r.userState = 'active'
        r.activityAt = Date.now()
        // Back before the remote cursors faded — no need to fade them now.
        clearTimeout(r.peersTimer)
        ch.send({ t: 'hello', since: s.rev, epoch: s.epoch, ...(ch.lastDrop ? { dropped: ch.lastDrop.reason, aliveMs: ch.lastDrop.aliveMs } : {}) })
        ch.lastDrop = null
        // After a restart the server doesn't know who follows whom — remind it.
        const following = apiRef.current?.getAppState().userToFollow as { socketId: string } | null | undefined
        if (following) ch.send({ t: 'follow', target: following.socketId, on: true })
        if (document.visibilityState === 'hidden') setUserState('away')
      },
      onMessage: onLive,
      // The channel is silent after an edit — send it over HTTP while the watchdog checks whether the channel is alive.
      onStall: () => syncNowRef.current(true),
      onClose: () => {
        // Unacked edits go again: with the next poll or after reconnecting.
        const r = rt.current
        r.pending.clear()
        r.inflight.clear()
        r.inflightFiles.clear()
        // Don't wipe participants at once: the channel usually returns within a
        // second, and avatars and cursors vanishing and reappearing is pointless
        // flicker. If it doesn't return, cursors fade: they are no longer true,
        // and polling reports who is on the board from then on.
        clearTimeout(r.peersTimer)
        r.peersTimer = setTimeout(() => {
          if (isLive()) return
          for (const [id, peer] of peers.current) peers.current.set(id, { ...peer, pointer: undefined, selectedElementIds: undefined })
          renderPeers()
        }, PEERS_GRACE_MS)
        setStatus(live.current.canEdit ? 'saved' : 'readonly')
        // Don't wait for the next poll: whatever was typed into the dropped channel goes over HTTP right now.
        syncNowRef.current()
      },
    })
    channel.current = ch
    ch.start()
  }, [onLive, renderPeers, setUserState])

  useEffect(() => {
    if (apiRef.current) startLive()
    return () => {
      channel.current?.stop()
      channel.current = null
    }
  }, [startLive])

  /** A guest gave a name — reconnect so the cursor is labelled with it. */
  const namedAs = useRef(guest)
  useEffect(() => {
    if (namedAs.current === guest) return
    namedAs.current = guest
    if (!channel.current) return
    channel.current.stop()
    channel.current = null
    startLive()
  }, [guest, startLive])

  /** Edits, selection and scrolling for those following us. */
  const onSceneChange = useCallback(
    (version: number, appState: Record<string, unknown>) => {
      if (!isLive()) return
      const r = rt.current
      if (version !== r.sceneVersion) {
        r.sceneVersion = version
        schedulePush()
      }
      const selected = appState.selectedElementIds as Record<string, boolean>
      const selection = Object.keys(selected)
        .filter((id) => selected[id])
        .sort()
        .join(',')
      if (selection !== r.selection) {
        r.selection = selection
        channel.current?.sendVolatile({ t: 'select', ids: selection ? selection.split(',') : [] })
      }
    },
    [schedulePush],
  )

  const lastPointer = useRef<{ x: number; y: number } | null>(null)
  /**
   * Pasting a single URL puts a card on the board instead of a line of text.
   * Everything else (text, images, shapes, links the editor embeds itself)
   * pastes as usual. If exactly one block is selected, the link attaches to it.
   */
  const onPaste = useCallback((data: { text?: string }) => {
    const api = apiRef.current as unknown as StudioApi | null
    const url = singleUrl(data.text)
    // A text reference a plugin recognises (an issue key, say) becomes a card too.
    const ref = url ? null : matchReference(config.plugins?.patterns, data.text)
    if (!api || (!url && !ref)) return true
    const state = api.getAppState() as { scrollX: number; scrollY: number; width: number; height: number; zoom: { value: number }; selectedElementIds: Record<string, boolean> }
    if (ref) {
      const point = lastPointer.current ?? { x: -state.scrollX + state.width / 2 / state.zoom.value, y: -state.scrollY + state.height / 2 / state.zoom.value }
      void addRefCard(api, base, q, ref, point)
      return false
    }
    if (!url) return true
    // One block selected — the link attaches to it instead of landing next to it as a card.
    // A selected card is a link itself: nothing gets attached to it.
    const hosts = new Set(Object.keys(state.selectedElementIds ?? {}).filter((id) => state.selectedElementIds[id]).map((id) => hostOf(api, id)?.id))
    const host = hosts.size === 1 ? hostOf(api, [...hosts][0] ?? null) : null
    if (host && host.customData?.kind !== 'card') {
      linkToBlock(api, host.id, url, boardOrigin)
      return false
    }
    const at = lastPointer.current ?? { x: -state.scrollX + state.width / 2 / state.zoom.value, y: -state.scrollY + state.height / 2 / state.zoom.value }
    // The same parsing decides the paste: a link the editor embeds itself goes to the editor.
    const target = classifyUrl(url, { boardOrigin })
    if (!target) return true
    void addCard(api, base, q, url, at, boardOrigin, { cardsForLinks: Boolean(config.plugins?.cardsForLinks) })
    return false
  }, [])
  const onPointerUpdate = useCallback(
    (payload: { pointer: { x: number; y: number; tool: string }; button: string }) => {
      const r = rt.current
      r.activityAt = Date.now()
      // Where the cursor is on the canvas: a card from a pasted link lands here.
      lastPointer.current = { x: payload.pointer.x, y: payload.pointer.y }
      if (r.userState !== 'active' && document.visibilityState === 'visible') setUserState('active')
      if (!isLive()) return
      r.pointer = { x: payload.pointer.x, y: payload.pointer.y, tool: payload.pointer.tool, button: payload.button }
      if (r.pointerTimer) return
      r.pointerTimer = setTimeout(
        () => {
          r.pointerTimer = 0
          r.pointerAt = Date.now()
          if (r.pointer) channel.current?.sendVolatile({ t: 'pointer', ...r.pointer })
        },
        Math.max(0, POINTER_MS - (Date.now() - r.pointerAt)),
      )
    },
    [setUserState],
  )

  const onUserFollow = useCallback((payload: { userToFollow: { socketId: string }; action: 'FOLLOW' | 'UNFOLLOW' }) => {
    channel.current?.send({ t: 'follow', target: payload.userToFollow.socketId, on: payload.action === 'FOLLOW' })
  }, [])

  /** Stepped away from the board — others see it on the avatar. */
  useEffect(() => {
    if (!config.live) return
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') setUserState('away')
      else {
        rt.current.activityAt = Date.now()
        setUserState('active')
      }
    }
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible' && Date.now() - rt.current.activityAt > IDLE_MS) setUserState('idle')
    }, 5_000)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [setUserState])

  /** Draw the preview when things are quiet or in the background, see PREVIEW_QUIET_MS. */
  useEffect(() => {
    const run = async (leaving = false) => {
      const s = sync.current
      if (!s.previewDue || s.previewBusy || !live.current.canEdit) return
      const hidden = document.visibilityState === 'hidden'
      // A background tab doesn't mean the board is quiet: others may be editing
      // it right now. A background tab used to redraw the preview on every
      // remote edit — a full scene export with fonts every two seconds while
      // someone typed. Now: immediately only when leaving the tab, otherwise
      // like everyone else — once edits have settled.
      const settled = Date.now() - s.editedAt > PREVIEW_QUIET_MS
      const quiet = settled && (hidden || Date.now() - rt.current.activityAt > PREVIEW_STILL_MS)
      if (!leaving && !quiet) return
      s.previewDue = false
      s.previewBusy = true
      try {
        await uploadPreview()
      } finally {
        s.previewBusy = false
      }
    }
    const timer = setInterval(() => run(), PREVIEW_CHECK_MS)
    const onHide = () => {
      if (document.visibilityState === 'hidden') run(true)
    }
    document.addEventListener('visibilitychange', onHide)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onHide)
    }
  }, [uploadPreview])

  /** Polling: the main path without a live channel and the fallback while it reconnects. */
  const syncNow = useCallback(async (force = false) => {
    const api = apiRef.current
    const s = sync.current
    // force — the live channel looks open but did not ack an edit: send it via polling too.
    if (!api || s.inFlight || (isLive() && !force)) return
    s.inFlight = true
    try {
      const writer = live.current.canEdit
      const local = api.getSceneElementsIncludingDeleted()
      const changed = writer ? local.filter((el) => s.sent.get(el.id) !== el.version) : []
      const files = writer ? Object.values(api.getFiles()).filter((f) => !s.sentFiles.has(f.id)) : []
      if (changed.length) setStatus('saving')
      const response = await fetch(`${base}/sync${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ since: s.rev, epoch: s.epoch, elements: changed, files, client: clientId, guest: live.current.guest || undefined }),
      })
      if (!response.ok) throw new Error(String(response.status))
      const data = (await response.json()) as Remote
      for (const el of changed) s.sent.set(el.id, el.version)
      for (const f of files) s.sentFiles.add(f.id)
      // The live channel may have come up while the response was in flight — then it owns the revision.
      if (isLive()) return
      applyRemote(data)
      if (writer && (changed.length || files.length)) schedulePreview()
      setStatus(writer ? 'saved' : 'readonly')
    } catch {
      if (!isLive()) setStatus('offline')
    } finally {
      s.inFlight = false
    }
  }, [applyRemote, schedulePreview])
  syncNowRef.current = syncNow

  useEffect(() => {
    // A checkpoint snapshot isn't live: polling would pull the current scene into it.
    if (!initial || config.at) return
    const timer = setInterval(syncNow, SYNC_MS)
    const flushOnHide = () => {
      if (document.visibilityState !== 'hidden') return
      if (isLive()) pushLive()
      else syncNow()
    }
    document.addEventListener('visibilitychange', flushOnHide)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', flushOnHide)
    }
  }, [initial, syncNow, pushLive])

  /** What web plugins may do with the scene: read it, add and change elements, select, scroll, toast. */
  const bridge = useMemo<EditorBridge>(
    () => ({
      getSceneElements: () => (apiRef.current?.getSceneElements() ?? []) as unknown as SceneElement[],
      getSelectedElements: () => {
        const api = apiRef.current
        if (!api) return []
        const picked = api.getAppState().selectedElementIds as Record<string, boolean>
        return api.getSceneElements().filter((el) => picked[el.id]) as unknown as SceneElement[]
      },
      addElements: (skeletons) => {
        const api = apiRef.current
        if (!api || !live.current.canEdit) return []
        const created = convertToExcalidrawElements(skeletons as never) as unknown as Element[]
        api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...created], captureUpdate: CaptureUpdateAction.IMMEDIATELY })
        return created.map((el) => el.id)
      },
      updateElements: (patches) => {
        const api = apiRef.current
        if (!api || !live.current.canEdit) return
        const byId = new Map(patches.map((p) => [p.id, p]))
        const next = api.getSceneElementsIncludingDeleted().map((el) => {
          const patch = byId.get(el.id)
          if (!patch) return el
          const { id: _id, ...fields } = patch
          return newElementWith(el as never, fields as never) as unknown as Element
        })
        api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      },
      select: (ids) => apiRef.current?.updateScene({ appState: { selectedElementIds: Object.fromEntries(ids.map((id) => [id, true])) }, captureUpdate: CaptureUpdateAction.NEVER }),
      scrollTo: (ids) => {
        const api = apiRef.current
        if (api) api.scrollToContent(api.getSceneElements().filter((el) => ids.includes(el.id)), { fitToContent: false, animate: true })
      },
      toast: (message) => apiRef.current?.setToast({ message: String(message).slice(0, 300), closable: true, duration: 5000 }),
    }),
    [],
  )
  const metaRef = useRef({ title: config.title, fields: config.fields ?? {} })
  metaRef.current = { title, fields: meta.fields ?? {} }
  const pluginsStarted = useRef(false)
  const startPlugins = useCallback(() => {
    if (pluginsStarted.current || !config.plugins?.web?.length) return
    pluginsStarted.current = true
    void loadWebPlugins(config.plugins.web, {
      // Read live: a property changed in the dialog or by someone else shows up without a reload.
      board: {
        slug: config.slug,
        url: config.boardUrl ?? `${location.origin}${base}${q}`,
        user: config.user,
        get title() {
          return metaRef.current.title
        },
        get canEdit() {
          return live.current.canEdit
        },
        get fields() {
          return { ...(metaRef.current.fields ?? {}) }
        },
      },
      editor: () => (apiRef.current ? bridge : null),
      key: config.key,
      guest: () => live.current.guest,
      flags: config.flags ?? {},
    })
  }, [bridge])

  /**
   * Embedded in a narrow pane (another app's side panel, a hand-off link next to a chat) the default view — 100 %
   * around the content — shows only a corner of the board. Fit the whole board once instead, never above 100 %.
   */
  const fitted = useRef(false)
  const fitOnLoad = useCallback((api: Api) => {
    if (fitted.current) return
    fitted.current = true
    let framed = false
    try {
      framed = window.self !== window.top
    } catch {
      framed = true
    }
    if (!shouldFitOnLoad({ framed, width: window.innerWidth, param: new URLSearchParams(location.search).get('fit') })) return
    requestAnimationFrame(() => {
      const state = api.getAppState() as { width?: number; height?: number }
      const viewport = { width: state.width || window.innerWidth, height: state.height || window.innerHeight }
      const fit = fitScene(api.getSceneElements() as never, viewport, { maxZoom: 1 })
      api.updateScene({ appState: { zoom: { value: fit.zoom }, scrollX: fit.scrollX, scrollY: fit.scrollY }, captureUpdate: CaptureUpdateAction.NEVER })
      if (config.studio) setView(api.getAppState())
    })
  }, [])

  const onApi = useCallback(
    (api: unknown) => {
      apiRef.current = api as Api
      if (config.studio) setStudioApi(api as unknown as StudioApi)
      if (!api) return
      // In 0.18 follow events only come through the API subscription — the editor
      // never calls the onUserFollow prop.
      ;(api as Api).onScrollChange(() => {
        // Scrolling and zooming count as activity: don't draw the preview meanwhile.
        rt.current.activityAt = Date.now()
        sendViewport()
        if (config.studio) setView((api as Api).getAppState())
      })
      if (config.studio) setView((api as Api).getAppState())
      if (config.studio) loadLibrary(api as unknown as StudioApi)
      if (config.live) (api as Api).onUserFollow(onUserFollow)
      startLive()
      startPlugins()
      fitOnLoad(api as Api)
      setTimeout(() => {
        if (!live.current.canEdit) return
        remeasure(api as Api)
        // No preview or a stale one — draw it once the board is left alone.
        if (!config.hasPreview || config.previewStale) sync.current.previewDue = true
      }, 300)
    },
    [schedulePreview, sendViewport, startLive, onUserFollow, startPlugins],
  )

  /**
   * Excalidraw calls onChange on every repaint, not only on edits — dozens of
   * times a second on any movement. So there is no React state here: the view
   * goes straight to the camera in the DOM, edits reach layers through their own
   * subscription, and the page re-renders only when the studio tool changes.
   */
  const lastScene = useRef(-1)
  // Right-click menu: the editor opens its own (hidden) and we draw ours in its place.
  const [menu, setMenu] = useState<MenuState | null>(null)
  const nativeMenu = useRef<unknown>(null)
  // Snapping toggles from the menu, Alt+S and the canvas context menu — we learn about it from the editor state.
  const [snapOn, setSnapOn] = useState(readSnap)
  const snapRef = useRef(snapOn)
  // Motion is a personal setting, like snapping: it lives in the browser, not in the scene.
  const [smooth, setSmooth] = useState(motionChosen)
  const toggleSmooth = useCallback(() => {
    const next = !motionChosen()
    setMotionChosen(next)
    setSmooth(next)
  }, [])
  const toggleSnap = useCallback(() => {
    const api = apiRef.current
    if (api) api.updateScene({ appState: { objectsSnapModeEnabled: !snapRef.current }, captureUpdate: CaptureUpdateAction.NEVER })
  }, [])
  const onChange = useCallback(
    (elements: readonly Element[], appState: Record<string, unknown>) => {
      const version = getSceneVersion(elements as never)
      if (config.live) onSceneChange(version, appState)
      if (config.snap) {
        const on = Boolean(appState.objectsSnapModeEnabled)
        if (on !== snapRef.current) {
          snapRef.current = on
          writeSnap(on)
          setSnapOn(on)
        }
      }
      if (config.workboard) {
        const picked = appState.selectedElementIds as Record<string, boolean>
        const opened = (live.current.canEdit ? appState.contextMenu : null) as { left: number; top: number } | null
        if (opened !== nativeMenu.current) {
          nativeMenu.current = opened
          if (!opened) setMenu(null)
          else {
            const zoom = (appState.zoom as { value: number }).value
            setMenu({
              left: opened.left + ((appState.offsetLeft as number) ?? 0),
              top: opened.top + ((appState.offsetTop as number) ?? 0),
              at: { x: opened.left / zoom - (appState.scrollX as number), y: opened.top / zoom - (appState.scrollY as number) },
              ids: Object.keys(picked).filter((id) => picked[id]),
            })
          }
        }
      }
      if (!config.studio) return
      setView(appState)
      if (version !== lastScene.current) {
        lastScene.current = version
        bumpScene()
      }
      const active = appState.activeTool as { type?: string; customType?: string } | undefined
      const next: StudioTool = active?.type === 'custom' && (active.customType === 'sticky' || active.customType === 'comment') ? active.customType : null
      setTool(next)
    },
    [onSceneChange],
  )

  const me = config.user?.name ?? (guest ? `guest: ${guest}` : null)
  const react = useCallback(
    async (id: string, emoji: string, on: boolean) => {
      const response = await fetch(`${base}/react${q}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id, emoji, on, guest: live.current.guest || undefined }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) return apiRef.current?.setToast({ message: body.error ?? t('editor.reactionNotSaved'), closable: true, duration: 4000 })
      // The live channel will broadcast the same, but there's no need to wait for it.
      if (body.notes) setNotes(body.notes)
    },
    [],
  )

  /** Comments: a new thread and actions on it. The server responds with all notes. */
  const commentRequest = useCallback(async (path: string, body: Record<string, unknown>) => {
    const response = await fetch(`${base}/${path}${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...body, guest: live.current.guest || undefined }),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok) {
      apiRef.current?.setToast({ message: data.error ?? t('editor.commentNotSaved'), closable: true, duration: 5000 })
      return null
    }
    if (data.notes) setNotes(data.notes)
    return data
  }, [])
  const timerAct = useCallback(
    async (action: TimerAction) => {
      const response = await fetch(`${base}/timer${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...action, guest: live.current.guest || undefined }) })
      const data = await response.json().catch(() => ({}))
      if (response.ok) setTimer(data.timer as TimerState, data.now as number)
      else apiRef.current?.setToast({ message: data.error ?? t('editor.timerNoResponse'), closable: true, duration: 4000 })
    },
    [setTimer],
  )
  const createComment = useCallback(
    async (c: { x: number; y: number; elementId: string | null; text: string }) => (await commentRequest('comments', c))?.thread ?? null,
    [commentRequest],
  )
  const updateComment = useCallback(
    async (id: string, change: Change) => Boolean(await commentRequest(`comments/${id}`, change)),
    [commentRequest],
  )

  /**
   * Sticky and comment are editor tools (activeTool custom): pick one, click the
   * board, and it lands at that point. Excalidraw draws nothing for custom tools
   * and passes the point to onPointerDown.
   */
  const toolbarSlot = useToolbarSlot(Boolean(studioApi) && canEdit)
  useEffect(() => {
    document.body.classList.toggle('studio-top', Boolean(toolbarSlot))
  }, [toolbarSlot])
  // Right island: full, compact with a "More" menu, or minimal when the bottom dock is shown.
  const barMode = useBarMode(toolbarSlot)
  useEffect(() => {
    document.body.dataset.bar = barMode
  }, [barMode])
  const [timerOpen, setTimerOpen] = useState(false)
  const [slopOpen, setSlopOpen] = useState(false)
  const onTool = useCallback(
    (next: StudioTool) => {
      if (!studioApi) return
      if (next === 'comment') setCommentsHidden(false)
      setPanel(null)
      setStudioTool(studioApi, next)
    },
    [studioApi],
  )
  const onStudioPointerDown = useCallback(
    (active: { type: string; customType?: string; locked?: boolean }, down: { origin: { x: number; y: number } }) => {
      const api = studioApi
      if (!api || active.type !== 'custom') return
      const { x, y } = down.origin
      if (active.customType === 'sticky') addSticky(api, { fill: stickyColor, author: me, x, y })
      else if (active.customType === 'comment') setCommentDraft(draftAt(api, x, y))
      else return
      // Like Excalidraw shapes: after placing, return to selection unless the tool is locked.
      if (!active.locked) setStudioTool(api, null)
    },
    [studioApi, stickyColor, me],
  )
  useEffect(() => {
    document.body.classList.toggle('studio-tool-on', Boolean(tool))
  }, [tool])
  // Our menu replaces the stock one only where the board is editable: view mode keeps the editor's menu.
  useEffect(() => {
    document.body.classList.toggle('board-menu-on', config.workboard && canEdit)
  }, [canEdit])
  const closeMenu = useCallback(() => setMenu(null), [])
  usePluginRegistry()
  /**
   * Plugin block actions for the right-click menu: the server's (run on the server, which may edit the board) and
   * web plugins' own, each shown only when its `when` fits the selection.
   */
  const pluginItems = useCallback(
    (state: MenuState): PluginMenuItem[] => {
      const api = studioApi
      if (!api || !state.ids.length) return []
      const hosts = [...new Map(state.ids.map((id) => hostOf(api, id)).filter(Boolean).map((el) => [el!.id, el!])).values()] as unknown as SceneElement[]
      const items: PluginMenuItem[] = []
      for (const action of config.plugins?.actions ?? []) {
        if (!fitsSelection(action.when, hosts)) continue
        items.push({
          key: `${action.plugin}/${action.id}`,
          label: action.label,
          icon: action.icon,
          run: () => void runServerAction(action.plugin, action.id, action.confirm, hosts.map((el) => el.id)),
        })
      }
      for (const action of webActions()) {
        if (!fitsSelection(action.when, hosts)) continue
        items.push({ key: `web/${action.id}`, label: action.label, icon: action.icon ?? null, run: () => void Promise.resolve(action.run({ selection: hosts, api: pluginApi()! })).catch((error) => console.error(`[boards] action ${action.id} failed`, error)) })
      }
      return items
    },
    [studioApi],
  )
  /** Run a server plugin's action; its edit arrives like any other edit, its toast and link right here. */
  const runServerAction = useCallback(async (plugin: string, id: string, confirm: string | null, ids: string[]) => {
    if (confirm && !window.confirm(confirm)) return
    const response = await fetch(`${base}/actions/${plugin}/${id}${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ids, guest: live.current.guest || undefined }) }).catch(() => null)
    const body = response ? await response.json().catch(() => ({})) : {}
    if (!response?.ok) return apiRef.current?.setToast({ message: body.error ?? t('plugins.actionFailed'), closable: true, duration: 6000 })
    if (body.toast) apiRef.current?.setToast({ message: body.toast, closable: true, duration: 5000 })
    if (body.open) window.open(body.open, '_blank', 'noopener')
    if (Array.isArray(body.select) && body.select.length) bridge.select(body.select)
  }, [bridge])
  const commentAt = useCallback(
    (at: { x: number; y: number }) => {
      if (!studioApi) return
      setCommentsHidden(false)
      setCommentDraft(draftAt(studioApi, at.x, at.y))
    },
    [studioApi],
  )
  const stickyAt = useCallback(
    (at: { x: number; y: number }) => {
      if (studioApi) addSticky(studioApi, { fill: stickyColor, author: me, x: at.x, y: at.y })
    },
    [studioApi, stickyColor, me],
  )
  /**
   * A trackpad pinch is a wheel event with ctrlKey. Over the canvas Excalidraw
   * takes it and zooms the board. Over anything on top of the canvas — a thread
   * card, a pin, the comments panel, the editor's own panels — nobody took it,
   * and the browser zoomed the whole page: the UI drifted, and a board embedded
   * in a host app dragged the whole host along. Now the gesture always goes to
   * the canvas.
   */
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      if ((e.target as globalThis.Element | null)?.closest?.('canvas')) return
      e.preventDefault()
      document
        .querySelector('canvas.interactive')
        ?.dispatchEvent(new WheelEvent('wheel', { deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, clientX: e.clientX, clientY: e.clientY, ctrlKey: e.ctrlKey, metaKey: e.metaKey, bubbles: true, cancelable: true }))
    }
    // Safari reports pinches with its own events — unless cancelled, it zooms the page.
    const stop = (e: Event) => e.preventDefault()
    document.addEventListener('wheel', onWheel, { passive: false, capture: true })
    document.addEventListener('gesturestart', stop)
    document.addEventListener('gesturechange', stop)
    return () => {
      document.removeEventListener('wheel', onWheel, { capture: true })
      document.removeEventListener('gesturestart', stop)
      document.removeEventListener('gesturechange', stop)
    }
  }, [])

  // Esc drops our tool, like any Excalidraw tool.
  useEffect(() => {
    if (!tool || !studioApi) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStudioTool(studioApi, null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [tool, studioApi])

  const saveMeta = useCallback(async (changes: Record<string, unknown>) => {
    const response = await fetch(`${base}/meta${q}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...changes, guest: live.current.guest || undefined }),
    })
    const body = await response.json().catch(() => ({}))
    if (!response.ok) {
      apiRef.current?.setToast({ message: body.error ?? t('editor.notSaved'), closable: true, duration: 5000 })
      return null
    }
    return body
  }, [])

  const rename = useCallback(async () => {
    const next = window.prompt(t('editor.boardTitlePrompt'), title)?.trim()
    if (!next || next === title) return
    if (await saveMeta({ title: next })) setTitle(next)
  }, [title, saveMeta])

  const saveProperties = useCallback(
    async (changes: Partial<BoardMeta>) => {
      const body = await saveMeta(changes)
      if (!body) return false
      setMeta((prev) => ({ ...prev, description: body.description ?? prev.description, tags: body.tags ?? prev.tags, task: body.task ?? null, fields: body.fields ?? prev.fields }))
      apiRef.current?.setToast({ message: t('editor.propertiesSaved'), duration: 2500 })
      return true
    },
    [saveMeta],
  )

  const changeAccess = useCallback(
    async (next: 'team' | 'link') => {
      const body = await saveMeta({ access: next })
      if (body) {
        setAccess(body.access)
        apiRef.current?.setToast({ message: next === 'link' ? t('editor.accessLink') : t('editor.accessTeam'), duration: 3500 })
      }
    },
    [saveMeta],
  )

  const saveGuest = useCallback(() => {
    const name = guestDraft.trim().slice(0, 40)
    if (!name) return
    try {
      localStorage.setItem(GUEST_KEY, name)
    } catch {
      // Private window: the name lives until the tab closes.
    }
    setGuest(name)
  }, [guestDraft])

  const statusText = STATUS_TEXT[shownStatus]

  /**
   * The top-right corner is a slot: Excalidraw renders an empty node once and the
   * content is portalled in from Board. So a status or comment-count change
   * re-renders only the corner, not the whole editor.
   */
  const [topRight, setTopRight] = useState<HTMLElement | null>(null)
  const renderTopRightUI = useCallback(() => <div className="board-top" ref={setTopRight} />, [])
  const openShare = useCallback(() => setSharing(true), [])
  const openProperties = useCallback(() => setProperties(true), [])
  const startComment = useCallback(() => onTool('comment'), [onTool])
  const openComments = useMemo(() => notes.comments.filter((t) => !t.resolved).length, [notes.comments])

  /**
   * The menu and welcome screen are Excalidraw children. The editor is memoized
   * and compares children by reference: rebuilt on every render, they re-rendered
   * the whole editor on every mouse move. Now only when their content changes.
   */
  const excalidrawChildren = useMemo(
    () =>
      <>
        <MainMenu>
          <MainMenu.ItemLink href={homeUrl}>{t('editor.allBoards')}</MainMenu.ItemLink>
          {canEdit && <MainMenu.Item onSelect={rename}>{t('editor.rename', { title })}</MainMenu.Item>}
          <MainMenu.Item onSelect={openShare}>{t('editor.shareEllipsis')}</MainMenu.Item>
          {config.studio && <MainMenu.Item onSelect={openProperties}>{t('editor.boardProperties')}</MainMenu.Item>}
          <MainMenu.ItemLink href={`${base}.md${q}`}>{t('editor.boardAsText')}</MainMenu.ItemLink>
          <MainMenu.ItemLink href={`${base}/scene.excalidraw${q}&download=1`}>{t('editor.downloadExcalidraw')}</MainMenu.ItemLink>
          <MainMenu.Separator />
          <MainMenu.DefaultItems.SaveAsImage />
          <MainMenu.DefaultItems.SearchMenu />
          <MainMenu.DefaultItems.Help />
          {config.snap && canEdit && (
            <MainMenu.Item onSelect={toggleSnap} shortcut="Alt+S" icon={<SnapIcon on={snapOn} />}>
              {t('editor.snapToObjects', { state: snapOn ? t('editor.on') : t('editor.off') })}
            </MainMenu.Item>
          )}
          {config.motion && <MainMenu.Item onSelect={toggleSmooth}>{t('editor.smoothMotion', { state: smooth ? t('editor.on') : t('editor.off') })}</MainMenu.Item>}
          {canEdit && <MainMenu.DefaultItems.ClearCanvas />}
          <MainMenu.Separator />
          <MainMenu.DefaultItems.ToggleTheme />
          <MainMenu.DefaultItems.ChangeCanvasBackground />
          <MainMenu.Separator />
          {config.user ? (
            <MainMenu.ItemLink href={logoutUrl()}>{t('editor.signOutAs', { name: config.user.name })}</MainMenu.ItemLink>
          ) : config.authEnabled ? (
            <MainMenu.ItemLink href={loginUrl()}>{t('editor.signIn')}</MainMenu.ItemLink>
          ) : null}
        </MainMenu>
        <WelcomeScreen>
          <WelcomeScreen.Center>
            <WelcomeScreen.Center.Logo>
              <span className="board-welcome-logo">
                <img src={`${config.staticBase}/logo-mark.svg`} alt="" />
                <span>boards</span>
              </span>
            </WelcomeScreen.Center.Logo>
            <WelcomeScreen.Center.Heading>
              {canEdit ? t('editor.welcomeEdit') : t('editor.welcomeView')}
            </WelcomeScreen.Center.Heading>
            <WelcomeScreen.Center.Menu>
              {!canEdit && config.authEnabled && (
                <WelcomeScreen.Center.MenuItemLink href={loginUrl()}>{t('editor.signInToEdit')}</WelcomeScreen.Center.MenuItemLink>
              )}
              <WelcomeScreen.Center.MenuItemLink href={homeUrl}>{t('editor.allBoards')}</WelcomeScreen.Center.MenuItemLink>
              <WelcomeScreen.Center.MenuItemHelp />
            </WelcomeScreen.Center.Menu>
          </WelcomeScreen.Center>
          {canEdit && <WelcomeScreen.Hints.ToolbarHint />}
          <WelcomeScreen.Hints.MenuHint />
        </WelcomeScreen>
      </>,
    [canEdit, title, rename, openShare, openProperties, snapOn, toggleSnap, smooth, toggleSmooth],
  )
  const initialData = useMemo(() => {
    if (!initial) return null
    return { ...initial, scrollToContent: true } as never
  }, [initial])

  if (status === 'offline' && !initial) {
    return (
      <div className="board-error">
        <Brand />
        <p>{t('editor.loadFailed')}</p>
      </div>
    )
  }
  if (!initial) return null

  const needsGuestName = !config.at && !config.user && access === 'link' && !guest

  return (
    <>
      <Excalidraw
        excalidrawAPI={onApi}
        initialData={initialData!}
        langCode={excalidrawLang}
        name={title}
        viewModeEnabled={!canEdit}
        isCollaborating
        onChange={config.live || config.studio || config.snap || config.workboard ? (onChange as never) : undefined}
        onPointerUpdate={config.live || config.workboard ? (onPointerUpdate as never) : undefined}
        onPaste={config.workboard && canEdit ? (onPaste as never) : undefined}
        onPointerDown={config.studio ? (onStudioPointerDown as never) : undefined}
        validateEmbeddable
        UIOptions={UI_OPTIONS}
        renderTopRightUI={renderTopRightUI}
      >
        {excalidrawChildren}
      </Excalidraw>

      {topRight &&
        createPortal(
          <>
            {/*
              Right island: participants, connection, everything about the board and Share —
              one block of same-looking buttons. CSS order sets the sequence: the editor's own
              Library button sits among ours. Timer, checkpoints and slop check live here only
              when our tools are in the top toolbar; on narrow screens they move to the bottom
              dock and the island stays short.
            */}
            <span className={`board-status board-status--${shownStatus}`} title={statusText}>
              <span className="board-status__dot">{shownStatus === 'saved' || shownStatus === 'live' ? '●' : shownStatus === 'saving' ? '◐' : shownStatus === 'readonly' ? '◌' : '○'}</span> <span className="board-status__text">{shownStatus === 'live' ? t('editor.statusLiveShort') : statusText}</span>
            </span>
            <span className="bar-sep bar-sep--tools" />
            {studioApi && canEdit && barMode !== 'dock' && config.workboard && (
              <TimerTool timer={timer.value} offset={timer.offset} canEdit={canEdit} onAct={timerAct} quiet={barMode === 'compact'} open={timerOpen} onOpen={setTimerOpen} />
            )}
            {studioApi && canEdit && barMode === 'full' && config.workboard && (
              <BarButton label={t('editor.checkpointsTitle')} on={panel === 'checkpoints'} onClick={() => openPanel(panel === 'checkpoints' ? null : 'checkpoints')}>
                <CheckpointsIcon />
              </BarButton>
            )}
            {studioApi && <CommentsButton count={openComments} open={commentsPanel} onClick={() => setCommentsPanel(!commentsPanel)} />}
            {studioApi && canEdit && barMode !== 'dock' && <SlopBadge api={studioApi} placement="bar" quiet={barMode === 'compact'} open={slopOpen} onOpen={setSlopOpen} />}
            {studioApi && canEdit && barMode === 'compact' && (
              <BarMenu
                items={[
                  ...(config.workboard
                    ? [
                        { id: 'timer', label: t('editor.timer'), icon: BAR_ICONS.timer, onSelect: () => setTimerOpen(true) },
                        { id: 'checkpoints', label: t('editor.checkpoints'), icon: BAR_ICONS.checkpoints, onSelect: () => openPanel('checkpoints') },
                      ]
                    : []),
                  { id: 'slop', label: t('editor.slopCheck'), icon: BAR_ICONS.slop, onSelect: () => setSlopOpen(true) },
                  { id: 'library', label: t('editor.library'), icon: BAR_ICONS.library, hint: '0', onSelect: () => (studioApi as unknown as { toggleSidebar(o: { name: string }): boolean }).toggleSidebar({ name: 'default' }) },
                ]}
              />
            )}
            {toolbarButtons().map((button) => (
              <BarButton key={button.id} label={button.label} onClick={() => void Promise.resolve(button.onClick({ api: pluginApi()! })).catch((error) => console.error(`[boards] toolbar button ${button.id} failed`, error))}>
                <span className="bar-btn__plugin-icon" aria-hidden dangerouslySetInnerHTML={{ __html: button.icon ?? PLUGIN_ICON }} />
              </BarButton>
            ))}
            <span className="bar-sep bar-sep--share" />
            {!config.user && config.authEnabled && (
              <a className="board-button board-button--ghost" href={loginUrl()}>
                {t('editor.signIn')}
              </a>
            )}
            <button type="button" className="board-button board-button--share" onClick={openShare} title={t('editor.share')} aria-label={t('editor.share')}>
              <svg className="board-button__icon" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13" />
              </svg>
              <span className="board-button__label">{t('editor.share')}</span>
            </button>
          </>,
          topRight,
        )}

      <Brand />

      {studioApi && config.motion && <PulseLayer />}
      {studioApi && <StickyOverlay api={studioApi} me={me} reactions={REACTIONS} votes={notes.reactions} canReact={canEdit} onReact={react} />}
      {studioApi && (
        <Comments
          api={studioApi}
          slug={config.slug}
          threads={notes.comments}
          me={me}
          canComment={canEdit}
          isTeam={Boolean(config.user)}
          draft={commentDraft}
          setDraft={setCommentDraft}
          onStartComment={startComment}
          hidden={commentsHidden}
          setHidden={setCommentsHidden}
          panelOpen={commentsPanel}
          setPanelOpen={setCommentsPanel}
          onCreate={createComment}
          onUpdate={updateComment}
        />
      )}
      {studioApi && canEdit && (
        <>
          {/* Desktop: buttons in the Excalidraw top toolbar; phone: the bottom dock. */}
          {toolbarSlot
            ? createPortal(
                <ToolbarTools tool={tool} onTool={onTool} panel={panel} setPanel={openPanel} stickyColor={stickyColor} />,
                toolbarSlot,
              )
            : (
                <Dock tool={tool} onTool={onTool} panel={panel} setPanel={openPanel} stickyColor={stickyColor} workboard={config.workboard}>
                  {config.workboard && <TimerTool timer={timer.value} offset={timer.offset} canEdit={canEdit} onAct={timerAct} dock />}
                  <SlopBadge api={studioApi} />
                </Dock>
              )}
          {panel === 'palette' && <PalettePanel api={studioApi} onClose={() => setPanel(null)} stickyColor={stickyColor} setStickyColor={setStickyColor} />}
          {panel === 'templates' && <TemplatesPanel api={studioApi} onClose={() => setPanel(null)} staticBase={config.staticBase} />}
          {panel === 'checkpoints' && config.workboard && (
            <Checkpoints api={studioApi} base={base} q={q} guest={guest} canEdit={canEdit} list={checkpoints} setList={setCheckpoints} onClose={() => setPanel(null)} />
          )}
        </>
      )}
      {studioApi && config.workboard && (
        <LinkLayer
          api={studioApi}
          base={base}
          q={q}
          staticBase={config.staticBase}
          boardOrigin={boardOrigin}
          cardsForLinks={Boolean(config.plugins?.cardsForLinks)}
        />
      )}
      {studioApi && config.workboard && canEdit && menu && (
        <BoardMenu api={studioApi} menu={menu} onClose={closeMenu} onComment={commentAt} onSticky={stickyAt} pluginItems={pluginItems(menu)} />
      )}
      {studioApi && config.at && <CheckpointView api={studioApi} base={base} q={q} guest={guest} at={config.at} canCopy={Boolean(config.canCopy)} boardUrl={config.boardUrl ?? `${base}${q}`} />}
      {properties && <PropertiesDialog meta={{ ...meta, title }} canEdit={Boolean(config.user)} onSave={saveProperties} onClose={() => setProperties(false)} fields={config.plugins?.fields ?? []} />}

      {!canEdit && config.authEnabled && (
        <div className="board-banner" role="status">
          <span>{t('editor.viewOnlyBanner')}</span>
          <a className="board-button" href={loginUrl()}>
            {t('editor.signInToEdit')}
          </a>
        </div>
      )}

      {needsGuestName && (
        <form
          className="board-banner"
          onSubmit={(e) => {
            e.preventDefault()
            saveGuest()
          }}
        >
          <span>{t('editor.guestPrompt')}</span>
          <input value={guestDraft} onChange={(e) => setGuestDraft(e.target.value)} placeholder={t('editor.name')} maxLength={40} aria-label={t('editor.yourName')} />
          <button type="submit" className="board-button">
            {t('editor.done')}
          </button>
          {config.authEnabled && (
            <a className="board-button board-button--ghost" href={loginUrl()}>
              {t('editor.signIn')}
            </a>
          )}
        </form>
      )}

      {sharing && <ShareDialog access={access} onAccess={changeAccess} onClose={() => setSharing(false)} />}
    </>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Board />
  </StrictMode>,
)
