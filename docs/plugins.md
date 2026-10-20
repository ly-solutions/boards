# Plugins

Plugins add features to a stock boards image without forking it: rich cards for your issue tracker or docs, actions
on selected blocks ("create an issue from this"), extra board properties (a deadline), webhooks, feature flags,
interface messages. A deployment runs the published image unchanged and mounts its plugin package next to it:

```sh
BOARDS_PLUGINS=/plugins/acme/index.mjs   # server plugins, comma-separated
BOARDS_WEB_PLUGINS=                      # extra editor modules (server plugins can ship their own with `web`)
```

A complete, tested example lives in [`examples/plugin-example/`](../examples/plugin-example/): GitHub issue cards,
a "turn sticky notes into a checklist" action, a deadline property, a signed webhook, a board route, a per-person
flag and a toolbar button. Run it with:

```sh
npm run build
BOARDS_PLUGINS=./examples/plugin-example/index.mjs npm run dev
```

Types for both halves of the API are in [`types/plugin.d.ts`](../types/plugin.d.ts).

## Versioning

The plugin API has its own [semantic version](https://semver.org), `PLUGIN_API_VERSION` (currently **1.0.0**;
`GET /b/api/plugins` reports it):

- **minor** releases only add (a new registration method, a new field in a context object);
- a **major** release may change or remove anything a plugin could notice.

A plugin states the range it was written for in `apiVersion` (`"^1.0.0"`). The server refuses to start with a plugin
whose range it does not satisfy, and names the plugin and both versions; a web module with an incompatible
`apiVersion` is skipped with a console warning. Everything a plugin registers is validated when it registers, so a
mistake stops the start-up instead of failing on the first click.

Plugins are trusted code that runs inside the server and the editor page. Install only what you would install as a
dependency.

## Server plugins

A server plugin is an ES module (a path, a `file:` URL or a package name) exporting:

```js
/** @type {import('boards/types/plugin').ServerPlugin} */
export default {
  name: 'acme',              // lowercase, digits, dashes; appears in URLs
  version: '1.4.0',
  apiVersion: '^1.0.0',
  web: './web/index.mjs',    // optional editor module, in a folder of its own
  async register(api) {
    // …register what you need, see below
  },
}
```

`register` may be async; the server listens only after every plugin has registered. Named exports
(`export const name`, `export function register`) work too.

### What `api` offers

