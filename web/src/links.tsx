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
 * the current board actually links to. The same server asks plugin card
 * resolvers (and the optional link preview) about other URLs and about text
 * references such as issue keys; their cards are drawn by a renderer a web
 * plugin registered for the card's kind, or by the generic card below.
 */
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CaptureUpdateAction, convertToExcalidrawElements, newElementWith, restoreElements } from '@excalidraw/excalidraw'
import { CameraLayer, inWindow, useSceneVersion, useSceneWindow } from './camera'
import type { StudioApi } from './studio'
import { classify, fallbackLabel } from '../../shared/links.mjs'
import { dateLocale, t } from './i18n'
import { cardRenderer, usePluginRegistry, type Card as PluginCardData } from './plugins'

type Target = { kind: 'board' | 'link' | 'ref'; ref: string; url: string; slug?: string; host?: string; text?: string }
/** Card data from the server: a board (title, last update) or a plugin's card. */
export type Meta = PluginCardData & { updatedAt?: string | null }
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
export function useMeta(base: string, q: string, refs: string[], { links = false }: { links?: boolean } = {}) {
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
    // Bookmarks are asked about only when something on the server can turn a URL into a card.
    const wanted = key ? key.split('|').filter((ref) => links || !ref.startsWith('link:')) : []
    const ask = () => {
      const now = Date.now()
      void load(base, q, wanted.filter((ref) => !fresh(ref, now)))
    }
    ask()
    const timer = setInterval(ask, RETRY_MS)
    return () => clearInterval(timer)
  }, [base, q, key, links])
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

const ago = (iso: string | null | undefined) => {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return ''
  const days = Math.floor((Date.now() - d.valueOf()) / 86_400_000)
  return days <= 0 ? t('editor.updatedToday') : days === 1 ? t('editor.updatedYesterday') : t('editor.updatedOn', { date: d.toLocaleDateString(dateLocale, { day: 'numeric', month: 'long' }) })
}

/** A card icon: an image URL, a data URI or a short emoji; otherwise the link glyph. */
function CardIcon({ icon }: { icon?: string }) {
  if (icon && /^(https:\/\/|\/b\/|data:image\/)/.test(icon)) return <img className="link-glyph" src={icon} alt="" referrerPolicy="no-referrer" />
  if (icon) return <span className="link-glyph link-glyph--emoji" aria-hidden>{icon}</span>
  return <LinkGlyph />
}

/** A plugin's card without a renderer of its own: icon and site, status, title, subtitle. */
function GenericCard({ card, target }: { card: Meta; target: Target }) {
  return (
    <>
      <span className="link-card__head">
        <CardIcon icon={card.icon} />
        <span className="link-card__kind">{card.site ?? target.host ?? card.kind}</span>
        {card.status && <span className={`link-card__status link-card__status--${card.status.tone}`}>{card.status.label}</span>}
      </span>
      <span className="link-card__title">{card.title}</span>
      {card.subtitle && <span className="link-card__foot">{card.subtitle}</span>}
    </>
  )
}

