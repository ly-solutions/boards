/**
 * Web plugins: ES modules the editor imports at start-up (BOARDS_WEB_PLUGINS, or a server plugin's `web`).
 *
 * A module exports `register(api)` (or a default function) and, optionally, `apiVersion` — a semver range of the
 * plugin API it was written for; an incompatible module is skipped with a console warning. The API (types in
 * types/plugin.d.ts):
 *
 *   registerCardRenderer(kind, render)   draw cards of a kind your server resolver returns; `render(el, card, ctx)`
 *                                        fills a DOM node and may return a cleanup function
 *   registerBlockAction({ id, label, when, run })   an item in the right-click menu for selected elements
 *   registerToolbarButton({ id, label, icon, onClick })   a button in the top-right bar
 *   registerMetaField({ id, format })    how a board property (added by a server plugin) is shown
 *   flags, isEnabled(name)               the current person's feature flags
 *   t(key), addMessages(locale, dict), locale
 *   board, editor, fetch, pluginUrl      the open board, its scene, and calls to plugin routes
 *
 * Renderers work on plain DOM nodes rather than React components: a plugin bundles whatever it likes (or nothing)
 * and never has to share our React instance.
 */
import { useSyncExternalStore } from 'react'
import { PLUGIN_API_VERSION, satisfies } from '../../shared/semver.mjs'
import { locale, localized, t } from './i18n'

export type CardStatus = { label: string; tone: 'neutral' | 'info' | 'success' | 'warning' | 'danger' }
/** Card data as the server's card registry returns it (server/cards.mjs normalizeCard). */
export type Card = { kind: string; title: string; subtitle?: string; site?: string; status?: CardStatus; icon?: string; image?: string; url?: string; updatedAt?: string; fields?: { label: string; value: string }[]; slug?: string }
export type SceneElement = { id: string; type: string; x: number; y: number; width: number; height: number; text?: string; link?: string | null; customData?: Record<string, unknown>; containerId?: string | null; isDeleted?: boolean }
export type When = { min?: number; max?: number | null; types?: string[] | null; kinds?: string[] | null }

export type EditorBridge = {
  getSceneElements(): SceneElement[]
  getSelectedElements(): SceneElement[]
  /** Add elements described as Excalidraw skeletons (convertToExcalidrawElements input). Returns the new ids. */
  addElements(skeletons: Record<string, unknown>[]): string[]
  /** Change fields of existing elements by id; one undo step. */
  updateElements(patches: { id: string; [field: string]: unknown }[]): void
  select(ids: string[]): void
  scrollTo(ids: string[]): void
  toast(message: string): void
}

export type BoardInfo = { slug: string; title: string; url: string; canEdit: boolean; user: { name: string; email: string | null } | null; fields: Record<string, unknown> }

export type WebPluginApi = {
  apiVersion: string
  locale: string
  t: (key: string, vars?: Record<string, unknown>) => string
  addMessages(locale: string, messages: Record<string, unknown>): void
  flags: Readonly<Record<string, boolean | string>>
  isEnabled(name: string): boolean
  board: BoardInfo
  editor: EditorBridge
  /** fetch() with the board key (and guest name) attached, for this board's plugin routes. */
  fetch(input: string, init?: RequestInit): Promise<Response>
  /** URL of a plugin route: board scope by default (`/b/<slug>/plugins/<plugin><path>`), or global. */
  pluginUrl(plugin: string, path?: string, scope?: 'board' | 'global'): string
  registerCardRenderer(kind: string, render: CardRenderer): void
  registerBlockAction(action: WebBlockAction): void
  registerToolbarButton(button: ToolbarButton): void
  registerMetaField(field: MetaFieldView): void
}

export type CardContext = { locale: string; t: WebPluginApi['t']; staticBase: string; element: SceneElement }
export type CardRenderer = (el: HTMLElement, card: Card, ctx: CardContext) => void | (() => void)
export type WebBlockAction = { id: string; label: string | Record<string, string>; icon?: string; when?: When; run(ctx: { selection: SceneElement[]; api: WebPluginApi }): void | Promise<void> }
export type ToolbarButton = { id: string; label: string | Record<string, string>; icon?: string; onClick(ctx: { api: WebPluginApi }): void | Promise<void> }
export type MetaFieldView = { id: string; label?: string | Record<string, string>; placeholder?: string | Record<string, string>; format?(value: unknown): string }

/** What the server says about plugins (page config `plugins`). */
export type ServerAction = { plugin: string; id: string; label: string; icon: string | null; when: When; confirm: string | null }
export type ServerField = { id: string; plugin: string; label: string; type: 'text' | 'date' | 'url' | 'number' | 'select'; options: { value: string; label: string }[] | null; placeholder: string | null; home: boolean }
export type PluginConfig = { web: string[]; actions: ServerAction[]; fields: ServerField[]; patterns: { resolver: string; source: string; flags: string }[]; cardsForLinks?: boolean; apiVersion?: string }

// ---- Registry ---------------------------------------------------------------------------------------------------

const renderers = new Map<string, CardRenderer>()
const actions: (WebBlockAction & { label: string })[] = []
const buttons: (ToolbarButton & { label: string })[] = []
const fieldViews = new Map<string, MetaFieldView>()
let version = 0
const subscribers = new Set<() => void>()
const changed = () => {
  version += 1
  subscribers.forEach((notify) => notify())
}

