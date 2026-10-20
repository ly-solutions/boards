/**
 * Plugins: extend a stock boards image without forking it.
 *
 * BOARDS_PLUGINS lists ES modules (paths, file: URLs or package names) that the server imports at start-up. A
 * plugin exports `{ name, version, apiVersion, register(api), web? }`; `register` receives the API below and
 * may add:
 *
 *   routes        api.addRoute({ method, path, scope: 'board' | 'global', access, handler })
 *                   board  → /b/<slug>/plugins/<name><path>   (the board's key or a token; `access: 'editor'`
 *                                                              requires the right to edit)
 *                   global → /b/plugins/<name><path>          (`access`: member (default), token, public)
 *   card resolvers api.addCardResolver({ id, match(url) | pattern, resolve(input, ctx) })   see server/cards.mjs
 *   block actions api.addBlockAction({ id, label, when, run(ctx) })   context-menu items on selected elements;
 *                                                                     the result may edit the board
 *   meta fields   api.addMetaField({ id, label, type, home })          extra board properties, e.g. a deadline
 *   webhooks      api.addWebhook({ path, secret | verify, handler })  incoming: POST /b/hooks/<name><path>
 *   events        api.on('thread.created' | 'board.created' | 'board.changed' | 'board.meta' | …, fn)
 *   flags         api.addFlags({ id, flags(user) })                   see server/flags.mjs
 *   messages      api.addMessages('ru', { 'myplugin.hello': 'Привет' })
 *   web code      `web: './web/index.mjs'` (or BOARDS_WEB_PLUGINS) — an ES module the editor imports; see
 *                 web/src/plugins.ts for the browser-side API
 *
 * The API is versioned with semver (PLUGIN_API_VERSION). A plugin states the range it was written for in
 * `apiVersion` (e.g. `^1.0.0`); an incompatible plugin stops the server at start-up with a clear message rather
 * than half-working. Everything a plugin registers is checked when it registers, for the same reason.
 *
 * Plugins are trusted code running inside the server: install only what you would install as a dependency.
 */
import { timingSafeEqual, createHmac } from 'node:crypto'
import { dirname, isAbsolute, resolve, sep, basename } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createTranslator, pickLocalized } from '../shared/i18n.mjs'
import { CATALOGS } from '../shared/locales/index.mjs'
import { validateResolver } from './cards.mjs'
import { PLUGIN_API_VERSION, satisfies } from '../shared/semver.mjs'

export { PLUGIN_API_VERSION, satisfies }


const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/
const ID = /^[a-z0-9][a-z0-9._-]{0,60}$/
const FIELD_TYPES = ['text', 'date', 'url', 'number', 'select']
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

// ---------------------------------------------------------------------------------------------------------------

export class PluginHttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.status = status
    this.extra = extra
  }
}

/** A route handler's answer with an explicit status and headers: `return api.reply(201, { id })`. */
export class PluginReply {
  constructor(status = 200, body = null, headers = {}) {
    this.status = status
    this.body = body
    this.headers = headers
  }
}

/** Compile `/items/:id` into a matcher. */
function compilePath(path) {
  if (typeof path !== 'string' || (path !== '' && !path.startsWith('/'))) throw new Error(`route path "${path}" must start with /`)
  const keys = []
  const source = path
    .split('/')
    .map((segment) => {
      if (segment.startsWith(':')) {
        if (!/^:[A-Za-z_]\w*$/.test(segment)) throw new Error(`route path "${path}": bad parameter ${segment}`)
        keys.push(segment.slice(1))
        return '([^/]+)'
      }
      if (!/^[A-Za-z0-9._~-]*$/.test(segment)) throw new Error(`route path "${path}": segment "${segment}" has characters outside A-Z a-z 0-9 . _ ~ -`)
      return segment.replace(/\./g, '\\.')
    })
    .join('/')
  return { regex: new RegExp(`^${source}/?$`), keys }
}

