/**
 * Comments: Figma-style threads pinned to the board.
 *
 * Threads are not scene elements. They live in the board's notes (next to
 * reactions), arrive whole from the server after every change, and are drawn
 * here as DOM above the canvas:
 *
 * - pins in the camera layer (scene coordinates, constant on-screen size), so
 *   they pan and zoom with the canvas without React hearing about scrolling;
 * - a thread card next to the open pin (a bottom sheet on phones);
 * - a composer at the bottom centre while a new thread is being written;
 * - the comments panel on the right with every thread, resolved ones apart.
 *
 * All rules that do not need the DOM (hit testing, pin position, ordering,
 * "new" state, card placement) are in comments-model.ts and unit-tested.
 */
import { createContext, memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { CameraLayer, getView, inWindow, toScreen, useSceneVersion, useSceneWindow, useView } from './camera'
import { BarButton, type StudioApi } from './studio'
import {
  canDelete,
  cardOffset,
  displayName,
  draftFrom,
  excerpt,
  focusPoint,
  fullTime,
  initialOf,
  isDrag,
  isGuest,
  isUnseen,
  markSeen,
  parseSeen,
  pinColor,
  pinPoint,
  placeName,
  relativeTime,
  replyCount,
  seenKey,
  sortThreads,
  type Draft,
  type Message,
  type Point,
  type SceneEl,
  type Seen,
  type Thread,
} from './comments-model'
import { commentCall } from './app-call'
import { glow } from './islands/overlays'
import { candidates, insertMention, mentionQuery, splitMentions, suggest, type Candidate } from './mentions'
import './comments.css'
import { t, dateLocale } from './i18n'

export type { Draft, Message, Thread } from './comments-model'
export { pinColor } from './comments-model'

/** One action on a thread; the server applies exactly one kind per request. */
export type Change = { reply?: string; replyTo?: string; react?: { emoji: string; on: boolean }; resolved?: boolean; remove?: boolean; removeMessage?: string; x?: number; y?: number; elementId?: string | null }

type CommentsProps = {
  /** Tabs of the right island (comments · chat) in place of the panel title, and the chat itself when its tab is on. */
  tabs?: ReactNode
  api: StudioApi
  slug: string
  threads: Thread[]
  me: string | null
  canComment: boolean
  isTeam: boolean
  draft: Draft | null
  setDraft(d: Draft | null): void
  onStartComment(): void
  hidden: boolean
  setHidden(v: boolean): void
  panelOpen: boolean
  setPanelOpen(v: boolean): void
  onCreate(c: { x: number; y: number; elementId: string | null; text: string }): Promise<Thread | null>
  onUpdate(id: string, change: Change): Promise<boolean>
  /** People of the board beyond the threads' authors (who is here now), for `@` (HRN-1452). */
  people?: readonly string[]
  /** The agent can be called here (the harnessly app view): `@harnessly` is offered first. */
  agent?: boolean
  /** A thread to open (HRN-1469): from the address (`?thread=`) or the app view; `n` opens it again when asked again. */
  focus?: { id: string; n: number } | null
}

/** Who `@` offers, for the inputs and the chips of the sent messages. */
const Mentionable = createContext<readonly Candidate[]>([])

const MAX_TEXT = 2000
/** Memory slot for the text of a thread that does not exist yet. */
const NEW = '\u0000new'
/** Pin + card width, used to frame both when jumping to a thread from the panel. */
const CARD_SPAN = 340
const PANEL_SPAN = 352

const sceneOf = (api: StudioApi) => api.getSceneElements() as unknown as SceneEl[]

/** Where a new thread goes when the user clicks (x, y) in scene coordinates. */
export function draftAt(api: StudioApi, x: number, y: number): Draft {
  return draftFrom(sceneOf(api), x, y)
}

// ── Small hooks ─────────────────────────────────────────────────────────────

const PHONE = '(max-width: 640px)'
function subscribePhone(listener: () => void) {
  const query = window.matchMedia?.(PHONE)
  query?.addEventListener('change', listener)
  return () => query?.removeEventListener('change', listener)
}
/** Phones get bottom sheets instead of floating cards. */
const usePhone = () => useSyncExternalStore(subscribePhone, () => Boolean(window.matchMedia?.(PHONE).matches))

/** Relative times ("5 min") must move on even when nothing else changes. */
function useNow(every = 30_000) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), every)
    return () => clearInterval(timer)
  }, [every])
  return now
}

function readSeen(slug: string): Seen {
  try {
    return parseSeen(localStorage.getItem(seenKey(slug)))
  } catch {
    // Storage blocked (private mode, sandboxed frame): every thread just looks new.
    return {}
  }
}
function writeSeen(slug: string, seen: Seen) {
  try {
    localStorage.setItem(seenKey(slug), JSON.stringify(seen))
  } catch {
    // Same as above: the "new" dot is a convenience, losing it is fine.
  }
}

/** Centre the view so the pin and its card (or sheet) are both visible, gliding like Excalidraw's own jumps. */
function scrollToPin(api: StudioApi, p: Point, phone: boolean, panelOpen: boolean) {
  const v = getView()
  const target = focusPoint(p, v, phone ? { sheet: true } : { right: panelOpen ? PANEL_SPAN : 0, card: CARD_SPAN })
  // scrollToContent takes elements; a throwaway 2×2 box marks the point (the editor's search does the same).
  const [box] = convertToExcalidrawElements([{ type: 'rectangle', x: target.x - 1, y: target.y - 1, width: 2, height: 2 }] as never)
  api.scrollToContent([box] as never, { fitToContent: false, animate: true })
}

