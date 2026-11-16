/**
 * Boards 2.0 (HRN-1480): islands over the canvas instead of the editor's own panels.
 *
 * Excalidraw's toolbar, menus and properties panel are hidden (islands.css); the islands drive the editor through its
 * API — setActiveTool, updateScene, its shortcuts — and read what to show from its app state. Top left: back, the
 * title, the board menu and edit/view. Top right: who is here, share, comments, chat. Bottom: the tools with tooltips
 * and popovers of variants. Bottom left: undo, redo and zoom. Over the selection: the context bar (ctxbar.tsx).
 */
import { HOST_ICON, runHostAction, useHostActions } from '../host-actions'
import { installDarkDots } from './dark-dots'
import { darkKind, installDarkPaint, type DarkEl } from './dark-paint'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { STICKY_COLORS } from '../../../shared/palette.mjs'
import type { StudioApi } from '../studio'
import { t } from '../i18n'
import { Icon } from './icons'
import { Pop, Swatches, useOpenKey } from './ui'
import { ACTIONS, isTerminal, sceneOf, type El } from './scene'
import { ContextBar } from './ctxbar'
import { useStickyFit } from './fit-text'
import './islands.css'

export type Api = StudioApi & {
  toggleSidebar?: (o: { name: string; tab?: string; force?: boolean }) => boolean
  onChange?: (cb: (elements: readonly unknown[], appState: Record<string, unknown>) => void) => () => void
  onPointerDown?: (cb: (tool: { type: string; customType?: string; locked?: boolean }, state: { origin: { x: number; y: number } }) => void) => () => void
}

export type Person = { id: string; name: string; color: string; idle?: boolean }

export type IslandsProps = {
  api: Api
  canEdit: boolean
  /** May comment without editing: the harnessly hub's «comments» (HRN-1519); absent: as canEdit. */
  canComment?: boolean
  /** Inside the harnessly app view: back and chat go to harnessly. */
  app: boolean
  title: string
  onRename: (title: string) => Promise<unknown> | void
  homeUrl: string
  textUrl: string
  fileUrl: string
  crowd: Person[]
  /** An agent is at work on the board: «Агент рисует…» in the right island. */
  agentWorking?: boolean
  status: { kind: string; text: string }
  onShare: (() => void) | null
  openComments: number
  side: 'comments' | 'chat' | null
  setSide: (side: 'comments' | 'chat' | null) => void
  stickyColor: string
  setStickyColor: (c: string) => void
  onStudioTool: (tool: 'sticky' | 'comment' | null) => void
  reactions: string[]
  onPanel: (panel: 'templates' | 'palette' | null) => void
  /** Timer, checkpoints, the check and plugin buttons: the right island keeps them. */
  extras?: ReactNode
  menu: {
    properties?: () => void
    snap?: { on: boolean; toggle: () => void }
    smooth?: { on: boolean; toggle: () => void }
    signIn?: string
    signOut?: { name: string; url: string }
  }
  /** Hands the selection to harnessly's chat; null outside harnessly. */
  onAsk: ((text: string, ids: string[]) => void) | null
  /** Reaction picked on an object. */
  onReact: (id: string, emoji: string, on: boolean) => void
  votes: Record<string, Record<string, string[]>>
  me: string | null
  /** Another board element inserts: the one terminal of the machine, a site. */
  insert: { site: () => void; terminal: (() => void) | null; terminalTaken: boolean }
}

type Tool = { type: string; customType?: string; locked?: boolean }

/**
 * The editor's app state, re-read once per frame while something the islands show changes. Excalidraw calls
 * onChange on every repaint — every frame of a pan — so a bump that only moves the camera is skipped unless
 * something is selected (the context bar follows the selection on screen). Re-rendering every island on every
 * frame of a pan was a good part of the lag of Boards 2.0 (HRN-1515).
 */
export function useEditorTick(api: Api) {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let frame = 0
    let seenState: Record<string, unknown> | null = null
    let seenElements: readonly unknown[] | null = null
    const bump = () => {
      if (frame) return
      frame = requestAnimationFrame(() => {
        frame = 0
        setTick((n) => n + 1)
      })
    }
    const followsCamera = (st: Record<string, unknown>) =>
      Boolean(st.editingTextElement) || Object.values((st.selectedElementIds ?? {}) as Record<string, boolean>).some(Boolean)
    const onChange = (elements: readonly unknown[], st: Record<string, unknown>) => {
      const was = seenState
      const wasElements = seenElements
      seenState = st
      seenElements = elements
      if (!was || elements !== wasElements || followsCamera(st)) return bump()
      for (const k in st) {
        if (k === 'scrollX' || k === 'scrollY') continue
        if (st[k] !== was[k]) return bump()
      }
    }
    const onScroll = () => {
      const st = api.getAppState()
      if (followsCamera(st)) bump()
    }
    const offChange = api.onChange?.(onChange)
    const offScroll = (api as unknown as { onScrollChange?: (cb: () => void) => () => void }).onScrollChange?.(onScroll)
    window.addEventListener('resize', bump)
    return () => {
      cancelAnimationFrame(frame)
      offChange?.()
      offScroll?.()
      window.removeEventListener('resize', bump)
    }
  }, [api])
  return tick
}

