/**
 * The people of a board and their stable ids (HRN-1469).
 *
 * Why. A comment that calls `@Name` should reach that person — in harnessly, a dot on the bell. A name is not an
 * address, and the board must not hand e-mails to everyone who holds its link. So the board keeps, for each person who
 * was here signed in (opened it, edited it, commented), an id that a receiver of the comments webhook can turn back into
 * the person, and only the receiver can:
 *
 * - `hub:<id>` — signed in from the harnessly app view (`board_signin`): the id is the person's id in the harnessly hub;
 * - `mail:<hex>` — signed in any other way with an e-mail: HMAC-SHA256 of the lower-case e-mail keyed with the webhook
 *   secret. The hub holds the same secret and finds its own person with that e-mail; nobody else can reverse it.
 *
 * Without a webhook secret no `mail:` id is made (nobody could read it). Guests, API tokens and the local user have none.
 *
 * Who may be told: only these people. Each of them opened the board signed in, so a mention never shows a board to
 * someone who has not had it; a name typed by hand that is not one of them stays text.
 */
import { createHmac } from 'node:crypto'

/** The person's stable id, or null when they have none (guest, token, local). */
export function personId(user, secret = '') {
  if (!user || typeof user !== 'object') return null
  if (user.via === 'harnessly' && user.sub) return `hub:${String(user.sub).slice(0, 120)}`
  const email = typeof user.email === 'string' ? user.email.trim().toLowerCase() : ''
  if (!email || !secret || user.via === 'none' || user.via === 'token') return null
  return `mail:${createHmac('sha256', secret).update(email).digest('hex')}`
}

const MAX_PEOPLE = 200

/**
 * Remember a person on the board's notes: `notes.people[id] = { name, at }`. Returns true when something changed
 * (a new person, or a new name), so the caller saves only then.
 */
export function rememberPerson(notes, id, name, at = new Date().toISOString()) {
  if (!id || !name) return false
  notes.people ??= {}
  const was = notes.people[id]
  if (was && was.name === name) return false
  if (!was && Object.keys(notes.people).length >= MAX_PEOPLE) {
    // The longest unseen leaves: a board visited by hundreds keeps the recent ones.
    const oldest = Object.entries(notes.people).sort((a, b) => String(a[1].at).localeCompare(String(b[1].at)))[0]
    if (oldest) delete notes.people[oldest[0]]
  }
  notes.people[id] = { name: String(name).slice(0, 80), at }
  return true
}

/** The names the editor offers after `@`: the people of the board, without ids. */
export function peopleNames(notes) {
  return Object.values(notes.people ?? {}).map((p) => p.name).filter(Boolean)
}

/** Whether `@name` stands in the text as a whole word: at the start or after a space, and not followed by a letter. */
function mentioned(lower, name) {
  const needle = `@${name.toLowerCase()}`
  let at = lower.indexOf(needle)
  while (at >= 0) {
    const after = lower[at + needle.length] ?? ''
    if ((at === 0 || /\s/.test(lower[at - 1])) && !/[\p{L}\p{N}_]/u.test(after)) return true
    at = lower.indexOf(needle, at + 1)
  }
  return false
}

/**
 * Who a message calls: `[{ name, agent: true }]` for `@harnessly`, `[{ name, id }]` for a person of the board.
 * The author is never among them. A name two people share goes to both: the board cannot tell them apart either.
 * `@Bobby` does not call `Bob`.
 * Thread authors without an id (guests are out) are still named, with `id: null`, as before.
 */
export function mentionsIn(text, notes, { agent = 'harnessly', authorId = null, authorName = null } = {}) {
  const lower = String(text ?? '').toLowerCase()
  const out = []
  const self = authorName ? String(authorName).toLowerCase() : null
  if (mentioned(lower, agent)) out.push({ name: agent, agent: true })
  const named = new Set()
  for (const [id, p] of Object.entries(notes.people ?? {})) {
    if (id === authorId || !p?.name || p.name.toLowerCase() === agent) continue
    if (!mentioned(lower, p.name)) continue
    out.push({ name: p.name, id })
    named.add(p.name.toLowerCase())
  }
  for (const th of notes.comments ?? []) {
    for (const m of th.messages ?? []) {
      const name = m.author
      if (m.authorKind === 'agent' || !name || /^guest:/i.test(name) || m.authorId) continue
      const key = name.toLowerCase()
      if (key === agent || key === self || named.has(key) || !mentioned(lower, name)) continue
      named.add(key)
      out.push({ name, id: null })
    }
  }
  return out
}
