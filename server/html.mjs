/**
 * Server-rendered pages: the board page (editor shell), the boards list, sign-in and "not found".
 *
 * The board page starts with the board as plain text. That is for one scenario: someone pastes a board link to
 * an agent, the agent fetches it like any web page — and gets the meaning of the board immediately, without
 * scripts, screenshots or instructions on where to look. Browsers never show that block: the editor covers it
 * as soon as it loads.
 */
import { readFileSync } from 'node:fs'
import { translator } from '../shared/locales/index.mjs'

export const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])

/** JSON inside `<script>` must not be able to close the tag. */
const safeJson = (value) => JSON.stringify(value).replace(/</g, '\\u003c')

/** A message as a single-quoted JavaScript string inside an inline `<script>`: it can neither end the string nor the tag. */
const jsString = (value) => `'${String(value).replace(/[\\'\n\r\u2028\u2029<]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)}'`

/** English unless a translator is passed: BOARDS_LOCALE is wired in server/index.mjs. */
const EN = translator('en')

let manifestCache = null
/**
 * Built files come from the Vite manifest (their names carry content hashes). Two pages are built: the editor and
 * the read-only embed view. Both start with `boot.ts`, which sets the static base for Excalidraw's fonts before
 * the package loads — module scripts run in document order, so it is listed first.
 */
export function webAssets(manifestPath) {
  if (manifestCache) return manifestCache
  const none = { scripts: [], styles: [], modules: [], fonts: [] }
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    const boot = manifest['web/src/boot.ts']
    // Stylesheets of an entry include those of the chunks it imports: with two entries, Vite moves shared CSS
    // (Excalidraw's own) into the shared chunk.
    const cssOf = (manifest, key, seen = new Set()) => {
      if (seen.has(key) || !manifest[key]) return []
      seen.add(key)
      return [...new Set([...(manifest[key].imports ?? []).flatMap((name) => cssOf(manifest, name, seen)), ...(manifest[key].css ?? [])])]
    }
    const page = (key) => {
      const entry = manifest[key]
      if (!entry || !boot) return none
      return {
        scripts: [boot.file, entry.file],
        styles: cssOf(manifest, key),
        // Discovered late by the browser otherwise: shared chunks only after the entry has run, UI fonts after the
        // first paint. Preloading turns sequential waits into one.
        modules: (entry.imports ?? []).map((name) => manifest[name]?.file).filter(Boolean),
        fonts: (entry.assets ?? []).filter((file) => /\/Assistant-(Regular|Medium|Bold)-[^/]+\.woff2$/.test(file)),
      }
    }
    manifestCache = { editor: page('web/src/main.tsx'), embed: page('web/src/embed-view.tsx') }
  } catch {
    manifestCache = { editor: none, embed: none }
  }
  return manifestCache
}

const BASE_STYLE = `
  :root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1b1f; --muted: #6b6b76; --line: #e4e4ea; --card: #ffffff; --accent: #6965db; --accent-fg: #ffffff; --lime: #5E7D00; }
  @media (prefers-color-scheme: dark) { :root { --bg: #121214; --fg: #ececf1; --muted: #9a9aa6; --line: #2a2a31; --card: #1a1a1f; --accent: #a8a5ff; --accent-fg: #121214; --lime: #D4FF3A; } }
  html, body { margin: 0; background: var(--bg); color: var(--fg); }
  body { font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  a { color: var(--accent); }
  .brand { display: inline-flex; align-items: center; gap: .55rem; color: var(--fg); text-decoration: none; font: 700 1.2rem/1 system-ui, sans-serif; letter-spacing: -.01em; }
  .brand img { width: 28px; height: 28px; }
  .brand b { color: var(--lime); }
`

const brand = (staticBase, href = '/b/') => `<a class="brand" href="${escape(href)}"><img src="${staticBase}/logo-mark.svg" alt=""><span>boards<b>.</b></span></a>`