const SHAPE_KINDS = [
  { id: 'rectangle', round: false, icon: 'square', key: 'R' },
  { id: 'rectangle', round: true, icon: 'squareRound', key: '' },
  { id: 'diamond', round: false, icon: 'diamond', key: 'D' },
  { id: 'ellipse', round: false, icon: 'circle', key: 'O' },
] as const
const ARROW_KINDS = [
  { id: 'sharp', icon: 'arrow' },
  { id: 'round', icon: 'arrowCurve' },
  { id: 'elbow', icon: 'arrowElbow' },
] as const
const PEN_WIDTHS = [1, 2, 4] as const
export const INK_COLORS = ['#1e1e1e', '#868e96', '#e03131', '#e8590c', '#f59f00', '#2f9e44', '#0c8599', '#1971c2', '#6741d9', '#c2255c', '#846358', '#ffffff']

function Btn({ icon, tip, keyHint, on, onClick, disabled, children, className = '' }: { icon?: string; tip: string; keyHint?: string; on?: boolean; onClick: () => void; disabled?: boolean; children?: ReactNode; className?: string }) {
  return (
    <button type="button" className={`isl-ib${on ? ' on' : ''}${disabled ? ' dis' : ''} ${className}`} data-tip={tip} data-key={keyHint} aria-label={tip} aria-pressed={on} disabled={disabled} onClick={onClick}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  )
}

const Sep = () => <span className="isl-vs" />

function initialOf(name: string) {
  const clean = name.replace(/^guest:\s*/i, '').trim()
  return (clean[0] ?? '?').toUpperCase()
}

// ── Top left: back, title, menu, edit/view ───────────────────────────────────

