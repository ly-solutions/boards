/**
 * Interface language: the translator and the completeness of the built-in locales.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTranslator, format, isPlural, normalizeLocale, pickLocalized, LOCALES } from '../shared/i18n.mjs'
import { AREAS, CATALOGS, translator } from '../shared/locales/index.mjs'

const placeholders = (value) => {
  const texts = isPlural(value) ? Object.values(value) : [value]
  return [...new Set(texts.flatMap((text) => [...String(text).matchAll(/\{(\w+)\}/g)].map((m) => m[1])))].sort()
}

test('every built-in locale has every key, and no extra ones', () => {
  const en = Object.keys(CATALOGS.en)
  assert.ok(en.length > 100, `the English catalog looks empty (${en.length} keys)`)
  for (const locale of LOCALES) {
    const keys = new Set(Object.keys(CATALOGS[locale] ?? {}))
    const missing = en.filter((key) => !keys.has(key))
    const extra = [...keys].filter((key) => !(key in CATALOGS.en))
    assert.deepEqual(missing, [], `${locale}: missing keys`)
    assert.deepEqual(extra, [], `${locale}: keys that English does not have`)
  }
})

test('every locale registers every area', () => {
  for (const locale of LOCALES) assert.deepEqual(Object.keys(AREAS[locale]).sort(), Object.keys(AREAS.en).sort(), locale)
})

test('translations keep the placeholders and plural forms of the English message', () => {
  const ruForms = new Set(['one', 'few', 'many', 'other'])
  for (const [key, value] of Object.entries(CATALOGS.en)) {
    for (const locale of LOCALES) {
      const translated = CATALOGS[locale][key]
      assert.deepEqual(placeholders(translated), placeholders(value), `${locale} ${key}: placeholders differ`)
      assert.equal(isPlural(translated), isPlural(value), `${locale} ${key}: plural in one locale but not the other`)
      if (isPlural(translated) && locale === 'ru') assert.deepEqual(new Set(Object.keys(translated)), ruForms, `ru ${key}: Russian plurals need one, few, many and other`)
      const texts = isPlural(translated) ? Object.values(translated) : [translated]
      for (const text of texts) {
        assert.equal(typeof text, 'string', `${locale} ${key}: not a string`)
        assert.ok(text.trim().length > 0 || String(value).trim() === '', `${locale} ${key}: empty translation`)
      }
    }
  }
})

test('the Russian catalog is actually Russian', () => {
  const entries = Object.entries(CATALOGS.ru).filter(([, v]) => typeof v === 'string' && /[a-zA-Z]{4,}/.test(v.replace(/\{\w+\}/g, '')))
  const cyrillic = Object.values(CATALOGS.ru).filter((v) => /[а-яё]/i.test(isPlural(v) ? v.other : v)).length
  assert.ok(cyrillic / Object.keys(CATALOGS.ru).length > 0.8, `only ${cyrillic} of ${Object.keys(CATALOGS.ru).length} Russian messages contain Cyrillic; e.g. ${entries.slice(0, 5).map(([k]) => k).join(', ')}`)
})

test('the translator: placeholders, plurals, fallback to English, then to the key', () => {
  const t = createTranslator('ru', {
    en: { 'a.hello': 'Hello, {name}', 'a.items': { one: '{count} item', other: '{count} items' }, 'a.only': 'English only' },
    ru: { 'a.hello': 'Привет, {name}', 'a.items': { one: '{count} элемент', few: '{count} элемента', many: '{count} элементов', other: '{count} элемента' } },
  })
  assert.equal(t('a.hello', { name: 'Ада' }), 'Привет, Ада')
  assert.equal(t('a.items', { count: 1 }), '1 элемент')
  assert.equal(t('a.items', { count: 3 }), '3 элемента')
  assert.equal(t('a.items', { count: 5 }), '5 элементов')
  assert.equal(t('a.items', { count: 21 }), '21 элемент')
  assert.equal(t('a.only'), 'English only')
  assert.equal(t('a.unknown'), 'a.unknown')
  t.add('ru', { 'p.label': 'Плагин' })
  t.add('en', { 'p.other': 'Plugin fallback' })
  assert.equal(t('p.label'), 'Плагин')
  assert.equal(t('p.other'), 'Plugin fallback')
  const en = createTranslator('en', { en: { 'a.items': { one: '{count} item', other: '{count} items' } } })
  assert.equal(en('a.items', { count: 1 }), '1 item')
  assert.equal(en('a.items', { count: 2 }), '2 items')
})

test('locale names and localized plugin labels', () => {
  assert.equal(normalizeLocale('ru-RU'), 'ru')
  assert.equal(normalizeLocale('RU'), 'ru')
  assert.equal(normalizeLocale('de'), 'en')
  assert.equal(normalizeLocale(undefined), 'en')
  assert.equal(pickLocalized({ en: 'Create', ru: 'Создать' }, 'ru'), 'Создать')
  assert.equal(pickLocalized({ en: 'Create' }, 'ru'), 'Create')
  assert.equal(pickLocalized('Plain', 'ru'), 'Plain')
  assert.equal(format('{a} and {b}', { a: 1 }), '1 and {b}')
})

test('the cached translator serves the built-in catalogs', () => {
  assert.equal(translator('ru'), translator('ru-RU'))
  for (const key of Object.keys(CATALOGS.en).slice(0, 20)) assert.notEqual(translator('ru')(key, { count: 2 }), key)
})
