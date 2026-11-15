// The standalone boards page (/b/): mounts the shared list (list.js) on the rows the server put into the page.
;(function () {
  'use strict'
  var data = JSON.parse(document.getElementById('boards-data').textContent)
  window.BoardsList.mount(document.getElementById('boards'), {
    lang: data.lang,
    base: data.base,
    query: data.query,
    me: data.me,
    rows: data.rows,
    templates: data.templates,
  })
})()
