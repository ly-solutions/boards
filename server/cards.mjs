/**
 * Card registry: turns what is pasted on a board — a URL, or a short reference a plugin recognises — into card
 * data the editor draws: title, subtitle, status, icon, link.
 *
 * Refs (see shared/links.mjs):
 *   board:<slug>          another board on this server (built in)
 *   link:<url>            any http(s) URL; plugin resolvers are asked in registration order, then the optional
 *                         link preview. Nobody claims it → the card stays a plain bookmark.
 *   ref:<resolver>:<text> a text reference (e.g. an issue key) matched by that resolver's `pattern`
 *
 * Every lookup is cached (hits and misses with their own TTLs), deduplicated while in flight and cut off by a
 * timeout, so a slow third-party API never holds up the editor — the card just stays a link a bit longer.
 */

const DEFAULTS = { ttlMs: 5 * 60_000, missTtlMs: 30_000, timeoutMs: 3000 }
const TONES = ['neutral', 'info', 'success', 'warning', 'danger']
const MAX_CACHE = 5000

/** A reference pattern matches the whole pasted text, never a part of it. */
export const fullMatch = (pattern) => new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace(/[gy]/g, ''))

const str = (value, max) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : null)
const httpUrl = (value) => {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.href : null
  } catch {
    return null
  }
}

/**
 * Card data as the editor receives it. Anything a resolver returns passes through here: unknown fields are dropped,
 * links must be http(s), images https or same-origin paths, so a card can never smuggle a `javascript:` URL.
 */
