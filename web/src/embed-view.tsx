/**
 * Read-only embed view (`/b/<slug>?k=<key>&embed=1`): a board shown inside someone else's page via <iframe>.
 *
 * Deliberately a separate, small entry point instead of a mode of the editor: the embedding page may sandbox the
 * frame without `allow-same-origin`, which gives this document an opaque origin — no cookies, no storage, and every
 * request to the boards origin is cross-origin. So everything the view needs (the scene, the board URL) is inlined by
 * the server into #embed-data, and this file never talks to the boards API, opens the live channel, or polls.
 *
 * Page contract (server/html.mjs renderEmbedPage): #embed-text holds the board as text for agents and as a
 * fallback; adding `ready` to <body> hides it once the canvas is up. #embed-root is where the view renders.
 */
import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { CaptureUpdateAction, Excalidraw } from '@excalidraw/excalidraw'
import type { ExcalidrawImperativeAPI, ExcalidrawInitialDataState } from '@excalidraw/excalidraw/types'
import '@excalidraw/excalidraw/index.css'
import './embed-view.css'
import { debounce, fitScene, type Fit, type FitElement } from './fit'
import { excalidrawLang, t } from './i18n'

type EmbedData = {
  title?: string
  boardUrl?: string
  scene?: { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> }
}

type Zoom = { value: number }

/** Frame resizes come in bursts (dragging a splitter, rotating a phone); refit once they settle. */
const REFIT_DELAY_MS = 150

/** Excalidraw normalizes zoom and scroll values; anything within this tolerance is still "our" fit. */
const SAME = 1e-3

function readData(): EmbedData | null {
  const node = document.getElementById('embed-data')
  if (!node) return null
  try {
    const data = JSON.parse(node.textContent ?? 'null') as EmbedData | null
    return data && typeof data === 'object' ? data : null
  } catch (error) {
    console.error('embed: unreadable #embed-data', error)
    return null
  }
}

/** Only http(s) links leave the frame: a malformed or script URL is dropped rather than rendered as a link. */
function safeUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw) return null
  try {
    const url = new URL(raw, location.href)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    // The embed URL itself may have been passed through; the "Open board" link is the full editor.
    url.searchParams.delete('embed')
    return url.href
  } catch {
    return null
  }
}

/** The frame is the viewport: #embed-root is `position: fixed; inset: 0`. */
function viewport(root: HTMLElement | null) {
  const width = root?.clientWidth || window.innerWidth
  const height = root?.clientHeight || window.innerHeight
  return { width, height }
}

function sameView(a: Fit | null, scrollX: number, scrollY: number, zoom: number): boolean {
  if (!a) return false
  const near = (x: number, y: number) => Math.abs(x - y) <= SAME * Math.max(1, Math.abs(x), Math.abs(y))
  return near(a.zoom, zoom) && near(a.scrollX, scrollX) && near(a.scrollY, scrollY)
}

function useColorScheme(): 'light' | 'dark' {
  const query = useMemo(() => window.matchMedia?.('(prefers-color-scheme: dark)') ?? null, [])
  const [dark, setDark] = useState(() => query?.matches ?? false)
  useEffect(() => {
    if (!query) return
    const onChange = (event: MediaQueryListEvent) => setDark(event.matches)
    query.addEventListener?.('change', onChange)
    return () => query.removeEventListener?.('change', onChange)
  }, [query])
  return dark ? 'dark' : 'light'
}

// --- Fullscreen ----------------------------------------------------------------------------------------------------

/** Safari (iPadOS, older macOS) only has the webkit-prefixed variant. */
type FullscreenDocument = Document & {
  webkitFullscreenEnabled?: boolean
  webkitFullscreenElement?: Element | null
  webkitExitFullscreen?: () => Promise<void> | void
}
type FullscreenElement = HTMLElement & { webkitRequestFullscreen?: () => Promise<void> | void }

const fsDocument = document as FullscreenDocument