// ── Icons ───────────────────────────────────────────────────────────────────

function Glyph({ d, size = 16 }: { d: string; size?: number }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}
const ICON = {
  comment: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20l1.1-4.6A8.4 8.4 0 1 1 21 11.5z',
  close: 'M6 6l12 12 M18 6L6 18',
  reply: 'M9 14L4 9l5-5 M4 9h10.5A5.5 5.5 0 0 1 20 14.5V20',
  trash: 'M4 7h16 M10 11v6 M14 11v6 M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12 M9 7V4h6v3',
  send: 'M12 19V5 M6 11l6-6 6 6',
  plus: 'M12 5v14 M5 12h14',
  eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeOff: 'M3 3l18 18 M10.6 5.1A10 10 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4 M6.6 6.6A17 17 0 0 0 2 12s3.6 7 10 7a9.6 9.6 0 0 0 5.4-1.6 M9.9 9.9a3 3 0 0 0 4.2 4.2',
  chevron: 'M9 6l6 6-6 6',
  check: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z M8.5 12.5l2.5 2.5 5-5.5',
  locate: 'M12 19a7 7 0 1 0 0-14 7 7 0 0 0 0 14z M12 2v3 M12 19v3 M2 12h3 M19 12h3',
}

// ── Button in the right island ──────────────────────────────────────────────

/** Opens the comments panel; the badge counts open threads. Same look as every island button. */
export function CommentsButton({ count, open, onClick }: { count: number; open: boolean; onClick(): void }) {
  return (
    <BarButton label={count ? t('comments.buttonOpen', { count }) : t('comments.title')} on={open} onClick={onClick}>
      <Glyph d={ICON.comment} size={18} />
      {count > 0 && <span className="note-count">{count > 99 ? '99+' : count}</span>}
    </BarButton>
  )
}

function Avatar({ name, small }: { name: string; small?: boolean }) {
  return (
    <span className={`note-avatar${small ? ' note-avatar--small' : ''}`} style={{ background: pinColor(name) }} aria-hidden>
      {initialOf(name)}
    </span>
  )
}

function Who({ message }: { message: Pick<Message, 'author' | 'authorKind'> }) {
  return (
    <>
      <span className="note-who">{displayName(message.author)}</span>
      {message.authorKind === 'agent' && <span className="note-badge">{t('comments.badgeAgent')}</span>}
      {isGuest(message.author) && <span className="note-badge note-badge--quiet">{t('comments.badgeGuest')}</span>}
    </>
  )
}

// ── Text input shared by the composer and the reply box ─────────────────────

function TextBox({ value, onChange, onSend, onEscape, placeholder, autoFocus, busy, label }: { value: string; onChange(v: string): void; onSend(text: string): void; onEscape(): void; placeholder: string; autoFocus?: boolean; busy: boolean; label: string }) {
  const ref = useRef<HTMLTextAreaElement>(null)
  // Grow with the text up to a few lines, then scroll: a fixed one-liner hid long comments.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 140)}px`
  }, [value])
  useEffect(() => {
    const el = ref.current
    if (!autoFocus || !el) return
    const focus = () => {
      el.focus()
      // Restored draft text: put the caret at the end, where the user left off.
      el.setSelectionRange(el.value.length, el.value.length)
    }
    focus()
    // The composer mounts on pointerdown (comment tool), and the editor focuses
    // its own container when the pointer goes up. Take focus back once that
    // gesture is over, or the first keystrokes go to the canvas shortcuts.
    let timer: ReturnType<typeof setTimeout> | undefined
    const onUp = () => {
      timer = setTimeout(focus)
    }
    window.addEventListener('pointerup', onUp, { capture: true, once: true })
    const stop = setTimeout(() => window.removeEventListener('pointerup', onUp, { capture: true }), 1000)
    return () => {
      clearTimeout(timer)
      clearTimeout(stop)
      window.removeEventListener('pointerup', onUp, { capture: true })
    }
  }, [autoFocus])
  const send = () => {
    const text = value.trim()
    if (text && !busy) onSend(text)
  }
  // `@`: the list of who can be called, under the caret's word; arrows move, Enter or Tab picks, Escape closes.
  const known = useContext(Mentionable)
  const [caret, setCaret] = useState(0)
  const [active, setActive] = useState(0)
  const [dismissed, setDismissed] = useState<number | null>(null)
  const query = mentionQuery(value, caret)
  const offered = query && dismissed !== query.start ? suggest(query.query, known) : []
  const listOpen = offered.length > 0
  const at = Math.min(active, Math.max(offered.length - 1, 0))
  const pickMention = (c: Candidate) => {
    if (!query) return
    const next = insertMention(value, query.start, caret, c.name)
    onChange(next.text)
    setCaret(next.caret)
    setActive(0)
    requestAnimationFrame(() => {
      ref.current?.focus()
      ref.current?.setSelectionRange(next.caret, next.caret)
    })
  }
  const track = (el: HTMLTextAreaElement) => setCaret(el.selectionStart ?? el.value.length)
  return (
    <div className="note-input">
      {listOpen && (
        <div className="note-mentions" role="listbox" aria-label={t('comments.mention')}>
          {offered.map((c, i) => (
            <button
              key={c.name}
              type="button"
              role="option"
              aria-selected={i === at}
              className={`note-mentions__item${i === at ? ' is-on' : ''}`}
              onPointerDown={(e) => e.preventDefault()}
              onClick={() => pickMention(c)}
              onPointerEnter={() => setActive(i)}
            >
              {c.agent ? <span className="note-avatar note-avatar--small note-avatar--agent" aria-hidden>h</span> : <Avatar name={c.name} small />}
              <span className="note-mentions__name">{c.agent ? `@${c.name}` : c.name}</span>
              {c.agent && <span className="note-mentions__hint">{t('comments.mentionAgent')}</span>}
            </button>
          ))}
        </div>
      )}
      <textarea
        ref={ref}
        rows={1}
        value={value}
        maxLength={MAX_TEXT}
        placeholder={placeholder}
        aria-label={label}
        aria-expanded={listOpen}
        onChange={(e) => {
          onChange(e.target.value)
          track(e.target)
          setDismissed(null)
        }}
        onSelect={(e) => track(e.currentTarget)}
        onKeyDown={(e) => {
          if (listOpen && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
            e.preventDefault()
            const step = e.key === 'ArrowDown' ? 1 : -1
            setActive((at + step + offered.length) % offered.length)
            return
          }
          if (listOpen && (e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            pickMention(offered[at])
            return
          }
          if (listOpen && e.key === 'Escape') {
            e.preventDefault()
            e.stopPropagation()
            setDismissed(query?.start ?? null)
            return
          }
          if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
            e.preventDefault()
            send()
          } else if (e.key === 'Escape') {
            // Keep Escape away from the editor and the tool shortcut in main.tsx: here it only cancels typing.
            e.preventDefault()
            e.stopPropagation()
            onEscape()
          }
        }}
      />
      <button type="button" className="note-send" disabled={!value.trim() || busy} onClick={send} aria-label={t('comments.send')} title={t('comments.sendHint')}>
        <Glyph d={ICON.send} />
      </button>
    </div>
  )
}