export function normalizeCard(raw, { kind, url } = {}) {
  if (!raw || typeof raw !== 'object') return null
  const title = str(raw.title, 200)
  if (!title) return null
  const card = { kind: str(raw.kind, 60) ?? kind ?? 'link', title }
  const subtitle = str(raw.subtitle, 300)
  if (subtitle) card.subtitle = subtitle
  const site = str(raw.site, 80)
  if (site) card.site = site
  if (raw.status) {
    const label = str(typeof raw.status === 'string' ? raw.status : raw.status.label, 40)
    const tone = TONES.includes(raw.status?.tone) ? raw.status.tone : 'neutral'
    if (label) card.status = { label, tone }
  }
  const icon = typeof raw.icon === 'string' ? raw.icon.trim() : ''
  if (icon && (/^https:\/\//.test(icon) || /^\/b\//.test(icon) || /^data:image\/(png|svg\+xml|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(icon))) card.icon = icon.slice(0, 64 * 1024)
  else if (icon && [...icon].length <= 4) card.icon = icon
  const image = typeof raw.image === 'string' && /^https:\/\//.test(raw.image) ? httpUrl(raw.image) : null
  if (image) card.image = image
  const link = httpUrl(raw.url) ?? (url ? httpUrl(url) : null)
  if (link) card.url = link
  const updatedAt = str(raw.updatedAt, 40)
  if (updatedAt && !Number.isNaN(Date.parse(updatedAt))) card.updatedAt = updatedAt
  if (Array.isArray(raw.fields)) {
    const fields = raw.fields
      .map((f) => ({ label: str(f?.label, 40), value: str(typeof f?.value === 'number' ? String(f.value) : f?.value, 120) }))
      .filter((f) => f.label && f.value)
      .slice(0, 6)
    if (fields.length) card.fields = fields
  }
  return card
}

/** The built-in resolver for links to other boards on this server. Its answer is trusted as is. */
export function boardResolver(boardMeta) {
  return {
    id: 'board',
    trusted: true,
    ttlMs: 60_000,
    missTtlMs: 15_000,
    async resolveRef(slug) {
      const meta = await boardMeta(slug)
      return meta ? { kind: 'board', slug, title: meta.title ?? slug, updatedAt: meta.updatedAt ?? null } : null
    },
  }
}

/** Check a resolver definition at registration time, so a broken plugin fails at start-up, not on first paste. */
export function validateResolver(resolver) {
  if (!resolver || typeof resolver !== 'object') throw new Error('a card resolver must be an object')
  if (!/^[a-z0-9][a-z0-9._-]{0,60}$/.test(String(resolver.id ?? ''))) throw new Error(`card resolver id "${resolver.id}": lowercase letters, digits, dots, dashes`)
  if (typeof resolver.resolve !== 'function') throw new Error(`card resolver ${resolver.id}: resolve(input, ctx) is required`)
  if (resolver.match !== undefined && typeof resolver.match !== 'function') throw new Error(`card resolver ${resolver.id}: match(url) must be a function`)
  if (resolver.pattern !== undefined && !(resolver.pattern instanceof RegExp)) throw new Error(`card resolver ${resolver.id}: pattern must be a RegExp`)
  if (!resolver.match && !resolver.pattern) throw new Error(`card resolver ${resolver.id}: give match(url), pattern, or both`)
  return resolver
}

export function createCards({ boardMeta = async () => null, resolvers = [], linkPreview = null, now = () => Date.now(), log = () => {} } = {}) {
  const board = boardResolver(boardMeta)
  const plugins = [...resolvers]
  const cache = new Map()
  const inflight = new Map()

  function add(resolver) {
    validateResolver(resolver)
    if (plugins.some((r) => r.id === resolver.id)) throw new Error(`card resolver ${resolver.id} is registered twice`)
    plugins.push(resolver)
  }

  /** Which resolver takes a ref, and with what input. */
  function route(ref) {
    if (ref.startsWith('board:')) return { resolver: board, input: ref.slice('board:'.length), viaRef: true }
    if (ref.startsWith('link:')) {
      const url = ref.slice('link:'.length)
      for (const resolver of [...plugins, ...(linkPreview ? [linkPreview] : [])]) {
        if (!resolver.match) continue
        let matched = null
        try {
          matched = resolver.match(url)
        } catch {
          matched = null
        }
        if (matched !== null && matched !== undefined && matched !== false) return { resolver, input: url, match: matched }
      }
      return null
    }
    const m = /^ref:([a-z0-9][a-z0-9._-]{0,60}):(.{1,200})$/s.exec(ref)
    if (m) {
      const resolver = plugins.find((r) => r.id === m[1])
      if (resolver?.pattern && fullMatch(resolver.pattern).test(m[2])) return { resolver, input: m[2], match: m[2], kind: 'ref' }
    }
    return null
  }

  async function run({ resolver, input, match, kind, viaRef }) {
    if (viaRef) return resolver.resolveRef(input)
    const timeoutMs = resolver.timeoutMs ?? DEFAULTS.timeoutMs
    const controller = new AbortController()
    let timer
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error(`timed out after ${timeoutMs} ms`))
      }, timeoutMs)
    })
    try {
      const raw = await Promise.race([resolver.resolve(input, { signal: controller.signal, kind: kind ?? 'url', match }), timeout])
      return resolver.trusted ? raw : normalizeCard(raw, { kind: resolver.id, url: kind === 'ref' ? null : input })
    } finally {
      clearTimeout(timer)
    }
  }

  /** Card data for a ref; null when nobody knows it (misses are remembered briefly, then asked again). */
  async function meta(ref) {
    if (typeof ref !== 'string' || ref.length > 2100) return null
    const target = route(ref)
    if (!target) return null
    const hit = cache.get(ref)
    const ttl = (value) => (value ? (target.resolver.ttlMs ?? DEFAULTS.ttlMs) : (target.resolver.missTtlMs ?? DEFAULTS.missTtlMs))
    if (hit && now() - hit.at < ttl(hit.value)) return hit.value
    if (inflight.has(ref)) return inflight.get(ref)
    const pending = (async () => {
      let value = null
      try {
        value = (await run(target)) ?? null
      } catch (error) {
        log({ level: 'warn', event: 'link_meta_failed', resolver: target.resolver.id, ref: ref.slice(0, 80), error: String(error?.message ?? error) })
        // A failure keeps serving the last good answer rather than flipping the card back to a bare link.
        if (hit?.value) value = hit.value
      }
      cache.set(ref, { value, at: now() })
      if (cache.size > MAX_CACHE) cache.delete(cache.keys().next().value)
      return value
    })()
    inflight.set(ref, pending)
    try {
      return await pending
    } finally {
      inflight.delete(ref)
    }
  }

  /** Drop cached answers: one ref, or every ref a predicate accepts (e.g. after a webhook said an issue changed). */
  function invalidate(which) {
    if (typeof which === 'function') {
      for (const ref of [...cache.keys()]) if (which(ref)) cache.delete(ref)
    } else cache.delete(which)
  }

  /** Text-reference patterns for the editor: which pasted words become cards, and which resolver owns them. */
  const patterns = () => plugins.filter((r) => r.pattern).map((r) => ({ resolver: r.id, source: r.pattern.source, flags: r.pattern.flags.replace(/[gy]/g, '') }))

  /** Whether anything may turn a plain URL into a rich card — if not, the editor need not ask about bookmarks. */
  const claimsLinks = () => Boolean(linkPreview) || plugins.some((r) => r.match)

  return { meta, forget: invalidate, invalidate, add, patterns, claimsLinks, resolvers: () => plugins.map((r) => r.id) }
}
