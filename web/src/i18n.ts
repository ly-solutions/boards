/**
 * The editor's translator. The server renders `<html lang="…">` from BOARDS_LOCALE; the whole page — our UI and
 * Excalidraw's own — follows it. Web plugins add their messages through the plugin API (`addMessages`).
 */
import { createTranslator, normalizeLocale, pickLocalized } from '../../shared/i18n.mjs'
import { CATALOGS } from '../../shared/locales/index.mjs'

export const locale: 'en' | 'ru' = normalizeLocale(typeof document !== 'undefined' ? document.documentElement.lang : 'en') as 'en' | 'ru'

type Translate = ((key: string, vars?: Record<string, unknown>) => string) & { add(locale: string, messages: Record<string, unknown>): void; has(key: string): boolean; locale: string }

export const t = createTranslator(locale, CATALOGS) as Translate

/** Excalidraw's language code for our locale. */
export const excalidrawLang = locale === 'ru' ? 'ru-RU' : 'en'

/** A plugin label: a plain string or `{ en, ru }`. */
export const localized = (value: unknown) => pickLocalized(value, locale)

/** Dates in the interface language; English keeps the browser's own date format. */
export const dateLocale: string | undefined = locale === 'ru' ? 'ru-RU' : undefined