function TopLeft({ api, app, title, onRename, homeUrl, textUrl, fileUrl, canEdit, menu, viewOnly, setViewOnly }: Pick<IslandsProps, 'api' | 'app' | 'title' | 'onRename' | 'homeUrl' | 'textUrl' | 'fileUrl' | 'canEdit' | 'menu'> & { viewOnly: boolean; setViewOnly: (v: boolean) => void }) {
  'use no memo' // reads the editor (api) while rendering: the compiler would cache it by the stable api (HRN-1515)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(title)
  const pop = useOpenKey<'menu'>()
  const close = pop.close
  // harnessly's own actions (share, the right pane, its menu): it draws no bar above the app (HRN-1498).
  const hostActions = useHostActions(app && pop.open === 'menu')
  const theme = (api.getAppState().theme as string) ?? 'light'
  const back = () => {
    if (app && window.parent !== window) window.parent.postMessage({ type: 'board-back' }, location.origin)
    else location.href = homeUrl
  }
  const commit = () => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== title) void onRename(next)
  }
  const run = (fn: () => void) => () => {
    close()
    fn()
  }
  const dialog = (name: string) => api.updateScene({ appState: { openDialog: { name } } })
  return (
    <div className="isl isl-tl isl-tips-down">
      <Btn icon="back" tip={t('islands.allBoards')} onClick={back} />
      {!editing && (
        <button type="button" className="isl-ttl" data-tip={canEdit ? t('islands.rename') : undefined} onClick={() => canEdit && (setDraft(title), setEditing(true))} disabled={!canEdit}>
          {title}
        </button>
      )}
      {editing && (
        <input
          className="isl-ttl-in"
          autoFocus
          value={draft}
          maxLength={120}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit()
            if (e.key === 'Escape') setEditing(false)
            e.stopPropagation()
          }}
        />
      )}
      <div className="isl-tw">
        <Btn icon="dots" tip={t('islands.boardMenu')} on={pop.open === 'menu'} onClick={() => pop.toggle('menu')} />
        <Pop open={pop.open === 'menu'} onClose={close} place="down" align="start" className="isl-menu">
          {hostActions.map((a) => (
            <button type="button" key={a.id} className={`isl-mi${a.danger ? ' dg' : ''}`} onClick={run(() => runHostAction(a.id))}>
              <Icon name={HOST_ICON[a.icon] ?? 'dots'} />
              {a.label}
              {a.pressed !== undefined && <span className={`isl-tgl${a.pressed ? ' on' : ''}`} />}
            </button>
          ))}
          {hostActions.length > 0 && <div className="isl-msep" />}
          {menu.properties && (
            <button type="button" className="isl-mi" onClick={run(menu.properties)}>
              <Icon name="settings" />
              {t('islands.properties')}
            </button>
          )}
          <a className="isl-mi" href={textUrl} target="_blank" rel="noopener">
            <Icon name="fileText" />
            {t('islands.asText')}
          </a>
          <button type="button" className="isl-mi" onClick={run(() => dialog('imageExport'))}>
            <Icon name="image" />
            {t('islands.downloadImage')}
            <small>.png · .svg</small>
          </button>
          <a className="isl-mi" href={fileUrl}>
            <Icon name="download" />
            {t('islands.downloadFile')}
            <small>.excalidraw</small>
          </a>
          <button type="button" className="isl-mi" onClick={run(() => api.toggleSidebar?.({ name: 'default', tab: 'search', force: true }))}>
            <Icon name="search" />
            {t('islands.find')}
            <kbd>⌘F</kbd>
          </button>
          <div className="isl-msep" />
          <button type="button" className="isl-mi" onClick={run(() => api.updateScene({ appState: { theme: theme === 'dark' ? 'light' : 'dark' } }))}>
            <Icon name="sun" />
            {theme === 'dark' ? t('islands.themeLight') : t('islands.themeDark')}
          </button>
          {menu.snap && (
            <button type="button" className="isl-mi" onClick={run(menu.snap.toggle)}>
              <Icon name="magnet" />
              {t('islands.snap')}
              <span className={`isl-tgl${menu.snap.on ? ' on' : ''}`} />
            </button>
          )}
          {menu.smooth && (
            <button type="button" className="isl-mi" onClick={run(menu.smooth.toggle)}>
              <Icon name="sparkles" />
              {t('islands.smooth')}
              <span className={`isl-tgl${menu.smooth.on ? ' on' : ''}`} />
            </button>
          )}
          <button type="button" className="isl-mi" onClick={run(() => dialog('help'))}>
            <Icon name="keyboard" />
            {t('islands.shortcuts')}
            <kbd>?</kbd>
          </button>
          {(menu.signIn || menu.signOut) && <div className="isl-msep" />}
          {menu.signIn && (
            <a className="isl-mi" href={menu.signIn}>
              <Icon name="login" />
              {t('islands.signIn')}
            </a>
          )}
          {menu.signOut && (
            <a className="isl-mi" href={menu.signOut.url}>
              <Icon name="logout" />
              {t('islands.signOut', { name: menu.signOut.name })}
            </a>
          )}
          {canEdit && (
            <>
              <div className="isl-msep" />
              <button type="button" className="isl-mi dg" onClick={run(() => api.updateScene({ appState: { activeConfirmDialog: 'clearCanvas' } as never }))}>
                <Icon name="trash" />
                {t('islands.clear')}
              </button>
            </>
          )}
        </Pop>
      </div>
      {canEdit && (
        <>
          <Sep />
          <div className="isl-seg isl-seg--ic">
            <button type="button" className={!viewOnly ? 'on' : ''} data-tip={t('islands.modeEdit')} aria-label={t('islands.modeEdit')} onClick={() => setViewOnly(false)}>
              <Icon name="pencil" size={16} />
            </button>
            <button type="button" className={viewOnly ? 'on' : ''} data-tip={t('islands.modeView')} aria-label={t('islands.modeView')} onClick={() => setViewOnly(true)}>
              <Icon name="eye" size={16} />
            </button>
          </div>
        </>
      )}
    </div>
  )
}

// ── Top right: people, share, comments, chat ─────────────────────────────────

