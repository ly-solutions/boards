/**
 * The harnessly hub as the source of who may do what with a board (BOARDS_HUB_RIGHTS=on).
 *
 * Why. In harnessly a board is shared in one dialog with documents and designs: its owner gives the team, people and
 * links without sign-in a role — view, comment or edit — and the hub keeps it. This service is where the board is
 * opened, drawn and commented, so it asks the hub and does what the role allows:
 *
 * - a signed-in person: `POST <hub>/api/platform/docs/_rights` with their hub id (signed in from harnessly) or their
 *   address (signed in here), answered `none | view | comment | edit`. A board the hub has never heard of keeps this
 *   service's own rules (a signed-in person edits);
 * - a guest of a link without sign-in (`?g=<token>`): `POST <hub>/api/platform/docs/_guest` answers what the link
 *   allows, `view` or `comment`, and for whom it was made. The link is the hub's: a switched-off or expired link opens
 *   nothing from the next question on.
 *
 * Answers are kept for a few seconds, so a page's calls do not each ask the hub; a refusal of the hub (it is down) is
 * a HubRightsError, which the server answers with 503: a board is not opened to people the hub would not let in.
 */

export const RIGHTS = ['none', 'view', 'comment', 'edit']
const RIGHT_RANK = { none: 0, view: 1, comment: 2, edit: 3 }
export const rankOf = (right) => RIGHT_RANK[right] ?? 0

/** The prefix of a guest's credential in place of a board key: `g.<token>` (a board key never has a dot). */
export const GUEST_PREFIX = 'g.'

export class HubRightsError extends Error {}

export function createHubRights({ issuer, token, ttlMs = 10_000, fetchImpl = fetch, now = () => Date.now() }) {
  const base = `${String(issuer).replace(/\/+$/, '')}/api/platform/docs`
  const cache = new Map()

  const remember = (key, value) => {
    if (cache.size > 5000) cache.clear()
    cache.set(key, { value, at: now() })
    return value
  }
  const recall = (key) => {
    const hit = cache.get(key)
    if (hit && now() - hit.at < ttlMs) return hit.value
    return undefined
  }

  async function ask(path, body) {
    let response
    try {
      response = await fetchImpl(`${base}/${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      })
    } catch (error) {
      throw new HubRightsError(`the hub did not answer: ${error.message}`)
    }
    if (response.status === 404 && path === '_guest') return null
    if (!response.ok) throw new HubRightsError(`the hub answered ${response.status}`)
    return response.json()
  }

  /**
   * A person's right on a board: { right, known }. `known` is false for a board the hub keeps no record of: the
   * caller keeps its own rules for it. The person is `{ hubId }` (signed in from harnessly) or `{ email }`.
   */
  async function personRight(person, slug) {
    const who = person.hubId ? `h:${person.hubId}` : person.email ? `m:${String(person.email).toLowerCase()}` : null
    const key = `${who ?? '-'}|${slug}`
    const kept = recall(key)
    if (kept) return kept
    const body = person.hubId ? { sub: person.hubId, slugs: [slug] } : person.email ? { email: person.email, slugs: [slug] } : { sub: '-', slugs: [slug] }
    const answer = await ask('_rights', body)
    const right = RIGHTS.includes(answer?.rights?.[slug]) ? answer.rights[slug] : 'none'
    // An older hub does not say which boards it knows: it is then taken to know none, and nothing changes here.
    const known = Array.isArray(answer?.known) ? answer.known.includes(slug) : false
    return remember(key, { right, known })
  }

  /** The person's rights on many boards at once (a list): Map slug → { right, known }, asked 200 at a time. */
  async function personRights(person, slugs) {
    const out = new Map()
    const who = person.hubId ? `h:${person.hubId}` : person.email ? `m:${String(person.email).toLowerCase()}` : '-'
    const missing = []
    for (const slug of slugs) {
      const kept = recall(`${who}|${slug}`)
      if (kept) out.set(slug, kept)
      else missing.push(slug)
    }
    for (let i = 0; i < missing.length; i += 200) {
      const part = missing.slice(i, i + 200)
      const body = person.hubId ? { sub: person.hubId, slugs: part } : person.email ? { email: person.email, slugs: part } : { sub: '-', slugs: part }
      const answer = await ask('_rights', body)
      const known = new Set(Array.isArray(answer?.known) ? answer.known : [])
      for (const slug of part) {
        const right = RIGHTS.includes(answer?.rights?.[slug]) ? answer.rights[slug] : 'none'
        out.set(slug, remember(`${who}|${slug}`, { right, known: known.has(slug) }))
      }
    }
    return out
  }

  /** What a guest link allows on this board: { right: 'view'|'comment', forWhom, linkId }, or null when it opens nothing. */
  async function guest(tokenValue, slug, { open = false } = {}) {
    if (typeof tokenValue !== 'string' || tokenValue.length < 20 || tokenValue.length > 128) return null
    const key = `g:${tokenValue}|${slug}`
    if (!open) {
      const kept = recall(key)
      if (kept !== undefined) return kept
    }
    const answer = await ask('_guest', { token: tokenValue, slug, open })
    if (!answer || answer.slug !== slug) return remember(key, null)
    const right = answer.rights === 'comment' ? 'comment' : 'view'
    const forWhom = typeof answer.forWhom === 'string' ? answer.forWhom.trim().slice(0, 40) : ''
    return remember(key, { right, forWhom, linkId: String(answer.linkId ?? '') })
  }

  return { url: String(issuer).replace(/\/+$/, ''), personRight, personRights, guest, forget: () => cache.clear() }
}