export function renderBoardPage({ state, text, config, assets, staticBase, t = EN }) {
  const title = state.meta.title ?? t('pages.untitledBoard')
  const styles = assets.styles.map((file) => `<link rel="stylesheet" href="${staticBase}/${file}">`).join('\n')
  // The browser starts fetching the scene with the first bytes of the page instead of when the editor asks for it.
  // The URL must be exactly the one web/src/boot.ts requests, or it becomes a second download.
  const scenePath = config.at?.id ? `checkpoints/${config.at.id}/scene` : 'scene.excalidraw'
  const early = [
    `<link rel="preload" as="fetch" crossorigin href="${escape(`/b/${state.slug}/${scenePath}?k=${encodeURIComponent(state.meta.key)}`)}">`,
    ...(assets.modules ?? []).map((file) => `<link rel="modulepreload" href="${staticBase}/${file}">`),
    ...(assets.fonts ?? []).map((file) => `<link rel="preload" as="font" type="font/woff2" crossorigin href="${staticBase}/${file}">`),
  ].join('\n')
  const script = assets.scripts.length
    ? assets.scripts.map((file) => `<script type="module" src="${staticBase}/${file}"></script>`).join('\n')
    : `<p class="fallback">${t('pages.editorNotBuilt')}</p>`
  const markdownUrl = `/b/${state.slug}.md?k=${encodeURIComponent(state.meta.key)}`

  return `<!doctype html>
<html lang="${t.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escape(title)} · boards</title>
<link rel="icon" href="${staticBase}/favicon.svg" type="image/svg+xml">
<link rel="alternate" type="text/markdown" href="${escape(markdownUrl)}" title="${escape(t('pages.boardAsTextTitle'))}">
<link rel="alternate" type="application/json+oembed" href="${escape(`/b/api/oembed?url=${encodeURIComponent(config.boardUrl ?? '')}`)}" title="${escape(title)}">
${early}
${styles}
<style>
${BASE_STYLE}
  html, body { height: 100%; overscroll-behavior: none; }
  #root { position: fixed; inset: 0; }
  #agent-view { max-width: 52rem; margin: 2rem auto; padding: 0 1rem; }
  #agent-view pre { white-space: pre-wrap; font: inherit; opacity: .8; }
  #agent-view .brand { margin-bottom: 1.25rem; }
  .loading { font-size: 1.1rem; margin: 0 0 1rem; }
  body.ready #agent-view { display: none; }
</style>
</head>
<body>
<main id="agent-view" aria-label="${escape(t('pages.boardAsTextLabel'))}">
${brand(staticBase, config.homeUrl)}
<p class="loading">${t('pages.loadingBoard', { title: escape(title) })}</p>
<pre>${t('pages.agentIntro', { scene: escape(`/b/${state.slug}/scene.excalidraw?k=…`), markdown: escape(markdownUrl) })}

${escape(text)}</pre>
</main>
<div id="root"></div>
<script type="application/json" id="board-config">${safeJson(config)}</script>
${script}
</body>
</html>
`
}

/** The Content-Security-Policy shared by the editor and the embed view. */
function boardCsp({ publicUrl, frameAncestors, scriptOrigins = [] }) {
  // The live channel is a WebSocket to our host; 'self' covers ws(s) only in recent browsers, so it is named.
  const socket = publicUrl.replace(/^http/, 'ws')
  const directives = [
    "default-src 'self'",
    // WASM: font subsetting when exporting SVG. Extra origins: web plugins loaded from https URLs (BOARDS_WEB_PLUGINS).
    `script-src 'self' 'wasm-unsafe-eval'${scriptOrigins.map((o) => ` ${o}`).join('')}`,
    "style-src 'self' 'unsafe-inline'", // Excalidraw styles its UI inline
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    `connect-src 'self' ${socket}`,
    "worker-src 'self' blob:",
    'frame-src https:', // videos and design files embedded on a board
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ]
  if (frameAncestors) directives.push(`frame-ancestors ${frameAncestors}`)
  return directives.join('; ')
}

const boardPageHeaders = (csp) => ({
  'content-type': 'text/html; charset=utf-8',
  'content-security-policy': csp,
  'x-robots-tag': 'noindex, nofollow, noarchive',
  // The access key is part of the URL: never send it on in a Referer.
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cache-control': 'no-store',
})