function TopRight({ api, crowd, agentWorking, status, onShare, openComments, side, setSide, app, extras }: Pick<IslandsProps, 'api' | 'crowd' | 'agentWorking' | 'status' | 'onShare' | 'openComments' | 'side' | 'setSide' | 'app' | 'extras'>) {
  'use no memo' // reads the editor (api) while rendering: the compiler would cache it by the stable api (HRN-1515)
  const following = (api.getAppState().userToFollow as { socketId?: string } | null)?.socketId ?? null
  const shown = crowd.slice(0, 4)
  const more = crowd.length - shown.length
  return (
    <div className="isl isl-tr isl-tips-down">
      {agentWorking && (
        <span className="isl-agent" role="status">
          <span className="isl-agent__orb" aria-hidden="true" />
          {t('islands.agentWorking')}
          <span className="isl-agent__dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        </span>
      )}
      {shown.length > 0 && (
        <div className="isl-av">
          {shown.map((p) => (
            <button
              type="button"
              key={p.id}
              className={`isl-avs${p.idle ? ' is-idle' : ''}${following === p.id ? ' is-follow' : ''}`}
              style={{ background: p.color }}
              data-tip={following === p.id ? t('islands.unfollow', { name: p.name }) : t('islands.follow', { name: p.name })}
              onClick={() => api.updateScene({ appState: { userToFollow: following === p.id ? null : { socketId: p.id, username: p.name } } })}
            >
              {initialOf(p.name)}
            </button>
          ))}
          {more > 0 && <span className="isl-avs isl-avs--more">+{more}</span>}
        </div>
      )}
      <span className={`isl-status isl-status--${status.kind}`} data-tip={status.text} aria-label={status.text} />
      {extras}
      {onShare && (
        <button type="button" className="isl-btn isl-btn--pri" onClick={onShare}>
          <Icon name="users" size={16} />
          <span className="isl-btn__label">{t('islands.share')}</span>
        </button>
      )}
      <Sep />
      <Btn icon="commentPlain" tip={t('islands.comments')} on={side === 'comments'} onClick={() => setSide(side === 'comments' ? null : 'comments')}>
        {openComments > 0 && <span className="isl-cnt">{openComments}</span>}
      </Btn>
      <Btn icon="sparkles" tip={t('islands.chat')} on={side === 'chat'} onClick={() => setSide(side === 'chat' ? null : 'chat')} />
    </div>
  )
}

// ── Bottom: the tools ─────────────────────────────────────────────────────────

type Prefs = { shape: number; arrow: 'sharp' | 'round' | 'elbow'; startHead: boolean; endHead: boolean; pen: number; penColor: string; emoji: string }

function readPrefs(): Prefs {
  try {
    const raw = JSON.parse(localStorage.getItem('boards-tools') ?? '{}')
    return { shape: 0, arrow: 'round', startHead: false, endHead: true, pen: 2, penColor: '#1e1e1e', emoji: '👍', ...raw }
  } catch {
    return { shape: 0, arrow: 'round', startHead: false, endHead: true, pen: 2, penColor: '#1e1e1e', emoji: '👍' }
  }
}

