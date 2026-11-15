// The boards list (Boards 2.0, HRN-1480): the one screen of the standalone page (/b/) and of the harnessly app view
// (/b/app). `BoardsList.mount(root, options)` draws it; the styles are list.css. Boards come as rows
// ({slug, title, url, preview, updatedAt, author, mine, tags, description, fields}); actions go to our own API by the
// person's session: create, rename, copy, trash and back. Changes are pessimistic: the card changes after the answer.
;(function () {
  'use strict'

  var TEXT = {
    en: {
      title: 'Boards', find: 'Find a board', newBoard: 'New board', all: 'All', mine: 'Mine', shared: 'Shared',
      sort: 'Recently updated first', start: 'Start from a template', recent: 'Recent', blank: 'Blank board',
      open: 'Open', more: 'More', rename: 'Rename', copy: 'Make a copy', del: 'Delete', undo: 'Undo',
      nothing: 'Nothing found. Try another name or create a board.', empty: 'No boards yet — create the first one.',
      untitled: 'New board', justNow: 'just now', minAgo: '{n} min ago', hrAgo: '{n} h ago',
      copied: 'Copy is ready', deleted: 'Board “{t}” deleted', restored: 'Board “{t}” is back',
      createFail: 'Could not create the board', renameFail: 'Could not rename the board',
      copyFail: 'Could not make a copy', delFail: 'Could not delete the board', restoreFail: 'Could not restore the board',
      you: 'you',
    },
    ru: {
      title: 'Доски', find: 'Найти доску', newBoard: 'Новая доска', all: 'Все', mine: 'Мои', shared: 'Общие',
      sort: 'Сначала недавние', start: 'Начать с шаблона', recent: 'Недавние', blank: 'Пустая доска',
      open: 'Открыть', more: 'Ещё', rename: 'Переименовать', copy: 'Сделать копию', del: 'Удалить', undo: 'Вернуть',
      nothing: 'Ничего не нашлось. Попробуйте другое название или создайте доску.', empty: 'Досок пока нет — создайте первую.',
      untitled: 'Новая доска', justNow: 'только что', minAgo: '{n} мин назад', hrAgo: '{n} ч назад',
      copied: 'Копия доски готова', deleted: 'Доска «{t}» удалена', restored: 'Доска «{t}» вернулась',
      createFail: 'Не удалось создать доску', renameFail: 'Не удалось переименовать доску',
      copyFail: 'Не удалось сделать копию', delFail: 'Не удалось удалить доску', restoreFail: 'Не удалось вернуть доску',
      you: 'вы',
    },
  }

  // Line icons (24×24, stroke), as in the editor's islands.
  var ICON = {
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    dots: '<path d="M5 12h.01M12 12h.01M19 12h.01"/>',
    out: '<path d="M7 17 17 7M8 7h9v9"/>',
    pencil: '<path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    copy: '<path d="M9 9h11v11H9z"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    trash: '<path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14M10 10v6M14 10v6"/>',
    // harnessly's actions in the head (HRN-1498), by harnessly's own icon names.
    share: '<path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7M16 6l-4-4-4 4M12 2v13"/>',
    'panel-right': '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 16v-4M12 8h.01"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    bug: '<path d="M8 2l1.9 1.9M16 2l-1.9 1.9M9 7.1V6a3 3 0 0 1 6 0v1.1"/><path d="M12 20c-3.3 0-6-2.7-6-6v-3a4 4 0 0 1 4-4h4a4 4 0 0 1 4 4v3c0 3.3-2.7 6-6 6zM12 20v-9"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  }
  function icon(name) {
    return '<svg viewBox="0 0 24 24" aria-hidden="true">' + ICON[name] + '</svg>'
  }

  // Mini pictures of the templates: [kind, left, top, width, height] in percent. f frame, s shape, l line, y/g/p/b stickies.
  var THUMBS = {
    retro: [['f', 6, 14, 27, 72], ['f', 37, 14, 27, 72], ['f', 68, 14, 27, 72], ['g', 11, 24, 14, 22], ['p', 42, 24, 14, 22], ['b', 73, 24, 14, 22], ['g', 11, 52, 14, 22]],
    brainstorm: [['s', 36, 38, 28, 24, 1], ['y', 12, 12, 14, 22], ['p', 74, 12, 14, 22], ['g', 12, 64, 14, 22], ['b', 74, 64, 14, 22]],
    flow: [['s', 8, 40, 22, 20, 1], ['s', 39, 40, 22, 20], ['s', 72, 36, 18, 28], ['l', 30, 50, 9, 1], ['l', 61, 50, 11, 1]],
    architecture: [['f', 5, 18, 20, 64], ['f', 30, 18, 20, 64], ['f', 55, 18, 20, 64], ['s', 78, 30, 16, 14], ['s', 78, 56, 16, 14], ['b', 9, 30, 12, 16], ['g', 34, 30, 12, 16], ['y', 59, 30, 12, 16]],
    weekly: [['f', 5, 14, 20, 72], ['f', 28, 14, 20, 72], ['f', 51, 14, 20, 72], ['f', 74, 14, 21, 72], ['y', 8, 26, 14, 16], ['g', 31, 26, 14, 16], ['b', 54, 26, 14, 16], ['p', 77, 26, 14, 16]],
    incident: [['l', 8, 30, 84, 2], ['s', 12, 22, 10, 16, 1], ['s', 44, 22, 10, 16, 1], ['s', 76, 22, 10, 16, 1], ['f', 8, 52, 40, 36], ['f', 52, 52, 40, 36]],
    decision: [['f', 6, 12, 40, 52], ['f', 54, 12, 40, 52], ['g', 12, 24, 14, 20], ['p', 60, 24, 14, 20], ['s', 30, 74, 40, 16]],
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag)
    if (cls) node.className = cls
    if (text !== undefined) node.textContent = text
    return node
  }
  function btn(cls, html, label) {
    var b = el('button', cls)
    b.type = 'button'
    if (html) b.innerHTML = html
    if (label) b.setAttribute('aria-label', label)
    return b
  }
  function fill(str, vars) {
    return str.replace(/\{(\w+)\}/g, function (_, k) {
      return vars[k]
    })
  }

  var COLORS = ['#7b61ff', '#2fb36b', '#e5879a', '#e0953a', '#3f8ae0', '#8f6bd1']
  function avatar(name) {
    var s = String(name || '?').trim()
    var hash = 0
    for (var i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
    var a = el('span', 'bl-av', (s.charAt(0) || '?').toUpperCase())
    a.style.background = COLORS[hash % COLORS.length]
    a.title = s
    return a
  }

  function post(url, body) {
    return fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body || {}) }).then(function (res) {
      return res.json().catch(function () { return {} }).then(function (data) {
        if (!res.ok) throw new Error(data.error || 'HTTP ' + res.status)
        return data
      })
    })
  }

  function mount(root, options) {
    var lang = options.lang === 'ru' ? 'ru' : 'en'
    var T = TEXT[lang]
    var base = options.base || '/b'
    var templates = options.templates || []
    var rows = options.rows || []
    var state = { tab: 'all', query: options.query || '', menu: null, renaming: null, busy: false, status: options.rows ? 'ready' : 'loading' }
    var mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '')

    root.textContent = ''
    root.classList.add('bl')
    root.removeAttribute('aria-busy')

    // ---- Fixed parts: head, segment, templates. Only the grid is redrawn. ----
    var head = el('div', 'bl-hd')
    head.appendChild(el('h1', '', T.title))
    var srch = el('label', 'bl-srch')
    srch.innerHTML = icon('search')
    var input = el('input')
    input.type = 'search'
    input.placeholder = T.find
    input.setAttribute('aria-label', T.find)
    input.value = state.query
    srch.appendChild(input)
    srch.appendChild(el('kbd', '', mac ? '⌘K' : 'Ctrl K'))
    head.appendChild(srch)
    var newBtn = btn('bl-btn bl-btn--pri', icon('plus'))
    newBtn.appendChild(document.createTextNode(T.newBoard))
    head.appendChild(newBtn)
    // harnessly draws no bar above the app (HRN-1498): its actions — share, the right pane, its menu — are here.
    if (options.hostActions) {
      var hostWrap = el('div', 'bl-host')
      hostWrap.hidden = true
      var hostBtn = btn('bl-btn bl-btn--icon', icon('dots'), T.more)
      hostWrap.appendChild(hostBtn)
      head.appendChild(hostWrap)
      options.hostActions().then(function (list) {
        if (list.length) hostWrap.hidden = false
      })
      hostBtn.addEventListener('click', function () {
        if (state.menu === ':host') return closeMenu()
        closeMenu()
        options.hostActions().then(function (list) {
          state.menu = ':host'
          var m = el('div', 'bl-menu')
          m.setAttribute('role', 'menu')
          list.forEach(function (a) {
            var b = btn('bl-mi' + (a.danger ? ' bl-mi--dg' : ''), ICON[a.icon] ? icon(a.icon) : icon('dots'))
            b.setAttribute('role', 'menuitem')
            b.appendChild(document.createTextNode(a.label))
            if (a.pressed) b.appendChild(el('span', 'bl-mi-on')).innerHTML = icon('check')
            b.addEventListener('click', function () {
              closeMenu()
              if (options.hostRun) options.hostRun(a.id)
            })
            m.appendChild(b)
          })
          hostWrap.appendChild(m)
          menuEl = m
        })
      })
    }
    root.appendChild(head)

    var sub = el('div', 'bl-sub')
    var seg = el('div', 'bl-seg')
    seg.setAttribute('role', 'tablist')
    ;[['all', T.all], ['mine', T.mine], ['shared', T.shared]].forEach(function (t) {
      var b = btn('', '')
      b.textContent = t[1]
      b.setAttribute('role', 'tab')
      b.dataset.tab = t[0]
      b.addEventListener('click', function () {
        state.tab = t[0]
        draw()
      })
      seg.appendChild(b)
    })
    sub.appendChild(seg)
    sub.appendChild(el('span', 'bl-sp'))
    sub.appendChild(el('span', 'bl-note', T.sort))
    root.appendChild(sub)

    root.appendChild(el('div', 'bl-lbl', T.start))
    var tplRow = el('div', 'bl-tpl')
    root.appendChild(tplRow)
    root.appendChild(el('div', 'bl-lbl', T.recent))
    var grid = el('div', 'bl-grid')
    root.appendChild(grid)
    var toasts = el('div', 'bl-toasts')
    toasts.setAttribute('role', 'status')
    toasts.setAttribute('aria-live', 'polite')
    root.appendChild(toasts)

    // ---- Toast ----
    var toastTimer = 0
    function toast(text, action, onAction) {
      clearTimeout(toastTimer)
      toasts.textContent = ''
      var t = el('div', 'bl-toast' + (action ? ' bl-toast--act' : ''))
      t.appendChild(el('span', '', text))
      var gone = function () {
        clearTimeout(toastTimer)
        t.classList.add('is-out')
        setTimeout(function () {
          if (t.parentNode) t.parentNode.removeChild(t)
        }, 180)
      }
      if (action) {
        var a = btn('', '')
        a.textContent = action
        a.addEventListener('click', function () {
          gone()
          onAction()
        })
        t.appendChild(a)
      }
      toasts.appendChild(t)
      toastTimer = setTimeout(gone, action ? 7000 : 3500)
    }

    // ---- Templates ----
    function tplCard(tpl) {
      var b = btn('bl-tc', '')
      var pv = el('div', 'bl-pv' + (tpl ? '' : ' bl-pv--new'))
      if (!tpl) pv.innerHTML = icon('plus')
      var parts = tpl ? THUMBS[tpl.id] || [] : []
      parts.forEach(function (p) {
          var i = el('i', 'bl-tb bl-tb--' + p[0])
          i.style.left = p[1] + '%'
          i.style.top = p[2] + '%'
          i.style.width = p[3] + '%'
          i.style.height = p[0] === 'l' ? (p[4] === 1 ? '1.5px' : p[4] + 'px') : p[4] + '%'
          if (p[0] === 's' && p[5]) i.style.borderRadius = '99px'
          else if (p[0] === 's') i.style.borderRadius = '4px'
          pv.appendChild(i)
        })
      b.appendChild(pv)
      b.appendChild(el('b', '', tpl ? tpl.title : T.blank))
      b.addEventListener('click', function () {
        create(tpl ? tpl.id : null)
      })
      return b
    }
    tplRow.appendChild(tplCard(null))
    templates
      .filter(function (t) {
        return t.id !== 'blank'
      })
      .forEach(function (t) {
        tplRow.appendChild(tplCard(t))
      })

    function create(template) {
      if (state.busy) return
      state.busy = true
      newBtn.disabled = true
      post(base + '/api/boards', { title: T.untitled, template: template || undefined }).then(
        function (made) {
          if (options.onCreated) options.onCreated(made)
          else location.href = made.url
        },
        function () {
          state.busy = false
          newBtn.disabled = false
          toast(T.createFail)
        }
      )
    }
    newBtn.addEventListener('click', function () {
      create(null)
    })

    // ---- Search ----
    input.addEventListener('input', function () {
      state.query = input.value.trim().toLowerCase()
      draw()
    })
    if (window.BoardsList && window.BoardsList.off) window.BoardsList.off()
    var onKey = function (e) {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        input.focus()
        input.select()
      } else if (e.key === 'Escape' && state.menu) closeMenu()
    }
    var onDown = function (e) {
      if (menuEl && !(e.target.closest && e.target.closest('.bl-menu, .bl-more, .bl-host'))) closeMenu()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onDown)
    window.BoardsList.off = function () {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onDown)
    }
    state.query = state.query.toLowerCase()

    // ---- Cards ----
    function when(row) {
      var at = Date.parse(row.updatedAt || '')
      if (!isFinite(at)) return ''
      var min = Math.round((Date.now() - at) / 60000)
      if (min < 1) return T.justNow
      if (min < 60) return fill(T.minAgo, { n: min })
      if (min < 1440) return fill(T.hrAgo, { n: Math.round(min / 60) })
      return new Date(at).toLocaleDateString(lang === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short', year: min > 60 * 24 * 300 ? 'numeric' : undefined })
    }

    function shown() {
      var words = state.query.split(/\s+/).filter(Boolean)
      return rows
        .filter(function (row) {
          if (state.tab === 'mine' && !row.mine) return false
          if (state.tab === 'shared' && row.mine) return false
          if (!words.length) return true
          var hay = [row.title, row.description, row.author].concat(row.tags || []).join(' ').toLowerCase()
          return words.every(function (w) {
            return hay.indexOf(w) >= 0
          })
        })
        .sort(function (a, b) {
          return (Date.parse(b.updatedAt || '') || 0) - (Date.parse(a.updatedAt || '') || 0)
        })
    }

    var menuEl = null
    function closeMenu() {
      var m = menuEl
      if (!m) return
      menuEl = null
      state.menu = null
      var card = m.parentNode
      m.classList.add('is-out')
      setTimeout(function () {
        if (m.parentNode) m.parentNode.removeChild(m)
        if (card && !state.menu) card.classList.remove('is-menu')
      }, 160)
    }
    function openMenu(row, card) {
      if (state.menu === row.slug) return closeMenu()
      closeMenu()
      state.menu = row.slug
      card.classList.add('is-menu')
      var m = el('div', 'bl-menu')
      m.setAttribute('role', 'menu')
      function item(cls, ic, label, fn) {
        var b = btn('bl-mi' + cls, icon(ic))
        b.setAttribute('role', 'menuitem')
        b.appendChild(document.createTextNode(label))
        b.addEventListener('click', function () {
          closeMenu()
          fn()
        })
        m.appendChild(b)
      }
      item('', 'pencil', T.rename, function () {
        state.renaming = row.slug
        draw()
      })
      item('', 'copy', T.copy, function () {
        copy(row)
      })
      m.appendChild(el('div', 'bl-sep'))
      item(' bl-mi--dg', 'trash', T.del, function () {
        trash(row)
      })
      card.appendChild(m)
      menuEl = m
    }

    function keyed(row, path) {
      var k = /[?&]k=([^&]+)/.exec(row.url || '')
      return base + path + (k ? '?k=' + k[1] : '')
    }

    function rename(row, title) {
      var next = title.trim()
      state.renaming = null
      if (next.length < 2 || next === row.title) return draw()
      post(keyed(row, '/' + row.slug + '/meta'), { title: next }).then(
        function (res) {
          row.title = res.title || next
          row.updatedAt = new Date().toISOString()
          draw()
        },
        function () {
          toast(T.renameFail)
          draw()
        }
      )
    }

    function copy(row) {
      post(keyed(row, '/api/boards/' + row.slug + '/copy'), {}).then(
        function (made) {
          var key = /[?&]k=([^&]+)/.exec(made.url || '')
          rows.unshift({
            slug: made.slug,
            title: made.title,
            description: row.description,
            tags: row.tags || [],
            author: options.me ? options.me.name : null,
            mine: true,
            updatedAt: new Date().toISOString(),
            url: made.url,
            preview: base + '/' + made.slug + '/preview.svg' + (key ? '?k=' + key[1] : ''),
          })
          draw()
          toast(T.copied)
        },
        function () {
          toast(T.copyFail)
        }
      )
    }

    function trash(row) {
      post(keyed(row, '/api/boards/' + row.slug + '/trash'), {}).then(
        function () {
          var at = rows.indexOf(row)
          var node = grid.querySelector('[data-slug="' + row.slug + '"]')
          if (node) node.classList.add('is-gone')
          setTimeout(function () {
            rows.splice(rows.indexOf(row), 1)
            draw()
          }, node ? 180 : 0)
          toast(fill(T.deleted, { t: row.title }), T.undo, function () {
            post(keyed(row, '/api/boards/' + row.slug + '/restore'), {}).then(
              function () {
                rows.splice(Math.min(at, rows.length), 0, row)
                draw()
              },
              function () {
                toast(T.restoreFail)
              }
            )
          })
        },
        function () {
          toast(T.delFail)
        }
      )
    }

    function card(row) {
      var box = el('div', 'bl-bc')
      box.dataset.slug = row.slug
      var link = el('a', 'bl-a')
      link.href = options.href ? options.href(row) : row.url
      var th = el('span', 'bl-th')
      var img = el('img')
      img.alt = ''
      img.loading = 'lazy'
      img.src = row.preview
      th.appendChild(img)
      var open = el('span', 'bl-open')
      open.innerHTML = icon('out')
      open.appendChild(document.createTextNode(T.open))
      th.appendChild(open)
      link.appendChild(th)
      var meta = el('span', 'bl-meta')
      if (state.renaming === row.slug) {
        var field = el('input', 'bl-rn')
        field.value = row.title
        field.maxLength = 120
        field.setAttribute('aria-label', T.rename)
        var done = false
        var finish = function (save) {
          if (done) return
          done = true
          if (save) rename(row, field.value)
          else {
            state.renaming = null
            draw()
          }
        }
        field.addEventListener('keydown', function (e) {
          e.stopPropagation()
          if (e.key === 'Enter') finish(true)
          else if (e.key === 'Escape') finish(false)
        })
        field.addEventListener('blur', function () {
          finish(true)
        })
        field.addEventListener('click', function (e) {
          e.preventDefault()
        })
        meta.appendChild(field)
        setTimeout(function () {
          field.focus()
          field.select()
        }, 0)
      } else meta.appendChild(el('b', '', row.title))
      if (row.author) meta.appendChild(avatar(row.mine && options.me ? options.me.name : row.author))
      link.appendChild(meta)
      var w = el('span', 'bl-when')
      w.style.display = 'block'
      w.appendChild(document.createTextNode(when(row)))
      ;(row.fields || []).forEach(function (f) {
        w.appendChild(document.createTextNode(' · '))
        w.appendChild(el('span', f.late ? 'is-late' : '', f.label + ': ' + f.value))
      })
      link.appendChild(w)
      link.addEventListener('click', function (e) {
        if (state.renaming === row.slug) return e.preventDefault()
        if (options.onOpen && !(e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0)) {
          e.preventDefault()
          options.onOpen(row)
        }
      })
      box.appendChild(link)
      var more = btn('bl-more', icon('dots'), T.more)
      more.title = T.more
      more.setAttribute('aria-haspopup', 'menu')
      more.addEventListener('click', function () {
        openMenu(row, box)
      })
      box.appendChild(more)
      return box
    }

    function draw() {
      Array.prototype.forEach.call(seg.children, function (b) {
        b.setAttribute('aria-selected', String(b.dataset.tab === state.tab))
      })
      menuEl = null
      state.menu = null
      grid.textContent = ''
      if (state.status === 'loading') {
        for (var i = 0; i < 8; i += 1) grid.appendChild(el('div', 'bl-skel'))
        return
      }
      if (state.status === 'fail') return grid.appendChild(state.failNode)
      var list = shown()
      if (!list.length) {
        grid.appendChild(el('div', 'bl-empty', state.query || state.tab !== 'all' || rows.length ? T.nothing : T.empty))
        return
      }
      list.forEach(function (row) {
        grid.appendChild(card(row))
      })
    }

    draw()

    return {
      setRows: function (next) {
        rows = next
        state.status = 'ready'
        draw()
      },
      fail: function (node) {
        state.status = 'fail'
        state.failNode = node
        node.classList.add('bl-fail')
        draw()
      },
      loading: function () {
        state.status = 'loading'
        draw()
      },
    }
  }

  window.BoardsList = { mount: mount, TEXT: TEXT }
})()
