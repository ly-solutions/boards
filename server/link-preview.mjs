/**
 * Built-in card resolver: link previews from a page's Open Graph tags (`og:title`, `og:description`,
 * `og:site_name`, `og:image`), falling back to `<title>` and `<meta name="description">`.
 *
 * Off by default (BOARDS_LINK_PREVIEW=on): previews make the server fetch URLs that people paste, which an operator
 * should opt into. Fetches go through the SSRF guard (server/ssrf.mjs); private addresses are never contacted.
 */
import { safeFetch } from './ssrf.mjs'

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'" }
const decode = (text) =>
  String(text ?? '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39);/gi, (whole, name) => {
      if (name[0] === '#') {
        const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : Number(name.slice(1))
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole
      }
      return ENTITIES[name.toLowerCase()] ?? whole
    })
    .replace(/\s+/g, ' ')
    .trim()

const attr = (tag, name) => {
  const m = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag)
  return m ? (m[2] ?? m[3] ?? m[4] ?? '') : null
}

/** Open Graph and fallback metadata from the head of an HTML document. Pure; exported for tests. */
export function parsePreview(html, pageUrl) {
  const head = String(html ?? '').slice(0, 256 * 1024)
  const meta = {}
  for (const [tag] of head.matchAll(/<meta\b[^>]*>/gi)) {
    const key = (attr(tag, 'property') ?? attr(tag, 'name') ?? '').toLowerCase()
    const content = attr(tag, 'content')
    if (key && content !== null && !(key in meta)) meta[key] = decode(content)
  }
  const title = meta['og:title'] || meta['twitter:title'] || decode(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(head)?.[1] ?? '')
  if (!title) return null
  let image = meta['og:image'] || meta['twitter:image'] || null
  try {
    // Only https images: the browser loads them, and mixed content would be blocked anyway.
    image = image ? new URL(image, pageUrl).href : null
    if (image && !image.startsWith('https:')) image = null
  } catch {
    image = null
  }
  const host = new URL(pageUrl).hostname.replace(/^www\./, '')
  return {
    kind: 'link',
    title: title.slice(0, 200),
    subtitle: (meta['og:description'] || meta['twitter:description'] || meta.description || '').slice(0, 300) || null,
    site: (meta['og:site_name'] || host).slice(0, 80),
    image,
    url: pageUrl,
  }
}

/** The resolver: matches every bookmark (`link:` ref) and reads the page. */
export function linkPreviewResolver({ fetchPage = safeFetch, timeoutMs = 4000 } = {}) {
  return {
    id: 'link-preview',
    ttlMs: 60 * 60_000,
    missTtlMs: 10 * 60_000,
    timeoutMs,
    match: (url) => url,
    async resolve(url, { signal }) {
      const page = await fetchPage(url, { timeoutMs, signal })
      if (page.status < 200 || page.status >= 300) return null
      if (!/html/i.test(String(page.headers?.['content-type'] ?? 'text/html'))) return null
      return parsePreview(page.body, page.url ?? url)
    },
  }
}