/** A card drawn by a web plugin's renderer into a plain DOM node; the renderer may return a cleanup. */
function RenderedCard({ card, element, staticBase }: { card: Meta; element: SceneEl; staticBase: string }) {
  const host = useRef<HTMLDivElement>(null)
  const render = cardRenderer(card.kind)
  const signature = JSON.stringify(card)
  useEffect(() => {
    const node = host.current
    if (!node || !render) return
    node.replaceChildren()
    let cleanup: void | (() => void)
    try {
      cleanup = render(node, card, { locale: t.locale, t: (key, vars) => t(key, vars), staticBase, element: element as never })
    } catch (error) {
      console.error(`[boards] card renderer for ${card.kind} failed`, error)
    }
    return () => {
      if (typeof cleanup === 'function') cleanup()
      node.replaceChildren()
    }
    // The card's content, not its object identity, decides a re-render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [render, signature, staticBase])
  return <div className="link-card__plugin" ref={host} />
}

function Card({ target, meta, staticBase, element }: { target: Target; meta: Meta | null; staticBase: string; element: SceneEl }) {
  usePluginRegistry()
  if (meta && meta.kind !== 'board') {
    if (cardRenderer(meta.kind)) return <RenderedCard card={meta} element={element} staticBase={staticBase} />
    return <GenericCard card={meta} target={target} />
  }
  let head: string
  let title: string
  let foot: string | null = null
  if (meta?.kind === 'board') {
    head = t('editor.cardBoard')
    title = meta.title
    foot = ago(meta.updatedAt)
  } else if (target.kind === 'ref') {
    // A reference the server has not resolved (yet): show it as typed.
    head = ''
    title = target.text ?? target.ref
  } else if (target.kind === 'link') {
    head = target.host ?? ''
    // The last path segment without a numeric prefix is the closest thing to a title we have without fetching the site.
    title = decodeURIComponent(new URL(target.url).pathname.replace(/\/$/, '').split('/').pop() || target.host || target.url).replace(/^\d+[-_]/, '').replace(/[-_]+/g, ' ')
  } else {
    // The server did not answer or the board is gone: the card stays a link.
    head = t('editor.cardBoard')
    title = fallbackLabel(null, target)
  }
  return (
    <>
      <span className="link-card__head">
        <Glyph kind={target.kind === 'board' ? 'board' : 'link'} staticBase={staticBase} />
        <span className="link-card__kind">{head}</span>
      </span>
      <span className="link-card__title">{title}</span>
      {foot && <span className="link-card__foot">{foot}</span>}
    </>
  )
}

type Item = { id: string; x: number; y: number; width: number; height: number; target: Target | null; element: SceneEl }

/** A reference card's target: `ref:<resolver>:<text>`. */
const refTarget = (ref: string): Target | null => {
  const m = /^ref:([a-z0-9][a-z0-9._-]{0,60}):(.{1,200})$/s.exec(ref)
  return m ? { kind: 'ref', ref, url: '', text: m[2] } : null
}

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
  /** The server may have rich cards for plain URLs (plugin resolvers, link preview). */
  cardsForLinks?: boolean
}

/** Card layer above the canvas: moves with the camera, re-renders only when the cards themselves change. */
export const LinkLayer = memo(function LinkLayer({ api, base, q, staticBase, boardOrigin, cardsForLinks = false }: LayerProps) {
  const version = useSceneVersion()
  const [items, setItems] = useState<Item[]>([])
  const signature = useRef('')

  useLayoutEffect(() => {
    const all = api.getSceneElements() as unknown as SceneEl[]
    const next: Item[] = []
    for (const el of all) {
      if (el.customData?.kind !== 'card') continue
      const url = el.customData.url as string | undefined
      const ref = el.customData.ref as string | undefined
      const target = url ? (classify(url, { boardOrigin }) as Target | null) : ref ? refTarget(ref) : null
      if (url || ref) next.push({ id: el.id, x: el.x, y: el.y, width: el.width, height: el.height, target, element: el })
    }
    const sig = next.map((i) => `${i.id}:${i.x}:${i.y}:${i.width}:${i.height}:${i.target?.ref ?? ''}`).join('|')
    if (sig === signature.current) return
    signature.current = sig
    setItems(next)
  }, [api, version, boardOrigin])

  const refs = [...new Set(items.flatMap((i) => (i.target ? [i.target.ref] : [])))].sort()
  const metaOf = useMeta(base, q, refs, { links: cardsForLinks })
  const near = useSceneWindow()

  return (
    <CameraLayer className="link-layer">
      {items
        .filter((i) => i.target && inWindow(near, i.x, i.y, i.x + i.width, i.y + i.height))
        .map((i) => (
          <div key={i.id} className={`link-card link-card--${i.target!.kind}${metaOf(i.target!.ref) && metaOf(i.target!.ref)!.kind !== 'board' ? ' link-card--rich' : ''}`} style={{ left: Math.min(i.x, i.x + i.width), top: Math.min(i.y, i.y + i.height), width: Math.abs(i.width), height: Math.abs(i.height) }}>
            <Card target={i.target!} meta={metaOf(i.target!.ref)} staticBase={staticBase} element={i.element} />
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
  api.setToast({ message: t('editor.linkAttached'), closable: true, duration: 3500 })
}

/**
 * A pasted URL becomes a card at `at` (scene coordinates). For a board card we
 * then ask for its title: the fallback label should be the real title, written
 * into the scene once rather than patched again and again.
 */
export async function addCard(api: StudioApi, base: string, q: string, url: string, at: { x: number; y: number }, boardOrigin?: string, { cardsForLinks = false }: { cardsForLinks?: boolean } = {}) {
  const target = classify(url, { boardOrigin }) as Target | null
  if (!target) return false
  return placeCard(api, base, q, target, at, { cardsForLinks })
}

/** A pasted text reference a plugin recognises (see matchReference in plugins.ts) becomes a card too. */
export async function addRefCard(api: StudioApi, base: string, q: string, ref: string, at: { x: number; y: number }) {
  const target = refTarget(ref)
  if (!target) return false
  return placeCard(api, base, q, target, at, { cardsForLinks: true })
}

async function placeCard(api: StudioApi, base: string, q: string, target: Target, at: { x: number; y: number }, { cardsForLinks }: { cardsForLinks: boolean }) {
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
          ...(target.url ? { link: target.url } : {}),
          customData: target.kind === 'ref' ? { kind: 'card', ref: target.ref } : { kind: 'card', url: target.url },
          label: { text: label, fontSize: 14, fontFamily: 6, strokeColor: '#495057' },
        },
      ] as never,
      { regenerateIds: false },
    )
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...created], appState: { selectedElementIds: { [id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  }
  // The card appears at once with the URL instead of a title: the server only answers about
  // what is already on the board. The title replaces the fallback label right after.
  place(target.kind === 'ref' ? (target.text ?? target.ref) : (fallbackLabel(null, target) as string))
  if (target.kind === 'link' && !cardsForLinks) return true
  // The card reaches the server through regular sync — up to 1.5 s when polling. Wait for it there.
  let meta: Meta | null = null
  for (let attempt = 0; attempt < 6 && !meta; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, attempt ? 700 : 150))
    await load(base, q, [target.ref])
    meta = known.get(target.ref)?.meta ?? null
  }
  if (!meta) return true
  // The fallback label is what exports and agents see: the card's real title once known. A reference card also
  // gets the link the resolver found, so it opens like any linked block.
  const label = cut(meta.kind === 'board' ? (fallbackLabel(meta, target, { boardWord: t('editor.cardBoard') }) as string) : target.kind === 'ref' ? `${target.text} · ${meta.title}` : meta.title, LABEL_MAX)
  const current = api.getSceneElementsIncludingDeleted()
  const renamed = current.map((el) => {
    if ((el as SceneEl).containerId === id && el.type === 'text') return newElementWith(el as never, { text: label, originalText: label } as never)
    if (el.id === id && target.kind === 'ref' && meta!.url) return newElementWith(el as never, { link: meta!.url } as never)
    return el
  })
  api.updateScene({ elements: restoreElements(renamed as never, null, { refreshDimensions: true, repairBindings: true }) as never, captureUpdate: CaptureUpdateAction.NEVER })
  return true
}
