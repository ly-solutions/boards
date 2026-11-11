// The pane view of the app: the latest boards from the boards service, through the app's own MCP server.
(function () {
  var note = document.getElementById('note');
  var list = document.getElementById('list');

  function show(rows) {
    list.textContent = '';
    if (!rows.length) {
      note.textContent = 'No boards yet — ask the agent to draw the first one.';
      return;
    }
    note.textContent = '';
    rows.forEach(function (r) {
      // Only links to the boards service itself: board_library builds them from its public address.
      if (typeof r.url !== 'string' || !/^https?:\/\//.test(r.url)) return;
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = String(r.title || r.slug || '');
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  window.harnessly.connect({ protocol: 2 }).then(function (hl) {
    return hl.tools.call('boards.board_library', { limit: 20 }).then(function (res) {
      if (hl.refused(res) || !res || res.isError) throw new Error('refused');
      var text = (res.content || []).map(function (c) { return c.text || ''; }).join('\n');
      show(JSON.parse(text).boards || []);
    });
  }).catch(function () {
    note.textContent = 'The boards service is not answering right now. Boards and links to them are safe — try again later.';
  });
})();
