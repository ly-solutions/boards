/**
 * Links on a board that we render as cards: a link to another board on the
 * same server becomes a live board card (board mention), any other http(s)
 * URL becomes a bookmark card.
 *
 * Shared by the server (it fetches board metadata) and the editor (it decides
 * what becomes a card), so it has no imports.
 */

const SLUG = '[a-z0-9][a-z0-9-]{2,120}'
const BOARD_PATH = new RegExp(`^/b/(${SLUG})/?$`)

/** Sites Excalidraw embeds itself as a player or frame: we leave those pastes alone. */
const EMBEDS = new Set(['youtube.com', 'm.youtube.com', 'youtu.be', 'vimeo.com', 'player.vimeo.com', 'figma.com', 'excalidraw.com', 'link.excalidraw.com', 'codesandbox.io', 'twitter.com', 'x.com'])

/**
 * What kind of link this is. null means not a link, or something the editor
 * embeds itself. `ref` is the short name of the target: metadata is cached by
 * it, and it is how the server checks that the link really is on the board.
 *
 * `boardOrigin` is the origin boards are served from; when given, only
 * `/b/<slug>` links on that origin count as boards.
 */
export function classify(raw, { boardOrigin } = {}) {
  let url
  try {
    url = new URL(String(raw ?? '').trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const board = BOARD_PATH.exec(url.pathname)
  if (board && (boardOrigin === undefined || url.origin === boardOrigin)) return { kind: 'board', slug: board[1], ref: `board:${board[1]}`, url: url.href }
  const bare = url.hostname.toLowerCase().replace(/^www\./, '')
  if (EMBEDS.has(bare)) return null
  return { kind: 'link', ref: `link:${url.href}`, url: url.href, host: bare }
}

/** Whether the text is a single URL and nothing else: that is what pasting an address looks like. */
export function singleUrl(text) {
  const value = String(text ?? '').trim()
  return /^https?:\/\/\S+$/i.test(value) ? value : null
}

/** Targets the board really links to: URLs in element links and in link cards. */
export function refsOf(elements, { boardOrigin } = {}) {
  const refs = new Set()
  for (const el of elements ?? []) {
    if (!el || el.isDeleted) continue
    for (const candidate of [el.link, el.customData?.url]) {
      const target = candidate ? classify(candidate, { boardOrigin }) : null
      if (target) refs.add(target.ref)
    }
  }
  return refs
}

/** Fallback card label: what stays in exports and in the board text for agents. `boardWord` is the localized "Board". */
export function fallbackLabel(meta, target, { boardWord = 'Board' } = {}) {
  if (meta?.kind === 'board') return `${boardWord} · ${meta.title}`
  if (target.kind === 'link') return `${target.host}${new URL(target.url).pathname.replace(/\/$/, '')}`.slice(0, 80)
  return target.url
}