/** The editor may be framed only by the origins in BOARDS_FRAME_ANCESTORS. */
export function editorHeaders({ publicUrl = 'http://localhost:8080', frameAncestors = "'self'", scriptOrigins = [] } = {}) {
  return boardPageHeaders(boardCsp({ publicUrl, frameAncestors, scriptOrigins }))
}

/**
 * The embed view is read-only and may be framed by any page, including documents in a sandbox without
 * `allow-same-origin`. Such a parent has an opaque origin, which no `frame-ancestors` source expression matches —
 * not even `*` — so the directive is left out entirely. Framing grants nothing: the key in the URL only reads.
 */
export function embedHeaders({ publicUrl = 'http://localhost:8080' } = {}) {
  return boardPageHeaders(boardCsp({ publicUrl, frameAncestors: null }))
}

/**
 * The read-only embed view. Everything it needs is in the page: in an opaque-origin sandbox it can neither use
 * cookies nor call our API, so the scene is inlined. Asset URLs are absolute for the same reason.
 */
export function renderEmbedPage({ state, text, scene, boardUrl, assets, staticUrl, t = EN }) {
  const title = state.meta.title ?? t('pages.untitledBoard')
  const scripts = assets.scripts.map((file) => `<script type="module" crossorigin src="${staticUrl}/${file}"></script>`).join('\n')
  const styles = [
    ...assets.styles.map((file) => `<link rel="stylesheet" crossorigin href="${staticUrl}/${file}">`),
    ...(assets.modules ?? []).map((file) => `<link rel="modulepreload" crossorigin href="${staticUrl}/${file}">`),
  ].join('\n')
  return `<!doctype html>
<html lang="${t.locale}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<meta name="referrer" content="no-referrer">
<title>${escape(title)} · boards</title>
${styles}
<style>
  html, body { margin: 0; height: 100%; overflow: hidden; background: #fff; color: #1b1b1f; font: 14px/1.5 system-ui, sans-serif; }
  @media (prefers-color-scheme: dark) { html, body { background: #121214; color: #ececf1; } }
  #embed-root { position: fixed; inset: 0; }
  #embed-text { padding: 1rem; white-space: pre-wrap; opacity: .8; }
  body.ready #embed-text { display: none; }
</style>
</head>
<body>
<pre id="embed-text">${escape(text)}</pre>
<div id="embed-root"></div>
<script type="application/json" id="embed-data">${safeJson({ title, boardUrl, scene })}</script>
${scripts || `<p>${t('pages.viewerNotBuilt')}</p>`}
</body>
</html>
`
}

/** Headers for the list, sign-in and error pages. */
export function pageHeaders({ frameAncestors = "'self'" } = {}) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors ${frameAncestors}; base-uri 'none'; object-src 'none'`,
    'x-robots-tag': 'noindex, nofollow',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  }
}

/** "No such board" for people: the same 404 as a wrong key, but readable. */
export function renderNotFound(staticBase, homeUrl = '/b/', t = EN) {
  return `<!doctype html>
<html lang="${t.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${t('pages.notFoundTitle')} · boards</title>
<link rel="icon" href="${staticBase}/favicon.svg" type="image/svg+xml">
<style>${BASE_STYLE}
  body { min-height: 100vh; display: grid; place-items: center; }
  main { max-width: 30rem; padding: 1rem; }
  .brand { margin-bottom: 1.5rem; }
</style></head>
<body><main>
${brand(staticBase, homeUrl)}
<h1>${t('pages.notFoundHeading')}</h1>
<p>${t('pages.notFoundBody', { link: `<a href="${escape(homeUrl)}">${t('pages.allBoards')}</a>` })}</p>
</main></body></html>
`
}

/** Token-mode sign-in: paste an API token once, get a session. */
export function renderTokenLogin({ staticBase, next, error = null, t = EN }) {
  return `<!doctype html>