// ── Pins ────────────────────────────────────────────────────────────────────

type PinProps = {
  id: string
  x: number
  y: number
  author: string
  text: string
  replies: number
  unseen: boolean
  active: boolean
  resolved: boolean
  movable: boolean
  onOpen(id: string): void
  onMove(id: string, to: Point): void
}

/**
 * One pin. Its tip is the thread's point (bottom-left corner of the bubble).
 * Dragging uses pointer events with capture, so mouse, pen and touch behave the
 * same; a move below the threshold still counts as a click.
 */
const Pin = memo(function Pin({ id, x, y, author, text, replies, unseen, active, resolved, movable, onOpen, onMove }: PinProps) {
  const [shift, setShift] = useState<{ dx: number; dy: number } | null>(null)
  const drag = useRef<{ pointer: number; sx: number; sy: number; moved: boolean } | null>(null)
  const swallowClick = useRef(false)
  return (
    <div className="camera-fixed" style={{ left: x, top: y }}>
      <button
        type="button"
        className={`note-pin${active ? ' is-active' : ''}${resolved ? ' is-resolved' : ''}${shift ? ' is-dragging' : ''}`}
        style={{ background: pinColor(author), transform: shift ? `translate(${shift.dx}px, ${shift.dy}px)` : undefined }}
        title={`${displayName(author)}: ${excerpt(text, 100)}`}
        aria-label={`${t('comments.pinLabel', { name: displayName(author) })}${replies ? t('comments.pinReplies', { count: replies }) : ''}${unseen ? t('comments.pinNew') : ''}`}
        aria-expanded={active}
        onPointerDown={(e) => {
          swallowClick.current = false
          if (!movable || e.button !== 0) return
          drag.current = { pointer: e.pointerId, sx: e.clientX, sy: e.clientY, moved: false }
          e.currentTarget.setPointerCapture(e.pointerId)
        }}
        onPointerMove={(e) => {
          const d = drag.current
          if (!d || d.pointer !== e.pointerId) return
          const dx = e.clientX - d.sx
          const dy = e.clientY - d.sy
          if (!d.moved && !isDrag(dx, dy)) return
          d.moved = true
          setShift({ dx, dy })
        }}
        onPointerUp={(e) => {
          const d = drag.current
          if (!d || d.pointer !== e.pointerId) return
          drag.current = null
          if (!d.moved) return
          swallowClick.current = true
          setShift(null)
          // The pin is drawn at constant screen size, but the move is in scene units.
          const zoom = getView().zoom || 1
          onMove(id, { x: x + (e.clientX - d.sx) / zoom, y: y + (e.clientY - d.sy) / zoom })
        }}
        onPointerCancel={() => {
          drag.current = null
          setShift(null)
        }}
        onClick={() => {
          if (swallowClick.current) {
            swallowClick.current = false
            return
          }
          onOpen(id)
        }}
      >
        <span className="note-pin__initial">{initialOf(author)}</span>
        {replies > 0 && <span className="note-pin__count">{replies}</span>}
        {unseen && <span className="note-pin__dot" />}
      </button>
    </div>
  )
})

