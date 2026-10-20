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
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CameraLayer, inWindow, useSceneVersion, useSceneWindow } from './camera'
import { createPortal } from 'react-dom'
import { CaptureUpdateAction, convertToExcalidrawElements, exportToSvg, newElementWith, restoreElements } from '@excalidraw/excalidraw'
import { INK, STICKY_COLORS, STYLE, TONES, VARIANTS, paint, stickyStroke } from '../../shared/palette.mjs'
import { sticky as stickySkeleton } from '../../shared/templates.mjs'
import { analyzeSlop } from '../../shared/slop.mjs'
import { locale, t } from './i18n'

/** `prefix` + capitalised id: the catalog key for a palette or template name, e.g. `studio.toneBlue`. */
const nameKey = (prefix: string, id: string) => `studio.${prefix}${id.charAt(0).toUpperCase()}${id.slice(1)}`
/** A translated name for a palette entry or template; unknown ids (added elsewhere) keep their own name. */
const nameOf = (prefix: string, id: string, fallback: string) => {
  const key = nameKey(prefix, id)
  return t.has(key) ? t(key) : fallback
}

type El = {
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

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
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

// ── Palette ─────────────────────────────────────────────────────────────────

/** Paint the selection in a tone; each element type uses the tone in its own role. */
export function applyTone(api: StudioApi, toneId: string, variant: string) {
  const tone = TONES.find((item) => item.id === toneId)!
  const p = paint(tone, variant)
  const selected = api.getAppState().selectedElementIds as Record<string, boolean>
  const all = api.getSceneElementsIncludingDeleted()
  const ids = new Set(Object.keys(selected).filter((id) => selected[id]))
  if (!ids.size) {
    // Nothing selected: the palette sets the colour of the next shapes.
    api.updateScene({ appState: { currentItemStrokeColor: p.strokeColor, currentItemBackgroundColor: p.backgroundColor, currentItemFillStyle: 'solid' }, captureUpdate: CaptureUpdateAction.NEVER })
    const variantInfo = VARIANTS.find((v) => v.id === variant)
    api.setToast({ message: t('studio.nextShapes', { tone: nameOf('tone', tone.id, tone.name), variant: variantInfo ? nameOf('variant', variantInfo.id, variantInfo.name).toLowerCase() : '' }), duration: 2500 })
    return
  }
  const labelColor = new Map<string, string>()
  const next = all.map((el) => {
    if (!ids.has(el.id) || el.isDeleted || isSticky(el)) return el
    if (SHAPES.has(el.type)) {
      for (const b of el.boundElements ?? []) if (b.type === 'text') labelColor.set(b.id, p.text)
      return newElementWith(el as never, { strokeColor: p.strokeColor, backgroundColor: p.backgroundColor, fillStyle: 'solid' } as never) as unknown as El
    }
    if (el.type === 'text' && !el.containerId) return newElementWith(el as never, { strokeColor: variant === 'strong' ? tone.strong : tone.ink } as never) as unknown as El
    if (el.type === 'arrow' || el.type === 'line') {
      for (const b of el.boundElements ?? []) if (b.type === 'text') labelColor.set(b.id, tone.ink)
      return newElementWith(el as never, { strokeColor: variant === 'strong' ? tone.strong : tone.ink } as never) as unknown as El
    }
    return el
  })
  api.updateScene({
    elements: next.map((el) => (labelColor.has(el.id) ? (newElementWith(el as never, { strokeColor: labelColor.get(el.id) } as never) as unknown as El) : el)),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}

export function paintStickies(api: StudioApi, fill: string) {
  const selected = api.getAppState().selectedElementIds as Record<string, boolean>
  let touched = 0
  const next = api.getSceneElementsIncludingDeleted().map((el) => {
    if (!selected[el.id] || !isSticky(el)) return el
    touched += 1
    return newElementWith(el as never, { backgroundColor: fill, strokeColor: stickyStroke(fill) } as never) as unknown as El
  })
  if (touched) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  return touched
}

export function PalettePanel({ api, onClose, stickyColor, setStickyColor }: { api: StudioApi; onClose: () => void; stickyColor: string; setStickyColor: (c: string) => void }) {
  return (
    <div className="studio-panel studio-panel--palette" role="dialog" aria-label={t('studio.palette')}>
      <div className="studio-panel__head">
        <strong>{t('studio.palette')}</strong>
        <span>{t('studio.paletteHint')}</span>
        <button type="button" className="studio-panel__close" onClick={onClose} aria-label={t('studio.close')}>×</button>
      </div>
      <div className="studio-palette">
        {VARIANTS.map((variant) => (
          <div className="studio-palette__row" key={variant.id}>
            <span className="studio-palette__label">{nameOf('variant', variant.id, variant.name)}</span>
            {TONES.map((tone) => {
              const p = paint(tone, variant.id)
              return (
                <button
                  type="button"
                  key={tone.id}
                  className="studio-swatch"
                  title={t('studio.swatchTitle', { tone: nameOf('tone', tone.id, tone.name), variant: nameOf('variant', variant.id, variant.name).toLowerCase() })}
                  style={{ background: p.backgroundColor, borderColor: p.strokeColor, color: p.text }}
                  onClick={() => applyTone(api, tone.id, variant.id)}
                >
                  {t('studio.toneSample')}
                </button>
              )
            })}
          </div>
        ))}
        <div className="studio-palette__row">
          <span className="studio-palette__label">{t('studio.stickies')}</span>
          {STICKY_COLORS.map((c) => (
            <button
              type="button"
              key={c.id}
              className={`studio-swatch studio-swatch--sticky${stickyColor === c.fill ? ' is-on' : ''}`}
              title={nameOf('sticky', c.id, c.name)}
              style={{ background: c.fill }}
              onClick={() => {
                setStickyColor(c.fill)
                paintStickies(api, c.fill)
              }}
            />
          ))}
        </div>
      </div>
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

type StickyBox = { id: string; x: number; y: number; width: number; height: number; author: string | null; authorCovered: boolean; reactionsCovered: boolean }

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
export const StickyOverlay = memo(function StickyOverlay({ api, me, reactions, votes, canReact, onReact }: { api: StudioApi; me: string | null; reactions: string[]; votes: Record<string, Record<string, string[]>>; canReact: boolean; onReact: (id: string, emoji: string, on: boolean) => void }) {
  const version = useSceneVersion()
  const [boxes, setBoxes] = useState<StickyBox[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const signature = useRef('')
  // Before paint, so a dragged sticky and its caption move together.
  useLayoutEffect(() => {
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
      out.push({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height, author, authorCovered, reactionsCovered })
      sig += `${el.id}:${el.x}:${el.y}:${el.width}:${el.height}:${author}:${authorCovered ? 1 : 0}${reactionsCovered ? 1 : 0}|`
    }
    if (sig === signature.current) return
    signature.current = sig
    setBoxes(out)
  }, [api, version])

  // Nodes only for stickies on or near the screen; no point laying out the rest.
  const near = useSceneWindow()
  return (
    <CameraLayer className="studio-stickies">
      {boxes.filter((v) => inWindow(near, v.x, v.y, v.x + v.width, v.y + v.height)).map((v) => {
        const mineVotes = votes[v.id] ?? {}
        const shown = reactions.filter((e) => (mineVotes[e]?.length ?? 0) > 0)
        return (
          <div key={v.id} className="studio-sticky" style={{ left: v.x, top: v.y, width: v.width, height: v.height }}>
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

// ── Templates and library ───────────────────────────────────────────────────

type TemplateInfo = { id: string; title: string; description: string }

/** Copy elements with new ids and an offset, so a template can be inserted twice. */
export function cloneWithNewIds(elements: El[], dx: number, dy: number): El[] {
  const ids = new Map<string, string>()
  const fresh = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6)
  for (const el of elements) ids.set(el.id, fresh())
  const groups = new Map<string, string>()
  const group = (g: string) => {
    if (!groups.has(g)) groups.set(g, fresh())
    return groups.get(g)!
  }
  return elements.map((el) => ({
    ...el,
    id: ids.get(el.id)!,
    x: el.x + dx,
    y: el.y + dy,
    containerId: el.containerId ? ids.get(el.containerId) ?? null : el.containerId,
    boundElements: el.boundElements?.map((b) => ({ ...b, id: ids.get(b.id) ?? b.id })) ?? el.boundElements,
    startBinding: el.startBinding ? { ...el.startBinding, elementId: ids.get(el.startBinding.elementId) ?? el.startBinding.elementId } : el.startBinding,
    endBinding: el.endBinding ? { ...el.endBinding, elementId: ids.get(el.endBinding.elementId) ?? el.endBinding.elementId } : el.endBinding,
    frameId: el.frameId ? ids.get(el.frameId) ?? null : el.frameId,
    groupIds: (el.groupIds ?? []).map(group),
    customData: isSticky(el) ? { ...el.customData, reactions: {} } : el.customData,
  }))
}

function TemplatePreview({ id, staticBase }: { id: string; staticBase: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/b/api/templates/${id}`)
      .then((r) => r.json())
      .then(async (body) => {
        if (!body.elements?.length) return setSvg('')
        const node = await exportToSvg({ elements: body.elements, appState: { exportBackground: true, viewBackgroundColor: '#ffffff' }, files: null, exportPadding: 16, skipInliningFonts: true } as never)
        if (!cancelled) setSvg(node.outerHTML)
      })
      .catch(() => !cancelled && setSvg(''))
    return () => {
      cancelled = true
    }
  }, [id, staticBase])
  if (svg === null) return <span className="studio-template__loading">…</span>
  if (!svg) return <span className="studio-template__blank">{t('studio.templateBlank')}</span>
  return <span className="studio-template__svg" dangerouslySetInnerHTML={{ __html: svg }} />
}

export function TemplatesPanel({ api, onClose, staticBase }: { api: StudioApi; onClose: () => void; staticBase: string }) {
  const [list, setList] = useState<TemplateInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    fetch('/b/api/templates')
      .then((r) => r.json())
      .then((body) => setList((body.templates ?? []).filter((tpl: TemplateInfo) => tpl.id !== 'blank')))
      .catch(() => setList([]))
  }, [])
  const insert = async (id: string) => {
    setBusy(id)
    try {
      const body = await (await fetch(`/b/api/templates/${id}`)).json()
      const elements = body.elements as El[]
      const app = api.getAppState() as { scrollX: number; scrollY: number; width: number; height: number; zoom: { value: number } }
      const minX = Math.min(...elements.map((el) => el.x))
      const minY = Math.min(...elements.map((el) => el.y))
      // Put the template's top-left in the left third of the screen so it reads at once.
      const dx = -app.scrollX + (app.width * 0.15) / app.zoom.value - minX
      const dy = -app.scrollY + (app.height * 0.15) / app.zoom.value - minY
      const clones = restoreElements(cloneWithNewIds(elements, Math.round(dx), Math.round(dy)) as never, null) as unknown as El[]
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...clones], captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      api.scrollToContent(clones as never, { fitToContent: true, animate: true })
      onClose()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="studio-panel studio-panel--templates" role="dialog" aria-label={t('studio.templates')}>
      <div className="studio-panel__head">
        <strong>{t('studio.templates')}</strong>
        <span>{t('studio.templatesHint')}</span>
        <button type="button" className="studio-panel__close" onClick={onClose} aria-label={t('studio.close')}>×</button>
      </div>
      <div className="studio-templates">
        {list.map((tpl) => (
          <button type="button" key={tpl.id} className="studio-template" onClick={() => insert(tpl.id)} disabled={busy !== null}>
            <span className="studio-template__preview">
              <TemplatePreview id={tpl.id} staticBase={staticBase} />
            </span>
            <span className="studio-template__title">{busy === tpl.id ? t('studio.inserting') : nameOf('template', `${tpl.id}Title`, tpl.title)}</span>
            <span className="studio-template__desc">{nameOf('template', `${tpl.id}Description`, tpl.description)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

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

export type BoardMeta = { title: string; description: string; tags: string[]; task: string | null }

export function PropertiesDialog({ meta, canEdit, onSave, onClose }: { meta: BoardMeta; canEdit: boolean; onSave: (m: Partial<BoardMeta>) => Promise<boolean>; onClose: () => void }) {
  const [description, setDescription] = useState(meta.description)
  const [tags, setTags] = useState(meta.tags.join(', '))
  const [task, setTask] = useState(meta.task ?? '')
  const [error, setError] = useState<string | null>(null)
  const parsed = useMemo(() => tags.split(',').map((tag) => tag.trim()).filter(Boolean), [tags])
  const save = async () => {
    const ref = task.trim()
    if (ref.length > 64) return setError(t('studio.referenceTooLong'))
    if (await onSave({ description: description.trim(), tags: parsed, task: ref || null })) onClose()
  }
  return (
    <div className="board-dialog__backdrop" onClick={onClose}>
      <div className="board-dialog" role="dialog" aria-label={t('studio.properties')} onClick={(e) => e.stopPropagation()}>
        <div className="board-dialog__head">
          <h2>{t('studio.properties')}</h2>
          <button type="button" className="board-dialog__close" onClick={onClose} aria-label={t('studio.close')}>×</button>
        </div>
        <fieldset className="studio-form" disabled={!canEdit}>
          <label>
            <span>{t('studio.description')}</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={500} placeholder={t('studio.descriptionPlaceholder')} />
          </label>
          <label>
            <span>{t('studio.tags')}</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('studio.tagsPlaceholder')} />
          </label>
          {parsed.length > 0 && (
            <span className="studio-tags">
              {parsed.slice(0, 10).map((tag) => (
                <span key={tag} className="studio-tag">{tag}</span>
              ))}
            </span>
          )}
          <label>
            <span>{t('studio.reference')}</span>
            <input value={task} onChange={(e) => setTask(e.target.value)} maxLength={64} placeholder={t('studio.referencePlaceholder')} />
          </label>
          {error && <p className="studio-form__error">{error}</p>}
        </fieldset>
        <div className="board-dialog__foot">
          {canEdit ? (
            <button type="button" className="board-button" onClick={save}>{t('studio.save')}</button>
          ) : (
            <span>{t('studio.propertiesReadOnly')}</span>
          )}
        </div>
      </div>
    </div>
  )
}