function Toolbar({ api, tool, stickyColor, setStickyColor, onStudioTool, reactions, onPanel, insert, prefs, setPrefs }: Pick<IslandsProps, 'api' | 'stickyColor' | 'setStickyColor' | 'onStudioTool' | 'reactions' | 'onPanel' | 'insert'> & { tool: Tool; prefs: Prefs; setPrefs: (p: Partial<Prefs>) => void }) {
  'use no memo' // reads the editor (api) while rendering: the compiler would cache it by the stable api (HRN-1515)
  const pop = useOpenKey<'sticky' | 'shape' | 'arrow' | 'pen' | 'react' | 'plus'>()
  const close = pop.close
  const custom = tool.type === 'custom' ? tool.customType : null
  const is = (type: string) => tool.type === type
  const set = (type: string, appState: Record<string, unknown> = {}) => {
    if (Object.keys(appState).length) api.updateScene({ appState })
    api.setActiveTool({ type })
  }
  // A second click on the active tool opens its variants, as in FigJam.
  const pick = (key: 'sticky' | 'shape' | 'arrow' | 'pen' | 'react', active: boolean, activate: () => void) => {
    if (active) pop.toggle(key)
    else {
      close()
      activate()
    }
  }
  const shape = SHAPE_KINDS[prefs.shape] ?? SHAPE_KINDS[0]
  const shapeOn = is('rectangle') || is('diamond') || is('ellipse')
  const useShape = (i: number) => {
    const k = SHAPE_KINDS[i]
    setPrefs({ shape: i })
    set(k.id, { currentItemRoundness: k.round || k.id !== 'rectangle' ? 'round' : 'sharp' })
  }
  const arrowState = (p: Prefs) => ({ currentItemArrowType: p.arrow, currentItemStartArrowhead: p.startHead ? 'arrow' : null, currentItemEndArrowhead: p.endHead ? 'arrow' : null })
  const useArrow = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p }
    setPrefs(p)
    set('arrow', arrowState(next))
  }
  const usePen = (p: Partial<Prefs>) => {
    const next = { ...prefs, ...p }
    setPrefs(p)
    set('freedraw', { currentItemStrokeWidth: next.pen, currentItemStrokeColor: next.penColor })
  }
  const tray = useMemo(() => {
    const rest = STICKY_COLORS.filter((c) => c.fill !== stickyColor).slice(0, 4)
    return [...rest, STICKY_COLORS.find((c) => c.fill === stickyColor) ?? { fill: stickyColor }]
  }, [stickyColor])
  const arrowIcon = ARROW_KINDS.find((a) => a.id === prefs.arrow)?.icon ?? 'arrow'
  // One terminal per board.
  const terminalTaken = sceneOf(api).some((e) => isTerminal(e) && !e.isDeleted)
  return (
    <div className="isl isl-tools">
      <Btn icon="pointer" tip={t('islands.select')} keyHint="V" on={is('selection')} onClick={() => (close(), set('selection'))} />
      <Btn icon="hand" tip={t('islands.hand')} keyHint="H" on={is('hand')} onClick={() => (close(), set('hand'))} />
      <Sep />
      <div className="isl-tw">
        <button type="button" className={`isl-tray${custom === 'sticky' ? ' on' : ''}`} data-tip={t('islands.sticky')} data-key="S" aria-label={t('islands.sticky')} onClick={() => pick('sticky', custom === 'sticky', () => onStudioTool('sticky'))}>
          {tray.map((c, i) => (
            <i key={c.fill + i} style={{ background: c.fill }} />
          ))}
        </button>
        <Pop open={pop.open === 'sticky'} onClose={close} className="isl-pop--pad">
          <div className="isl-mlab">{t('islands.stickyColor')}</div>
          <Swatches
            colors={STICKY_COLORS.map((c) => c.fill)}
            value={stickyColor}
            custom={false}
            onPick={(c) => {
              setStickyColor(c)
              close()
              onStudioTool('sticky')
            }}
          />
        </Pop>
      </div>
      <div className="isl-tw">
        <Btn icon={shape.icon} tip={t('islands.shape')} keyHint="R" on={shapeOn} onClick={() => pick('shape', shapeOn, () => useShape(prefs.shape))} />
        <Pop open={pop.open === 'shape'} onClose={close} className="isl-pop--row">
          {SHAPE_KINDS.map((k, i) => (
            <Btn key={i} icon={k.icon} tip={t(`islands.shape_${i}`)} keyHint={k.key || undefined} on={prefs.shape === i} onClick={() => (useShape(i), close())} />
          ))}
        </Pop>
      </div>
      <div className="isl-tw">
        <Btn icon={is('line') ? 'line' : arrowIcon} tip={t('islands.arrow')} keyHint="A" on={is('arrow') || is('line')} onClick={() => pick('arrow', is('arrow') || is('line'), () => useArrow({}))} />
        <Pop open={pop.open === 'arrow'} onClose={close} className="isl-pop--pad">
          <div className="isl-mlab">{t('islands.arrowKind')}</div>
          <div className="isl-prow">
            {ARROW_KINDS.map((k) => (
              <Btn key={k.id} icon={k.icon} tip={t(`islands.arrow_${k.id}`)} on={is('arrow') && prefs.arrow === k.id} onClick={() => useArrow({ arrow: k.id })} />
            ))}
            <Btn icon="line" tip={t('islands.line')} keyHint="L" on={is('line')} onClick={() => set('line')} />
          </div>
          <div className="isl-mlab">{t('islands.heads')}</div>
          <div className="isl-prow">
            <Btn icon="headStart" tip={t('islands.headStart')} on={prefs.startHead} onClick={() => useArrow({ startHead: !prefs.startHead })} />
            <Btn icon="headEnd" tip={t('islands.headEnd')} on={prefs.endHead} onClick={() => useArrow({ endHead: !prefs.endHead })} />
          </div>
        </Pop>
      </div>
      <div className="isl-tw">
        <Btn icon="pen" tip={t('islands.pen')} keyHint="P" on={is('freedraw') || is('eraser')} onClick={() => pick('pen', is('freedraw') || is('eraser'), () => usePen({}))} />
        <Pop open={pop.open === 'pen'} onClose={close} className="isl-pop--pad">
          <div className="isl-mlab">{t('islands.width')}</div>
          <div className="isl-prow">
            {PEN_WIDTHS.map((w) => (
              <button type="button" key={w} className={`isl-ib${prefs.pen === w && is('freedraw') ? ' on' : ''}`} data-tip={t(`islands.width_${w}`)} onClick={() => usePen({ pen: w })}>
                <i className="isl-wbar" style={{ height: w + 1 }} />
              </button>
            ))}
            <Btn icon="eraser" tip={t('islands.eraser')} keyHint="0" on={is('eraser')} onClick={() => set('eraser')} />
          </div>
          <div className="isl-mlab">{t('islands.color')}</div>
          <Swatches colors={INK_COLORS} value={prefs.penColor} onPick={(c) => usePen({ penColor: c })} />
        </Pop>
      </div>
      <Btn icon="type" tip={t('islands.text')} keyHint="T" on={is('text')} onClick={() => (close(), set('text'))} />
      <Btn icon="frame" tip={t('islands.frame')} keyHint="F" on={is('frame')} onClick={() => (close(), set('frame'))} />
      <Sep />
      <Btn icon="comment" tip={t('islands.comment')} keyHint="C" on={custom === 'comment'} onClick={() => (close(), onStudioTool(custom === 'comment' ? null : 'comment'))} />
      <div className="isl-tw">
        <button type="button" className={`isl-ib isl-emo${custom === 'react' ? ' on' : ''}`} data-tip={t('islands.reaction')} data-key="E" aria-label={t('islands.reaction')} onClick={() => pick('react', custom === 'react', () => api.setActiveTool({ type: 'custom', customType: 'react' }))}>
          {prefs.emoji}
        </button>
        <Pop open={pop.open === 'react'} onClose={close} className="isl-pop--row">
          {reactions.map((e) => (
            <button
              type="button"
              key={e}
              className={`isl-ebtn${prefs.emoji === e ? ' on' : ''}`}
              onClick={() => {
                setPrefs({ emoji: e })
                close()
                api.setActiveTool({ type: 'custom', customType: 'react' })
              }}
            >
              {e}
            </button>
          ))}
        </Pop>
      </div>
      <Sep />
      <div className="isl-tw">
        <Btn icon="plus" tip={t('islands.insert')} on={pop.open === 'plus'} onClick={() => pop.toggle('plus')} />
        <Pop open={pop.open === 'plus'} onClose={close} align="end" className="isl-menu">
          <button type="button" className="isl-mi" onClick={() => (close(), insert.site())}>
            <Icon name="globe" />
            {t('islands.site')}
            <kbd>W</kbd>
          </button>
          {insert.terminal && (
            <button type="button" className={`isl-mi${terminalTaken ? ' dis' : ''}`} disabled={terminalTaken} onClick={() => (close(), insert.terminal?.())}>
              <Icon name="terminal" />
              {t('islands.terminal')}
              <small>{terminalTaken ? t('islands.terminalTaken') : t('islands.terminalOne')}</small>
            </button>
          )}
          <button type="button" className="isl-mi" onClick={() => (close(), api.setActiveTool({ type: 'image' }))}>
            <Icon name="image" />
            {t('islands.image')}
            <kbd>9</kbd>
          </button>
          <div className="isl-msep" />
          <button type="button" className="isl-mi" onClick={() => (close(), onPanel('templates'))}>
            <Icon name="grid" />
            {t('islands.templates')}
          </button>
          <button type="button" className="isl-mi" onClick={() => (close(), onPanel('palette'))}>
            <Icon name="palette" />
            {t('islands.palette')}
          </button>
          <button type="button" className="isl-mi" onClick={() => (close(), api.toggleSidebar?.({ name: 'default' }))}>
            <Icon name="library" />
            {t('islands.library')}
            <kbd>0</kbd>
          </button>
          <button type="button" className="isl-mi" onClick={() => (close(), api.setActiveTool({ type: 'laser' }))}>
            <Icon name="laser" />
            {t('islands.laser')}
            <kbd>K</kbd>
          </button>
        </Pop>
      </div>
    </div>
  )
}