/** The thread card on desktop: in the camera layer next to its pin, nudged to stay on screen. */
function CardSpot({ at, children }: { at: Point; children: ReactNode }) {
  const view = useView()
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState({ width: 296, height: 220 })
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      const next = { width: el.offsetWidth, height: el.offsetHeight }
      setSize((prev) => (prev.width === next.width && prev.height === next.height ? prev : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    // The camera layer forwards every wheel to the canvas. Over the card a plain
    // wheel must scroll the messages instead; pinch / Ctrl+wheel still passes
    // through, so it zooms the board (main.tsx), never the page.
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation()
    }
    el.addEventListener('wheel', onWheel, { passive: true })
    return () => {
      observer.disconnect()
      el.removeEventListener('wheel', onWheel)
    }
  }, [])
  const { dx, dy } = cardOffset(toScreen(at.x, at.y, view), size, view, { pinSize: 26 })
  return (
    <div className="camera-fixed" style={{ left: at.x, top: at.y }}>
      <div ref={ref} className="note-card" style={{ left: dx, top: dy }} role="dialog" aria-label={t('comments.thread')}>
        {children}
      </div>
    </div>
  )
}

type LayerProps = {
  api: StudioApi
  threads: Thread[]
  hidden: boolean
  openId: string | null
  draft: Draft | null
  draftAuthor: string
  moved: Record<string, Point>
  seen: Seen
  me: string | null
  movable: boolean
  card: ReactNode
  onOpen(id: string): void
  onMove(id: string, to: Point): void
}

/**
 * Pins, the draft pin and the desktop card. Subscribes to the scene version so
 * anchored pins follow their shapes; only pins near the viewport get DOM nodes.
 */
