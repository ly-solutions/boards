/**
 * boards server: an Excalidraw editor for people and a text API for agents.
 *
 * Everything lives under one prefix, `/b`, so the service can share a host with other apps.
 *
 *   GET  /b/                           boards list (signed-in users)
 *   GET  /b/<slug>?k=…                 editor; plain fetch without JS gets the board as text first
 *   GET  /b/<slug>.md?k=…              the board as markdown — the main entry for agents
 *   GET  /b/<slug>.json?k=…            the board as JSON (metadata, links, text)
 *   GET  /b/<slug>/scene.excalidraw    the whole scene; opens in excalidraw.com too
 *   GET  /b/<slug>/preview.svg         thumbnail
 *   POST /b/<slug>/edit                agent edit: graph, skeleton, update, delete
 *   POST /b/<slug>/sync                polling exchange with browsers
 *   GET  /b/<slug>/live?k=…            WebSocket: edits, cursors, selection (live.mjs)
 *   GET  /b/<slug>/history[/<id>]      automatic snapshots; POST …/<id>/restore
 *   GET  /b/api                        API cheat sheet
 *   GET  /b/api/boards[/<slug>]        list / one board (token or signed-in user)
 *   POST /b/api/boards                 new board
 *   GET  /b/api/oembed?url=…           oEmbed for board links
 *   POST /b/api/handoff                one-time sign-in link for an integration's user (token)
 *   GET  /healthz, /readyz             probes
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createStore, LimitError } from './store.mjs'
import { summarize as summarizeChanges, weekOutcome } from '../shared/checkpoints.mjs'
import { createLinks } from './links.mjs'
import { refsOf } from '../shared/links.mjs'
import { isValidSlug, makeKey, makeSlug, secretMatches } from './access.mjs'
import { EditError, applyDeletes, applyUpdates, layoutGraph, loadEngine, materialize } from './engine.mjs'
import { editorHeaders, embedHeaders, pageHeaders, renderBoardPage, renderEmbedPage, renderHome, renderNotFound, renderTokenLogin, webAssets } from './html.mjs'
import { API_HELP } from './help.mjs'
import { createAuth } from './auth.mjs'
import { createLive } from './live.mjs'
import { sendBody } from './compress.mjs'
import { COMPONENTS, TEMPLATES, templateById } from '../shared/templates.mjs'
import { paletteColors } from '../shared/palette.mjs'
import { describeScene } from './summary.mjs'
import { createWebhook } from './hooks.mjs'
import { CommentError } from './comments.mjs'
import { createStatic } from './static.mjs'
import { loadConfig, testConfig } from './config.mjs'
import { createMetrics } from './metrics.mjs'
import { SNAPSHOT_ID } from './storage/boards.mjs'

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const PREFIX = '/b'
export const VERSION = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8')).version

class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

const json = (res, status, body) => sendBody(res, status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' }, JSON.stringify(body))

const text = (res, status, body, type = 'text/markdown; charset=utf-8') =>
  sendBody(res, status, { 'content-type': type, 'cache-control': 'no-store', 'x-robots-tag': 'noindex, nofollow, noarchive', 'referrer-policy': 'no-referrer' }, body)

async function readBody(req, limit) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new HttpError(413, `request body is larger than ${Math.round(limit / 1024 / 1024)} MB`)
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function readJson(req, limit) {
  const raw = await readBody(req, limit)
  try {
    return JSON.parse(raw || '{}')
  } catch {
    throw new HttpError(400, 'request body must be JSON')
  }
}

/**
 * The preview SVG is rendered by a browser and sent to us — user input that we later serve from our origin.
 * Previews never need scripts, so documents with any are rejected.
 */
export function isSafePreview(svg) {
  if (typeof svg !== 'string' || svg.length > 3 * 1024 * 1024) return false
  const head = svg.trimStart().slice(0, 200)
  if (!/^(<\?xml[^>]*>\s*)?<svg[\s>]/i.test(head)) return false
  return !/<script|<foreignObject|\son[a-z]+\s*=|javascript:|<iframe|<embed|<object/i.test(svg)
}

/** `task`: a free-form external reference (issue key or URL), up to 64 characters. */
function normalizeTask(value) {
  if (value === undefined) return undefined
  if (value === null || value === '') return null
  if (typeof value !== 'string' || value.trim().length > 64 || /[\u0000-\u001f]/.test(value)) throw new HttpError(400, 'task: a reference (issue key or URL) up to 64 characters')
  return value.trim()
}

/** Tags: up to ten, up to 32 characters each, case-insensitively unique; the first spelling wins. */
export function normalizeTags(value) {
  if (value === undefined || value === null) return undefined
  const raw = Array.isArray(value) ? value : String(value).split(',')
  const seen = new Set()
  const out = []
  for (const item of raw) {
    const tag = String(item ?? '').trim().replace(/\s+/g, ' ').slice(0, 32)
    if (!tag || seen.has(tag.toLowerCase())) continue
    seen.add(tag.toLowerCase())
    out.push(tag)
    if (out.length === 10) break
  }
  return out
}

