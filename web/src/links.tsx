/**
 * Link cards: a pasted URL becomes a card — a bookmark for any site, or a live
 * card for another board on the same server (title and last update).
 *
 * In the scene a card is a plain rectangle marked `customData.kind: 'card'`
 * with a fallback label inside; this layer draws the live card on top, like the
 * author of a sticky. So in exports and in the board text for agents the card
 * stays a readable line, while it moves, selects and deletes like any shape.
 *
 * Board titles come from the boards server, which only answers about boards
 * the current board actually links to.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith, restoreElements } from '@excalidraw/excalidraw'
import { CameraLayer, inWindow, useSceneVersion, useSceneWindow } from './camera'
import type { StudioApi } from './studio'
import { classify, fallbackLabel } from '../../shared/links.mjs'

type Target = { kind: 'board' | 'link'; ref: string; url: string; slug?: string; host?: string }
export type Meta = { kind: 'board'; slug: string; title: string; updatedAt: string | null }
export type SceneEl = { id: string; type: string; x: number; y: number; width: number; height: number; isDeleted?: boolean; containerId?: string | null; text?: string; customData?: Record<string, unknown> }

/** How often to re-ask the server: a board title rarely changes, but a card should not lie for more than a minute. */
const REFRESH_MS = 60_000
/** Empty answers are retried sooner: the card may not have reached the server yet. */
const RETRY_MS = 10_000
const fresh = (ref: string, now: number) => {
  const hit = known.get(ref)
  return Boolean(hit) && now - hit!.at < (hit!.meta ? REFRESH_MS : RETRY_MS)
}
const CARD = { width: 288, height: 96 }
const BOOKMARK = { width: 264, height: 56 }
/** A longer fallback label does not fit the card and would stick out from under it. */
const LABEL_MAX = 72
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

// What we already know about targets — one cache per tab: all cards for the same board ask the server once.
const known = new Map<string, { meta: Meta | null; at: number }>()
const subscribers = new Set<() => void>()