/** View only: no tools, only comments and reactions stay. */
function ViewBar({ api, tool, canEdit, canComment = canEdit, setViewOnly, onStudioTool, prefs, signIn }: { api: Api; tool: Tool; canEdit: boolean; canComment?: boolean; setViewOnly: (v: boolean) => void; onStudioTool: IslandsProps['onStudioTool']; prefs: Prefs; signIn?: string }) {
  const custom = tool.type === 'custom' ? tool.customType : null
  return (
    <div className="isl isl-tools isl-viewbar">
      <Icon name="eye" size={16} />
      <span className="isl-viewbar__label">{t('islands.viewOnly')}</span>
      {/* A guest of a team board: the way in is here, not a second banner over the board (HRN-1480). */}
      {!canEdit && canComment && (
        <>
          <Sep />
          <Btn icon="comment" tip={t('islands.comment')} keyHint="C" on={custom === 'comment'} onClick={() => onStudioTool(custom === 'comment' ? null : 'comment')} />
        </>
      )}
      {!canEdit && !canComment && signIn && (
        <a className="isl-btn isl-btn--soft isl-viewbar__in" href={signIn} data-tip={t('editor.viewOnlyBanner')}>
          <Icon name="pencil" size={16} />
          {t('islands.signIn')}
        </a>
      )}
      {canEdit && (
        <>
          <Sep />
          <Btn icon="comment" tip={t('islands.comment')} keyHint="C" on={custom === 'comment'} onClick={() => onStudioTool(custom === 'comment' ? null : 'comment')} />
          <button type="button" className={`isl-ib isl-emo${custom === 'react' ? ' on' : ''}`} data-tip={t('islands.reaction')} data-key="E" onClick={() => api.setActiveTool(custom === 'react' ? { type: 'selection' } : { type: 'custom', customType: 'react' })}>
            {prefs.emoji}
          </button>
          <button type="button" className="isl-btn isl-btn--soft" onClick={() => setViewOnly(false)}>
            <Icon name="pencil" size={16} />
            {t('islands.edit')}
          </button>
        </>
      )}
    </div>
  )
}

