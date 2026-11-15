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
      down: 'The boards service is not answering right now', downHint: 'Boards and links to them are safe — try again later.',
      back: 'All boards', newTab: 'Open in a new tab', gone: 'There is no such board, or it is not yours to open.',
      signIn: 'Sign in to see the boards', signInGo: 'Sign in', retry: 'Try again',
      askBoard: 'Board',
    },
    ru: {
      down: 'Сервис досок сейчас не отвечает', downHint: 'Доски и ссылки на них на месте — попробуйте позже.',
      back: 'Все доски', newTab: 'Открыть в новой вкладке', gone: 'Такой доски нет, или она вам недоступна.',
      signIn: 'Войдите, чтобы увидеть доски', signInGo: 'Войти', retry: 'Повторить',
      askBoard: 'Доска',
    },
  }
  var LANG = document.documentElement.lang === 'ru' ? 'ru' : 'en'
  var T = TEXT[LANG]
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

  var libMe = null
  function fetchLibrary() {
    return fetch(BASE + '/api/app/library', { credentials: 'same-origin', headers: { accept: 'application/json' } }).then(function (res) {
      if (res.status === 401) return null
      if (!res.ok) throw new Error('HTTP ' + res.status)
      return res.json().then(function (body) {
        libMe = body.me || null
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

  /** A thread to open on the board (`&thread=`: a mention in harnessly's bell, HRN-1469). */
  function wantedThread() {
    var id = new URLSearchParams(location.search).get('thread')
    return id && /^[a-f0-9]{6,32}$/.test(id) ? id : null
  }

  function address(slug, thread) {
    return slug ? '?board=' + encodeURIComponent(slug) + (thread ? '&thread=' + encodeURIComponent(thread) : '') : location.pathname
  }

  function go(slug, thread) {
    if (current() === slug) {
      // The same board: the canvas stays, only the thread opens.
      if (thread && canvas && canvas.contentWindow) {
        history.replaceState(null, '', address(slug, thread))
        canvas.contentWindow.postMessage({ type: 'board-thread', id: thread }, location.origin)
      }
      return
    }
    history.pushState(null, '', address(slug, thread))
    route()
  }

  var OUT_ICON =
    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/></svg>'

  var canvas = null
  var opened = null

  /** harnessly's own actions (share, the right pane, its menu) for our bar: none without harnessly or on an older one. */
  function hostActions() {
    return connect()
      .then(function (hl) {
        return hl.host ? hl.host.actions() : null
      })
      .then(function (r) {
        return (r && Array.isArray(r.actions) && r.actions) || []
      })
      .catch(function () {
        return []
      })
  }
  function hostRun(id) {
    connect()
      .then(function (hl) {
        if (hl.host && id) return hl.host.run(id)
      })
      .catch(function () {})
  }
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
    } else if (m.type === 'board-chrome') {
      // Boards 2.0 (HRN-1480): the editor draws its own way back and title in its islands — the bar goes.
      root.classList.toggle('ba--islands', Boolean(m.islands))
      if (m.terminal) watchTerminal(true)
    } else if (m.type === 'board-back') {
      go(null)
    } else if (m.type === 'board-host-actions') {
      // harnessly draws no bar above the app (HRN-1498): its actions go into the board's own ⋯.
      hostActions().then(function (list) {
        if (canvas && canvas.contentWindow) canvas.contentWindow.postMessage({ type: 'host-actions', actions: list }, location.origin)
      })
    } else if (m.type === 'board-host-run') {
      hostRun(String(m.id || ''))
    } else if (m.type === 'board-ask') {
      // «Спросить»: the selection goes to the chat as context (what the agent sees, HRN-1391); the chat gets only the
      // person's own words and the board's address — what is written on the board is not passed off as their message.
      var words = String(m.text || '').slice(0, 2000)
      var picked = String(m.selection || '').slice(0, 600)
      tell({ kind: 'board', title: opened.title, url: opened.url, object: opened.slug, selection: picked, rect: onPage(m.rect), area: area })
      if (words.trim())
        connect()
          .then(function (hl) {
            return hl.chat.send(words + '\n\n' + T.askBoard + ': ' + opened.url)
          })
          .catch(function () {})
    } else if (m.type === 'board-pane') {
      // Only a web page goes to the pane: a site card's address is whatever was typed on the board.
      var target = String(m.target || '')
      if (/^https?:\/\/[^\s]+$/i.test(target))
        connect()
          .then(function (hl) {
            return hl.pane.open(target)
          })
          .catch(function () {})
    } else if (m.type === 'board-terminal') {
      watchTerminal(Boolean(m.on))
    } else if (m.type === 'board-call') {
      // A call in a comment carries its thread: harnessly sends it to the agent at once, the answer comes back there.
      var thread = typeof m.thread === 'string' ? m.thread : null
      tell({ kind: 'board', title: opened.title, url: opened.url, object: opened.slug, selection: '', rect: onPage(m.rect), area: area, call: String(m.text || '') || '@harnessly', thread: thread })
    }
  })

  // ---- The machine's terminal on the board: its last lines every few seconds while a card is there ----

  var termTimer = 0
  function watchTerminal(on) {
    clearInterval(termTimer)
    termTimer = 0
    if (!on) return
    function pull() {
      if (!canvas || !canvas.contentWindow) return
      connect()
        .then(function (hl) {
          return hl.terminal.read({ lines: 18 })
        })
        .then(function (list) {
          var first = (list || []).filter(function (x) {
            return x && x.id !== 'agent'
          })[0] || (list || [])[0]
          canvas.contentWindow.postMessage({ type: 'terminal-text', text: first ? String(first.text || '') : '', live: Boolean(first) }, location.origin)
        })
        .catch(function () {
          if (canvas && canvas.contentWindow) canvas.contentWindow.postMessage({ type: 'terminal-text', text: null, live: false }, location.origin)
        })
    }
    pull()
    termTimer = setInterval(pull, 3000)
  }

  function route(again) {
    var slug = current()
    if (!slug) {
      watchTerminal(false)
      canvas = null
      // The list has nothing open: harnessly drops the chip of a board shown before, even one of a frame before this
      // one (it starts anew when the chat is made, HRN-1452), so the agent never gets a board nobody looks at.
      tell(null)
      opened = null
    }
    Promise.all([library(again), templatesReady])
      .then(function (both) {
        var rows = both[0]
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
    var thread = wantedThread()
    if (thread) at.searchParams.set('thread', thread)
    var frame = el('iframe', 'ba__canvas')
    frame.title = row.title
    frame.src = at.pathname + at.search
    canvas = frame
    opened = { title: row.title, url: row.url, slug: row.slug }
    root.appendChild(frame)
    tell({ kind: 'board', title: row.title, url: row.url, object: row.slug, selection: '', rect: null })
  }

  // ---- The library: the shared list (list.js, list.css) ----

  var listUi = null
  function home(all) {
    root.className = 'ba ba--home'
    root.removeAttribute('aria-busy')
    listUi = window.BoardsList.mount(root, {
      lang: LANG,
      base: BASE,
      hostActions: hostActions,
      hostRun: hostRun,
      rows: all,
      me: libMe,
      templates: TEMPLATES,
      href: function (row) {
        return '?board=' + encodeURIComponent(row.slug)
      },
      onOpen: function (row) {
        go(row.slug)
      },
      onShare: function (row) {
        connect()
          .then(function (hl) {
            return hl.pane.open('share:' + row.slug)
          })
          .catch(function () {})
      },
      onCreated: function (made) {
        // The new board is not in the cached library yet.
        rowsReady = null
        go(made.slug)
      },
    })
  }

  /** Templates for the shelf: ids and names from the service, once. */
  var TEMPLATES = []
  var templatesReady = fetch(BASE + '/api/templates', { credentials: 'same-origin' })
    .then(function (res) {
      return res.ok ? res.json() : { templates: [] }
    })
    .then(function (body) {
      TEMPLATES = body.templates || []
    })
    .catch(function () {})

  // ---- Start: the library at once; harnessly, when it answers, gives the theme and the object to open ----

  function skeleton() {
    root.className = 'ba ba--home'
    root.textContent = ''
    var wait = el('div', 'bl bl-grid')
    for (var i = 0; i < 8; i += 1) wait.appendChild(el('div', 'bl-skel'))
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
  function start(object, thread) {
    if (started) return
    started = true
    if (object && !current()) history.replaceState(null, '', address(object, thread))
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
      // What harnessly asks to open: a board, and a thread on it. The view stays the same document when harnessly asks
      // for another board later (its spaces keep one window, HRN-1469): the `context` event carries the new ask.
      // Only a new ask moves the view: the same context again (the theme changed) leaves the board the person opened.
      var asked = null
      function ask(data) {
        var object = data && typeof data.object === 'string' && /^[a-z0-9-]+$/.test(data.object) ? data.object : null
        var thread = data && typeof data.thread === 'string' && /^[a-f0-9]{6,32}$/.test(data.thread) ? data.thread : null
        var key = (object || '') + '#' + (thread || '')
        if (key === asked) return
        var first = asked === null
        asked = key
        if (!started) return start(object, thread)
        if (object) go(object, thread)
        else if (!first && current()) go(null)
      }
      // A voice quick edit changed elements of the open board (HRN-1466): the canvas outlines them for a moment.
      hl.on('event', function (e) {
        if (!e || e.kind !== 'quick-edit' || e.object !== current() || !Array.isArray(e.ids) || !canvas || !canvas.contentWindow) return
        var ids = e.ids.filter(function (id) { return typeof id === 'string' }).slice(0, 50)
        if (ids.length) canvas.contentWindow.postMessage({ type: 'board-flash', ids: ids }, location.origin)
      })
      ask(hl.context.data)
      hl.on('context', function (next) {
        ask(next && next.data)
      })
    })
    .catch(function () {
      // Opened outside harnessly, or harnessly did not answer: the site works by itself.
      start(null)
    })
})()