function NoteLayer({ api, threads, hidden, openId, draft, draftAuthor, moved, seen, me, movable, card, onOpen, onMove }: LayerProps) {
  const version = useSceneVersion()
  const near = useSceneWindow()
  const points = useMemo(() => {
    const byId = new Map<string, SceneEl>()
    if (threads.some((t) => t.elementId)) for (const el of sceneOf(api)) byId.set(el.id, el)
    const out = new Map<string, Point>()
    for (const t of threads) out.set(t.id, moved[t.id] ?? pinPoint(t, byId))
    return out
    // `version` is the signal that shapes moved; the elements themselves are read from the API.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, threads, moved, version])
  const open = openId ? threads.find((t) => t.id === openId) : undefined
  const openAt = open ? points.get(open.id) : undefined
  return (
    <CameraLayer className="note-layer">
      {!hidden &&
        threads.map((t) => {
          // Resolved threads stay in the panel only, unless one is open right now.
          if (t.resolved && t.id !== openId) return null
          const p = points.get(t.id)!
          if (t.id !== openId && !inWindow(near, p.x, p.y, p.x, p.y)) return null
          const first = t.messages[0]
          return (
            <Pin
              key={t.id}
              id={t.id}
              x={p.x}
              y={p.y}
              author={first?.author ?? t.author}
              text={first?.text ?? ''}
              replies={replyCount(t)}
              unseen={isUnseen(t, seen, me)}
              active={t.id === openId}
              resolved={t.resolved}
              movable={movable}
              onOpen={onOpen}
              onMove={onMove}
            />
          )
        })}
      {draft && (
        <div className="camera-fixed" style={{ left: draft.x, top: draft.y }}>
          <span className="note-pin note-pin--draft" style={{ background: pinColor(draftAuthor) }} aria-hidden>
            <span className="note-pin__initial">{draftAuthor ? initialOf(draftAuthor) : '+'}</span>
          </span>
        </div>
      )}
      {card && openAt && <CardSpot at={openAt}>{card}</CardSpot>}
    </CameraLayer>
  )
}

// ── Thread card ─────────────────────────────────────────────────────────────

type Unsent = { text: string; replyTo?: string }

type CardProps = {
  api: StudioApi
  thread: Thread
  me: string | null
  isTeam: boolean
  canComment: boolean
  memory: Map<string, Unsent>
  onUpdate(id: string, change: Change): Promise<boolean>
  onClose(): void
}

function ThreadBody({ api, thread, me, isTeam, canComment, memory, onUpdate, onClose }: CardProps) {
  useSceneVersion() // the header names the shape; keep it current when the label is edited
  const now = useNow()
  const saved = memory.get(thread.id)
  const [text, setTextRaw] = useState(saved?.text ?? '')
  const [replyTo, setReplyToRaw] = useState<string | undefined>(saved?.replyTo)
  const [busy, setBusy] = useState(false)
  const [armed, setArmed] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Unsent text survives closing the card: kept per thread in memory, not on the server.
  const remember = (next: Unsent) => {
    if (next.text || next.replyTo) memory.set(thread.id, next)
    else memory.delete(thread.id)
  }
  const setText = (value: string) => {
    setTextRaw(value)
    remember({ text: value, replyTo })
  }
  const setReplyTo = (id: string | undefined) => {
    setReplyToRaw(id)
    remember({ text, replyTo: id })
  }

  const byId = useMemo(() => new Map(thread.messages.map((m) => [m.id, m])), [thread.messages])
  // A message being answered can be deleted by someone else meanwhile.
  const target = replyTo ? byId.get(replyTo) : undefined

  // Newest message in view on open and when one arrives.
  useLayoutEffect(() => {
    const list = listRef.current
    if (list) list.scrollTop = list.scrollHeight
  }, [thread.messages.length])

  // The first click on Delete only arms it; it disarms by itself if not confirmed.
  useEffect(() => {
    if (!armed) return
    const timer = setTimeout(() => setArmed(null), 4000)
    return () => clearTimeout(timer)
  }, [armed])
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(null), 1600)
    return () => clearTimeout(timer)
  }, [flash])

  const jumpTo = (id: string) => {
    listRef.current?.querySelector<HTMLElement>(`[data-message="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    setFlash(id)
  }

  const send = async (value: string) => {
    setBusy(true)
    const ok = await onUpdate(thread.id, target ? { reply: value, replyTo: target.id } : { reply: value })
    setBusy(false)
    if (!ok) return
    commentCall(value, { x: thread.x, y: thread.y, thread: thread.id })
    setTextRaw('')
    setReplyToRaw(undefined)
    memory.delete(thread.id)
  }

  const remove = async (m: Message, index: number) => {
    if (armed !== m.id) return setArmed(m.id)
    setArmed(null)
    const ok = await onUpdate(thread.id, { removeMessage: m.id })
    // Deleting the first message deletes the thread itself.
    if (ok && index === 0) {
      memory.delete(thread.id)
      onClose()
    }
  }

  return (
    <>
      <div className="note-card__head">
        <span className="note-card__place">{placeName(sceneOf(api), thread.elementId, t)}</span>
        {thread.resolved && <span className="note-badge note-badge--done">{t('comments.resolvedBadge')}</span>}
        {canComment && (
          <button
            type="button"
            className={`icon-button note-card__resolve${thread.resolved ? ' is-on' : ''}`}
            onClick={() => {
              void onUpdate(thread.id, { resolved: !thread.resolved })
              if (!thread.resolved) onClose()
            }}
            aria-label={thread.resolved ? t('comments.reopen') : t('comments.resolve')}
            title={thread.resolved ? t('comments.reopenHint') : t('comments.resolveHint')}
          >
            <Glyph d={ICON.check} />
          </button>
        )}
        <button type="button" className="icon-button" onClick={onClose} aria-label={t('comments.close')} title={t('comments.close')}>
          <Glyph d={ICON.close} />
        </button>
      </div>
      <div className="note-card__list" ref={listRef}>
        {thread.messages.map((m, i) => {
          const original = m.replyTo ? byId.get(m.replyTo) : undefined
          const deletable = canComment && canDelete(m, me, isTeam)
          return (
            <div key={m.id} data-message={m.id} className={`note-msg${flash === m.id ? ' is-flash' : ''}`}>
              <Avatar name={m.author} />
              <div className="note-msg__body">
                <div className="note-msg__meta">
                  <Who message={m} />
                  <time className="note-msg__time" dateTime={m.at} title={fullTime(m.at, dateLocale)}>
                    {relativeTime(m.at, now, t, dateLocale)}
                  </time>
                  {canComment && (
                    <span className="note-msg__actions">
                      <button type="button" className="icon-button" onClick={() => setReplyTo(m.id)} aria-label={t('comments.replyTo', { name: displayName(m.author) })} title={t('comments.reply')}>
                        <Glyph d={ICON.reply} size={14} />
                      </button>
                      {deletable && (
                        <button
                          type="button"
                          className={`icon-button note-delete${armed === m.id ? ' is-armed' : ''}`}
                          onClick={() => void remove(m, i)}
                          onBlur={() => armed === m.id && setArmed(null)}
                          aria-label={armed === m.id ? t('comments.confirmDelete') : i === 0 ? t('comments.deleteThread') : t('comments.deleteMessage')}
                          title={i === 0 ? t('comments.deleteThread') : t('comments.deleteMessage')}
                        >
                          {armed === m.id ? t('comments.deleteAsk') : <Glyph d={ICON.trash} size={14} />}
                        </button>
                      )}
                    </span>
                  )}
                </div>
                {m.replyTo &&
                  (original ? (
                    <button type="button" className="note-quote" onClick={() => jumpTo(original.id)} title={t('comments.showOriginal')}>
                      <b>{displayName(original.author)}</b> {excerpt(original.text, 80)}
                    </button>
                  ) : (
                    <span className="note-quote note-quote--gone">{t('comments.replyToDeleted')}</span>
                  ))}
                <div className="note-msg__text">
                  <MessageText text={m.text} />
                </div>
                {m.ids && m.ids.length > 0 && (
                  <button type="button" className="note-show" onClick={() => showOnBoard(api, m.ids!)}>
                    <Glyph d={ICON.locate} size={14} />
                    {t('comments.showOnBoard')}
                  </button>
                )}
              </div>
            </div>
          )
        })}
        {agentTyping(thread, now) && (
          <div className="note-typing" role="status">
            <span className="note-typing__orb" aria-hidden="true" />
            {t('comments.agentTyping')}
            <span className="note-typing__dots" aria-hidden="true">
              <i />
              <i />
              <i />
            </span>
          </div>
        )}
      </div>
      <div className="note-rx">
        {reactionsOf(thread).map(([emoji, who]) => {
          const mine = Boolean(me && who.includes(me))
          return (
            <button
              key={emoji}
              type="button"
              className={`note-rx__pill${mine ? ' is-on' : ''}`}
              disabled={!canComment}
              onClick={() => void onUpdate(thread.id, { react: { emoji, on: !mine } })}
              title={who.length ? who.map(displayName).join(', ') : t('comments.react')}
            >
              <span aria-hidden="true">{emoji}</span>
              {who.length > 0 && <span>{who.length}</span>}
            </button>
          )
        })}
      </div>
      {thread.resolved && thread.resolvedBy && <div className="note-card__note">{t('comments.resolvedBy', { name: displayName(thread.resolvedBy) })}</div>}
      {canComment && (
        <div className="note-card__foot">
          {target && (
            <div className="note-replying">
              <span>
                {t('comments.replyingTo')} <b>{displayName(target.author)}</b>: {excerpt(target.text, 60)}
              </span>
              <button type="button" className="icon-button" onClick={() => setReplyTo(undefined)} aria-label={t('comments.dontReply')} title={t('comments.cancelReply')}>
                <Glyph d={ICON.close} size={14} />
              </button>
            </div>
          )}
          <TextBox value={text} onChange={setText} onSend={send} onEscape={onClose} placeholder={t('comments.reply')} label={t('comments.reply')} busy={busy} autoFocus={Boolean(target)} />
        </div>
      )}
    </>
  )
}

/** The thread's reactions to show: those it has, and 👍 to start with. */
function reactionsOf(thread: Thread): [string, string[]][] {
  const list = Object.entries(thread.reactions ?? {}).filter(([, who]) => who.length > 0)
  return list.some(([e]) => e === '👍') ? list : [['👍', []], ...list]
}

/** The agent was called in the last message a moment ago and has not answered yet. */
const CALL = /(^|\s)@(harnessly|агент|agent)\b/i
function agentTyping(thread: Thread, now: number) {
  const last = thread.messages[thread.messages.length - 1]
  if (!last || last.authorKind === 'agent' || !CALL.test(last.text)) return false
  return now - Date.parse(last.at) < 120_000
}

/** Brings the view to the objects a reply is about and outlines them. */
function showOnBoard(api: StudioApi, ids: string[]) {
  const want = new Set(ids)
  const els = sceneOf(api).filter((el) => want.has(el.id))
  if (!els.length) return
  api.scrollToContent(els as never, { fitToContent: els.length > 1, animate: true })
  glow(els as never)
}

/** A message with its mentions as chips; the rest as typed. */
function MessageText({ text }: { text: string }) {
  const known = useContext(Mentionable)
  return (
    <>
      {splitMentions(text, known).map((part, i) =>
        part.mention ? (
          <span key={i} className={`note-mention${part.mention.agent ? ' note-mention--agent' : ''}`}>
            {part.text}
          </span>
        ) : (
          <span key={i}>{part.text}</span>
        ),
      )}
    </>
  )
}

/** On phones the card is a bottom sheet outside the camera layer. */
function Sheet({ children }: { children: ReactNode }) {
  return createPortal(
    <div className="note-card note-card--sheet" role="dialog" aria-label={t('comments.thread')}>
      {children}
    </div>,
    document.body,
  )
}

// ── Composer ────────────────────────────────────────────────────────────────

function Composer({ api, draft, memory, onSend, onCancel }: { api: StudioApi; draft: Draft; memory: Map<string, Unsent>; onSend(text: string): Promise<boolean>; onCancel(): void }) {
  const [text, setText] = useState(memory.get(NEW)?.text ?? '')
  const [busy, setBusy] = useState(false)
  const change = (value: string) => {
    setText(value)
    if (value) memory.set(NEW, { text: value })
    else memory.delete(NEW)
  }
  return (
    <div className="note-composer" role="dialog" aria-label={t('comments.newComment')}>
      <div className="note-composer__head">
        <span>
          {t('comments.newComment')} · <span className="note-composer__place">{placeName(sceneOf(api), draft.elementId, t)}</span>
        </span>
        <button type="button" className="icon-button" onClick={onCancel} aria-label={t('comments.cancel')} title={t('comments.cancelHint')}>
          <Glyph d={ICON.close} />
        </button>
      </div>
      <TextBox
        value={text}
        onChange={change}
        onEscape={onCancel}
        placeholder={t('comments.addComment')}
        label={t('comments.comment')}
        busy={busy}
        autoFocus
        onSend={async (value) => {
          setBusy(true)
          const ok = await onSend(value)
          // On success the composer unmounts; on failure the text stays for another try.
          if (!ok) setBusy(false)
        }}
      />
    </div>
  )
}

// ── Panel ───────────────────────────────────────────────────────────────────

type PanelProps = {
  tabs?: ReactNode
  threads: Thread[]
  openId: string | null
  seen: Seen
  me: string | null
  canComment: boolean
  hidden: boolean
  setHidden(v: boolean): void
  onPick(t: Thread): void
  onUpdate(id: string, change: Change): Promise<boolean>
  onStartComment(): void
  onClose(): void
}

function Row({ thread, active, unseen, now, canComment, onPick, onUpdate }: { thread: Thread; active: boolean; unseen: boolean; now: number; canComment: boolean; onPick(t: Thread): void; onUpdate: PanelProps['onUpdate'] }) {
  const first = thread.messages[0]
  const last = thread.messages[thread.messages.length - 1]
  const replies = replyCount(thread)
  const author = first?.author ?? thread.author
  return (
    <div
      className={`note-row${active ? ' is-on' : ''}${thread.resolved ? ' is-resolved' : ''}`}
      role="button"
      tabIndex={0}
      onClick={() => onPick(thread)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== 'Enter' && e.key !== ' ')) return
        e.preventDefault()
        onPick(thread)
      }}
    >
      <Avatar name={author} small />
      <div className="note-row__body">
        <div className="note-row__meta">
          <span className="note-who">{displayName(author)}</span>
          <time dateTime={last?.at ?? thread.createdAt} title={fullTime(last?.at ?? thread.createdAt, dateLocale)}>
            {relativeTime(last?.at ?? thread.createdAt, now, t, dateLocale)}
          </time>
          {unseen && <span className="note-dot" aria-label={t('comments.new')} />}
        </div>
        <div className="note-row__text">{excerpt(first?.text ?? '', 140)}</div>
        {replies > 0 && <div className="note-row__replies">{t('comments.replies', { count: replies })}</div>}
      </div>
      {canComment && (
        <button
          type="button"
          className="note-row__action"
          onClick={(e) => {
            e.stopPropagation()
            void onUpdate(thread.id, { resolved: !thread.resolved })
          }}
          title={thread.resolved ? t('comments.reopenHint') : t('comments.resolveHint')}
        >
          {thread.resolved ? t('comments.reopen') : t('comments.resolve')}
        </button>
      )}
    </div>
  )
}

type Filter = 'open' | 'resolved' | 'mine'

/** Threads where I wrote or where I am called by name. */
function mine(thread: Thread, me: string | null) {
  if (!me) return false
  const name = displayName(me).toLowerCase()
  return thread.messages.some((m) => m.author === me || m.text.toLowerCase().includes(`@${name}`))
}

function Panel({ tabs, threads, openId, seen, me, canComment, hidden, setHidden, onPick, onUpdate, onStartComment, onClose }: PanelProps) {
  const now = useNow()
  const [filter, setFilter] = useState<Filter>('open')
  const { open, resolved } = useMemo(() => sortThreads(threads), [threads])
  const shown = filter === 'open' ? open : filter === 'resolved' ? resolved : [...open, ...resolved].filter((th) => mine(th, me))
  const row = (t: Thread) => <Row key={t.id} thread={t} active={t.id === openId} unseen={isUnseen(t, seen, me)} now={now} canComment={canComment} onPick={onPick} onUpdate={onUpdate} />
  const filters: { id: Filter; label: string }[] = [
    { id: 'open', label: t('comments.filterOpen') },
    { id: 'resolved', label: t('comments.filterResolved') },
    ...(me ? [{ id: 'mine' as const, label: t('comments.filterMine') }] : []),
  ]
  return (
    <aside className={`note-panel${tabs ? ' note-panel--island' : ''}`} aria-label={t('comments.title')}>
      <div className="note-panel__head">
        {tabs ?? <strong>{t('comments.title')}</strong>}
        {!tabs && open.length > 0 && <span className="note-panel__count">{open.length}</span>}
        <span className="note-panel__tools">
          {canComment && (
            <button type="button" className="icon-button" onClick={onStartComment} aria-label={t('comments.newComment')} title={t('comments.newCommentHint')}>
              <Glyph d={ICON.plus} />
            </button>
          )}
          <button type="button" className={`icon-button${hidden ? ' is-off' : ''}`} onClick={() => setHidden(!hidden)} aria-pressed={!hidden} aria-label={hidden ? t('comments.showPins') : t('comments.hidePins')} title={hidden ? t('comments.showPinsHint') : t('comments.hidePinsHint')}>
            <Glyph d={hidden ? ICON.eyeOff : ICON.eye} />
          </button>
          <button type="button" className="icon-button" onClick={onClose} aria-label={t('comments.close')} title={t('comments.close')}>
            <Glyph d={ICON.close} />
          </button>
        </span>
      </div>
      <div className="note-filter" role="tablist">
        {filters.map((f) => (
          <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'is-on' : ''} onClick={() => setFilter(f.id)}>
            {f.label}
            {f.id === 'open' && open.length > 0 && <span className="note-filter__n">{open.length}</span>}
          </button>
        ))}
      </div>
      <div className="note-panel__list">
        {shown.map(row)}
        {!shown.length && (
          <div className="note-empty">
            {filter === 'open' && (resolved.length ? <p>{t('comments.noOpen')}</p> : <p>{t('comments.none')}</p>)}
            {filter === 'resolved' && <p>{t('comments.noResolved')}</p>}
            {filter === 'mine' && <p>{t('comments.noMine')}</p>}
            {filter === 'open' && canComment && <p>{t('comments.emptyHint')}</p>}
            {filter === 'open' && canComment && (
              <button type="button" className="board-button board-button--ghost" onClick={onStartComment}>
                {t('comments.addComment')}
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}

// ── Root ────────────────────────────────────────────────────────────────────

export function Comments({ tabs, api, slug, threads, me, canComment, isTeam, draft, setDraft, onStartComment, hidden, setHidden, panelOpen, setPanelOpen, onCreate, onUpdate, people = [], agent = false, focus = null }: CommentsProps) {
  const phone = usePhone()
  // The people of the board: who wrote in its threads and who is here now; the agent first where it answers.
  const mentionable = useMemo(
    () => candidates([...threads.flatMap((th) => th.messages.filter((msg) => msg.authorKind !== 'agent' && !isGuest(msg.author)).map((msg) => msg.author)), ...people], me, agent),
    [threads, people, me, agent],
  )
  const [openId, setOpenId] = useState<string | null>(null)
  const [seen, setSeen] = useState<Seen>(() => readSeen(slug))
  // Pins dropped but not yet confirmed by the server: shown at the drop point, not snapped back.
  const [moved, setMoved] = useState<Record<string, Point>>({})
  const memory = useRef(new Map<string, Unsent>()).current

  // Derived, not synced: a thread deleted elsewhere simply closes its card.
  const open = openId ? threads.find((t) => t.id === openId) ?? null : null

  // A new draft replaces the open card.
  useEffect(() => {
    if (draft) setOpenId(null)
  }, [draft])

  // Whatever is open counts as read, including messages that arrive while it is open.
  useEffect(() => {
    if (!open || !isUnseen(open, seen, me)) return
    const next = markSeen(seen, open, threads)
    setSeen(next)
    writeSeen(slug, next)
  }, [open, seen, me, threads, slug])

  // Click away closes the card and the draft. Capture phase: the canvas stops bubbling.
  const showDraft = Boolean(draft && canComment)
  useEffect(() => {
    if (!openId && !showDraft) return
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest?.('.note-card, .note-composer, .note-pin, .note-panel')) return
      setOpenId(null)
      if (showDraft) setDraft(null)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [openId, showDraft, setDraft])

  const openPin = useCallback(
    (id: string) => {
      setDraft(null)
      setOpenId((prev) => (prev === id ? null : id))
    },
    [setDraft],
  )

  const movePin = useCallback(
    async (id: string, to: Point) => {
      setMoved((prev) => ({ ...prev, [id]: to }))
      // Dropped on a shape, the thread attaches to it and from then on moves with it.
      const { elementId } = draftAt(api, to.x, to.y)
      await onUpdate(id, { x: to.x, y: to.y, elementId })
      setMoved((prev) => {
        const { [id]: _, ...rest } = prev
        return rest
      })
    },
    [api, onUpdate],
  )

  const pick = useCallback(
    (t: Thread) => {
      setHidden(false)
      setDraft(null)
      const byId = new Map(sceneOf(api).map((el) => [el.id, el]))
      scrollToPin(api, pinPoint(t, byId), phone, panelOpen)
      setOpenId(t.id)
      // On a phone the panel and the card are both bottom sheets; the card wins.
      if (phone) setPanelOpen(false)
    },
    [api, phone, panelOpen, setHidden, setDraft, setPanelOpen],
  )

  const create = useCallback(
    async (text: string) => {
      if (!draft) return false
      const thread = await onCreate({ x: draft.x, y: draft.y, elementId: draft.elementId, text })
      if (!thread) return false
      // `@harnessly` in a new comment calls the agent of the app view to this place.
      commentCall(text, { x: draft.x, y: draft.y, thread: thread.id })
      memory.delete(NEW)
      setDraft(null)
      setOpenId(thread.id)
      return true
    },
    [draft, onCreate, setDraft, memory],
  )

  const closeCard = useCallback(() => setOpenId(null), [])

  // A thread asked for from outside (a mention in the bell, HRN-1469) opens once it is on the board.
  const focused = useRef<number | null>(null)
  useEffect(() => {
    if (!focus || !api || focused.current === focus.n) return
    const th = threads.find((t) => t.id === focus.id)
    if (!th) return
    focused.current = focus.n
    pick(th)
  }, [focus, api, threads, pick])

  const card = open ? <ThreadBody key={open.id} api={api} thread={open} me={me} isTeam={isTeam} canComment={canComment} memory={memory} onUpdate={onUpdate} onClose={closeCard} /> : null

  return (
    <Mentionable.Provider value={mentionable}>
      <NoteLayer
        api={api}
        threads={threads}
        hidden={hidden}
        openId={openId}
        draft={showDraft ? draft : null}
        draftAuthor={me ?? ''}
        moved={moved}
        seen={seen}
        me={me}
        movable={canComment}
        card={phone ? null : card}
        onOpen={openPin}
        onMove={movePin}
      />
      {phone && card && <Sheet>{card}</Sheet>}
      {showDraft && <Composer key={`${draft!.x}:${draft!.y}`} api={api} draft={draft!} memory={memory} onSend={create} onCancel={() => setDraft(null)} />}
      {panelOpen && (
        <Panel
          tabs={tabs}
          threads={threads}
          openId={openId}
          seen={seen}
          me={me}
          canComment={canComment}
          hidden={hidden}
          setHidden={setHidden}
          onPick={pick}
          onUpdate={onUpdate}
          onStartComment={() => {
            if (phone) setPanelOpen(false)
            onStartComment()
          }}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </Mentionable.Provider>
  )
}