async function load(base: string, q: string, refs: string[]) {
  if (!refs.length) return
  try {
    const response = await fetch(`${base}/links${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ refs }) })
    if (!response.ok) return
    const data = (await response.json()) as { meta: Record<string, Meta | null> }
    const at = Date.now()
    for (const ref of refs) known.set(ref, { meta: data.meta[ref] ?? null, at })
    subscribers.forEach((notify) => notify())
  } catch {
    // Offline — the card stays a plain link; we'll ask again on the next round.
  }
}

/** Data by target ref; missing and stale entries are fetched. */
export function useMeta(base: string, q: string, refs: string[]) {
  const [, bump] = useState(0)
  const key = refs.join('|')
  useEffect(() => {
    const notify = () => bump((n) => n + 1)
    subscribers.add(notify)
    return () => {
      subscribers.delete(notify)
    }
  }, [])
  useEffect(() => {
    const wanted = key ? key.split('|').filter((ref) => !ref.startsWith('link:')) : []
    const ask = () => {
      const now = Date.now()
      void load(base, q, wanted.filter((ref) => !fresh(ref, now)))
    }
    ask()
    const timer = setInterval(ask, RETRY_MS)
    return () => clearInterval(timer)
  }, [base, q, key])
  return (ref: string) => known.get(ref)?.meta ?? null
}

function LinkGlyph() {
  return (
    <svg className="link-glyph link-glyph--plain" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 14a4.5 4.5 0 0 0 6.4 0l3-3A4.5 4.5 0 0 0 13 4.6l-1.2 1.2 M14 10a4.5 4.5 0 0 0-6.4 0l-3 3A4.5 4.5 0 0 0 11 19.4l1.2-1.2" />
    </svg>
  )
}

function Glyph({ kind, staticBase }: { kind: Target['kind']; staticBase: string }) {
  if (kind === 'board') return <img className="link-glyph" src={`${staticBase}/logo-mark.svg`} alt="" />
  return <LinkGlyph />
}

const ago = (iso: string | null) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return ''
  const days = Math.floor((Date.now() - d.valueOf()) / 86_400_000)
  return days <= 0 ? 'updated today' : days === 1 ? 'updated yesterday' : `updated ${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })}`
}

function Card({ target, meta, staticBase }: { target: Target; meta: Meta | null; staticBase: string }) {
  let head: string
  let title: string
  let foot: string | null = null
  if (meta?.kind === 'board') {
    head = 'Board'
    title = meta.title
    foot = ago(meta.updatedAt)
  } else if (target.kind === 'link') {
    head = target.host ?? ''
    // The last path segment without a numeric prefix is the closest thing to a title we have without fetching the site.
    title = decodeURIComponent(new URL(target.url).pathname.replace(/\/$/, '').split('/').pop() || target.host || target.url).replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ')
  } else {
    // The server did not answer or the board is gone: the card stays a link.
    head = 'Board'
    title = fallbackLabel(null, target)
  }
  return (
    <>
      <span className="link-card__head">
        <Glyph kind={target.kind} staticBase={staticBase} />
        <span className="link-card__kind">{head}</span>
      </span>
      <span className="link-card__title">{title}</span>
      {foot && <span className="link-card__foot">{foot}</span>}
    </>
  )
}

type Item = { id: string; x: number; y: number; width: number; height: number; target: Target | null }

/** The block that owns the selection: a shape's label is a separate element, but links belong to the shape itself. */
export function hostOf(api: StudioApi, id: string | null): SceneEl | null {
  if (!id) return null
  const all = api.getSceneElements() as unknown as SceneEl[]
  const el = all.find((e) => e.id === id)
  if (!el) return null
  return el.containerId ? all.find((e) => e.id === el.containerId) ?? el : el
}

type LayerProps = {
  api: StudioApi
  base: string
  q: string
  staticBase: string
  /** Origin of this boards server: only `/b/<slug>` links on it become board cards. */
  boardOrigin?: string
}

/** Card layer above the canvas: moves with the camera, re-renders only when the cards themselves change. */
export const LinkLayer = memo(function LinkLayer({ api, base, q, staticBase, boardOrigin }: LayerProps) {
  const version = useSceneVersion()
  const [items, setItems] = useState<Item[]>([])
  const signature = useRef('')

  useLayoutEffect(() => {
    const all = api.getSceneElements() as unknown as SceneEl[]
    const next: Item[] = []
    for (const el of all) {
      const url = el.customData?.kind === 'card' ? (el.customData.url as string | undefined) : undefined
      if (url) next.push({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height, target: classify(url, { boardOrigin }) as Target | null })
    }
    const sig = next.map((i) => `${i.id}:${i.x}:${i.y}:${i.width}:${i.height}:${i.target?.ref ?? ''}`).join('|')
    if (sig === signature.current) return
    signature.current = sig
    setItems(next)
  }, [api, version, boardOrigin])

  const refs = [...new Set(items.flatMap((i) => (i.target ? [i.target.ref] : [])))].sort()
  const metaOf = useMeta(base, q, refs)
  const near = useSceneWindow()

  return (
    <CameraLayer className="link-layer">
      {items
        .filter((i) => i.target && inWindow(near, i.x, i.y, i.x + i.width, i.y + i.height))
        .map((i) => (
          <div key={i.id} className={`link-card link-card--${i.target!.kind}`} style={{ left: Math.min(i.x, i.x + i.width), top: Math.min(i.y, i.y + i.height), width: Math.abs(i.width), height: Math.abs(i.height) }}>
            <Card target={i.target!} meta={metaOf(i.target!.ref)} staticBase={staticBase} />
          </div>
        ))}
    </CameraLayer>
  )
})

/**
 * Attach a link to a block: a block is selected, a URL is in the clipboard,
 * Cmd/Ctrl+V. The URL becomes the block's own link — the editor draws its icon
 * at the corner. A regular edit: Ctrl+Z undoes it.
 */
export function linkToBlock(api: StudioApi, hostId: string, url: string, boardOrigin?: string) {
  const target = classify(url, { boardOrigin }) as Target | null
  const href = target?.url ?? url
  const next = api.getSceneElementsIncludingDeleted().map((el) => (el.id === hostId ? newElementWith(el as never, { link: href } as never) : el))
  api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  api.setToast({ message: 'Link attached to the block', closable: true, duration: 3500 })
}

/**
 * A pasted URL becomes a card at `at` (scene coordinates). For a board card we
 * then ask for its title: the fallback label should be the real title, written
 * into the scene once rather than patched again and again.
 */
export async function addCard(api: StudioApi, base: string, q: string, url: string, at: { x: number; y: number }, boardOrigin?: string) {
  const target = classify(url, { boardOrigin }) as Target | null
  if (!target) return false
  const size = target.kind === 'link' ? BOOKMARK : CARD
  const id = `card-${Math.random().toString(36).slice(2, 10)}`
  const place = (label: string) => {
    const created = convertToExcalidrawElements(
      [
        {
          type: 'rectangle',
          id,
          x: Math.round(at.x - size.width / 2),
          y: Math.round(at.y - size.height / 2),
          width: size.width,
          height: size.height,
          roughness: 0,
          strokeWidth: 1,
          fillStyle: 'solid',
          roundness: { type: 3, value: 10 },
          strokeColor: '#ced4da',
          backgroundColor: '#ffffff',
          link: target.url,
          customData: { kind: 'card', url: target.url },
          label: { text: label, fontSize: 14, fontFamily: 6, strokeColor: '#495057' },
        },
      ] as never,
      { regenerateIds: false },
    )
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...created], appState: { selectedElementIds: { [id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  }
  // The card appears at once with the URL instead of a title: the server only answers about
  // what is already on the board. The title replaces the fallback label right after.
  place(fallbackLabel(null, target) as string)
  if (target.kind === 'link') return true
  // The card reaches the server through regular sync — up to 1.5 s when polling. Wait for it there.
  let meta: Meta | null = null
  for (let attempt = 0; attempt < 6 && !meta; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt ? 700 : 150))
    await load(base, q, [target.ref])
    meta = known.get(target.ref)?.meta ?? null
  }
  if (!meta) return true
  const label = cut(fallbackLabel(meta, target) as string, LABEL_MAX)
  const current = api.getSceneElementsIncludingDeleted()
  const renamed = current.map((el) => ((el as SceneEl).containerId === id && el.type === 'text' ? newElementWith(el as never, { text: label, originalText: label } as never) : el))
  api.updateScene({ elements: restoreElements(renamed as never, null, { refreshDimensions: true, repairBindings: true }) as never, captureUpdate: CaptureUpdateAction.NEVER })
  return true
}