// ── Bottom left: history and zoom ────────────────────────────────────────────

function Zoom({ api, canEdit }: { api: Api; canEdit: boolean }) {
  'use no memo' // reads the editor (api) while rendering: the compiler would cache it by the stable api (HRN-1515)
  const zoom = Math.round(((api.getAppState().zoom as { value: number })?.value ?? 1) * 100)
  return (
    <div className="isl isl-bl">
      {canEdit && (
        <>
          <Btn icon="undo" tip={t('islands.undo')} keyHint="⌘Z" onClick={ACTIONS.undo} />
          <Btn icon="redo" tip={t('islands.redo')} keyHint="⇧⌘Z" onClick={ACTIONS.redo} />
          <Sep />
        </>
      )}
      <Btn icon="minus" tip={t('islands.zoomOut')} keyHint="⌘−" onClick={ACTIONS.zoomOut} />
      <button type="button" className="isl-zl" data-tip={t('islands.zoomReset')} data-key="⌘0" onClick={ACTIONS.zoomReset}>
        {zoom}%
      </button>
      <Btn icon="plus" tip={t('islands.zoomIn')} keyHint="⌘+" onClick={ACTIONS.zoomIn} />
      <Btn icon="fit" tip={t('islands.fit')} keyHint="⇧1" onClick={ACTIONS.fit} />
    </div>
  )
}

// ── Root ─────────────────────────────────────────────────────────────────────

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null
  return Boolean(el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)))
}

