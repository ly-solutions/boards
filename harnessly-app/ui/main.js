// The home of the app: the latest boards from the boards service, through the app's own MCP server.
(function () {
  var note = document.getElementById('note');
  var list = document.getElementById('list');

  // A line of board_list: "- <title> — <url>[ — <tags>][ — <updated>]".
  function parse(text) {
    return text.split('\n').map(function (line) {
      var parts = line.replace(/^- /, '').split(' — ');
      return parts.length >= 2 && /^https?:\/\//.test(parts[1]) ? { title: parts[0], url: parts[1] } : null;
    }).filter(Boolean);
  }

  function show(rows) {
    list.textContent = '';
    if (!rows.length) {
      note.textContent = 'No boards yet — ask the agent to draw the first one.';
      return;
    }
    note.textContent = '';
    rows.forEach(function (r) {
      var li = document.createElement('li');
      var a = document.createElement('a');
      a.href = r.url;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = r.title;
      li.appendChild(a);
      list.appendChild(li);
    });
  }

  window.harnessly.connect({ protocol: 2 }).then(function (hl) {
    return hl.tools.call('boards.board_list', { limit: 20 }).then(function (res) {
      if (hl.refused(res) || !res || res.isError) throw new Error('refused');
      var text = (res.content || []).map(function (c) { return c.text || ''; }).join('\n');
      show(parse(text));
    });
  }).catch(function () {
    note.textContent = 'The boards service is not answering right now. Boards and links to them are safe — try again later.';
  });
})();