/** A verify() for webhooks signed with an HMAC of the raw body (GitHub, GitLab-style, Stripe-like schemes). */
export function hmacVerifier({ secret, header = 'x-hub-signature-256', algorithm = 'sha256', prefix = 'sha256=', encoding = 'hex' }) {
  if (!secret) throw new Error('hmacVerifier: secret is required')
  return ({ headers, rawBody }) => {
    const given = String(headers[header.toLowerCase()] ?? '')
    const expected = prefix + createHmac(algorithm, secret).update(rawBody).digest(encoding)
    const a = Buffer.from(given)
    const b = Buffer.from(expected)
    return a.length === b.length && timingSafeEqual(a, b)
  }
}

const sameSecret = (given, expected) => {
  const a = Buffer.from(String(given ?? ''))
  const b = Buffer.from(String(expected ?? ''))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

/**
 * The registry every plugin registers into; createApp() serves what it holds. Without plugins it is empty and
 * the server behaves exactly as before.
 */
export function createPluginHost({ config = {}, env = {}, t = createTranslator(config.locale ?? 'en', CATALOGS), log = () => {}, cards = null, flags = null } = {}) {
  const locale = t.locale ?? config.locale ?? 'en'
  const plugins = []
  const routes = []
  const actions = []
  const fields = new Map()
  const webhooks = []
  const listeners = new Map()
  const web = [] // { plugin, url }
  const webDirs = new Map() // mount → absolute directory
  const scriptOrigins = new Set()
  const pendingResolvers = []
  let app = null

  /** A label given as a catalog key, a plain string or `{ en, ru }`. */
  const label = (value) => (typeof value === 'string' && t.has?.(value) ? t(value) : pickLocalized(value, locale))

  function register(kind, plugin, check) {
    try {
      return check()
    } catch (error) {
      throw new Error(`plugin ${plugin}: ${kind}: ${error.message}`)
    }
  }

  function apiFor(plugin) {
    const name = plugin.name
    const pluginLog = (event) => log({ plugin: name, ...(typeof event === 'string' ? { event } : event) })
    const api = {
      apiVersion: PLUGIN_API_VERSION,
      plugin: { name, version: plugin.version },
      locale,
      t,
      env: Object.freeze({ ...env }),
      config: Object.freeze({ publicUrl: config.publicUrl, locale, features: { ...(config.features ?? {}) } }),
      log: pluginLog,
      HttpError: PluginHttpError,
      reply: (status, body, headers) => new PluginReply(status, body, headers),
      hmacVerifier,

      addMessages(lang, messages) {
        register('messages', name, () => {
          if (!messages || typeof messages !== 'object') throw new Error('messages must be an object of key → text')
          t.add?.(lang, messages)
        })
      },

      addRoute({ method = 'GET', path = '', scope = 'board', access, handler, bodyLimit = 256 * 1024 } = {}) {
        register('route', name, () => {
          const verb = String(method).toUpperCase()
          if (!METHODS.includes(verb)) throw new Error(`method ${method}: one of ${METHODS.join(', ')}`)
          if (!['board', 'global'].includes(scope)) throw new Error('scope: board or global')
          const allowed = scope === 'board' ? ['viewer', 'editor', 'member'] : ['member', 'token', 'public']
          const mode = access ?? allowed[0]
          if (!allowed.includes(mode)) throw new Error(`access for a ${scope} route: ${allowed.join(', ')}`)
          if (typeof handler !== 'function') throw new Error('handler(ctx) is required')
          const { regex, keys } = compilePath(path)
          if (routes.some((r) => r.plugin === name && r.scope === scope && r.method === verb && String(r.regex) === String(regex))) throw new Error(`${verb} ${path} is registered twice`)
          routes.push({ plugin: name, method: verb, scope, access: mode, regex, keys, handler, bodyLimit, path })
        })
      },

      addCardResolver(resolver) {
        register('card resolver', name, () => {
          validateResolver(resolver)
          if (cards) cards.add(resolver)
          else pendingResolvers.push(resolver)
        })
      },

      addBlockAction({ id, label: text, icon = null, when = {}, confirm = null, run } = {}) {
        register('block action', name, () => {
          if (!ID.test(String(id ?? ''))) throw new Error(`id "${id}": lowercase letters, digits, dots, dashes`)
          if (actions.some((a) => a.plugin === name && a.id === id)) throw new Error(`action ${id} is registered twice`)
          if (typeof run !== 'function') throw new Error(`action ${id}: run(ctx) is required`)
          if (!text) throw new Error(`action ${id}: label is required`)
          if (icon !== null && (typeof icon !== 'string' || !/^<svg[\s>]/.test(icon.trim()) || /<script|\son\w+=|javascript:/i.test(icon))) throw new Error(`action ${id}: icon must be an inline <svg> without scripts`)
          const rule = {
            min: Number.isInteger(when.min) ? when.min : 1,
            max: Number.isInteger(when.max) ? when.max : null,
            types: Array.isArray(when.types) ? when.types.map(String) : null,
            kinds: Array.isArray(when.kinds) ? when.kinds.map(String) : null,
          }
          actions.push({ plugin: name, id, label: text, icon, when: rule, confirm, run })
        })
      },

      addMetaField({ id, label: text, type = 'text', options = null, placeholder = null, home = false, maxLength = 200, validate = null } = {}) {
        register('meta field', name, () => {
          if (!/^[a-z][a-zA-Z0-9_-]{0,40}$/.test(String(id ?? ''))) throw new Error(`id "${id}": a letter, then letters, digits, _ or -`)
          if (['title', 'description', 'tags', 'task', 'access', 'key', 'author', 'createdAt', 'updatedAt', 'stats', 'fields'].includes(id)) throw new Error(`id "${id}" is a built-in property`)
          if (fields.has(id)) throw new Error(`field ${id} is already registered by plugin ${fields.get(id).plugin}`)
          if (!FIELD_TYPES.includes(type)) throw new Error(`type: one of ${FIELD_TYPES.join(', ')}`)
          if (type === 'select' && (!Array.isArray(options) || !options.length)) throw new Error('a select field needs options: [{ value, label }]')
          if (!text) throw new Error('label is required')
          fields.set(id, { plugin: name, id, label: text, type, options, placeholder, home: Boolean(home), maxLength, validate })
        })
      },

      addWebhook({ path = '', secret = null, header = 'x-boards-webhook-secret', verify = null, public: open = false, handler, bodyLimit = 1024 * 1024 } = {}) {
        register('webhook', name, () => {
          if (typeof handler !== 'function') throw new Error('handler(ctx) is required')
          if (!secret && typeof verify !== 'function' && !open) throw new Error('give secret or verify(ctx) — or public: true if the endpoint really needs no authentication')
          const { regex, keys } = compilePath(path)
          webhooks.push({ plugin: name, regex, keys, secret, header: header.toLowerCase(), verify, handler, bodyLimit, path })
        })
      },

      on(event, fn) {
        register('event listener', name, () => {
          if (typeof fn !== 'function') throw new Error('on(event, fn): fn must be a function')
          if (!listeners.has(event)) listeners.set(event, [])
          listeners.get(event).push({ plugin: name, fn })
        })
      },

      addFlags(provider) {
        register('flags provider', name, () => {
          if (!flags) throw new Error('flags are not available')
          flags.add({ id: `${name}:${provider?.id ?? 'flags'}`, flags: provider?.flags?.bind(provider) })
        })
      },

      cards: {
        invalidate: (which) => cards?.invalidate(which),
      },

      boards: {
        list: async () => (app ? app.listBoards() : []),
        get: async (slug) => (app ? app.boardView(slug) : null),
        edit: async (slug, body, opts = {}) => {
          if (!app) throw new Error('boards are not available before the server starts')
          return app.editBoard(slug, body, { author: opts.author ?? name })
        },
      },
    }
    return api
  }

  /** A web module the editor imports: a URL, or a local file served under /b/_plugins/<mount>/. */
  function addWeb(plugin, spec, { cwd = process.cwd(), serverFile = null } = {}) {
    if (/^https:\/\//.test(spec)) {
      web.push({ plugin, url: spec })
      scriptOrigins.add(new URL(spec).origin)
      return
    }
    if (/^http:\/\//.test(spec)) throw new Error(`web plugin ${spec}: use https (or a local file)`)
    const file = spec.startsWith('file:') ? fileURLToPath(spec) : resolve(cwd, spec)
    const dir = dirname(file)
    // The whole folder of the web entry is served (chunks, CSS): it must not hold server code.
    if (serverFile && (dirname(serverFile) === dir || dirname(serverFile).startsWith(dir + sep))) {
      throw new Error(`plugin ${plugin}: put web files in their own folder (e.g. web/) — ${dir} would also serve the server module`)
    }
    const mount = `${plugin}${[...webDirs.keys()].filter((m) => m.split('~')[0] === plugin).length ? `~${webDirs.size}` : ''}`
    webDirs.set(mount, dir)
    web.push({ plugin, url: `/b/_plugins/${mount}/${encodeURIComponent(basename(file))}` })
  }

  async function load(specifiers, { cwd = process.cwd(), importer = (url) => import(url) } = {}) {
    for (const spec of specifiers) {
      let url
      if (spec.startsWith('file:')) url = spec
      else if (isAbsolute(spec) || spec.startsWith('./') || spec.startsWith('../')) url = pathToFileURL(resolve(cwd, spec)).href
      else url = import.meta.resolve(spec)
      let mod
      try {
        mod = await importer(url)
      } catch (error) {
        throw new Error(`plugin ${spec}: cannot import: ${error.message}`)
      }
      await use(mod, { spec, url })
    }
    return plugins
  }

  /** Register an already imported plugin module (tests and embedders call this directly). */
  async function use(mod, { spec = '(inline)', url = null } = {}) {
    const def = typeof mod?.default === 'function' ? { ...mod, register: mod.default } : mod?.default && typeof mod.default === 'object' ? mod.default : mod
    const name = def?.name
    if (!NAME.test(String(name ?? ''))) throw new Error(`plugin ${spec}: export a name (lowercase letters, digits, dashes)`)
    if (plugins.some((p) => p.name === name)) throw new Error(`plugin ${name} is loaded twice`)
    if (typeof def.register !== 'function') throw new Error(`plugin ${name}: export register(api)`)
    if (!def.apiVersion) throw new Error(`plugin ${name}: export apiVersion, the plugin API range it was written for (e.g. "^${PLUGIN_API_VERSION.split('.')[0]}.0.0")`)
    let ok
    try {
      ok = satisfies(PLUGIN_API_VERSION, def.apiVersion)
    } catch (error) {
      throw new Error(`plugin ${name}: apiVersion: ${error.message}`)
    }
    if (!ok) throw new Error(`plugin ${name} needs plugin API ${def.apiVersion}; this server provides ${PLUGIN_API_VERSION}`)
    const plugin = { name, version: String(def.version ?? '0.0.0'), apiVersion: def.apiVersion, spec }
    plugins.push(plugin)
    await def.register(apiFor(plugin))
    if (def.web) {
      const serverFile = url?.startsWith('file:') ? fileURLToPath(url) : null
      const entries = Array.isArray(def.web) ? def.web : [def.web]
      for (const entry of entries) addWeb(name, String(entry), { cwd: serverFile ? dirname(serverFile) : process.cwd(), serverFile })
    }
    log({ event: 'plugin_loaded', plugin: name, version: plugin.version, apiVersion: def.apiVersion })
    return plugin
  }

  /** Tell listeners about an event. Never throws and never waits: a plugin cannot slow down or break an edit. */
  function emit(event, payload) {
    for (const { plugin, fn } of listeners.get(event) ?? []) {
      try {
        Promise.resolve(fn(payload, { event })).catch((error) => log({ level: 'warn', event: 'plugin_listener_failed', plugin, on: event, error: String(error?.message ?? error) }))
      } catch (error) {
        log({ level: 'warn', event: 'plugin_listener_failed', plugin, on: event, error: String(error?.message ?? error) })
      }
    }
  }

  function findRoute(scope, plugin, method, subpath) {
    let pathMatched = false
    for (const route of routes) {
      if (route.scope !== scope || route.plugin !== plugin) continue
      const m = route.regex.exec(subpath)
      if (!m) continue
      pathMatched = true
      if (route.method !== method) continue
      return { route, params: Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }
    }
    return pathMatched ? { methodNotAllowed: true } : null
  }

  function findWebhook(plugin, subpath) {
    for (const hook of webhooks) {
      if (hook.plugin !== plugin) continue
      const m = hook.regex.exec(subpath)
      if (m) return { hook, params: Object.fromEntries(hook.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) }
    }
    return null
  }

  /** Whether a webhook request is authentic. */
  async function verifyWebhook(hook, ctx) {
    if (hook.secret && sameSecret(ctx.headers[hook.header], hook.secret)) return true
    if (hook.verify) return Boolean(await hook.verify(ctx))
    return !hook.secret && !hook.verify
  }

  /** Normalise `fields` sent to /meta; unknown ids and bad values throw with a message for the person. */
  function normalizeFields(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new PluginHttpError(400, 'fields: an object of field id → value')
    const out = {}
    for (const [id, raw] of Object.entries(input)) {
      const field = fields.get(id)
      if (!field) throw new PluginHttpError(400, `fields.${id}: no such field`)
      if (raw === null || raw === '') {
        out[id] = null
        continue
      }
      let value
      if (field.type === 'number') {
        value = Number(raw)
        if (!Number.isFinite(value)) throw new PluginHttpError(400, `fields.${id}: a number`)
      } else {
        value = String(raw).trim()
        if (field.type === 'date' && !(/^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().startsWith(value))) throw new PluginHttpError(400, `fields.${id}: a date as YYYY-MM-DD`)
        if (field.type === 'url') {
          let url
          try {
            url = new URL(value)
          } catch {
            url = null
          }
          if (!url || !['http:', 'https:'].includes(url.protocol) || value.length > 500) throw new PluginHttpError(400, `fields.${id}: an http(s) link`)
        }
        if (field.type === 'select' && !field.options.some((o) => String(o.value) === value)) throw new PluginHttpError(400, `fields.${id}: one of ${field.options.map((o) => o.value).join(', ')}`)
        if (field.type === 'text' && (value.length > field.maxLength || /[\u0000-\u001f]/.test(value))) throw new PluginHttpError(400, `fields.${id}: text up to ${field.maxLength} characters`)
      }
      if (field.validate) {
        try {
          const checked = field.validate(value)
          if (checked !== undefined) value = checked
        } catch (error) {
          throw new PluginHttpError(400, `fields.${id}: ${error.message}`)
        }
      }
      out[id] = value
    }
    return out
  }

  /** What the editor needs to know about plugins, in the interface language. */
  function clientView() {
    return {
      web: web.map((w) => w.url),
      actions: actions.map((a) => ({ plugin: a.plugin, id: a.id, label: label(a.label), icon: a.icon, when: a.when, confirm: a.confirm ? label(a.confirm) : null })),
      fields: [...fields.values()].map((f) => ({ id: f.id, plugin: f.plugin, label: label(f.label), type: f.type, options: f.options?.map((o) => ({ value: String(o.value), label: label(o.label ?? o.value) })) ?? null, placeholder: f.placeholder ? label(f.placeholder) : null, home: f.home })),
      patterns: cards?.patterns?.() ?? [],
    }
  }

  return {
    /** The interface translator plugins add their messages to; createApp renders with the same one. */
    t,
    load,
    use,
    emit,
    findRoute,
    findWebhook,
    verifyWebhook,
    normalizeFields,
    clientView,
    label,
    action: (plugin, id) => actions.find((a) => a.plugin === plugin && a.id === id) ?? null,
    homeFields: () => [...fields.values()].filter((f) => f.home).map((f) => ({ ...f, label: label(f.label), options: f.options?.map((o) => ({ value: String(o.value), label: label(o.label ?? o.value) })) ?? null })),
    fieldIds: () => [...fields.keys()],
    webDir: (mount) => webDirs.get(mount) ?? null,
    scriptOrigins: () => [...scriptOrigins],
    addWeb: (spec, opts) => addWeb('web', spec, opts),
    /** createApp hands over what plugins may reach: board lookup and edits. Resolvers registered early go in now. */
    attach(bindings) {
      app = bindings
      if (bindings.cards && !cards) {
        cards = bindings.cards
        for (const resolver of pendingResolvers.splice(0)) cards.add(resolver)
      }
    },
    resolvers: () => [...pendingResolvers],
    list: () => plugins.map((p) => ({ ...p })),
    get empty() {
      return plugins.length === 0 && web.length === 0
    },
  }
}