| Member | |
| --- | --- |
| `apiVersion`, `plugin`, `locale`, `config` | API version; this plugin's name and version; interface language; `{ publicUrl, locale, features }` |
| `env` | the server's environment, read-only: give your plugin its own variables (`ACME_TOKEN`) |
| `log(event)` | structured log line tagged with the plugin name |
| `t(key, vars)`, `addMessages(locale, messages)` | translator and your own messages (see [Interface language](#interface-language)) |
| `HttpError`, `reply(status, body, headers)` | errors and explicit responses for routes |
| `addRoute`, `addCardResolver`, `addBlockAction`, `addMetaField`, `addWebhook`, `on`, `addFlags` | below |
| `cards.invalidate(ref \| predicate)` | drop cached cards, e.g. after a webhook |
| `boards.list()`, `boards.get(slug)`, `boards.edit(slug, edit, { author })` | read boards and edit them (same format as `POST /b/<slug>/edit`) |
| `hmacVerifier({ secret, header, prefix })` | signature check for webhooks |

### Routes

```js
api.addRoute({ method: 'POST', path: '/tasks/:id', scope: 'board', access: 'editor', async handler(ctx) {
  const body = await ctx.json()
  return { id: ctx.params.id, board: ctx.board.slug, by: ctx.who.name }
} })
```

| `scope` | URL | `access` |
| --- | --- | --- |
| `board` (default) | `/b/<slug>/plugins/<name><path>` | `viewer` (default: the board key, `?k=` or `X-Board-Key`), `editor` (may edit the board), `member` (token or signed-in) |
| `global` | `/b/plugins/<name><path>` | `member` (default), `token` (agents only), `public` |

The handler gets `ctx` with `params`, `query`, `headers`, `who` (`{ kind, name, email }`), `user`, `agent`, `board`
(slug, title, url, meta with `fields`, `text()`, `elements()`), `json()`, `text()`, `rawBody()`, `flags()`, `t`.
Return a JSON-able value (200), `api.reply(status, body, headers)`, or nothing (204). Throw `new api.HttpError(409,
'reason')` for a client error; any other exception becomes a 500 and is logged with the plugin's name. Cookie-carrying
cross-site `POST`s are refused before your handler runs, as everywhere else.

### Card resolvers

A pasted URL becomes a card on the board. Without plugins a link to another board shows its title and anything
else is a bookmark. A card resolver turns more of them into rich cards — title, subtitle, status, icon, link:

```js
api.addCardResolver({
  id: 'tracker',
  match: (url) => /^https:\/\/tracker\.example\.com\/issue\/\d+$/.test(url),  // claim URLs …
  pattern: /[A-Z]{2,10}-\d+/,                                                  // … and/or typed references
  async resolve(input, { signal, kind }) {
    const issue = await fetchIssue(input, { signal })
    if (!issue) return null
    return { kind: 'tracker.issue', title: `${issue.key} ${issue.summary}`, site: issue.project,
             status: { label: issue.state, tone: issue.done ? 'success' : 'info' }, url: issue.link }
  },
  ttlMs: 5 * 60_000, missTtlMs: 30_000, timeoutMs: 3000,   // defaults
})
```

- URLs go to resolvers in registration order; the first whose `match` returns a truthy value resolves it. Nobody
  claims it → it stays a bookmark (or gets a [link preview](#link-previews), if enabled).
- With `pattern`, text pasted on the board that matches the **whole** pattern becomes a card too. It is stored as
  `customData: { kind: 'card', ref: 'ref:<id>:<text>' }`, so agents and exports still see the text.
- Answers are cached (hits and misses separately), concurrent lookups share one call, and a lookup that exceeds
  `timeoutMs` is aborted (`signal`) — the card simply stays a link a little longer. A failure keeps the last good
  card instead of flipping it back to a link.
- The server only answers about refs the board actually contains, so a board key never becomes a directory of
  your tracker.
- What `resolve` returns is normalised: unknown fields dropped, `url` must be http(s), `image` https, `icon` an
  https URL, a `data:image/…` URI or a short emoji, `status.tone` one of `neutral`, `info`, `success`, `warning`,
  `danger`.

The editor draws cards generically (icon, site, status pill, title, subtitle). A web plugin can draw a kind its own
way with `registerCardRenderer` (below).

### Block actions

An item in the right-click menu for selected blocks, run on the server:

```js
api.addBlockAction({
  id: 'create-issue',
  label: { en: 'Create an issue', ru: 'Создать задачу' },     // or a message key, or a plain string
  icon: '<svg viewBox="0 0 24 24">…</svg>',                   // optional inline SVG, no scripts
  when: { min: 1, max: 1, types: ['rectangle'], kinds: null },  // which selections it applies to
  confirm: null,                                               // optional question before running
  async run({ selection, board, who, t, input }) {
    const issue = await createIssue({ title: selection[0].text, board: board.url, reporter: who.email })
    return {
      edit: { update: [{ id: selection[0].id, link: issue.url }] },  // applied as one revision, signed by `who`
      toast: t('acme.created', { key: issue.key }),
      open: issue.url,                                               // opened in a new tab (optional)
    }
  },
})
```

`selection` lists the selected blocks — a label counts as its shape — with `id`, `type`, geometry, `text`, `link`
and `customData` (`customData.kind` is `sticky` for sticky notes, `card` for link cards). The endpoint is
`POST /b/<slug>/actions/<plugin>/<id>` with `{ ids: [...] }`; it requires the right to edit the board and checks
`when` again on the server.

### Board properties (meta fields)

```js
api.addMetaField({ id: 'deadline', label: { en: 'Deadline', ru: 'Дедлайн' }, type: 'date', home: true })
```

Types: `text` (`maxLength`, default 200), `date` (`YYYY-MM-DD`), `url` (http/https), `number`, `select`
(`options: [{ value, label }]`). `validate(value)` may normalise or throw an `Error` whose message the person sees.
Fields are edited in **Board properties**, sent with `POST /b/<slug>/meta` as `{ fields: { deadline: '2026-11-30' } }`
(`null` removes one), stored in `meta.yaml` under `fields:`, returned in board JSON and the boards list API, and —
with `home: true` — shown on the boards list (past dates are marked overdue). Built-in property names are reserved.

### Webhooks (incoming)

```js
api.addWebhook({
  path: '/github',
  verify: api.hmacVerifier({ secret: api.env.ACME_WEBHOOK_SECRET, header: 'x-hub-signature-256', prefix: 'sha256=' }),
  async handler(ctx) {
    const event = await ctx.json()
    api.cards.invalidate((ref) => ref.includes(event.issue.html_url))
    return { ok: true }
  },
})
```

Served at `POST /b/hooks/<name><path>`. Authenticate with a shared `secret` (compared with the `header`, default
`x-boards-webhook-secret`) or a `verify(ctx)` function that receives the raw body; registering a webhook with neither
fails unless you pass `public: true` deliberately.

### Events

```js
api.on('thread.created', (event) => notify(event))
```

| Event | Payload |
| --- | --- |
| `board.created` | `{ slug, title, author, url }` |
| `board.changed` | `{ slug }` — once edits settle (2 s after the last one) |
| `board.meta` | `{ slug, title, access, description, tags, task, fields }` |
| `board.checkpoints` | `{ slug, checkpoints }` |
| `thread.created`, `thread.replied`, `thread.resolved`, `thread.reopened`, `thread.removed` | the comment webhook payload ([format](integrations/harnessly.md#comment-webhook)) |

Listeners run in the background: they never delay or fail the request that caused the event; errors are logged.

### Feature flags

Flags decide per person what they get. The static provider reads `BOARDS_FLAGS` (`beta-cards,layout=compact`); a
plugin adds its own provider — a flag service, a group lookup:

```js
api.addFlags({ id: 'groups', async flags(user) {   // user: { kind, name, email }
  return { 'acme-beta': await isInBetaGroup(user.email) }
} })
```

Providers are merged in order (later ones win, flag by flag); a provider that throws or takes longer than 1.5 s is
skipped. A flag named after an editor feature — `live`, `studio`, `workboard`, `snap`, `motion` — set to `false`
turns that feature off for the person; flags never turn on a feature the operator disabled with
`BOARDS_DISABLE_FEATURES`. The editor receives the flags of the person who opened it (`api.flags` in web plugins);
routes and actions can ask with `ctx.flags()`.

## Web plugins

An ES module the editor imports after it starts. It comes from a server plugin's `web` (served from that folder
under `/b/_plugins/<name>/`), from a local file in `BOARDS_WEB_PLUGINS` (served the same way), or from an `https://`
URL in `BOARDS_WEB_PLUGINS` (its origin is added to the editor's `script-src`).

```js
export const apiVersion = '^1.0.0'

/** @param {import('boards/types/plugin').WebPluginApi} api */
export function register(api) {
  api.registerCardRenderer('tracker.issue', (el, card) => {
    el.innerHTML = ''
    const title = document.createElement('strong')
    title.textContent = card.title
    el.append(title)
    return () => {}                              // optional cleanup
  })

  api.registerBlockAction({ id: 'count', label: 'Count words', when: { min: 1 }, run: ({ selection, api }) => {
    api.editor.toast(`${selection.map((el) => el.text ?? '').join(' ').split(/\s+/).filter(Boolean).length} words`)
  } })

  if (api.isEnabled('acme-beta')) {
    api.registerToolbarButton({ id: 'acme-sync', label: { en: 'Sync', ru: 'Синхронизировать' }, icon: '<svg …>', async onClick({ api }) {
      await api.fetch(api.pluginUrl('acme', '/sync'), { method: 'POST' })
    } })
  }

  api.registerMetaField({ id: 'deadline', format: (value) => new Date(value).toLocaleDateString(api.locale) })
}
```

| Member | |
| --- | --- |
| `registerCardRenderer(kind, render)` | `render(el, card, ctx)` fills a DOM node covering the card and may return a cleanup; re-run when the card data changes. Plain DOM on purpose: your bundle never has to share the editor's React. Reuse the `link-card__*` classes to look native. |
| `registerBlockAction({ id, label, icon, when, run })` | a client-side menu item; `run({ selection, api })` |
| `registerToolbarButton({ id, label, icon, onClick })` | a button in the top-right bar |
| `registerMetaField({ id, label, placeholder, format })` | how a server-declared property is labelled and shown in Board properties |
| `flags`, `isEnabled(name)` | the person's flags |
| `board` | `{ slug, title, url, canEdit, user, fields }` — `title` and `fields` stay current |
| `editor` | `getSceneElements()`, `getSelectedElements()`, `addElements(skeletons)`, `updateElements(patches)`, `select(ids)`, `scrollTo(ids)`, `toast(message)` |
| `fetch(url, init)`, `pluginUrl(plugin, path, scope)` | call your routes; the board key (and guest name) are attached |
| `t`, `addMessages`, `locale` | interface language |

A module that throws while loading or registering is reported in the console and skipped; the editor keeps working.

## Interface language

`BOARDS_LOCALE` is `en` (default) or `ru`. Plugin labels can be a plain string, `{ en, ru }`, or a message key added
with `addMessages(locale, { 'acme.key': '…' })` — prefix keys with your plugin name. Messages support `{name}`
placeholders and plural forms (`{ one, few, many, other }`, chosen by `Intl.PluralRules`); a key missing in the
current language falls back to English. Built-in catalogs live in `shared/locales/<locale>/`; to add a language,
copy `en/`, translate, and register it in `shared/locales/index.mjs` and `LOCALES` — `tests/i18n.test.mjs` checks
that no key, placeholder or plural form is missing.

## Link previews

`BOARDS_LINK_PREVIEW=on` turns bookmarks into cards with the page's Open Graph title, description and site name. It
is off by default because the server then fetches the URLs people paste. Fetches go through an SSRF guard
([`server/ssrf.mjs`](../server/ssrf.mjs)): only http(s) on ports 80/443, the host is resolved first and refused if
*any* address is private, loopback, link-local, CGNAT, multicast or reserved (IPv4, IPv6 and IPv4-in-IPv6), the
connection goes to exactly the checked address (no DNS rebinding), every redirect is checked again, and time and size
are capped. Plugin resolvers come first; the preview only sees URLs no plugin claimed.

## Packaging for a deployment

Keep your plugins in a repository of their own and add them to the stock image, for example:

```dockerfile
FROM ghcr.io/ly-solutions/boards:<version>
COPY --chown=node:node plugins/ /plugins/
ENV BOARDS_PLUGINS=/plugins/acme/index.mjs
```

or mount them with an init container and set the same variable. Upgrading boards is then a tag change; the plugin's
`apiVersion` tells you at start-up if a major API change needs your attention.