/**
 * False inside an iframe without `allow="fullscreen"` (and on iPhone Safari): then the button is not shown at all,
 * because a control that silently does nothing is worse than no control.
 */
function fullscreenSupported(): boolean {
  return Boolean(fsDocument.fullscreenEnabled || fsDocument.webkitFullscreenEnabled)
}

function isFullscreen(): boolean {
  return Boolean(fsDocument.fullscreenElement || fsDocument.webkitFullscreenElement)
}

async function toggleFullscreen(): Promise<void> {
  try {
    if (isFullscreen()) {
      if (fsDocument.exitFullscreen) await fsDocument.exitFullscreen()
      else await fsDocument.webkitExitFullscreen?.()
    } else {
      const element = document.documentElement as FullscreenElement
      if (element.requestFullscreen) await element.requestFullscreen()
      else await element.webkitRequestFullscreen?.()
    }
  } catch (error) {
    // The browser may refuse (no user activation, policy change); the label follows the real state anyway.
    console.warn('embed: fullscreen request refused', error)
  }
}

function useFullscreen(): { supported: boolean; active: boolean } {
  const [supported] = useState(fullscreenSupported)
  const [active, setActive] = useState(isFullscreen)
  useEffect(() => {
    const onChange = () => setActive(isFullscreen())
    document.addEventListener('fullscreenchange', onChange)
    document.addEventListener('webkitfullscreenchange', onChange)
    return () => {
      document.removeEventListener('fullscreenchange', onChange)
      document.removeEventListener('webkitfullscreenchange', onChange)
    }
  }, [])
  return { supported, active }
}

// --- View ----------------------------------------------------------------------------------------------------------

function OpenIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M6.5 3.5h-3a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-3" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function FullscreenIcon({ active }: { active: boolean }) {
  const d = active
    ? 'M6 2.5v3.5H2.5M10 2.5v3.5h3.5M6 13.5V10H2.5M10 13.5V10h3.5'
    : 'M2.5 6V2.5H6M13.5 6V2.5H10M2.5 10v3.5H6M13.5 10v3.5H10'
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" focusable="false">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Controls({ boardUrl, title }: { boardUrl: string | null; title: string }) {
  const fullscreen = useFullscreen()
  return (
    <nav className="embed-controls" aria-label={t('embed.board')}>
      {boardUrl && (
        <a className="embed-control" href={boardUrl} target="_blank" rel="noopener noreferrer" title={t('embed.openInNewTab', { title })}>
          <OpenIcon />
          <span>{t('embed.openBoard')}</span>
        </a>
      )}
      {fullscreen.supported && (
        <button type="button" className="embed-control" onClick={() => void toggleFullscreen()} aria-pressed={fullscreen.active}>
          <FullscreenIcon active={fullscreen.active} />
          <span>{fullscreen.active ? t('embed.exitFullscreen') : t('embed.fullscreen')}</span>
        </button>
      )}
    </nav>
  )
}

/** Excalidraw props that never change: one reference so its memoized children are not re-rendered for nothing. */
const UI_OPTIONS = {
  canvasActions: {
    changeViewBackgroundColor: false,
    clearCanvas: false,
    export: false as const,
    loadScene: false,
    saveAsImage: false,
    saveToActiveFile: false,
    toggleTheme: false,
  },
  tools: { image: false },
}

