/**
 * Board addresses and access keys.
 *
 * A board is reachable by two secrets in its link: an unguessable slug and the key `?k=`. Login is not required to
 * open a link on purpose — boards are opened on phones and handed to agents as a single line — so a board must not
 * contain anything you would not show to whoever ends up with the link.
 *
 * Reading needs the link; editing needs a signed-in user or an API token, unless the board is opened for editing
 * by link (`access: link`). History makes vandalism recoverable.
 */
import { randomInt, timingSafeEqual, createHash } from 'node:crypto'

const TRANSLIT = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i',
  й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't',
  у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '',
  э: 'e', ю: 'yu', я: 'ya',
}

/** Readable part of the address: `/b/payment-architecture-…` is recognisable, `/b/d41d8…` is not. Cyrillic titles are transliterated. */
export function slugBase(title) {
  let out = ''
  for (const ch of String(title ?? '').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g, '')) {
    if (ch in TRANSLIT) out += TRANSLIT[ch]
    else if (/[a-z0-9]/.test(ch)) out += ch
    else out += '-'
  }
  return out.replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'board'
}

function randomString(alphabet, length, random = randomInt) {
  let out = ''
  for (let i = 0; i < length; i += 1) out += alphabet[random(alphabet.length)]
  return out
}

/** Twelve random characters — about 62 bits: the address cannot be guessed. */
export function makeSlug(title, random) {
  return `${slugBase(title)}-${randomString('abcdefghijklmnopqrstuvwxyz0123456789', 12, random)}`
}

/** Twenty-two base62 characters — about 130 bits. */
export function makeKey(random) {
  return randomString('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', 22, random)
}

/** Only slugs we generate ourselves ever reach a storage key. */
export function isValidSlug(slug) {
  return typeof slug === 'string' && /^[a-z0-9][a-z0-9-]{2,63}$/.test(slug)
}

/**
 * Constant-time secret comparison that does not leak the length: `===` stops at the first differing character,
 * and the timing difference lets an attacker guess a key character by character. Hashing first equalises the
 * lengths so `timingSafeEqual` never throws.
 */
export function secretMatches(provided, expected) {
  if (typeof expected !== 'string' || expected.length === 0) return false
  const a = createHash('sha256').update(String(provided ?? '')).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
