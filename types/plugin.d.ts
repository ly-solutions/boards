/**
 * Types of the boards plugin API, version 1.x (see docs/plugins.md).
 *
 * Server plugins:   /** @type {import('boards/types/plugin').ServerPlugin} *\/ export default { … }
 * Web plugins:      /** @param {import('boards/types/plugin').WebPluginApi} api *\/ export function register(api) { … }
 *
 * The plugin API follows semver: minor versions only add, a major version may break. A plugin declares the range
 * it was written for in `apiVersion`; the server refuses an incompatible plugin at start-up.
 */

export type Localized = string | { [locale: string]: string }

// ---- Shared shapes ----------------------------------------------------------------------------------------------

export type CardTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'

/** Card data a resolver returns. Unknown fields are dropped; links must be http(s), images https. */
export interface Card {
  /** Which renderer draws it; defaults to the resolver id. */
  kind?: string
  title: string
  subtitle?: string | null
  /** Small text in the card's head line, e.g. `owner/repo`. */
  site?: string
  status?: string | { label: string; tone?: CardTone }
  /** https URL, data:image URI, or a short emoji. */
  icon?: string
  image?: string
  url?: string
  updatedAt?: string
  fields?: { label: string; value: string | number }[]
}

export interface SceneElement {
  id: string
  type: string
  x: number
  y: number
  width: number
  height: number
  /** The shape's label, or a text element's text. */
  text?: string | null
  link?: string | null
  customData?: Record<string, unknown> | null
  groupIds?: string[]
  isDeleted?: boolean
}

/** Which selections an action applies to. All given conditions must hold. */
export interface When {
  /** At least this many selected blocks (default 1). */
  min?: number
  max?: number | null
  /** Excalidraw element types, e.g. ['rectangle', 'text']. */
  types?: string[] | null
  /** `customData.kind` of every selected block, e.g. ['sticky'] or ['card']. */
  kinds?: string[] | null
}

export type Flags = Record<string, boolean | string>

export interface Person {
  kind: 'user' | 'agent' | 'guest' | 'anonymous'
  name: string | null
  email: string | null
}

// ---- Server -----------------------------------------------------------------------------------------------------

export interface ServerPlugin {
  /** Lowercase letters, digits, dashes. Appears in URLs: /b/plugins/<name>/… */
  name: string
  version?: string
  /** Semver range of the plugin API this plugin was written for, e.g. "^1.0.0". */
  apiVersion: string
  /** Web module(s) for the editor, relative to this file; must live in a folder without server code. */
  web?: string | string[]
  register(api: ServerPluginApi): void | Promise<void>
}

export interface BoardView {
  slug: string
  title: string
  /** The board link with its key — treat it as a secret. */
  url: string
  rev: number
  meta: { description: string; tags: string[]; task: string | null; access: 'team' | 'link'; author: string | null; createdAt: string | null; updatedAt: string | null; fields: Record<string, unknown> }
  /** The board as text, as agents read it. */
  text(): string
  /** A copy of the live elements. */
  elements(): SceneElement[]
}

export interface Edit {
  graph?: unknown
  add?: Record<string, unknown>[]
  update?: ({ id: string } & Record<string, unknown>)[]
  delete?: string[]
  note?: string
}

export interface RouteContext {
  req: import('node:http').IncomingMessage
  url: URL
  method: string
  params: Record<string, string>
  query: URLSearchParams
  headers: import('node:http').IncomingHttpHeaders
  /** Who is calling: a signed-in user, an agent (API token), a guest on a link-editable board, or null. */
  who: Person | null
  user: { name: string; email: string | null } | null
  agent: boolean
  /** The board, for board routes. */
  board: BoardView | null
  t: Translate
  locale: string
  rawBody(): Promise<Buffer>
  text(): Promise<string>
  json<T = any>(): Promise<T>
  flags(): Promise<Flags>
}

export interface Route {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** '' or '/path/:param'. */
  path?: string
  /** board → /b/<slug>/plugins/<name><path>; global → /b/plugins/<name><path>. */
  scope?: 'board' | 'global'
  /** board: viewer (default; the board key), editor, member. global: member (default), token, public. */
  access?: 'viewer' | 'editor' | 'member' | 'token' | 'public'
  bodyLimit?: number
  /** Return a JSON-able value (200), `api.reply(status, body, headers)`, or nothing (204); throw `api.HttpError`. */
  handler(ctx: RouteContext): unknown | Promise<unknown>
}

export interface CardResolver {
  /** Lowercase id; text references are stored as `ref:<id>:<text>`. */
  id: string
  /** Claim a pasted URL: return a truthy value to resolve it. */
  match?(url: string): unknown
  /** Claim a pasted text reference (the whole text must match), e.g. /[A-Z]+-\d+/. */
  pattern?: RegExp
  resolve(input: string, ctx: { signal: AbortSignal; kind: 'url' | 'ref'; match: unknown }): Card | null | Promise<Card | null>
  /** Cache lifetime of a card (default 5 min) and of "unknown" (default 30 s); timeout per lookup (default 3 s). */
  ttlMs?: number
  missTtlMs?: number
  timeoutMs?: number
}

export interface ActionContext {
  board: BoardView
  /** Selected blocks (a label counts as its shape), with their text. */
  selection: SceneElement[]
  who: Person
  t: Translate
  locale: string
  /** Extra input a web plugin sent along. */
  input: unknown
  flags(): Promise<Flags>
}

export interface ActionResult {
  /** Applied to the board as one revision, signed by the person who ran the action. */
  edit?: Edit
  toast?: string
  /** Opened in a new tab. */
  open?: string
  /** Element ids to select afterwards. */
  select?: string[]
}