function EmbedView({ data }: { data: EmbedData }) {
  const theme = useColorScheme()
  const rootRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null)
  const elements = useMemo(() => (Array.isArray(data.scene?.elements) ? data.scene.elements : []) as FitElement[], [data])

  // The view we last set. While the camera still matches it the viewer has not touched it, and a resize refits.
  const lastFit = useRef<Fit | null>(null)
  const userMoved = useRef(false)

  const initialData = useMemo<ExcalidrawInitialDataState>(() => {
    const fit = fitScene(elements, viewport(document.getElementById('embed-root')))
    lastFit.current = fit
    const appState = data.scene?.appState ?? {}
    return {
      elements: elements as unknown as ExcalidrawInitialDataState['elements'],
      files: (data.scene?.files ?? {}) as ExcalidrawInitialDataState['files'],
      appState: {
        viewBackgroundColor: typeof appState.viewBackgroundColor === 'string' ? appState.viewBackgroundColor : '#ffffff',
        gridSize: typeof appState.gridSize === 'number' ? appState.gridSize : null,
        scrollX: fit.scrollX,
        scrollY: fit.scrollY,
        zoom: { value: fit.zoom } as ExcalidrawInitialDataState['appState']['zoom'],
      } as ExcalidrawInitialDataState['appState'],
      // No scrollToContent: it centres at the current zoom and would blow small diagrams up or cut big ones off.
    }
  }, [data, elements])

  const onApi = useCallback((api: ExcalidrawImperativeAPI) => {
    apiRef.current = api
    // The canvas is about to paint; the text fallback can go.
    requestAnimationFrame(() => document.body.classList.add('ready'))
  }, [])

  const onScrollChange = useCallback((scrollX: number, scrollY: number, zoom: Zoom) => {
    // Our own refits report back here too; only a camera that differs from the last fit is the viewer's doing.
    if (!sameView(lastFit.current, scrollX, scrollY, zoom.value)) userMoved.current = true
  }, [])

  useEffect(() => {
    const refit = debounce(() => {
      const api = apiRef.current
      if (!api || userMoved.current) return
      const fit = fitScene(elements, viewport(rootRef.current))
      lastFit.current = fit
      api.updateScene({
        appState: { scrollX: fit.scrollX, scrollY: fit.scrollY, zoom: { value: fit.zoom } } as Parameters<ExcalidrawImperativeAPI['updateScene']>[0]['appState'],
        captureUpdate: CaptureUpdateAction.NEVER,
      })
    }, REFIT_DELAY_MS)

    const node = rootRef.current
    let observer: ResizeObserver | null = null
    if (node && typeof ResizeObserver === 'function') {
      // The first callback fires right after observe() with the size we already fitted for; that is harmless.
      observer = new ResizeObserver(() => refit())
      observer.observe(node)
    } else {
      window.addEventListener('resize', refit)
    }
    return () => {
      refit.cancel()
      observer?.disconnect()
      window.removeEventListener('resize', refit)
    }
  }, [elements])

  useEffect(() => {
    // View mode still opens a canvas context menu (copy as PNG, grid, stats). Stop it before React's root listener
    // sees it, so the browser's own menu shows instead; nothing in it belongs in a read-only embed.
    const node = rootRef.current
    if (!node) return
    const onContextMenu = (event: MouseEvent) => {
      if ((event.target as Element | null)?.closest?.('.embed-controls')) return
      event.stopPropagation()
    }
    node.addEventListener('contextmenu', onContextMenu, true)
    return () => node.removeEventListener('contextmenu', onContextMenu, true)
  }, [])

  const boardUrl = useMemo(() => safeUrl(data.boardUrl), [data])
  const title = typeof data.title === 'string' && data.title ? data.title : t('embed.board')

  return (
    <div className="embed-view" ref={rootRef}>
      <div className="embed-view__canvas">
        <Excalidraw
          excalidrawAPI={onApi}
          initialData={initialData}
          viewModeEnabled
          zenModeEnabled
          gridModeEnabled={false}
          theme={theme}
          langCode={excalidrawLang}
          UIOptions={UI_OPTIONS}
          onScrollChange={onScrollChange}
          name={title}
        />
      </div>
      <Controls boardUrl={boardUrl} title={title} />
    </div>
  )
}

const data = readData()
const container = document.getElementById('embed-root')
if (data && container) {
  createRoot(container).render(
    <StrictMode>
      <EmbedView data={data} />
    </StrictMode>,
  )
} else {
  // Without data the board-as-text block stays visible, which is still a readable board.
  console.error('embed: missing #embed-data or #embed-root')
}