export function Islands(props: IslandsProps) {
  'use no memo' // reads the editor (api) while rendering: the compiler would cache it by the stable api (HRN-1515)
  const { api, canEdit, onStudioTool, onReact, votes, me } = props
  useEditorTick(api)
  useStickyFit(api, canEdit)
  const appState = api.getAppState()
  const tool = (appState.activeTool ?? { type: 'selection' }) as Tool
  const [viewOnly, setViewOnlyRaw] = useState(false)
  const [prefs, setPrefsRaw] = useState(readPrefs)
  const setPrefs = useCallback((p: Partial<Prefs>) => {
    setPrefsRaw((was) => {
      const next = { ...was, ...p }
      try {
        localStorage.setItem('boards-tools', JSON.stringify(next))
      } catch {
        // Private window: the choice lives until the tab closes.
      }
      return next
    })
  }, [])
  const editing = canEdit && !viewOnly
  const setViewOnly = useCallback(
    (v: boolean) => {
      setViewOnlyRaw(v)
      api.updateScene({ appState: { viewModeEnabled: v, selectedElementIds: {} } })
      if (v) api.setActiveTool({ type: 'selection' })
    },
    [api],
  )

  // The theme of the islands follows the editor's.
  const dark = appState.theme === 'dark'
  useEffect(() => {
    document.documentElement.classList.toggle('isl-dark', dark)
  }, [dark])
  useEffect(() => {
    document.documentElement.classList.add('islands-on')
    return () => document.documentElement.classList.remove('islands-on')
  }, [])
  useEffect(() => {
    if (!installDarkPaint()) return
    installDarkDots()
    // Text typed into a coloured sticky stays dark on its colour, as it will be drawn; free text is inverted.
    let typingId: string | null = null
    const offChange = api.onChange?.((elements, appState) => {
      const el = appState.editingTextElement as { id: string; containerId?: string | null } | null
      if ((el?.id ?? null) === typingId) return
      typingId = el?.id ?? null
      let keep = false
      if (el) {
        const all = elements as readonly DarkEl[]
        const container = el.containerId ? (all.find((x) => x.id === el.containerId) ?? null) : null
        keep = darkKind(el as DarkEl, container) === 'keep'
      }
      document.documentElement.classList.toggle('isl-edit-keep', keep)
    })
    return () => {
      offChange?.()
      document.documentElement.classList.remove('isl-edit-keep')
    }
  }, [api])
  // Side island open: the bars keep clear of it.
  useEffect(() => {
    document.documentElement.classList.toggle('isl-side-open', Boolean(props.side))
  }, [props.side])

  // Our tools' keys; the editor keeps its own (V, H, R, D, O, A, L, P, T, F, 0…).
  const prefsRef = useRef(prefs)
  prefsRef.current = prefs
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey || typing(e)) return
      const st = api.getAppState()
      if (st.editingTextElement) return
      const k = e.key.toLowerCase()
      if (k === 's' && editing) onStudioTool('sticky')
      else if (k === 'c' && (props.canComment ?? canEdit)) onStudioTool('comment')
      else if (k === 'e' && canEdit) api.setActiveTool({ type: 'custom', customType: 'react' })
      else if (k === 'w' && editing) props.insert.site()
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [api, editing, canEdit, onStudioTool, props.insert])

  // The reaction tool: a click on an object puts the chosen reaction on it, a second one takes it back.
  const votesRef = useRef(votes)
  votesRef.current = votes
  useEffect(() => {
    const off = api.onPointerDown?.((active, down) => {
      if (active.type !== 'custom' || active.customType !== 'react') return
      const hit = objectAt(sceneOf(api), down.origin.x, down.origin.y)
      if (hit) {
        const emoji = prefsRef.current.emoji
        const mine = Boolean(me && votesRef.current[hit.id]?.[emoji]?.includes(me))
        onReact(hit.id, emoji, !mine)
      }
      if (!active.locked) api.setActiveTool({ type: 'selection' })
    })
    return () => off?.()
  }, [api, me, onReact])

  return (
    <div className="islands">
      <TopLeft api={api} app={props.app} title={props.title} onRename={props.onRename} homeUrl={props.homeUrl} textUrl={props.textUrl} fileUrl={props.fileUrl} canEdit={canEdit} menu={props.menu} viewOnly={viewOnly} setViewOnly={setViewOnly} />
      <TopRight api={api} crowd={props.crowd} agentWorking={props.agentWorking} status={props.status} onShare={props.onShare} openComments={props.openComments} side={props.side} setSide={props.setSide} app={props.app} extras={props.extras} />
      {editing ? (
        <Toolbar api={api} tool={tool} stickyColor={props.stickyColor} setStickyColor={props.setStickyColor} onStudioTool={onStudioTool} reactions={props.reactions} onPanel={props.onPanel} insert={props.insert} prefs={prefs} setPrefs={setPrefs} />
      ) : (
        <ViewBar api={api} tool={tool} canEdit={canEdit} canComment={props.canComment} setViewOnly={setViewOnly} onStudioTool={onStudioTool} prefs={prefs} signIn={props.menu.signIn} />
      )}
      <Zoom api={api} canEdit={editing} />
      {editing && <ContextBar api={api} reactions={props.reactions} votes={votes} me={me} onReact={onReact} onAsk={props.onAsk} />}
    </div>
  )
}

/** The topmost object under a scene point (a label counts as its container). */
export function objectAt(elements: readonly El[], x: number, y: number): El | null {
  for (let i = elements.length - 1; i >= 0; i--) {
    const el = elements[i]
    if (el.isDeleted) continue
    let x0 = Math.min(el.x, el.x + el.width)
    let y0 = Math.min(el.y, el.y + el.height)
    let x1 = Math.max(el.x, el.x + el.width)
    let y1 = Math.max(el.y, el.y + el.height)
    if (el.points?.length) {
      x0 = Infinity
      y0 = Infinity
      x1 = -Infinity
      y1 = -Infinity
      for (const [px, py] of el.points) {
        x0 = Math.min(x0, el.x + px)
        y0 = Math.min(y0, el.y + py)
        x1 = Math.max(x1, el.x + px)
        y1 = Math.max(y1, el.y + py)
      }
      x0 -= 8
      y0 -= 8
      x1 += 8
      y1 += 8
    }
    if (x < x0 || x > x1 || y < y0 || y > y1) continue
    if (el.type === 'text' && el.containerId) return elements.find((c) => c.id === el.containerId) ?? el
    // A frame counts only by its title strip and edge, not its whole inside.
    if (el.type === 'frame' && x > x0 + 12 && x < x1 - 12 && y > y0 + 12 && y < y1 - 12) continue
    return el
  }
  return null
}
