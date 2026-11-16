/**
 * Studio: what makes a board look good without asking an agent.
 *
 * - FigJam-style stickies: author and 👍 👎 ❤️ reactions on top of the canvas;
 * - a palette of tones rather than loose colours;
 * - board templates and a component library;
 * - the slop check (AI-slop score) linking to the offending elements;
 * - board properties: description, tags, reference.
 *
 * Enabled by the `studio` feature. Palette, templates and the check are shared
 * with the server (shared/), so agents and people draw in one hand and are
 * judged by the same rules.
 */
import { keepsColour } from './islands/dark-paint'
import { memo, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { CameraLayer, inWindow, useSceneVersion, useSceneWindow } from './camera'
import { createPortal } from 'react-dom'
import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { INK, STICKY_COLORS, STYLE, paint } from '../../shared/palette.mjs'
import { sticky as stickySkeleton } from '../../shared/templates.mjs'
import { analyzeSlop } from '../../shared/slop.mjs'
import { locale, t } from './i18n'

/** `prefix` + capitalised id: the catalog key for a palette or template name, e.g. `studio.toneBlue`. */
const nameKey = (prefix: string, id: string) => `studio.${prefix}${id.charAt(0).toUpperCase()}${id.slice(1)}`
/** A translated name for a palette entry or template; unknown ids (added elsewhere) keep their own name. */
export const nameOf = (prefix: string, id: string, fallback: string) => {
  const key = nameKey(prefix, id)
  return t.has(key) ? t(key) : fallback
}

export type El = {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  version: number
  isDeleted?: boolean
  containerId?: string | null
  boundElements?: { id: string; type: string }[] | null
  startBinding?: { elementId: string } | null
  endBinding?: { elementId: string } | null
  frameId?: string | null
  groupIds?: string[]
  customData?: Record<string, unknown>
  backgroundColor?: string
  strokeColor?: string
  text?: string
}
export type StudioApi = {
  getSceneElements(): readonly El[]
  getSceneElementsIncludingDeleted(): readonly El[]
  getAppState(): Record<string, unknown>
  getFiles(): Record<string, unknown>
  updateScene(scene: { elements?: readonly unknown[]; appState?: Record<string, unknown>; captureUpdate?: unknown }): void
  scrollToContent(target?: readonly unknown[], opts?: { fitToContent?: boolean; animate?: boolean }): void
  updateLibrary(opts: { libraryItems: unknown[]; merge?: boolean; openLibraryMenu?: boolean }): Promise<unknown>
  setToast(toast: { message: string; closable?: boolean; duration?: number } | null): void
  setActiveTool(tool: { type: string; customType?: string }): void
}

export const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
export const isSticky = (el: El) => el.customData?.kind === 'sticky'

/** Good-looking from the first click: new shapes are clean, rounded and in Nunito. */
export const STUDIO_APP_STATE = {
  currentItemRoughness: STYLE.roughness,
  currentItemStrokeWidth: STYLE.strokeWidth,
  currentItemFontFamily: STYLE.fontFamily,
  currentItemRoundness: 'round',
  currentItemStrokeColor: INK,
}

function Icon({ d }: { d: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d={d} />
    </svg>
  )
}
const ICONS = {
  palette: 'M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.5 0-1.2-1-1.5-1-2.5s.8-1.5 1.8-1.5H16a5 5 0 0 0 5-5c0-4-4-7.5-9-7.5z M7.5 11.5h.01 M9.5 7.5h.01 M14.5 7.5h.01',
  templates: 'M4 4h7v7H4z M13 4h7v4h-7z M13 10h7v10h-7z M4 13h7v7H4z',
  checkpoints: 'M12 8v4l3 2 M3.5 12a8.5 8.5 0 1 0 2.6-6.1 M3 4v4.5h4.5',
  comment: 'M21 11.5a8.4 8.4 0 0 1-9 8.4 8.6 8.6 0 0 1-3.8-.9L3 20l1.1-4.6A8.4 8.4 0 1 1 21 11.5z',
}

// ── Dock ────────────────────────────────────────────────────────────────────

/** Studio tool: stickies and comments are placed by clicking the board, like Excalidraw shapes. */
export type StudioTool = 'sticky' | 'comment' | null

export function studioTool(api: StudioApi | null): StudioTool {
  const tool = api?.getAppState().activeTool as { type?: string; customType?: string } | undefined
  return tool?.type === 'custom' && (tool.customType === 'sticky' || tool.customType === 'comment') ? tool.customType : null
}

export function setStudioTool(api: StudioApi, tool: StudioTool) {
  api.setActiveTool(tool ? { type: 'custom', customType: tool } : { type: 'selection' })
}

type ToolsProps = {
  tool: StudioTool
  onTool: (tool: StudioTool) => void
  panel: string | null
  setPanel: (p: string | null) => void
  stickyColor: string
  /** Workboard (`workboard` feature): the Checkpoints button and whatever comes next. */
  workboard?: boolean
  children?: ReactNode
}

/**
 * Where the studio buttons live. Excalidraw 0.18 has no API for custom buttons in
 * the shapes toolbar, so on desktop we hook into its markup: our node goes last in
 * the tool row, after "More tools". Excalidraw is pinned to 0.18.1;
 * tests/toolbar-contract.test.mjs fails if the markup we rely on disappears. No
 * toolbar found (phone or different markup) means no node, and the buttons fall
 * back to the bottom dock.
 */
export const TOOLBAR_ROW = '.excalidraw .App-toolbar:not(.App-toolbar--mobile) > .Stack_horizontal'
/**
 * Widths at which the right island fits beside the centred toolbar. The toolbar
 * with our four buttons is 736 px, i.e. 368 each side of the centre, plus gaps.
 * - from BAR_FULL_MIN the full island: three avatars, timer, checkpoints,
 *   comments, check, library, Share — up to 462 px with a running timer;
 * - from TOOLBAR_MIN_WIDTH a compact one: two avatar slots, comments, More and
 *   Share, up to 305 px;
 * - narrower: our tools go to the bottom dock, as on a phone.
 */
const TOOLBAR_MIN_WIDTH = 1400
const BAR_FULL_MIN = 1720
export type BarMode = 'full' | 'compact' | 'dock'
export function useBarMode(slot: HTMLElement | null): BarMode {
  const [wide, setWide] = useState(() => window.innerWidth >= BAR_FULL_MIN)
  useEffect(() => {
    const onResize = () => setWide(window.innerWidth >= BAR_FULL_MIN)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  return !slot ? 'dock' : wide ? 'full' : 'compact'
}

export function useToolbarSlot(enabled: boolean) {
  const [slot, setSlot] = useState<HTMLElement | null>(null)
  useEffect(() => {
    if (!enabled) return
    const node = document.createElement('div')
    node.className = 'studio-toolbar-slot'
    let current: HTMLElement | null = null
    const attach = () => {
      // The observer fires on every editor DOM change — dozens of times a second.
      // Node in place and last in the row: nothing to do.
      if (current && node.isConnected && node.parentElement?.lastElementChild === node && window.innerWidth >= TOOLBAR_MIN_WIDTH) return
      // Below TOOLBAR_MIN_WIDTH the right corner doesn't fit next to the wide centred
      // toolbar, so use the bottom dock as on a phone.
      const row = window.innerWidth >= TOOLBAR_MIN_WIDTH ? document.querySelector(TOOLBAR_ROW) : null
      if (!row) {
        if (current) {
          node.remove()
          current = null
          setSlot(null)
        }
        return
      }
      // Excalidraw re-renders the row itself — keep our node last.
      if (node.parentElement !== row || row.lastElementChild !== node) row.appendChild(node)
      if (current !== node) {
        current = node
        setSlot(node)
      }
    }
    attach()
    const observer = new MutationObserver(attach)
    observer.observe(document.querySelector('.excalidraw') ?? document.body, { childList: true, subtree: true })
    window.addEventListener('resize', attach)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', attach)
      node.remove()
    }
  }, [enabled])
  return slot
}

function ToolButton({ label, title, checked, onClick, children }: { label: string; title: string; checked: boolean; onClick: () => void; children: ReactNode }) {
  // Same markup and classes as Excalidraw's tools: same size, selected state and
  // colours in both themes without custom styles.
  return (
    <label className="ToolIcon Shape studio-tool" title={title}>
      <input className="ToolIcon_type_radio ToolIcon_size_medium" type="checkbox" aria-label={label} checked={checked} onChange={onClick} />
      <div className="ToolIcon__icon" aria-hidden="true">{children}</div>
    </label>
  )
}

/**
 * Studio buttons in Excalidraw's centred toolbar (desktop) — only tools that place
 * and style board content: sticky, comment, templates, palette. Everything "about
 * the board" (timer, checkpoints, comment list, check) lives in the right island;
 * see BarButton and the right-corner markup in main.tsx. Keeping it here made the
 * toolbar 200 px wider and it ran into the participants.
 */
export function ToolbarTools({ tool, onTool, panel, setPanel, stickyColor }: Omit<ToolsProps, 'workboard' | 'children'>) {
  const toggle = (id: string) => setPanel(panel === id ? null : id)
  return (
    <>
      <div className="App-toolbar__divider" />
      <ToolButton label={t('studio.sticky')} title={t('studio.stickyToolTitle')} checked={tool === 'sticky'} onClick={() => onTool(tool === 'sticky' ? null : 'sticky')}>
        <StickyIcon color={stickyColor} />
      </ToolButton>
      <ToolButton label={t('studio.comment')} title={t('studio.commentToolTitle')} checked={tool === 'comment'} onClick={() => onTool(tool === 'comment' ? null : 'comment')}>
        <Icon d={ICONS.comment} />
      </ToolButton>
      <div className="App-toolbar__divider" />
      <ToolButton label={t('studio.templates')} title={t('studio.templatesTitle')} checked={panel === 'templates'} onClick={() => toggle('templates')}>
        <Icon d={ICONS.templates} />
      </ToolButton>
      <ToolButton label={t('studio.palette')} title={t('studio.palette')} checked={panel === 'palette'} onClick={() => toggle('palette')}>
        <Icon d={ICONS.palette} />
      </ToolButton>
    </>
  )
}

/** Right-island button: one size and look for everything there. */
export function BarButton({ label, on, onClick, children }: { label: string; on?: boolean; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" className={`bar-btn${on ? ' is-on' : ''}`} onClick={onClick} title={label} aria-label={label} aria-pressed={Boolean(on)}>
      {children}
    </button>
  )
}
export function CheckpointsIcon() {
  return <Icon d={ICONS.checkpoints} />
}

export type BarMenuItem = { id: string; label: string; icon: ReactNode; hint?: string; onSelect: () => void }
/**
 * The right island's "More" menu: holds what doesn't fit beside the toolbar on
 * screens narrower than BAR_FULL_MIN. Styled like the context menu.
 */
export function BarMenu({ items }: { items: BarMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node) && !(e.target as Element | null)?.closest?.('.bar-btn--more')) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  return (
    <>
      <button type="button" className={`bar-btn bar-btn--more${open ? ' is-on' : ''}`} onClick={() => setOpen(!open)} title={t('studio.moreTitle')} aria-label={t('studio.more')} aria-haspopup="menu" aria-expanded={open}>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
          <circle cx="5.5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="18.5" cy="12" r="1.7" />
        </svg>
      </button>
      {open &&
        createPortal(
          <div ref={ref} className="board-menu bar-menu" role="menu">
            {items.map((item) => (
              <button
                key={item.id}
                type="button"
                role="menuitem"
                className="board-menu__item"
                onClick={() => {
                  setOpen(false)
                  item.onSelect()
                }}
              >
                <span className="board-menu__icon">{item.icon}</span>
                <span className="board-menu__label">{item.label}</span>
                {item.hint && <span className="board-menu__hint">{item.hint}</span>}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  )
}
export const BAR_ICONS = {
  templates: <Icon d={ICONS.templates} />,
  checkpoints: <Icon d={ICONS.checkpoints} />,
  slop: <Icon d="M9 12l2 2 4-4 M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6z" />,
  library: <Icon d="M4 5.5A1.5 1.5 0 0 1 5.5 4H11v16H5.5A1.5 1.5 0 0 1 4 18.5z M13 4h5.5A1.5 1.5 0 0 1 20 5.5v13a1.5 1.5 0 0 1-1.5 1.5H13z" />,
  timer: (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 13V9 M9.5 2.5h5 M12 2.5V5 M18.4 6.6 20 5" />
      <circle cx="12" cy="13" r="8" />
    </svg>
  ),
}

function StickyIcon({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
      <path d="M5 4h14v10l-6 6H5z" fill={color} stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
      <path d="M13 20v-6h6" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    </svg>
  )
}

/** Bottom dock — on phones, where Excalidraw has its own layout. */
export function Dock({ tool, onTool, panel, setPanel, stickyColor, workboard, children }: ToolsProps) {
  const toggle = (id: string) => setPanel(panel === id ? null : id)
  return (
    <div className="studio-dock" role="toolbar" aria-label={t('studio.boardTools')}>
      <button type="button" className={`studio-dock__btn${tool === 'sticky' ? ' is-on' : ''}`} onClick={() => onTool(tool === 'sticky' ? null : 'sticky')} title={t('studio.stickyDockTitle')}>
        <span className="studio-dock__swatch" style={{ background: stickyColor }} />
        <span className="studio-dock__label">{t('studio.sticky')}</span>
      </button>
      <button type="button" className={`studio-dock__btn${panel === 'palette' ? ' is-on' : ''}`} onClick={() => toggle('palette')} title={t('studio.palette')}>
        <Icon d={ICONS.palette} />
        <span className="studio-dock__label">{t('studio.palette')}</span>
      </button>
      <button type="button" className={`studio-dock__btn${panel === 'templates' ? ' is-on' : ''}`} onClick={() => toggle('templates')} title={t('studio.templatesTitle')}>
        <Icon d={ICONS.templates} />
        <span className="studio-dock__label">{t('studio.templates')}</span>
      </button>
      <button type="button" className={`studio-dock__btn${tool === 'comment' ? ' is-on' : ''}`} onClick={() => onTool(tool === 'comment' ? null : 'comment')} title={t('studio.commentDockTitle')}>
        <Icon d={ICONS.comment} />
        <span className="studio-dock__label">{t('studio.comment')}</span>
      </button>
      {workboard && (
        <button type="button" className={`studio-dock__btn${panel === 'checkpoints' ? ' is-on' : ''}`} onClick={() => toggle('checkpoints')} title={t('studio.checkpointsTitle')}>
          <Icon d={ICONS.checkpoints} />
          <span className="studio-dock__label">{t('studio.checkpoints')}</span>
        </button>
      )}
      {children && <span className="studio-dock__sep" />}
      {children}
    </div>
  )
}

// ── Stickies ────────────────────────────────────────────────────────────────

/** A sticky centred on the click point, selected and straight into text editing. */
export function addSticky(api: StudioApi, { fill, author, x, y }: { fill: string; author: string | null; x: number; y: number }) {
  const size = 176
  const colorId = STICKY_COLORS.find((c) => c.fill === fill)?.id ?? 'yellow'
  const skeleton = stickySkeleton(`st-${Math.random().toString(36).slice(2, 10)}`, Math.round(x - size / 2), Math.round(y - size / 2), '', colorId, { author, size })
  const created = convertToExcalidrawElements([skeleton] as never, { regenerateIds: false }) as unknown as El[]
  const box = created.find((el) => el.type === 'rectangle')!
  api.updateScene({
    elements: [...api.getSceneElementsIncludingDeleted(), ...created],
    appState: { selectedElementIds: { [box.id]: true } },
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
  // Enter on a selected labelled shape is Excalidraw's standard way into text editing.
  requestAnimationFrame(() => {
    const target = document.querySelector('.excalidraw') ?? document
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
  })
}

type StickyBox = { id: string; x: number; y: number; width: number; height: number; author: string | null; authorCovered: boolean; reactionsCovered: boolean; surface: boolean }

/** What can cover a sticky's caption: filled shapes and images, not lines or text. */
const COVERING = new Set(['rectangle', 'ellipse', 'diamond', 'image'])
/** Where a sticky's author caption (bottom edge) and reactions (below it) sit, in scene px with margin. */
const AUTHOR_STRIP = 30
/** Room the author caption needs below the sticky's text. */
const AUTHOR_ROOM = 22
const REACTIONS_STRIP = 34
const REACTIONS_WIDTH = 130

function covers(el: El, x1: number, y1: number, x2: number, y2: number) {
  const ex1 = Math.min(el.x, el.x + el.width)
  const ey1 = Math.min(el.y, el.y + el.height)
  return ex1 < x2 && ex1 + Math.abs(el.width) > x1 && ey1 < y2 && ey1 + Math.abs(el.height) > y1
}

/**
 * Author and reactions on top of stickies. A layer over the canvas, not scene
 * elements: reactions are people's votes, and keeping them as board text would
 * let anyone erase someone else's vote with an ordinary edit.
 *
 * The layer is in scene coordinates and follows the canvas via the camera: React
 * doesn't touch it on scroll/zoom, and on edits re-renders only when a sticky
 * itself moved or changed.
 */
/** Dragging more shapes than this hides the sticky captions until the drop. */
const MASS_DRAG = 100

export const StickyOverlay = memo(function StickyOverlay({ api, me, reactions, votes, canReact, onReact }: { api: StudioApi; me: string | null; reactions: string[]; votes: Record<string, Record<string, string[]>>; canReact: boolean; onReact: (id: string, emoji: string, on: boolean) => void }) {
  const version = useSceneVersion()
  const [boxes, setBoxes] = useState<StickyBox[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const signature = useRef('')
  // A large selection being dragged (HRN-1515): the captions hide until the drop instead of being re-laid out for
  // every sticky in every frame; the drop lays them out once.
  const [massDrag, setMassDrag] = useState(false)
  useEffect(() => {
    if (!massDrag) return
    const drop = () => setMassDrag(false)
    window.addEventListener('pointerup', drop)
    window.addEventListener('pointercancel', drop)
    return () => {
      window.removeEventListener('pointerup', drop)
      window.removeEventListener('pointercancel', drop)
    }
  }, [massDrag])
  // Before paint, so a dragged sticky and its caption move together.
  useLayoutEffect(() => {
    const state = api.getAppState()
    if (state.selectedElementsAreBeingDragged && Object.keys((state.selectedElementIds as Record<string, boolean>) ?? {}).length > MASS_DRAG) {
      setMassDrag(true)
      return
    }
    const out: StickyBox[] = []
    let sig = ''
    const all = api.getSceneElements()
    const labels = new Map<string, El>()
    for (const el of all) if (el.type === 'text' && el.containerId) labels.set(el.containerId, el)
    for (let i = 0; i < all.length; i++) {
      const el = all[i]
      if (!isSticky(el)) continue
      const author = (el.customData?.author as string) ?? null
      // Captions are DOM over the canvas and know nothing about z-order. With a
      // sticky or shape on top, the lower sticky's author and reactions showed
      // through the upper one. Don't draw the covered part.
      const bottom = el.y + el.height
      // In a squashed sticky the text reaches the bottom; the author would sit on the last line.
      const label = labels.get(el.id)
      let authorCovered = Boolean(label && label.y + label.height > bottom - AUTHOR_ROOM)
      let reactionsCovered = false
      for (let j = i + 1; j < all.length && !(authorCovered && reactionsCovered); j++) {
        const over = all[j]
        if (!COVERING.has(over.type) || !over.backgroundColor || over.backgroundColor === 'transparent') continue
        if (!authorCovered && covers(over, el.x, bottom - AUTHOR_STRIP, el.x + el.width, bottom)) authorCovered = true
        if (!reactionsCovered && covers(over, el.x, bottom, el.x + Math.min(el.width, REACTIONS_WIDTH), bottom + REACTIONS_STRIP)) reactionsCovered = true
      }
      out.push({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height, author, authorCovered, reactionsCovered, surface: !keepsColour(el.backgroundColor, true) })
      sig += `${el.id}:${el.x}:${el.y}:${el.width}:${el.height}:${author}:${authorCovered ? 1 : 0}${reactionsCovered ? 1 : 0}:${el.backgroundColor}|`
    }
    if (sig === signature.current) return
    signature.current = sig
    setBoxes(out)
  }, [api, version, massDrag])

  // Nodes only for stickies on or near the screen; no point laying out the rest.
  const near = useSceneWindow()
  if (massDrag) return null
  return (
    <CameraLayer className="studio-stickies">
      {boxes.filter((v) => inWindow(near, v.x, v.y, v.x + v.width, v.y + v.height)).map((v) => {
        const mineVotes = votes[v.id] ?? {}
        const shown = reactions.filter((e) => (mineVotes[e]?.length ?? 0) > 0)
        return (
          <div key={v.id} className={`studio-sticky${v.surface ? ' studio-sticky--surface' : ''}`} style={{ left: v.x, top: v.y, width: v.width, height: v.height }}>
            {v.author && !v.authorCovered && <span className="studio-sticky__author" title={t('studio.author', { name: v.author })}>{v.author.replace(/^guest:\s*/, '')}</span>}
            {/* Reactions go below the sticky, as in FigJam: on the sticky they covered the text. */}
            <span className="studio-sticky__reactions" style={v.reactionsCovered ? { display: 'none' } : undefined}>
              {shown.map((emoji) => {
                const names = mineVotes[emoji] ?? []
                const mine = Boolean(me && names.includes(me))
                return (
                  <button type="button" key={emoji} className={`studio-reaction${mine ? ' is-mine' : ''}`} title={names.join(', ')} disabled={!canReact} onClick={() => onReact(v.id, emoji, !mine)}>
                    {emoji} {names.length}
                  </button>
                )
              })}
              {canReact && (
                <span className="studio-reaction-add">
                  <button type="button" className="studio-reaction studio-reaction--add" title={t('studio.react')} onClick={() => setOpen(open === v.id ? null : v.id)}>
                    +
                  </button>
                  {open === v.id && (
                    <span className="studio-reaction-menu">
                      {reactions.map((emoji) => {
                        const mine = Boolean(me && mineVotes[emoji]?.includes(me))
                        return (
                          <button
                            type="button"
                            key={emoji}
                            className={mine ? 'is-mine' : ''}
                            onClick={() => {
                              setOpen(null)
                              onReact(v.id, emoji, !mine)
                            }}
                          >
                            {emoji}
                          </button>
                        )
                      })}
                    </span>
                  )}
                </span>
              )}
            </span>
          </div>
        )
      })}
    </CameraLayer>
  )
})

/** Our components go into Excalidraw's own library and drag onto the canvas as usual. */
export async function loadLibrary(api: StudioApi) {
  try {
    const body = await (await fetch('/b/api/library')).json()
    if (Array.isArray(body.libraryItems)) await api.updateLibrary({ libraryItems: body.libraryItems, merge: true, openLibraryMenu: false })
  } catch {
    // Without the library the board still works.
  }
}

// ── Slop check ──────────────────────────────────────────────────────────────

type Slop = ReturnType<typeof analyzeSlop>
const SLOP_TEXT = { clean: 'studio.slopClean', warn: 'studio.slopWarn', slop: 'studio.slopSlop' } as const

/**
 * One check worker per page. If the browser won't create it, run on the main
 * thread: in such a browser the indicator matters more than smoothness.
 */
let slopWorker: Worker | null | undefined
let slopSeq = 0
const slopWaiters = new Map<number, (result: Slop | null) => void>()
function checkSlop(elements: readonly El[]): Promise<Slop | null> {
  if (slopWorker === undefined) {
    try {
      slopWorker = new Worker(new URL('./slop.worker.ts', import.meta.url), { type: 'module' })
      slopWorker.onmessage = (e: MessageEvent<{ id: number; result: Slop | null }>) => {
        slopWaiters.get(e.data.id)?.(e.data.result)
        slopWaiters.delete(e.data.id)
      }
    } catch {
      slopWorker = null
    }
  }
  if (!slopWorker) return Promise.resolve(analyzeSlop(elements as never, { locale }))
  const id = ++slopSeq
  return new Promise((resolve) => {
    slopWaiters.set(id, resolve)
    slopWorker!.postMessage({ id, elements, locale })
  })
}

export function useSlop(api: StudioApi | null) {
  const version = useSceneVersion()
  const [result, setResult] = useState<Slop | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const latest = useRef(0)
  useEffect(() => {
    if (!api) return
    clearTimeout(timer.current)
    // Check after edits settle; no need to run it on every mouse move.
    timer.current = setTimeout(() => {
      const ticket = ++latest.current
      checkSlop(api.getSceneElements()).then((next) => {
        // The board changed again while we were checking — this result is stale.
        if (next && ticket === latest.current) setResult(next)
      })
    }, 900)
    return () => clearTimeout(timer.current)
  }, [api, version])
  return result
}

/**
 * Slop-check badge and its panel. It subscribes to edits itself, so the page
 * doesn't re-render because of it. `quiet` hides the button: the panel is opened
 * from the island's More menu via `open`/`onOpen`.
 */
export function SlopBadge({ api, placement = 'bottom', quiet, open: openProp, onOpen }: { api: StudioApi; placement?: 'bar' | 'bottom'; quiet?: boolean; open?: boolean; onOpen?: (open: boolean) => void }) {
  'use no memo' // reads the editor (api) while rendering: the compiler would cache it by the stable api (HRN-1515)
  const result = useSlop(api)
  const [openOwn, setOpenOwn] = useState(false)
  const open = openProp ?? openOwn
  const setOpen = onOpen ?? setOpenOwn
  if (!result || !api.getSceneElements().length) return null
  const show = (ids: string[]) => {
    const set = new Set(ids)
    const targets = api.getSceneElements().filter((el) => set.has(el.id))
    if (!targets.length) return
    api.updateScene({ appState: { selectedElementIds: Object.fromEntries(targets.map((el) => [el.id, true])) }, captureUpdate: CaptureUpdateAction.NEVER })
    api.scrollToContent(targets as never, { fitToContent: targets.length > 1, animate: true })
  }
  return (
    <span className="studio-slop-wrap">
      {!quiet && (
        <button type="button" className={`${placement === 'bar' ? 'bar-btn bar-btn--wide' : 'studio-slop'} studio-slop--${result.level}${open ? ' is-on' : ''}`} onClick={() => setOpen(!open)} title={t('studio.slopButtonTitle')}>
          <span className="studio-slop__dot" />
          <span className="studio-dock__label">{t(SLOP_TEXT[result.level as keyof typeof SLOP_TEXT])} · </span>
          {result.score}
        </button>
      )}
      {/* Portal into body: Excalidraw's top-right corner clips anything wider than itself. */}
      {open && createPortal(
        <div className={`studio-panel studio-panel--slop studio-panel--${placement}`} role="dialog" aria-label={t('studio.slopCheck')}>
          <div className="studio-panel__head">
            <strong>{t('studio.slopHeading', { score: result.score })}</strong>
            <span>
              {result.level === 'clean'
                ? t('studio.slopCleanHint')
                : t('studio.slopIssuesHint')}
            </span>
            <button type="button" className="studio-panel__close" onClick={() => setOpen(false)} aria-label={t('studio.close')}>×</button>
          </div>
          <ul className="studio-slop__list">
            {result.issues.map((issue) => (
              <li key={issue.id}>
                <button type="button" onClick={() => show(issue.elementIds)} disabled={!issue.elementIds.length}>
                  <strong>{issue.title}</strong>
                  <span>{issue.detail}</span>
                </button>
              </li>
            ))}
            {!result.issues.length && <li className="studio-slop__empty">{t('studio.slopNoIssues')}</li>}
          </ul>
        </div>,
        document.body,
      )}
    </span>
  )
}

// ── Board properties ────────────────────────────────────────────────────────

export type BoardMeta = { title: string; description: string; tags: string[]; task: string | null; fields?: Record<string, unknown> }
