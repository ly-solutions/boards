/**
 * The harnessly app view: boards as an app inside a harnessly page.
 *
 * `/b/app` is the app home: a "what shall we draw" field (it goes to the agent in the conversation next to it) and
 * the library "All · Mine · Shared" with shelves by tag and a search. An open board is the same editor with `?app=1`:
 * the canvas only, without our own chrome (menu, brand, sign-in) — harnessly draws the chrome.
 *
 * Off by default: `BOARDS_APP_VIEW=on`. Who may frame the view is BOARDS_FRAME_ANCESTORS — list the harnessly hub and
 * machine origins there. Board links with a key (`?k=`) keep working as before.
 */

const escape = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

/** Headers of the view page: our own scripts and styles only; framing as for the editor. */
export function appViewHeaders({ frameAncestors = "'self'" } = {}) {
  return {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self'",
      "img-src 'self' data:",
      "connect-src 'self'",
      // The open board's canvas is our own editor in a frame inside the view.
      "frame-src 'self'",
      `frame-ancestors ${frameAncestors}`,
      "base-uri 'none'",
      "form-action 'none'",
      "object-src 'none'",
    ].join('; '),
    'x-robots-tag': 'noindex, nofollow, noarchive',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-store',
  }
}

/**
 * The view page. The harnessly bridge goes first (`bridge-shim.js` reads a one-time nonce from the URL fragment), then
 * the SDK and the view itself. Styles use the `--t-*` tokens harnessly sets on `:root` for its theme.
 */
export function renderAppView({ staticBase, locale = 'en', title = 'Boards' }) {
  const s = escape(staticBase)
  return `<!doctype html>
<html lang="${escape(locale)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<script src="${s}/hl/bridge-shim.js"></script>
<link rel="stylesheet" href="${s}/hl/hl-ui.css">
<link rel="stylesheet" href="${s}/app/app.css">
</head>
<body class="hl-body">
<div id="app" class="ba" aria-busy="true"></div>
<script src="${s}/hl/app-sdk.classic.js"></script>
<script src="${s}/app/app.js"></script>
</body>
</html>
`
}

/** A board in the library list: what the home needs and nothing more. */
export function libraryRow(meta, { publicUrl, prefix, me }) {
  const key = encodeURIComponent(meta.key ?? '')
  const author = meta.author ?? null
  const mine = Boolean(me && author && (author === me.name || author === me.email))
  return {
    slug: meta.slug,
    title: meta.title ?? meta.slug,
    description: meta.description ?? '',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    updatedAt: meta.updatedAt ?? null,
    author,
    mine,
    url: `${publicUrl}${prefix}/${meta.slug}?k=${key}`,
    preview: meta.hasPreview ? `${prefix}/${meta.slug}/preview.svg?k=${key}` : null,
  }
}
