// The boards app view in harnessly (server/app-view.mjs), built as a site: it reads its own library from this service
// (`/b/api/app/library`, by the person's session cookie) and opens a board in the same frame, with a way back. Nothing
// of that waits for harnessly. The harnessly bridge is used for three things only, when it is there: the theme, the
// object harnessly asks to open (`hl.context.data.object`), and the first sign-in — the app's MCP tool `board_signin`
// answers a one-time pass the page trades for the session cookie, so the next opening needs no bridge at all.
;(function () {
  'use strict'

  var root = document.getElementById('app')
  var TEXT = {
    en: {
      all: 'All', mine: 'Mine', shared: 'Shared', mineMark: 'mine', recent: 'Recent',
      down: 'The boards service is not answering right now', downHint: 'Boards and links to them are safe — try again later.',
      search: 'Search boards', nothing: 'Nothing found.', empty: 'No boards yet — ask the agent in the conversation to draw the first one.',
      back: 'All boards', newTab: 'Open in a new tab', gone: 'There is no such board, or it is not yours to open.',
      signIn: 'Sign in to see the boards', signInGo: 'Sign in', retry: 'Try again',
    },
    ru: {
      all: 'Все', mine: 'Мои', shared: 'Общие', mineMark: 'моя', recent: 'Недавние',
      down: 'Сервис досок сейчас не отвечает', downHint: 'Доски и ссылки на них на месте — попробуйте позже.',
      search: 'Поиск по доскам', nothing: 'Ничего не нашлось.', empty: 'Досок пока нет — попросите агента в чате нарисовать первую.',
      back: 'Все доски', newTab: 'Открыть в новой вкладке', gone: 'Такой доски нет, или она вам недоступна.',
      signIn: 'Войдите, чтобы увидеть доски', signInGo: 'Войти', retry: 'Повторить',
    },
  }
  var LANG = document.documentElement.lang === 'ru' ? 'ru' : 'en'
  var T = TEXT[LANG]
  var TABS = [
    { id: 'all', label: T.all },
    { id: 'mine', label: T.mine },
    { id: 'shared', label: T.shared },
  ]
  var SHELVES = 6
  var PER_SHELF = 8
  var BASE = location.pathname.replace(/\/app\/?$/, '')
  var BRIDGE_WAIT_MS = 6000

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }

  function textOf(res) {
    return ((res && res.content) || [])
      .map(function (c) {
        return c.text || ''
      })
      .join('\n')
  }

  function when(iso) {
    if (!iso) return ''
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleDateString(LANG === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short' })
  }

  // ---- The theme: harnessly's when the bridge is there, the system's until then ----

  var theme = { mode: window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light' }
  if (!document.documentElement.dataset.theme) document.documentElement.dataset.theme = theme.mode

  // ---- The bridge: optional, asked once, never awaited by the library ----

  var bridge = null
  function connect() {
    if (bridge) return bridge
    bridge = new Promise(function (resolve, reject) {
      var timer = setTimeout(function () {
        reject(new Error('no bridge'))
      }, BRIDGE_WAIT_MS)
      if (!window.harnessly || !window.harnessly.connect) return reject(new Error('no bridge'))
      window.harnessly.connect({ protocol: 2 }).then(function (hl) {
        clearTimeout(timer)
        resolve(hl)
      }, reject)
    })
    return bridge
  }

  // ---- Data: our own API, by the session cookie ----

  function fetchLibrary() {
    return fetch(BASE + '/api/app/library', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (res) {
      if (res.status === 401) return null
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json().then(function (body) {
        return body.boards || []
      })
    })
  }

  /** The first sign-in: harnessly's machine calls the app's MCP tool with the person's token; the answer sets our cookie. */
  function signIn() {
    return connect()
      .then(function (hl) {
        return hl.tools.call('boards.board_signin', {}).then(function (res) {
          if (hl.refused(res) || !res || res.isError) throw new Error(textOf(res) || 'refused')
          return JSON.parse(textOf(res)).pass
        })
      })
      .then(function (pass) {
        if (typeof pass !== 'string' || !pass) throw new Error('no sign-in pass')
        return fetch(BASE + '/api/app/enter', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ t: pass }) })
      })
      .then(function (res) {
        if (!res.ok) throw new Error('sign-in refused')
      })
  }

  var rowsReady = null
  /** The library, signing in once when the service does not know the person yet. null: the person has to sign in. */
  function library(again) {
    if (rowsReady && !again) return rowsReady
    rowsReady = fetchLibrary().then(function (rows) {
      if (rows) return rows
      return signIn().then(fetchLibrary, function () {
        return null
      })
    })
    return rowsReady
  }

  function failed(text, retry) {
    root.className = 'ba'
    root.textContent = ''
    root.removeAttribute('aria-busy')
    var box = el('div', 'ba__fail hl-empty')
    box.appendChild(el('p', 'hl-h', T.down))
    box.appendChild(el('p', 'hl-muted', text || T.downHint))
    if (retry) {
      var again = el('button', 'hl-btn', T.retry)
      again.type = 'button'
      again.addEventListener('click', retry)
      box.appendChild(again)
    }
    root.appendChild(box)
  }

  function needSignIn() {
    root.className = 'ba'
    root.textContent = ''
    root.removeAttribute('aria-busy')
    var box = el('div', 'ba__fail hl-empty')
    box.appendChild(el('p', 'hl-h', T.signIn))
    var go = el('a', 'hl-btn hl-btn--primary', T.signInGo)
    go.href = BASE + '/auth/login?next=' + encodeURIComponent(BASE + '/app')
    go.target = '_blank'
    go.rel = 'noopener'
    box.appendChild(go)
    var again = el('button', 'hl-btn hl-btn--ghost', T.retry)
    again.type = 'button'
    again.addEventListener('click', function () {
      route(true)
    })
    box.appendChild(again)
    root.appendChild(box)
  }

  // ---- Where we are: `?board=<slug>` is an open board, nothing is the library ----

  function current() {
    var slug = new URLSearchParams(location.search).get('board')
    return slug && /^[a-z0-9-]+$/.test(slug) ? slug : null
  }

  function go(slug) {
    if (current() === slug) return
    history.pushState(null, '', slug ? '?board=' + encodeURIComponent(slug) : location.pathname)
    route()
  }

  var OUT_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>'

  var canvas = null
  var opened = null
  // ---- What harnessly's chat knows: the board open, what is selected on it and where, a call written on it ----

  /** To harnessly, when it is there: the chat's context chip and the place its window opens beside. */
  function tell(space) {
    connect().then(
      function (hl) {
        if (hl.publish) return hl.publish({ space: space })
      },
      function () {}
    ).catch(function () {})
  }

  /** The editor's rectangle moved by the canvas frame's place in this page. */
  function onPage(rect) {
    if (!rect || !canvas) return null
    var at = canvas.getBoundingClientRect()
    return { x: rect.x + at.left, y: rect.y + at.top, w: rect.w, h: rect.h }
  }

  window.addEventListener('message', function (event) {
    if (!canvas || event.source !== canvas.contentWindow || event.origin !== location.origin || !opened) return
    var m = event.data || {}
    var area = typeof m.area === 'string' ? m.area : ''
    if (m.type === 'board-selection') {
      tell({ kind: 'board', title: opened.title, url: opened.url, object: opened.slug, selection: String(m.text || ''), rect: onPage(m.rect), area: area })
    } else if (m.type === 'board-call') {
      // A call in a comment carries its thread: harnessly sends it to the agent at once, the answer comes back there.
      var thread = typeof m.thread === 'string' ? m.thread : null
      tell({ kind: 'board', title: opened.title, url: opened.url, object: opened.slug, selection: '', rect: onPage(m.rect), area: area, call: String(m.text || '') || '@harnessly', thread: thread })
    }
  })

  function route(again) {
    var slug = current()
    if (!slug) {
      canvas = null
      // The list has nothing open: harnessly drops the chip of a board shown before, even one of a frame before this
      // one (it starts anew when the chat is made, HRN-1452), so the agent never gets a board nobody looks at.
      tell(null)
      opened = null
    }
    library(again)
      .then(function (rows) {
        if (rows === null) return needSignIn()
        if (current() !== slug) return
        if (slug) openBoard(rows, slug)
        else home(rows)
      })
      .catch(function (error) {
        failed(String((error && error.message) || ''), function () {
          route(true)
        })
      })
  }

  // ---- An open board: a bar with the way back, and the canvas ----

  function openBoard(rows, slug) {
    var row = rows.filter(function (r) {
      return r.slug === slug
    })[0]
    root.textContent = ''
    root.removeAttribute('aria-busy')
    root.className = 'ba ba--canvas'
    var bar = el('div', 'ba__top')
    var back = el('button', 'hl-btn hl-btn--ghost hl-btn--sm ba__back', '← ' + T.back)
    back.type = 'button'
    back.addEventListener('click', function () {
      go(null)
    })
    bar.appendChild(back)
    root.appendChild(bar)
    if (!row) {
      root.appendChild(el('p', 'hl-empty', T.gone))
      return
    }
    bar.appendChild(el('span', 'ba__top-title', row.title))
    // An icon with its words as the tip: the bar never cuts it, however narrow the pane (HRN-1452).
    var out = el('a', 'hl-btn hl-btn--ghost hl-btn--sm ba__out')
    out.setAttribute('aria-label', T.newTab)
    out.title = T.newTab
    out.innerHTML = OUT_ICON
    out.href = row.url
    out.target = '_blank'
    out.rel = 'noopener'
    bar.appendChild(out)
    var at = new URL(row.url)
    at.searchParams.set('app', '1')
    at.searchParams.set('theme', theme.mode)
    var frame = el('iframe', 'ba__canvas')
    frame.title = row.title
    frame.src = at.pathname + at.search
    canvas = frame
    opened = { title: row.title, url: row.url, slug: row.slug }
    root.appendChild(frame)
    tell({ kind: 'board', title: row.title, url: row.url, object: row.slug, selection: '', rect: null })
  }

  // ---- The library ----

  function card(row) {
    var item = el('a', 'ba__card')
    item.href = '?board=' + encodeURIComponent(row.slug)
    var thumb = el('span', 'ba__thumb')
    if (row.preview) {
      var img = el('img')
      img.src = row.preview
      img.alt = ''
      img.loading = 'lazy'
      thumb.appendChild(img)
    }
    item.appendChild(thumb)
    item.appendChild(el('span', 'ba__name', row.title))
    var meta = [when(row.updatedAt), row.mine ? T.mineMark : row.author || ''].filter(Boolean).join(' · ')
    item.appendChild(el('span', 'ba__meta hl-muted', meta))
    item.addEventListener('click', function (event) {
      if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
      event.preventDefault()
      go(row.slug)
    })
    return item
  }

  function grid(rows) {
    var box = el('div', 'ba__grid')
    rows.forEach(function (row) {
      box.appendChild(card(row))
    })
    return box
  }

  /** Shelves: the newest, then the most frequent tags. */
  function shelves(rows) {
    var out = [{ title: T.recent, rows: rows.slice(0, PER_SHELF) }]
    var count = {}
    rows.forEach(function (row) {
      row.tags.forEach(function (tag) {
        count[tag] = (count[tag] || 0) + 1
      })
    })
    Object.keys(count)
      .filter(function (tag) {
        return count[tag] > 1
      })
      .sort(function (a, b) {
        return count[b] - count[a] || a.localeCompare(b)
      })
      .slice(0, SHELVES)
      .forEach(function (tag) {
        out.push({
          title: tag,
          rows: rows
            .filter(function (row) {
              return row.tags.indexOf(tag) >= 0
            })
            .slice(0, PER_SHELF),
        })
      })
    return out
  }

  var view = { tab: 'all', query: '' }
  function home(all) {
    root.className = 'ba ba--home'
    var state = view

    var bar = el('div', 'ba__bar')
    var seg = el('div', 'hl-seg ba__tabs')
    seg.setAttribute('role', 'tablist')
    TABS.forEach(function (tab) {
      var b = el('button', 'ba__tab', tab.label)
      b.type = 'button'
      b.setAttribute('role', 'tab')
      b.dataset.tab = tab.id
      b.addEventListener('click', function () {
        state.tab = tab.id
        draw()
      })
      seg.appendChild(b)
    })
    var search = el('input', 'hl-input ba__search')
    search.type = 'search'
    search.value = state.query
    search.placeholder = T.search
    search.setAttribute('aria-label', T.search)
    search.addEventListener('input', function () {
      state.query = search.value.trim().toLowerCase()
      draw()
    })
    bar.appendChild(seg)
    bar.appendChild(search)

    var body = el('div', 'ba__lib')
    root.textContent = ''
    root.appendChild(bar)
    root.appendChild(body)

    function shown() {
      return all.filter(function (row) {
        if (state.tab === 'mine' && !row.mine) return false
        if (state.tab === 'shared' && row.mine) return false
        if (!state.query) return true
        var hay = [row.title, row.description].concat(row.tags).join(' ').toLowerCase()
        return state.query.split(/\s+/).every(function (w) {
          return hay.indexOf(w) >= 0
        })
      })
    }

    function draw() {
      Array.prototype.forEach.call(seg.children, function (b) {
        b.setAttribute('aria-selected', String(b.dataset.tab === state.tab))
      })
      body.textContent = ''
      var rows = shown()
      if (!rows.length) {
        body.appendChild(el('p', 'hl-empty', state.query || state.tab !== 'all' ? T.nothing : T.empty))
        return
      }
      if (state.query || state.tab !== 'all') {
        body.appendChild(grid(rows))
        return
      }
      shelves(rows).forEach(function (shelf) {
        var section = el('section', 'ba__shelf')
        section.appendChild(el('h2', 'ba__shelf-title hl-h', shelf.title))
        section.appendChild(grid(shelf.rows))
        body.appendChild(section)
      })
    }

    draw()
    root.removeAttribute('aria-busy')
  }

  // ---- Start: the library at once; harnessly, when it answers, gives the theme and the object to open ----

  function skeleton() {
    root.className = 'ba ba--home'
    root.textContent = ''
    var wait = el('div', 'ba__grid')
    for (var i = 0; i < 6; i += 1) wait.appendChild(el('div', 'ba__card hl-skeleton'))
    root.appendChild(wait)
  }

  window.addEventListener('popstate', function () {
    route()
  })
  skeleton()
  // Inside harnessly the object to open comes with the bridge: wait a moment for it, so a frame started anew (the chat
  // was just made) goes straight back to its board, not through the list (HRN-1452). Never longer than FIRST_WAIT_MS.
  var FIRST_WAIT_MS = 800
  var started = false
  function start(object) {
    if (started) return
    started = true
    if (object && !current()) history.replaceState(null, '', '?board=' + encodeURIComponent(object))
    route()
  }
  if (current() || !window.harnessly) start(null)
  else setTimeout(function () { start(null) }, FIRST_WAIT_MS)

  connect()
    .then(function (hl) {
      function follow(mode) {
        if (mode !== 'dark' && mode !== 'light') return
        theme.mode = mode
        if (canvas && canvas.contentWindow) canvas.contentWindow.postMessage({ type: 'board-theme', theme: mode }, location.origin)
      }
      follow(hl.context.theme && hl.context.theme.mode)
      hl.on('theme', function (next) {
        follow(next && next.mode ? next.mode : hl.context.theme.mode)
      })
      var data = hl.context.data
      var object = data && typeof data.object === 'string' && /^[a-z0-9-]+$/.test(data.object) ? data.object : null
      if (!started) start(object)
      else if (object && !current()) go(object)
    })
    .catch(function () {
      // Opened outside harnessly, or harnessly did not answer: the site works by itself.
      start(null)
    })
})()
