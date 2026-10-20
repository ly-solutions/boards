/**
 * Data for link cards on a board — the compatibility entry point over the card registry (server/cards.mjs).
 *
 * A pasted URL becomes a card. For links to other boards on this server the card shows the board's title and
 * when it was updated; the browser cannot know that without the other board's key, so it asks us. Other URLs are
 * plain bookmarks unless a plugin's card resolver claims them, or the operator turned on link previews
 * (BOARDS_LINK_PREVIEW), which fetch pages only through the SSRF guard (server/ssrf.mjs).
 */
import { createCards } from './cards.mjs'

export function createLinks({
  /** (slug) → { title, updatedAt } | null */
  boardMeta = async () => null,
  resolvers = [],
  linkPreview = null,
  now = () => Date.now(),
  log = () => {},
} = {}) {
  return createCards({ boardMeta, resolvers, linkPreview, now, log })
}
