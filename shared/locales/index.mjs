/**
 * Built-in message catalogs, one flat object per locale with keys `<area>.<key>`.
 *
 * Areas follow the code: `editor` (web/src/main.tsx, menu, link cards), `studio` (stickies, palette, templates,
 * properties), `comments`, `checkpoints` (checkpoints and timer), `slop` (the slop check), `pages` (server-rendered
 * pages), `text` (the board as text for agents), `embed` (the read-only embed view), `plugins` (plugin cards and
 * actions). To add a locale, copy shared/locales/en/ to shared/locales/<code>/, translate, register it here and in
 * LOCALES (shared/i18n.mjs); tests/i18n.test.mjs checks that no key is missing.
 */
import { createTranslator, normalizeLocale } from '../i18n.mjs'
import enEditor from './en/editor.mjs'
import enStudio from './en/studio.mjs'
import enComments from './en/comments.mjs'
import enCheckpoints from './en/checkpoints.mjs'
import enSlop from './en/slop.mjs'
import enPages from './en/pages.mjs'
import enText from './en/text.mjs'
import enEmbed from './en/embed.mjs'
import enPlugins from './en/plugins.mjs'
import ruEditor from './ru/editor.mjs'
import ruStudio from './ru/studio.mjs'
import ruComments from './ru/comments.mjs'
import ruCheckpoints from './ru/checkpoints.mjs'
import ruSlop from './ru/slop.mjs'
import ruPages from './ru/pages.mjs'
import ruText from './ru/text.mjs'
import ruEmbed from './ru/embed.mjs'
import ruPlugins from './ru/plugins.mjs'

/** Area name → messages, per locale. Exported for the completeness test. */
export const AREAS = {
  en: { editor: enEditor, studio: enStudio, comments: enComments, checkpoints: enCheckpoints, slop: enSlop, pages: enPages, text: enText, embed: enEmbed, plugins: enPlugins },
  ru: { editor: ruEditor, studio: ruStudio, comments: ruComments, checkpoints: ruCheckpoints, slop: ruSlop, pages: ruPages, text: ruText, embed: ruEmbed, plugins: ruPlugins },
}

const join = (areas) => Object.fromEntries(Object.entries(areas).flatMap(([area, messages]) => Object.entries(messages).map(([key, value]) => [`${area}.${key}`, value])))

export const CATALOGS = Object.fromEntries(Object.entries(AREAS).map(([locale, areas]) => [locale, join(areas)]))

const translators = new Map()
/** A cached translator over the built-in catalogs: `translator('ru')('text.comments')`. Plugin messages are added per app. */
export function translator(locale) {
  const code = normalizeLocale(locale)
  if (!translators.has(code)) translators.set(code, createTranslator(code, CATALOGS))
  return translators.get(code)
}