/** Reactions on stickies: exactly three. */
export const REACTIONS = ['👍', '👎', '❤️']

const stamp = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const authorOf = (body, fallback = 'agent') => (typeof body.author === 'string' && body.author.trim() ? body.author.trim().slice(0, 60) : fallback)

export function createApp({
  store,
  config = testConfig(),
  auth = createAuth(config.auth, { publicUrl: config.publicUrl, log: (event) => console.log(JSON.stringify(event)) }),
  webDir = join(ROOT, 'dist/web'),
  webhook = createWebhook(config.webhook),
  links = createLinks({ boardMeta: (slug) => store.boardMeta(slug), log: (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event })) }),
  metrics = createMetrics(),
  ready = async () => true,
} = {}) {
  const publicUrl = config.publicUrl
  const staticBase = `${PREFIX}/_static`
  const homeUrl = `${PREFIX}/`
  const serveStatic = createStatic({ root: webDir })
  const corsOrigins = new Set(config.corsOrigins ?? [])

  /**
   * Request context: who is calling. Cookie/proxy identity only counts on same-origin requests (or ones without an
   * Origin header, i.e. not from a browser page): a page on an allowed CORS origin may use bearer tokens and board
   * keys, never the visitor's session.
   */
  function context(req) {
    if (req.ctx) return req.ctx
    const origin = req.headers.origin
    const sameOrigin = !origin || origin === publicUrl
    const agent = auth.agent(req)
    req.ctx = { origin, sameOrigin, agent, user: !agent && sameOrigin ? auth.user(req) : null }
    return req.ctx
  }

  /** Cross-site POSTs carrying a session are refused outright (CSRF). */
  function guardOrigin(req) {
    if (req.method !== 'POST' && req.method !== 'DELETE') return
    const { origin, sameOrigin, agent } = context(req)
    if (!agent && !sameOrigin && !corsOrigins.has(origin)) throw new HttpError(403, `cross-origin request from ${origin} refused`)
  }

  /**
   * Who is editing, and may they.
   *
   * - API token (agents, integrations): always; the name comes from the request body;
   * - signed-in user: always; the name is theirs;
   * - board opened for editing by link (`access: link`): guests, who sign with a name of their choosing;
   * - otherwise read-only.
   */
  function editor(req, state, body = {}) {
    const { agent, user } = context(req)
    if (agent) return { kind: 'agent', name: authorOf(body) }
    if (user) return { kind: 'user', name: user.name, email: user.email }
    if ((state.meta.access ?? 'team') === 'link') {
      const guest = typeof body.guest === 'string' ? body.guest.trim().slice(0, 40) : ''
      return { kind: 'guest', name: guest ? `guest: ${guest}` : 'guest' }
    }
    return null
  }

  function requireEditor(req, state, body) {
    const who = editor(req, state, body)
    if (!who) throw new HttpError(403, 'sign in to edit this board, or ask its owner to open it for editing by link', { login: `${PREFIX}/auth/login` })
    return who
  }

  function requireMember(req) {
    const { agent, user } = context(req)
    if (agent) return { kind: 'agent', name: 'agent' }
    if (user) return { kind: 'user', name: user.name, email: user.email }
    throw new HttpError(401, 'an API token (Authorization: Bearer …) or a signed-in session is required')
  }

  /**
   * Webhook payload for a comment event. The anchor label is what an agent sees for that shape in the board text,
   * so a receiver can say "on API gateway" without fetching the board.
   */
  function commentPayload(event, state, thread, who, msg = null) {
    let label = null
    if (thread.elementId) {
      const scene = describeScene(store.elements(state))
      const el = scene.byId.get(thread.elementId)
      label = scene.labelOf.get(thread.elementId) ?? (el?.type === 'text' ? (el.originalText ?? el.text ?? null) : null)
    }
    return {
      event,
      slug: state.slug,
      key: state.meta.key,
      title: state.meta.title,
      url: store.boardUrl(state),
      thread: { id: thread.id, resolved: Boolean(thread.resolved), anchor: { elementId: thread.elementId ?? null, label, x: thread.x, y: thread.y } },
      ...(msg ? { message: { id: msg.id, text: msg.text, author: msg.author, authorEmail: who.email ?? null, authorKind: msg.authorKind, at: msg.at } } : {}),
    }
  }

  /** Comment requests: new thread or a change to one. Permissions here, data rules in comments.mjs. */
  async function handleComment(req, res, state, threadId) {
    const body = await readJson(req, 64 * 1024)
    const who = requireEditor(req, state, body)
    const actor = { name: who.name, kind: who.kind === 'agent' ? 'agent' : 'person', email: who.email }
    try {
      if (!threadId) {
        const created = store.comment(state, { text: body.text, x: body.x, y: body.y, elementId: body.elementId }, actor)
        webhook.emit(commentPayload('thread.created', state, created, who, created.messages[0]))
        return json(res, 201, { ok: true, thread: created, notes: store.notes(state) })
      }
      // Members and agents may delete anything (agents and departed guests leave threads nobody else could
      // clean up); a guest only what they wrote.
      const mayDelete = (author) => who.kind !== 'guest' || author === who.name
      const change = { reply: body.reply, replyTo: body.replyTo, resolved: body.resolved, remove: body.remove === true, removeMessage: body.removeMessage, x: body.x, y: body.y, elementId: body.elementId }
      const result = store.changeComment(state, threadId, change, actor, mayDelete)
      if (result.removed) webhook.emit(commentPayload('thread.removed', state, result.thread, who))
      if (result.replied) webhook.emit(commentPayload('thread.replied', state, result.thread, who, result.replied))
      if (result.resolvedChanged) webhook.emit(commentPayload(result.thread.resolved ? 'thread.resolved' : 'thread.reopened', state, result.thread, who))
      return json(res, 200, { ok: true, thread: result.removed ? { removed: true } : result.thread, notes: store.notes(state) })
    } catch (error) {
      if (error instanceof CommentError) throw new HttpError(error.status, error.message)
      throw error
    }
  }

  /**
   * A board by slug and key. A wrong key answers with the same 404 as a missing board: different answers would
   * tell someone guessing that the address is right and only the key is left.
   */
  async function board(req, url, slug, { keyless = false } = {}) {
    if (!isValidSlug(slug)) throw new HttpError(404, 'no such board')
    const state = await store.get(slug)
    if (!state) throw new HttpError(404, 'no such board')
    const key = url.searchParams.get('k') ?? req.headers['x-board-key']
    const { agent, user } = context(req)
    if (!agent && !(keyless && user) && !secretMatches(key, state.meta.key)) throw new HttpError(404, 'no such board')
    return state
  }

  /** Graph, skeleton, updates and deletes — one request, one revision. */
  async function applyEdit(state, body) {
    const now = Date.now()
    const engine = await loadEngine()
    let current = store.elements(state, { includeDeleted: true })
    const merged = () => {
      const map = new Map(current.map((el) => [el.id, el]))
      return (list) => {
        for (const el of list) map.set(el.id, el)
        current = [...map.values()]
        return list
      }
    }
    const touched = []
    const skeleton = []
    if (body.graph) skeleton.push(...layoutGraph(body.graph, { measureLine: engine.measureLine, existing: current, at: body.at }))
    if (Array.isArray(body.add)) skeleton.push(...body.add)
    if (skeleton.length) {
      const { created, changed } = await materialize(skeleton, current, { now })
      touched.push(...merged()([...changed, ...created]))
    }
    if (Array.isArray(body.update) && body.update.length) touched.push(...merged()(applyUpdates(body.update, current, { now })))
    if (Array.isArray(body.delete) && body.delete.length) touched.push(...merged()(applyDeletes(body.delete, current, { now })))
    if (!touched.length) throw new EditError('empty edit: send graph, add, update or delete')
    const accepted = store.applyAgentEdit(state, touched, { by: authorOf(body), note: typeof body.note === 'string' ? body.note.slice(0, 200) : null })
    return { accepted, created: touched.filter((el) => el.version === 1).map((el) => el.id) }
  }

  async function createBoard(body, who) {
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 120) : ''
    if (title.length < 2) throw new HttpError(400, 'title: the board title, at least two characters')
    const task = normalizeTask(body.task) ?? null
    const slug = makeSlug(title)
    const at = stamp()
    const template = body.template === undefined || body.template === null || body.template === '' ? null : templateById(String(body.template))
    if (body.template && !template) throw new HttpError(400, `template: unknown template; available: ${TEMPLATES.map((t) => t.id).join(', ')}`)
    const meta = {
      title,
      tags: normalizeTags(body.tags) ?? [],
      description: typeof body.description === 'string' ? body.description.trim().slice(0, 500) : '',
      author: who.kind === 'user' ? who.name : authorOf(body),
      access: body.access === 'link' ? 'link' : 'team',
      key: makeKey(),
      task,
      createdAt: at,
      updatedAt: at,
    }
    // Build the content before writing: a broken skeleton must not leave an empty board behind.
    let elements = []
    if (template && !body.graph && !Array.isArray(body.add)) elements = structuredClone(await templateElements(template.id))
    else if (body.graph || Array.isArray(body.add)) {
      const engine = await loadEngine()
      const skeleton = []
      if (body.graph) skeleton.push(...layoutGraph(body.graph, { measureLine: engine.measureLine, existing: [], at: body.at }))
      if (Array.isArray(body.add)) skeleton.push(...body.add)
      elements = (await materialize(skeleton, [])).created
    }
    return store.create({ slug, meta, elements })
  }

  /** Templates and the library are constants; materialising them costs hundreds of ms once, so cache them. */
  const templateCache = new Map()
  function templateElements(id) {
    if (!templateCache.has(id)) {
      const template = templateById(id)
      templateCache.set(
        id,
        (template.build().length ? materialize(template.build(), []) : Promise.resolve({ created: [] }))
          .then((r) => r.created)
          .catch((error) => {
            templateCache.delete(id)
            throw error
          }),
      )
    }
    return templateCache.get(id)
  }
  let libraryCache = null
  function library() {
    libraryCache ??= Promise.all(
      COMPONENTS.map(async (component) => ({ id: component.id, status: 'published', name: component.name, created: 1790467200000, elements: (await materialize(component.build(), [])).created })),
    ).catch((error) => {
      libraryCache = null
      throw error
    })
    return libraryCache
  }

  const links_ = (slug, key) => {
    const k = encodeURIComponent(key)
    return {
      url: `${publicUrl}${PREFIX}/${slug}?k=${k}`,
      markdown: `${publicUrl}${PREFIX}/${slug}.md?k=${k}`,
      json: `${publicUrl}${PREFIX}/${slug}.json?k=${k}`,
      embed: `${publicUrl}${PREFIX}/${slug}?k=${k}&embed=1`,
      scene: `${publicUrl}${PREFIX}/${slug}/scene.excalidraw?k=${k}`,
      live: `${publicUrl.replace(/^http/, 'ws')}${PREFIX}/${slug}/live?k=${k}`,
    }
  }

  const describe = (state) => ({ slug: state.slug, title: state.meta.title, key: state.meta.key, ...links_(state.slug, state.meta.key) })

  const boardJson = (state) => ({
    ...describe(state),
    description: state.meta.description ?? '',
    tags: state.meta.tags ?? [],
    task: state.meta.task ?? null,
    access: state.meta.access ?? 'team',
    author: state.meta.author ?? null,
    createdAt: state.meta.createdAt ?? null,
    updatedAt: state.meta.updatedAt ?? null,
    rev: state.rev,
    stats: store.stats(state),
    preview: state.preview ? `${publicUrl}${PREFIX}/${state.slug}/preview.svg?k=${encodeURIComponent(state.meta.key)}` : null,
    text: store.text(state),
  })

  async function listBoards(url) {
    const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase()
    const tag = String(url.searchParams.get('tag') ?? '').trim().toLowerCase()
    let boards = await store.list()
    if (q) boards = boards.filter((b) => [b.title, b.description, ...(b.tags ?? [])].some((v) => String(v ?? '').toLowerCase().includes(q)))
    if (tag) boards = boards.filter((b) => (b.tags ?? []).some((t) => t.toLowerCase() === tag))
    return boards
  }

  /** oEmbed (https://oembed.com) for board links: lets chat apps, wikis and workspaces unfurl a board. */
  async function oembed(req, url) {
    let target
    try {
      target = new URL(String(url.searchParams.get('url') ?? ''))
    } catch {
      throw new HttpError(400, 'url: a board link')
    }
    const m = /^\/b\/([a-z0-9-]+)\/?$/.exec(target.pathname)
    if (target.origin !== publicUrl || !m) throw new HttpError(404, 'not a board on this server')
    const state = await board(req, target, m[1])
    const width = Math.min(Number(url.searchParams.get('maxwidth')) || 800, 1600)
    const height = Math.min(Number(url.searchParams.get('maxheight')) || 500, 1200)
    const { embed } = links_(state.slug, state.meta.key)
    return {
      version: '1.0',
      type: 'rich',
      provider_name: 'boards',
      provider_url: `${publicUrl}${PREFIX}/`,
      title: state.meta.title,
      ...(state.meta.author ? { author_name: state.meta.author } : {}),
      width,
      height,
      html: `<iframe src="${embed.replace(/&/g, '&amp;')}" width="${width}" height="${height}" style="border:0" loading="lazy" referrerpolicy="no-referrer" allow="fullscreen" title="${String(state.meta.title).replace(/[<>&"]/g, '')}"></iframe>`,
      ...(state.preview ? { thumbnail_url: `${publicUrl}${PREFIX}/${state.slug}/preview.svg?k=${encodeURIComponent(state.meta.key)}` } : {}),
    }
  }

  function loginRedirect(res, next) {
    res.writeHead(302, { location: `${PREFIX}/auth/login?next=${encodeURIComponent(next)}`, 'cache-control': 'no-store' })
    res.end()
  }

  const readForm = async (req) => new URLSearchParams(await readBody(req, 16 * 1024))
  const renderTokenForm = (res, next, error, status) => {
    res.writeHead(status, pageHeaders({ frameAncestors: config.frameAncestors }))
    res.end(renderTokenLogin({ staticBase, next, error }))
  }

  async function route(req, res) {
    const url = new URL(req.url, 'http://boards.local')
    const path = url.pathname

    if (path === '/healthz') return json(res, 200, { ok: true, version: VERSION, epoch: store.epoch })
    if (path === '/readyz') {
      const ok = await ready().catch(() => false)
      return json(res, ok ? 200 : 503, { ok })
    }
    if (path === '/' || path === PREFIX) {
      res.writeHead(302, { location: homeUrl })
      return res.end()
    }
    if (!path.startsWith(`${PREFIX}/`)) throw new HttpError(404, 'no such path')

    const rest = path.slice(PREFIX.length + 1)
    if (rest.startsWith('_static/')) {
      if (await serveStatic(req, res, rest.slice('_static/'.length))) return
      throw new HttpError(404, 'no such file')
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, x-board-key', 'access-control-max-age': '600' })
      return res.end()
    }
    guardOrigin(req)

    if (rest === '' && req.method === 'GET') {
      const { user } = context(req)
      if (!user) {
        if (auth.enabled) return loginRedirect(res, homeUrl)
        throw new HttpError(401, 'not signed in')
      }
      const boards = await listBoards(url)
      res.writeHead(200, pageHeaders({ frameAncestors: config.frameAncestors }))
      return res.end(renderHome({ staticBase, boards, templates: TEMPLATES, user, canSignOut: auth.mode !== 'none', q: url.searchParams.get('q') ?? '' }))
    }

    if (rest === 'api' || rest === 'api/') return text(res, 200, API_HELP)
    if (rest === 'auth/login') return auth.login(req, res, url, { renderTokenForm, readForm })
    if (rest === 'auth/callback') return auth.callback(req, res, url)
    if (rest === 'auth/logout') return auth.logout(req, res, url)
    if (rest === 'auth/handoff') return auth.handoff(req, res, url)

    // Templates, library and palette are not secret; the editor needs them without a token.
    if (rest === 'api/templates' && req.method === 'GET') return json(res, 200, { templates: TEMPLATES.map(({ id, title, description }) => ({ id, title, description })) })
    const tpl = /^api\/templates\/([a-z-]+)$/.exec(rest)
    if (tpl && req.method === 'GET') {
      if (!templateById(tpl[1])) throw new HttpError(404, 'no such template')
      return json(res, 200, { id: tpl[1], elements: await templateElements(tpl[1]) })
    }
    if (rest === 'api/library' && req.method === 'GET') return json(res, 200, { type: 'excalidrawlib', version: 2, source: publicUrl, libraryItems: await library() })
    if (rest === 'api/palette' && req.method === 'GET') return json(res, 200, { colors: paletteColors() })
    if (rest === 'api/oembed' && req.method === 'GET') return json(res, 200, await oembed(req, url))

    if (rest === 'api/handoff' && req.method === 'POST') {
      if (!context(req).agent) throw new HttpError(401, 'an API token is required')
      const body = await readJson(req, 16 * 1024)
      let token
      try {
        token = auth.issueHandoff({ user: body.user, next: body.next, ttlS: Number(body.ttl) || undefined })
      } catch (error) {
        throw new HttpError(400, error.message)
      }
      return json(res, 201, { url: `${publicUrl}${PREFIX}/auth/handoff?t=${encodeURIComponent(token)}` })
    }

    if (rest === 'api/boards') {
      const who = requireMember(req)
      if (req.method === 'GET') {
        const boards = await listBoards(url)
        return json(res, 200, {
          boards: boards.map((b) => ({ ...b, ...links_(b.slug, b.key), preview: b.hasPreview ? `${publicUrl}${PREFIX}/${b.slug}/preview.svg?k=${encodeURIComponent(b.key)}` : null })),
        })
      }
      if (req.method === 'POST') {
        const state = await createBoard(await readJson(req, 4 * 1024 * 1024), who)
        return json(res, 201, { ...describe(state), summary: store.text(state) })
      }
      throw new HttpError(405, 'only GET and POST')
    }
    const one = /^api\/boards\/([a-z0-9-]+)$/.exec(rest)
    if (one && req.method === 'GET') {
      requireMember(req)
      return json(res, 200, boardJson(await board(req, url, one[1], { keyless: true })))
    }

    const md = /^([a-z0-9-]+)\.(md|json)$/.exec(rest)
    if (md && req.method === 'GET') {
      const state = await board(req, url, md[1])
      return md[2] === 'md' ? text(res, 200, store.text(state)) : json(res, 200, boardJson(state))
    }

    // Checkpoints: list, create, diff, scene, and a copy of the board from a checkpoint.
    const cp = /^([a-z0-9-]+)\/checkpoints(?:\/([a-f0-9]{6,20}|now)(?:\/(scene|diff|copy))?)?$/.exec(rest)
    if (cp) {
      const state = await board(req, url, cp[1])
      const [, , id, what] = cp
      if (!id && req.method === 'GET') {
        const changes = await store.checkpointChanges(state, 'now')
        return json(res, 200, { checkpoints: await store.checkpoints(state), pending: summarizeChanges(changes), week: weekOutcome(store.elements(state)) })
      }
      if (!id && req.method === 'POST') {
        const body = await readJson(req, 16 * 1024)
        const who = requireEditor(req, state, body)
        const checkpoint = await store.addCheckpoint(state, { title: body.title, by: who.name, closeWeek: body.closeWeek === true })
        return json(res, 201, { ok: true, checkpoint, checkpoints: await store.checkpoints(state) })
      }
      if (id && what === 'diff' && req.method === 'GET') {
        const changes = await store.checkpointChanges(state, id)
        if (!changes) throw new HttpError(404, 'no such checkpoint')
        return json(res, 200, changes)
      }
      if (id && id !== 'now' && what === 'scene' && req.method === 'GET') {
        const scene = await store.checkpointScene(state, id)
        if (!scene) throw new HttpError(404, 'no such checkpoint')
        return json(res, 200, { ...scene, rev: 0, epoch: store.epoch })
      }
      if (id && id !== 'now' && what === 'copy' && req.method === 'POST') {
        const body = await readJson(req, 16 * 1024)
        const who = requireEditor(req, state, body)
        const scene = await store.checkpointScene(state, id)
        const checkpoint = (await store.checkpoints(state)).find((c) => c.id === id)
        if (!scene || !checkpoint) throw new HttpError(404, 'no such checkpoint')
        // A copy is a new board: nothing ever overwrites the current board with an old version.
        const title = `${state.meta.title} — ${checkpoint.title}`.slice(0, 120)
        const at = stamp()
        const copy = await store.create({
          slug: makeSlug(title),
          meta: { title, tags: state.meta.tags ?? [], description: `Copy of checkpoint "${checkpoint.title}" of board "${state.meta.title}"`, author: who.name, access: state.meta.access ?? 'team', key: makeKey(), task: state.meta.task ?? null, createdAt: at, updatedAt: at },
          elements: structuredClone(scene.elements ?? []),
        })
        const files = Object.values(scene.files ?? {})
        if (files.length) store.apply(copy, [], files)
        return json(res, 201, { ok: true, url: store.boardUrl(copy), slug: copy.slug, key: copy.meta.key })
      }
      throw new HttpError(405, 'checkpoints have no such action')
    }

    // History: automatic snapshots (or bucket versions) and restoring one.
    const hist = /^([a-z0-9-]+)\/history(?:\/([^/]+)(?:\/(restore))?)?$/.exec(rest)
    if (hist) {
      const state = await board(req, url, hist[1])
      const [, , id, action] = hist
      if (!id && req.method === 'GET') return json(res, 200, { snapshots: await store.history(state) })
      if (!id || !SNAPSHOT_ID.test(id)) throw new HttpError(404, 'no such snapshot')
      if (!action && req.method === 'GET') {
        const scene = await store.historyScene(state, id)
        if (!scene) throw new HttpError(404, 'no such snapshot')
        return json(res, 200, { ...scene, id, rev: 0, epoch: store.epoch })
      }
      if (action === 'restore' && req.method === 'POST') {
        const body = await readJson(req, 16 * 1024)
        const who = requireEditor(req, state, body)
        if (who.kind === 'guest') throw new HttpError(403, 'only signed-in users and agents can restore a board')
        const changed = await store.restore(state, id, { by: who.name })
        if (changed === null) throw new HttpError(404, 'no such snapshot')
        return json(res, 200, { ok: true, changed, rev: state.rev })
      }
      throw new HttpError(405, 'history has no such action')
    }

    const threadRoute = /^([a-z0-9-]+)\/comments(?:\/([a-f0-9]{10}))?$/.exec(rest)
    if (threadRoute && req.method === 'POST') return handleComment(req, res, await board(req, url, threadRoute[1]), threadRoute[2] ?? null)

    const m = /^([a-z0-9-]+)(?:\/([a-z.]+))?$/.exec(rest)
    if (!m) throw new HttpError(404, 'no such path')
    const [, slug, action] = m
    const state = await board(req, url, slug)

    if (!action && req.method === 'GET') {
      const accept = String(req.headers.accept ?? '')
      if (url.searchParams.get('format') === 'md' || (/text\/markdown/.test(accept) && !/text\/html/.test(accept))) return text(res, 200, store.text(state))
      const { user } = context(req)
      const access = state.meta.access ?? 'team'
      const features = config.features ?? {}
      // The read-only embed view is its own page: see renderEmbedPage.
      if (url.searchParams.get('embed') === '1') {
        const page = renderEmbedPage({ state, text: store.text(state), scene: store.scene(state), boardUrl: `${publicUrl}${PREFIX}/${slug}?k=${encodeURIComponent(state.meta.key)}`, assets: webAssets(join(webDir, '.vite/manifest.json')).embed, staticUrl: `${publicUrl}${staticBase}` })
        return sendBody(res, 200, embedHeaders({ publicUrl }), page)
      }
      // `?at=<checkpoint>`: the board as it was — read-only, no live channel.
      const atId = url.searchParams.get('at')
      const at = atId && features.workboard ? ((await store.checkpoints(state)).find((c) => c.id === atId) ?? null) : null
      const pageConfig = {
        slug,
        key: state.meta.key,
        title: state.meta.title,
        author: state.meta.author ?? null,
        access,
        user: user ? { name: user.name, email: user.email } : null,
        canEdit: !at && (Boolean(user) || access === 'link'),
        canManage: !at && Boolean(user),
        canCopy: (Boolean(user) || access === 'link'),
        authEnabled: auth.enabled && auth.mode !== 'none',
        loginUrl: `${PREFIX}/auth/login`,
        logoutUrl: `${PREFIX}/auth/logout`,
        homeUrl,
        hasPreview: Boolean(state.preview),
        previewStale: Boolean(state.previewStale),
        agentUrl: store.boardUrl(state),
        staticBase,
        live: !at && features.live !== false,
        studio: features.studio !== false,
        workboard: features.workboard !== false,
        motion: features.motion !== false,
        at: at ? { id: at.id, title: at.title, by: at.by ?? null, at: at.at } : null,
        snap: features.snap !== false,
        boardUrl: `${publicUrl}${PREFIX}/${slug}?k=${encodeURIComponent(state.meta.key)}`,
        description: state.meta.description ?? '',
        tags: state.meta.tags ?? [],
        task: state.meta.task ?? null,
        reactions: REACTIONS,
      }
      const html = renderBoardPage({ state, text: store.text(state), config: pageConfig, assets: webAssets(join(webDir, '.vite/manifest.json')).editor, staticBase })
      return sendBody(res, 200, editorHeaders({ publicUrl, frameAncestors: config.frameAncestors }), html)
    }

    if (action === 'scene.excalidraw' && req.method === 'GET') {
      return sendBody(
        res,
        200,
        {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'x-robots-tag': 'noindex',
          'x-board-rev': String(state.rev),
          'x-board-epoch': store.epoch,
          ...(url.searchParams.has('download') ? { 'content-disposition': `attachment; filename="${slug}.excalidraw"` } : {}),
        },
        JSON.stringify({ ...store.scene(state), rev: state.rev, epoch: store.epoch, notes: store.notes(state) }),
      )
    }

    if (action === 'preview.svg' && req.method === 'GET') {
      if (!state.preview) throw new HttpError(404, 'no preview yet — open the board in a browser')
      return sendBody(
        res,
        200,
        {
          'content-type': 'image/svg+xml',
          'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; sandbox",
          'cache-control': 'private, max-age=30',
          'x-content-type-options': 'nosniff',
          'x-robots-tag': 'noindex',
        },
        state.preview,
      )
    }

    if (action === 'preview' && req.method === 'POST') {
      requireEditor(req, state, { guest: url.searchParams.get('guest') })
      const svg = await readBody(req, 3 * 1024 * 1024)
      if (!isSafePreview(svg)) throw new HttpError(400, 'the preview must be an SVG without scripts')
      store.setPreview(state, svg)
      return json(res, 200, { ok: true })
    }

    if (action === 'sync' && req.method === 'POST') {
      const body = await readJson(req, 30 * 1024 * 1024)
      const writes = (Array.isArray(body.elements) && body.elements.length > 0) || (Array.isArray(body.files) && body.files.length > 0)
      const who = editor(req, state, body)
      if (writes && !who) throw new HttpError(403, 'this board is view-only: sign in to edit')
      return json(res, 200, store.sync(state, body, who ?? { kind: 'viewer', name: null }))
    }

    if (action === 'edit' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024 * 1024)
      const who = requireEditor(req, state, body)
      const result = await applyEdit(state, { ...body, author: who.name })
      return json(res, 200, { ...describe(state), rev: state.rev, ...result, summary: store.text(state) })
    }

    if (action === 'meta' && req.method === 'POST') {
      const body = await readJson(req, 64 * 1024)
      const who = requireEditor(req, state, body)
      const changes = {}
      if (body.access !== undefined) {
        // Who may edit is decided by members, not by a guest let in by the link.
        if (who.kind === 'guest') throw new HttpError(403, 'only signed-in users and agents can change access')
        if (!['team', 'link'].includes(body.access)) throw new HttpError(400, 'access: team or link')
        changes.access = body.access
      }
      if (typeof body.title === 'string' && body.title.trim().length >= 2) changes.title = body.title.trim().slice(0, 120)
      if (typeof body.description === 'string') changes.description = body.description.trim().slice(0, 500)
      if (body.tags !== undefined) changes.tags = normalizeTags(body.tags)
      if (body.task !== undefined) changes.task = normalizeTask(body.task)
      store.setMeta(state, changes)
      return json(res, 200, { ok: true, title: state.meta.title, access: state.meta.access ?? 'team', description: state.meta.description ?? '', tags: state.meta.tags ?? [], task: state.meta.task ?? null })
    }

    // Link-card data. Only for refs this board actually contains — otherwise any board key would turn the
    // endpoint into a directory of every other board.
    if (action === 'links' && req.method === 'POST') {
      const body = await readJson(req, 32 * 1024)
      const wanted = Array.isArray(body.refs) ? body.refs.filter((r) => typeof r === 'string' && r.length <= 300).slice(0, 80) : []
      const present = refsOf(store.elements(state), { boardOrigin: publicUrl })
      const out = {}
      await Promise.all(
        wanted.map(async (ref) => {
          out[ref] = present.has(ref) ? await links.meta(ref) : null
        }),
      )
      return json(res, 200, { meta: out })
    }

    if (action === 'timer' && req.method === 'POST') {
      const body = await readJson(req, 4 * 1024)
      const who = requireEditor(req, state, body)
      const timer = store.timerAct(state, String(body.do ?? ''), { minutes: Number(body.minutes), by: who.name })
      return json(res, 200, { ok: true, timer, now: store.now() })
    }

    if (action === 'react' && req.method === 'POST') {
      const body = await readJson(req, 16 * 1024)
      const who = requireEditor(req, state, body)
      if (!REACTIONS.includes(body.emoji)) throw new HttpError(400, `emoji: one of ${REACTIONS.join(' ')}`)
      const reactions = store.react(state, String(body.id ?? ''), body.emoji, who.name, body.on !== false)
      if (!reactions) throw new HttpError(404, 'no sticky with that id on the board')
      return json(res, 200, { ok: true, reactions, notes: store.notes(state) })
    }

    throw new HttpError(405, 'boards have no such action')
  }

  const live = createLive({
    store,
    allowedOrigin: publicUrl,
    editorFor: editor,
    resolveBoard: async (req, url) => {
      const match = /^\/b\/([a-z0-9-]+)\/live$/.exec(url.pathname)
      if (!match) return null
      return board(req, url, match[1]).catch(() => null)
    },
    log: (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event })),
  })

  async function handler(req, res) {
    const started = process.hrtime.bigint()
    const origin = req.headers.origin
    if (origin && corsOrigins.has(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      res.setHeader('access-control-expose-headers', 'x-board-rev, x-board-epoch')
      res.setHeader('vary', 'origin')
    }
    res.on('finish', () => metrics.request(req, res.statusCode, Number(process.hrtime.bigint() - started) / 1e9))
    try {
      await route(req, res)
    } catch (error) {
      if (res.headersSent) return res.end()
      if (error instanceof HttpError && error.status === 404 && req.method === 'GET' && /text\/html/.test(String(req.headers.accept ?? ''))) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8', 'x-robots-tag': 'noindex', 'cache-control': 'no-store' })
        return res.end(renderNotFound(staticBase, homeUrl))
      }
      if (error instanceof HttpError) return json(res, error.status, { error: error.message, ...error.extra })
      if (error instanceof EditError || error instanceof LimitError) return json(res, 400, { error: error.message, help: `${PREFIX}/api` })
      console.error(JSON.stringify({ level: 'error', event: 'request_failed', path: req.url?.replace(/([?&](k|t)=)[^&]+/g, '$1…'), error: String(error?.stack ?? error) }))
      return json(res, 500, { error: 'internal error' })
    }
  }
  handler.upgrade = live.upgrade
  handler.live = live
  handler.auth = auth
  metrics.gauge('boards_live_sockets', 'Open live-channel WebSockets.', () => live.stats().sockets)
  metrics.gauge('boards_loaded', 'Boards held in memory.', () => store._boards.size)
  return handler
}

