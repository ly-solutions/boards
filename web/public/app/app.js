// The boards `app` view in harnessly (server/app-view.mjs). Without an object it is the home: a "what shall we draw"
// field that goes to the agent in the conversation next to it, and below it the library "All · Mine · Shared" with
// shelves by tag and a search. With an object (`hl.context.data.object`) it is the board canvas: the same editor with
// `?app=1`, without its own chrome, in the harnessly theme. Data comes through the app's MCP server (`hl.tools.call`);
// the harnessly machine adds the person's token.
;(function () {
  'use strict'

  var root = document.getElementById('app')
  var TEXT = {
    en: {
      all: 'All', mine: 'Mine', shared: 'Shared', mineMark: 'mine', recent: 'Recent',
      starters: ['Draw the service map: who calls whom', 'The user journey from sign-in to payment', 'A retro board: what went well, what got in the way', 'A plan for the week, day by day'],
      down: 'The boards service is not answering right now', downHint: 'Boards and links to them are safe — try again later.',
      ask: 'What shall we draw?', askHint: 'Describe a diagram, a plan or a board — the agent draws it in the conversation next to this', draw: 'Draw',
      prompt: 'Draw a board: ', sendFailed: 'Could not send to the conversation',
      search: 'Search boards', nothing: 'Nothing found.', empty: 'No boards yet — describe the first one in the field above.',
      outside: 'This view opens inside harnessly.',
    },
    ru: {
      all: 'Все', mine: 'Мои', shared: 'Общие', mineMark: 'моя', recent: 'Недавние',
      starters: ['Нарисуй схему сервиса: кто кого вызывает', 'Путь пользователя от входа до оплаты', 'Доска ретро: что было хорошо, что мешало', 'План недели по дням'],
      down: 'Сервис досок сейчас не отвечает', downHint: 'Доски и ссылки на них на месте — попробуйте позже.',
      ask: 'Что нарисуем?', askHint: 'Опишите схему, план или доску — агент нарисует её в чате рядом', draw: 'Нарисовать',
      prompt: 'Нарисуй доску: ', sendFailed: 'Не получилось отправить в чат',
      search: 'Поиск по доскам', nothing: 'Ничего не нашлось.', empty: 'Досок пока нет — опишите первую в поле выше.',
      outside: 'Этот вид открывается внутри harnessly.',
    },
  }
  var LANG = document.documentElement.lang === 'ru' ? 'ru' : 'en'
  var T = TEXT[LANG]
  var TABS = [
    { id: 'all', label: T.all },
    { id: 'mine', label: T.mine },
    { id: 'shared', label: T.shared },
  ]
  var STARTERS = T.starters
  var SHELVES = 6
  var PER_SHELF = 8

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

  function library(hl, args) {
    return hl.tools.call('boards.board_library', args || {}).then(function (res) {
      if (hl.refused(res) || !res || res.isError) throw new Error(textOf(res) || 'refused')
      return JSON.parse(textOf(res)).boards || []
    })
  }

  function when(iso) {
    if (!iso) return ''
    var d = new Date(iso)
    if (isNaN(d.getTime())) return ''
    return d.toLocaleDateString(LANG === 'ru' ? 'ru-RU' : 'en-US', { day: 'numeric', month: 'short' })
  }

  function failed(text) {
    root.textContent = ''
    root.removeAttribute('aria-busy')
    var box = el('div', 'ba__fail hl-empty')
    box.appendChild(el('p', 'hl-h', T.down))
    box.appendChild(el('p', 'hl-muted', text || T.downHint))
    root.appendChild(box)
  }

  // ---- An open board: the canvas only ----

  function openBoard(hl, slug) {
    root.className = 'ba ba--canvas'
    library(hl, { board: slug })
      .then(function (rows) {
        var row = rows[0]
        var at = new URL(row.url)
        at.searchParams.set('app', '1')
        at.searchParams.set('theme', hl.context.theme.mode)
        var frame = el('iframe', 'ba__canvas')
        frame.title = row.title
        frame.src = at.pathname + at.search
        root.textContent = ''
        root.removeAttribute('aria-busy')
        root.appendChild(frame)
        // The theme changes in harnessly — the canvas follows without a reload.
        hl.on('theme', function (theme) {
          var mode = theme && theme.mode ? theme.mode : hl.context.theme.mode
          if (frame.contentWindow) frame.contentWindow.postMessage({ type: 'board-theme', theme: mode }, location.origin)
        })
      })
      .catch(function (error) {
        failed(String((error && error.message) || ''))
      })
  }

  // ---- Home ----

  function card(hl, row) {
    var item = el('button', 'ba__card')
    item.type = 'button'
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
    item.addEventListener('click', function () {
      hl.pane.open('object:' + row.slug)
    })
    return item
  }

  function grid(hl, rows) {
    var box = el('div', 'ba__grid')
    rows.forEach(function (row) {
      box.appendChild(card(hl, row))
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

  function home(hl) {
    root.className = 'ba ba--home'
    var state = { tab: 'all', query: '', rows: null }

    var head = el('header', 'ba__head')
    head.appendChild(el('h1', 'ba__title', T.ask))
    var form = el('form', 'ba__ask')
    var field = el('textarea', 'ba__field hl-input')
    field.rows = 2
    field.placeholder = T.askHint
    field.setAttribute('aria-label', T.ask)
    var go = el('button', 'hl-btn hl-btn--primary ba__go', T.draw)
    go.type = 'submit'
    form.appendChild(field)
    form.appendChild(go)
    form.addEventListener('submit', function (event) {
      event.preventDefault()
      var text = field.value.trim()
      if (!text) return
      go.disabled = true
      hl.chat
        .send(T.prompt + text)
        .then(function (answer) {
          if (hl.refused(answer)) throw new Error(answer.message)
          field.value = ''
        })
        .catch(function () {
          hl.ui && hl.ui.toast && hl.ui.toast(T.sendFailed, { tone: 'error' })
        })
        .then(function () {
          go.disabled = false
        })
    })
    field.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        form.requestSubmit()
      }
    })
    head.appendChild(form)
    var starters = el('div', 'ba__starters')
    STARTERS.forEach(function (line) {
      var chip = el('button', 'hl-btn hl-btn--ghost hl-btn--sm', line)
      chip.type = 'button'
      chip.addEventListener('click', function () {
        field.value = line
        field.focus()
      })
      starters.appendChild(chip)
    })
    head.appendChild(starters)

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
    root.appendChild(head)
    root.appendChild(bar)
    root.appendChild(body)

    function shown() {
      return (state.rows || []).filter(function (row) {
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
      if (state.rows === null) {
        var wait = el('div', 'ba__grid')
        for (var i = 0; i < 6; i += 1) wait.appendChild(el('div', 'ba__card hl-skeleton'))
        body.appendChild(wait)
        return
      }
      var rows = shown()
      if (!rows.length) {
        body.appendChild(
          el(
            'p',
            'hl-empty',
            state.query || state.tab !== 'all' ? T.nothing : T.empty,
          ),
        )
        return
      }
      if (state.query || state.tab !== 'all') {
        body.appendChild(grid(hl, rows))
        return
      }
      shelves(rows).forEach(function (shelf) {
        var section = el('section', 'ba__shelf')
        section.appendChild(el('h2', 'ba__shelf-title hl-h', shelf.title))
        section.appendChild(grid(hl, shelf.rows))
        body.appendChild(section)
      })
    }

    draw()
    root.removeAttribute('aria-busy')
    library(hl)
      .then(function (rows) {
        state.rows = rows
        draw()
      })
      .catch(function (error) {
        failed(String((error && error.message) || ''))
      })
  }

  window.harnessly
    .connect({ protocol: 2 })
    .then(function (hl) {
      var data = hl.context.data
      var object = data && typeof data.object === 'string' ? data.object : null
      if (object) openBoard(hl, object)
      else home(hl)
    })
    .catch(function () {
      failed(T.outside)
    })
})()
