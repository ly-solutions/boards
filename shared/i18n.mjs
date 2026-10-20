/**
 * Interface language: one tiny translator shared by the server (pages, board text) and the editor.
 *
 * Messages live in shared/locales/<locale>/<area>.mjs as flat objects; shared/locales/index.mjs joins them into
 * one catalog per locale with keys `<area>.<key>`. A message is a string with `{name}` placeholders, or — when it
 * depends on a number — an object of plural forms picked by `Intl.PluralRules` (`one`, `few`, `many`, `other`).
 *
 * A key missing from a locale falls back to English, then to the key itself: a half-translated plugin never shows
 * a blank button. tests/i18n.test.mjs keeps the built-in locales complete.
 *
 * No imports: the module is used by the server, the editor and the slop-check worker alike.
 */

export const LOCALES = ['en', 'ru']
export const DEFAULT_LOCALE = 'en'

/** Normalise `ru-RU`, `RU`, `ru_RU` to a supported locale; anything unknown becomes the default. */
export function normalizeLocale(value) {
  const base = String(value ?? '').trim().toLowerCase().split(/[-_]/)[0]
  return LOCALES.includes(base) ? base : DEFAULT_LOCALE
}

const PLURAL_FORMS = new Set(['zero', 'one', 'two', 'few', 'many', 'other'])

/** Whether a catalog value is a set of plural forms rather than a string. */
export function isPlural(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && 'other' in value && Object.keys(value).every((k) => PLURAL_FORMS.has(k))
}

const pluralRules = new Map()
function pluralForm(locale, count) {
  if (!pluralRules.has(locale)) {
    try {
      pluralRules.set(locale, new Intl.PluralRules(locale))
    } catch {
      pluralRules.set(locale, new Intl.PluralRules('en'))
    }
  }
  return pluralRules.get(locale).select(Number(count) || 0)
}

/** `{name}` placeholders; unknown ones stay as written so a typo is visible instead of silently empty. */
export function format(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (whole, name) => (vars[name] === undefined || vars[name] === null ? whole : String(vars[name])))
}

/**
 * Pick the message for `locale` out of a value a plugin may pass instead of a key: a plain string (used as is) or
 * a map of locales (`{ en: 'Create issue', ru: 'Создать задачу' }`).
 */
export function pickLocalized(value, locale, fallback = DEFAULT_LOCALE) {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object') return String(value[locale] ?? value[fallback] ?? Object.values(value)[0] ?? '')
  return String(value)
}

/**
 * A translator for one locale. `catalogs` is `{ en: {...}, ru: {...} }`; later `add()` calls (plugins) extend it.
 *
 *   const t = createTranslator('ru', CATALOGS)
 *   t('editor.share')                       → 'Поделиться'
 *   t('editor.edited', { count: 3 })        → 'изменил 3 элемента'
 */
export function createTranslator(locale = DEFAULT_LOCALE, catalogs = {}) {
  const current = normalizeLocale(locale)
  const own = { ...(catalogs[current] ?? {}) }
  const fallback = current === DEFAULT_LOCALE ? own : { ...(catalogs[DEFAULT_LOCALE] ?? {}) }

  function t(key, vars) {
    let value = own[key]
    let lang = current
    if (value === undefined) {
      value = fallback[key]
      lang = DEFAULT_LOCALE
    }
    if (value === undefined) return key
    if (isPlural(value)) {
      const form = pluralForm(lang, vars?.count)
      value = value[form] ?? value.other
    }
    return format(value, vars)
  }

  /** Add or override messages, e.g. a plugin's own. Only the translator's locale and the fallback are kept. */
  t.add = (lang, messages) => {
    const target = normalizeLocale(lang)
    if (target === current) Object.assign(own, messages)
    if (target === DEFAULT_LOCALE && fallback !== own) Object.assign(fallback, messages)
  }
  t.has = (key) => own[key] !== undefined || fallback[key] !== undefined
  t.locale = current
  return t
}