export async function main(env = process.env) {
  const log = (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event }))
  let config
  try {
    config = loadConfig(env)
  } catch (error) {
    console.error(error.message)
    process.exit(2)
  }
  const { storageFromConfig } = await import('./storage/index.mjs')
  const storage = await storageFromConfig(config.storage, { log })
  const metrics = createMetrics()
  const store = createStore({ storage, baseUrl: config.publicUrl, flushDelayMs: config.flushDelayMs, flushMaxMs: config.flushMaxMs, log: (event) => { if (event.level === 'error') metrics.inc('boards_storage_errors_total', 'Failed storage writes.'); log(event) } })
  let readyAt = 0
  const ready = async () => {
    if (Date.now() - readyAt < 5000) return true
    await storage.readMeta('readiness-probe')
    readyAt = Date.now()
    return true
  }
  const app = createApp({ store, config, metrics, ready })
  const server = createServer(app)
  server.on('upgrade', app.upgrade)
  server.listen(config.port, config.host, () =>
    log({ event: 'listening', version: VERSION, url: config.publicUrl, port: config.port, storage: config.storage.driver, auth: config.auth.mode, epoch: store.epoch }),
  )
  if (config.auth.mode === 'none' && !['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    log({ level: 'warn', event: 'auth_disabled', note: 'BOARDS_AUTH=none: everyone who can reach this port can read, list and edit every board' })
  }
  let metricsServer = null
  if (config.metricsPort) {
    metricsServer = createServer((req, res) => {
      if (req.url !== '/metrics') {
        res.writeHead(404)
        return res.end()
      }
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4' })
      res.end(metrics.render())
    }).listen(config.metricsPort, config.host)
  }
  // Load the engine soon after start, not on the first agent edit (it parses ~13 MB).
  setTimeout(() => loadEngine().catch((error) => console.error('engine', error)), 1000).unref()

  let stopping = false
  const stop = async (signal) => {
    if (stopping) return
    stopping = true
    log({ event: 'stopping', signal })
    server.close()
    metricsServer?.close()
    app.live.close()
    await store.flushAll()
    process.exit(0)
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))
  return { server, app, store, config }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main()