/** Re-render when plugins register something (they load after the editor). */
export function usePluginRegistry() {
  return useSyncExternalStore(
    (notify) => {
      subscribers.add(notify)
      return () => subscribers.delete(notify)
    },
    () => version,
  )
}

export const cardRenderer = (kind: string) => renderers.get(kind) ?? null
export const webActions = () => actions
export const toolbarButtons = () => buttons
export const fieldView = (id: string) => fieldViews.get(id) ?? null

/** Whether an action's `when` fits the selection (shared by server and web actions). */
export function fitsSelection(when: When | undefined, selection: SceneElement[]) {
  const w = when ?? {}
  const min = w.min ?? 1
  if (selection.length < min) return false
  if (w.max !== null && w.max !== undefined && selection.length > w.max) return false
  if (w.types && !selection.every((el) => w.types!.includes(el.type))) return false
  if (w.kinds && !selection.every((el) => w.kinds!.includes(String(el.customData?.kind ?? '')))) return false
  return true
}

/** Text-reference patterns from server resolvers: which pasted words become cards. */
export function matchReference(patterns: PluginConfig['patterns'] | undefined, text: string | undefined) {
  const value = String(text ?? '').trim()
  if (!value || value.length > 200 || value.includes('\n')) return null
  for (const p of patterns ?? []) {
    try {
      if (new RegExp(`^(?:${p.source})$`, p.flags).test(value)) return `ref:${p.resolver}:${value}`
    } catch {
      // A pattern the browser cannot compile simply never matches.
    }
  }
  return null
}

// ---- Loading ----------------------------------------------------------------------------------------------------

type Bindings = { board: BoardInfo; editor: () => EditorBridge | null; key: string; guest: () => string; flags: Record<string, boolean | string> }

function makeApi(b: Bindings): WebPluginApi {
  const editorProxy: EditorBridge = {
    getSceneElements: () => b.editor()?.getSceneElements() ?? [],
    getSelectedElements: () => b.editor()?.getSelectedElements() ?? [],
    addElements: (s) => b.editor()?.addElements(s) ?? [],
    updateElements: (p) => b.editor()?.updateElements(p),
    select: (ids) => b.editor()?.select(ids),
    scrollTo: (ids) => b.editor()?.scrollTo(ids),
    toast: (m) => b.editor()?.toast(m),
  }
  const api: WebPluginApi = {
    apiVersion: PLUGIN_API_VERSION,
    locale,
    t: (key, vars) => t(key, vars),
    addMessages: (lang, messages) => t.add(lang, messages),
    flags: Object.freeze({ ...b.flags }),
    isEnabled: (name) => b.flags[name] === true || (typeof b.flags[name] === 'string' && b.flags[name] !== 'off'),
    board: b.board,
    editor: editorProxy,
    fetch: (input, init = {}) => {
      const headers = new Headers(init.headers ?? {})
      headers.set('x-board-key', b.key)
      if (b.guest()) headers.set('x-board-guest', b.guest())
      return fetch(input, { ...init, headers })
    },
    pluginUrl: (plugin, path = '', scope = 'board') => (scope === 'global' ? `/b/plugins/${plugin}${path}` : `/b/${b.board.slug}/plugins/${plugin}${path}`),
    registerCardRenderer(kind, render) {
      if (typeof render !== 'function') throw new Error(`registerCardRenderer(${kind}): render must be a function`)
      renderers.set(String(kind), render)
      changed()
    },
    registerBlockAction(action) {
      if (!action?.id || typeof action.run !== 'function') throw new Error('registerBlockAction: id and run(ctx) are required')
      actions.push({ ...action, label: localized(action.label) })
      changed()
    },
    registerToolbarButton(button) {
      if (!button?.id || typeof button.onClick !== 'function') throw new Error('registerToolbarButton: id and onClick(ctx) are required')
      buttons.push({ ...button, label: localized(button.label) })
      changed()
    },
    registerMetaField(field) {
      if (!field?.id) throw new Error('registerMetaField: id is required')
      fieldViews.set(field.id, field)
      changed()
    },
  }
  return api
}

let apiInstance: WebPluginApi | null = null
export const pluginApi = () => apiInstance

/** Import every web plugin; one that fails to load or register is reported and skipped, never breaks the editor. */
export async function loadWebPlugins(urls: string[], bindings: Bindings) {
  apiInstance = makeApi(bindings)
  for (const url of urls ?? []) {
    try {
      const mod = (await import(/* @vite-ignore */ url)) as { register?: (api: WebPluginApi) => unknown; default?: unknown; apiVersion?: string }
      const range = mod.apiVersion ?? (mod.default as { apiVersion?: string } | undefined)?.apiVersion
      if (range && !satisfies(PLUGIN_API_VERSION, range)) {
        console.warn(`[boards] web plugin ${url} needs plugin API ${range}; this editor provides ${PLUGIN_API_VERSION} — skipped`)
        continue
      }
      const register = typeof mod.register === 'function' ? mod.register : typeof mod.default === 'function' ? (mod.default as (api: WebPluginApi) => unknown) : (mod.default as { register?: (api: WebPluginApi) => unknown } | undefined)?.register
      if (typeof register !== 'function') {
        console.warn(`[boards] web plugin ${url} exports no register(api) — skipped`)
        continue
      }
      await register(apiInstance)
    } catch (error) {
      console.error(`[boards] web plugin ${url} failed`, error)
    }
  }
}