export interface BlockAction {
  id: string
  /** A message key, a plain string or { en, ru }. */
  label: Localized
  /** Inline <svg> markup (no scripts). */
  icon?: string
  when?: When
  /** Asked before running (window.confirm). */
  confirm?: Localized
  run(ctx: ActionContext): ActionResult | void | Promise<ActionResult | void>
}

export interface MetaField {
  /** Stored under meta.fields.<id>; a letter, then letters, digits, _ or -. */
  id: string
  label: Localized
  type?: 'text' | 'date' | 'url' | 'number' | 'select'
  options?: { value: string; label?: Localized }[]
  placeholder?: Localized
  /** Show on the boards list. */
  home?: boolean
  maxLength?: number
  /** Return a normalised value or throw an Error with a message for the person. */
  validate?(value: string | number): unknown
}

export interface WebhookContext {
  req: import('node:http').IncomingMessage
  url: URL
  params: Record<string, string>
  headers: import('node:http').IncomingHttpHeaders
  rawBody(): Promise<Buffer>
  text(): Promise<string>
  json<T = any>(): Promise<T>
  t: Translate
  locale: string
}

export interface Webhook {
  path?: string
  /** Compared with the header (default x-boards-webhook-secret). */
  secret?: string
  header?: string
  /** Custom check, e.g. api.hmacVerifier({ secret }). Receives the raw body as a Buffer. */
  verify?(ctx: Omit<WebhookContext, 'rawBody'> & { rawBody: Buffer }): boolean | Promise<boolean>
  /** Explicitly unauthenticated. */
  public?: boolean
  bodyLimit?: number
  handler(ctx: WebhookContext): unknown | Promise<unknown>
}

export interface FlagsProvider {
  id?: string
  flags(user: Person, ctx?: unknown): Flags | Promise<Flags>
}

export type PluginEvent =
  | 'board.created'
  | 'board.changed'
  | 'board.meta'
  | 'board.checkpoints'
  | 'thread.created'
  | 'thread.replied'
  | 'thread.resolved'
  | 'thread.reopened'
  | 'thread.removed'

export type Translate = ((key: string, vars?: Record<string, unknown>) => string) & { locale: string; has(key: string): boolean }

export interface ServerPluginApi {
  apiVersion: string
  plugin: { name: string; version: string }
  locale: string
  t: Translate
  env: Readonly<Record<string, string | undefined>>
  config: Readonly<{ publicUrl: string; locale: string; features: Record<string, boolean> }>
  log(event: string | Record<string, unknown>): void
  HttpError: new (status: number, message: string, extra?: Record<string, unknown>) => Error
  reply(status: number, body?: unknown, headers?: Record<string, string>): unknown
  hmacVerifier(options: { secret: string; header?: string; algorithm?: string; prefix?: string; encoding?: 'hex' | 'base64' }): Webhook['verify']
  addMessages(locale: string, messages: Record<string, string | Record<string, string>>): void
  addRoute(route: Route): void
  addCardResolver(resolver: CardResolver): void
  addBlockAction(action: BlockAction): void
  addMetaField(field: MetaField): void
  addWebhook(hook: Webhook): void
  on(event: PluginEvent, listener: (payload: any) => void | Promise<void>): void
  addFlags(provider: FlagsProvider): void
  cards: { invalidate(which: string | ((ref: string) => boolean)): void }
  boards: {
    list(): Promise<{ slug: string; title: string; author: string | null; updatedAt: string | null; tags: string[]; fields: Record<string, unknown>; url: string }[]>
    get(slug: string): Promise<BoardView | null>
    edit(slug: string, edit: Edit, options?: { author?: string }): Promise<{ rev: number; created: string[] }>
  }
}

// ---- Web --------------------------------------------------------------------------------------------------------

export interface WebCard extends Card {
  kind: string
  status?: { label: string; tone: CardTone }
}

export interface EditorBridge {
  getSceneElements(): SceneElement[]
  getSelectedElements(): SceneElement[]
  addElements(skeletons: Record<string, unknown>[]): string[]
  updateElements(patches: ({ id: string } & Record<string, unknown>)[]): void
  select(ids: string[]): void
  scrollTo(ids: string[]): void
  toast(message: string): void
}

export interface WebPluginApi {
  apiVersion: string
  locale: string
  t(key: string, vars?: Record<string, unknown>): string
  addMessages(locale: string, messages: Record<string, string | Record<string, string>>): void
  flags: Readonly<Flags>
  isEnabled(name: string): boolean
  board: { slug: string; title: string; url: string; canEdit: boolean; user: { name: string; email: string | null } | null; fields: Record<string, unknown> }
  editor: EditorBridge
  fetch(input: string, init?: RequestInit): Promise<Response>
  pluginUrl(plugin: string, path?: string, scope?: 'board' | 'global'): string
  registerCardRenderer(kind: string, render: (el: HTMLElement, card: WebCard, ctx: { locale: string; t: WebPluginApi['t']; staticBase: string; element: SceneElement }) => void | (() => void)): void
  registerBlockAction(action: { id: string; label: Localized; icon?: string; when?: When; run(ctx: { selection: SceneElement[]; api: WebPluginApi }): void | Promise<void> }): void
  registerToolbarButton(button: { id: string; label: Localized; icon?: string; onClick(ctx: { api: WebPluginApi }): void | Promise<void> }): void
  registerMetaField(field: { id: string; label?: Localized; placeholder?: Localized; format?(value: unknown): string }): void
}

export interface WebPluginModule {
  apiVersion?: string
  register(api: WebPluginApi): void | Promise<void>
}
