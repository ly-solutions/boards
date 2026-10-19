/**
 * Data for link cards on a board.
 *
 * A pasted URL becomes a card. For links to other boards on this server the card shows the board's title and
 * when it was updated; the browser cannot know that without the other board's key, so it asks us. Everything
 * else stays a plain bookmark: the server never fetches arbitrary URLs (that would be an SSRF hole).
 */
const TTL_MS = 60_000
const MISS_TTL_MS = 15_000

export function createLinks({
  /** (slug) → { title, updatedAt } | null */
  boardMeta = async () => null,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  const cache = new Map()

  async function load(ref) {
    if (!ref.startsWith('board:')) return null
    const slug = ref.slice('board:'.length)
    const meta = await boardMeta(slug)
    return meta ? { kind: 'board', slug, title: meta.title ?? slug, updatedAt: meta.updatedAt ?? null } : null
  }

  /** Metadata for a ref; null when unknown (misses are remembered briefly, then asked again). */
  async function meta(ref) {
    const hit = cache.get(ref)
    if (hit && now() - hit.at < (hit.value ? TTL_MS : MISS_TTL_MS)) return hit.value
    let value = null
    try {
      value = await load(ref)
    } catch (error) {
      log({ level: 'warn', event: 'link_meta_failed', ref: ref.slice(0, 80), error: String(error?.message ?? error) })
    }
    cache.set(ref, { value, at: now() })
    if (cache.size > 2_000) cache.delete(cache.keys().next().value)
    return value
  }

  return { meta, forget: (ref) => cache.delete(ref) }
}