<html lang="${t.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${t('pages.signInTitle')} · boards</title>
<link rel="icon" href="${staticBase}/favicon.svg" type="image/svg+xml">
<style>${BASE_STYLE}
  body { min-height: 100vh; display: grid; place-items: center; }
  main { width: min(26rem, calc(100vw - 2rem)); }
  form { display: grid; gap: .8rem; margin-top: 1.5rem; }
  label { display: grid; gap: .3rem; font-weight: 600; font-size: .9rem; }
  input { font: inherit; padding: .6rem .7rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--card); color: var(--fg); }
  button { font: 600 1rem/1 system-ui, sans-serif; padding: .75rem; border: 0; border-radius: .5rem; background: var(--accent); color: var(--accent-fg); cursor: pointer; }
  .error { color: #e03131; margin: 0; }
  .hint { color: var(--muted); font-size: .85rem; }
</style></head>
<body><main>
${brand(staticBase)}
<form method="post" action="/b/auth/login">
  <input type="hidden" name="next" value="${escape(next)}">
  <label>${t('pages.yourName')} <input name="name" autocomplete="name" required maxlength="60" placeholder="${escape(t('pages.namePlaceholder'))}"></label>
  <label>${t('pages.accessToken')} <input name="token" type="password" autocomplete="current-password" required></label>
  ${error ? `<p class="error">${escape(error)}</p>` : ''}
  <button type="submit">${t('pages.signIn')}</button>
  <p class="hint">${t('pages.signInHint')}</p>
</form>
</main></body></html>
`
}

const relative = (iso, t = EN) => {
  const at = Date.parse(iso ?? '')
  if (!Number.isFinite(at)) return ''
  const minutes = Math.round((Date.now() - at) / 60000)
  if (minutes < 1) return t('pages.justNow')
  if (minutes < 60) return t('pages.minutesAgo', { count: minutes })
  if (minutes < 60 * 24) return t('pages.hoursAgo', { count: Math.round(minutes / 60) })
  return new Date(at).toISOString().slice(0, 10)
}

/**
 * Plugin-defined board properties marked for the list (`home: true`), e.g. a deadline. Dates read in the interface
 * language; a date in the past is marked overdue.
 */
function homeFields(board, fields, t) {
  const shown = fields.filter((f) => board.fields?.[f.id] !== undefined && board.fields?.[f.id] !== null && board.fields?.[f.id] !== '')
  if (!shown.length) return ''
  const today = new Date().toISOString().slice(0, 10)
  const value = (f) => {
    const raw = board.fields[f.id]
    if (f.type === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(raw))) return new Date(`${raw}T00:00:00Z`).toLocaleDateString(t.locale === 'ru' ? 'ru-RU' : 'en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    if (f.type === 'select') return f.options?.find((o) => String(o.value) === String(raw))?.label ?? String(raw)
    return String(raw)
  }
  return `<span class="fields">${shown.map((f) => `<span class="field${f.type === 'date' && String(board.fields[f.id]) < today ? ' overdue' : ''}" data-field="${escape(f.id)}">${escape(f.label)}: <b>${escape(value(f))}</b></span>`).join('')}</span>`
}

/** The boards list: every board with its thumbnail, plus "New board". */
export function renderHome({ staticBase, boards, templates, user, canSignOut, q = '', t = EN, fields = [] }) {
  const cards = boards
    .map(
      (b) => `<a class="card" href="${escape(`/b/${b.slug}?k=${encodeURIComponent(b.key)}`)}">
  <div class="thumb">${b.hasPreview ? `<img loading="lazy" alt="" src="${escape(`/b/${b.slug}/preview.svg?k=${encodeURIComponent(b.key)}`)}">` : `<span>${t('pages.noPreview')}</span>`}</div>
  <div class="meta"><strong>${escape(b.title)}</strong><span>${escape(relative(b.updatedAt, t))}${b.author ? ` · ${escape(b.author)}` : ''}</span>${(b.tags ?? []).length ? `<span class="tags">${b.tags.map((t) => `<i>${escape(t)}</i>`).join('')}</span>` : ''}${homeFields(b, fields, t)}</div>
</a>`,
    )
    .join('\n')
  return `<!doctype html>
<html lang="${t.locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex"><title>${t('pages.boardsTitle')}</title>
<link rel="icon" href="${staticBase}/favicon.svg" type="image/svg+xml">
<style>${BASE_STYLE}
  header { display: flex; align-items: center; gap: 1rem; padding: 1rem clamp(1rem, 4vw, 2.5rem); border-bottom: 1px solid var(--line); }
  header .spacer { flex: 1; }
  header .who { color: var(--muted); font-size: .9rem; }
  main { padding: 1.5rem clamp(1rem, 4vw, 2.5rem) 3rem; }
  .bar { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; margin-bottom: 1.5rem; }
  .bar h1 { font-size: 1.4rem; margin: 0 auto 0 0; letter-spacing: -.01em; }
  input, select, button { font: inherit; padding: .55rem .7rem; border: 1px solid var(--line); border-radius: .5rem; background: var(--card); color: var(--fg); }
  button.primary { background: var(--accent); color: var(--accent-fg); border-color: transparent; font-weight: 600; cursor: pointer; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); gap: 1rem; }
  .card { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: .75rem; overflow: hidden; color: inherit; text-decoration: none; background: var(--card); transition: border-color .15s; }
  .card:hover { border-color: var(--accent); }
  .thumb { height: 10rem; overflow: hidden; display: grid; place-items: center; background: #fafafa; border-bottom: 1px solid var(--line); color: var(--muted); font-size: .85rem; }
  .thumb img { width: 100%; height: 100%; object-fit: contain; display: block; }
  .meta { display: grid; gap: .2rem; padding: .7rem .8rem .8rem; }
  .meta span { color: var(--muted); font-size: .82rem; }
  .tags i { font-style: normal; border: 1px solid var(--line); border-radius: 999px; padding: 0 .45rem; margin-right: .25rem; }
  .fields { display: flex; flex-wrap: wrap; gap: .2rem .7rem; }
  .fields b { font-weight: 600; color: var(--fg); }
  .fields .overdue b { color: #e03131; }
  .empty { color: var(--muted); padding: 3rem 0; text-align: center; }
  @media (prefers-color-scheme: dark) { .thumb { background: #f4f4f6; } }
</style></head>
<body>
<header>${brand(staticBase)}<span class="spacer"></span>${user ? `<span class="who">${escape(user.name)}</span>${canSignOut ? `<a href="/b/auth/logout?next=/b/">${t('pages.signOut')}</a>` : ''}` : ''}</header>
<main>
<div class="bar">
  <h1>${t('pages.boardsTitle')}</h1>
  <form method="get" action="/b/"><input type="search" name="q" value="${escape(q)}" placeholder="${escape(t('pages.searchBoards'))}" aria-label="${escape(t('pages.searchBoards'))}"></form>
  <form id="create">
    <input name="title" required minlength="2" maxlength="120" placeholder="${escape(t('pages.newBoardTitle'))}" aria-label="${escape(t('pages.newBoardTitle'))}">
    <select name="template" aria-label="${escape(t('pages.template'))}"><option value="">${t('pages.blank')}</option>${templates.map((t) => `<option value="${escape(t.id)}">${escape(t.title)}</option>`).join('')}</select>
    <button class="primary" type="submit">${t('pages.newBoard')}</button>
  </form>
</div>
${boards.length ? `<div class="grid">${cards}</div>` : `<p class="empty">${q ? t('pages.noMatches') : t('pages.noBoards')}</p>`}
</main>
<script>
document.getElementById('create').addEventListener('submit', async (event) => {
  event.preventDefault()
  const form = new FormData(event.target)
  const response = await fetch('/b/api/boards', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: form.get('title'), template: form.get('template') || undefined }) })
  const body = await response.json().catch(() => ({}))
  if (response.ok) location.href = body.url
  else alert(body.error || ${jsString(t('pages.createFailed'))})
})
</script>
</body></html>
`
}
