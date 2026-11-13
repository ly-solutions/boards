/** The read-only embed page (`?embed=1`) as the server renders it. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startApp, TOKEN } from './helpers/app.mjs'

test('embed: own page, inlined scene, absolute assets, no frame-ancestors; the editor keeps its frame-ancestors', async () => {
  const t = await startApp({ config: { frameAncestors: "'self' https://workspace.example" } })
  try {
    const { body } = await t.createBoard({ title: 'Embedded </script> board', graph: { nodes: [{ id: 'a', label: 'Client' }, { id: 'b', label: 'API' }], edges: [{ from: 'a', to: 'b' }] } })
    const k = new URL(body.url).searchParams.get('k')
    const res = await fetch(`${t.base}/b/${body.slug}?k=${k}&embed=1`, { headers: { cookie: t.cookie() } })
    assert.equal(res.status, 200)
    const csp = res.headers.get('content-security-policy')
    assert.ok(!/frame-ancestors/.test(csp), 'any parent, including opaque-origin sandboxes, may frame it')
    assert.match(csp, /default-src 'self'/)
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer')
    assert.equal(res.headers.get('cache-control'), 'no-store')
    const html = await res.text()
    // The scene and the link back are in the page; the closing-tag trick in the title cannot break out.
    const data = JSON.parse(/<script type="application\/json" id="embed-data">([\s\S]*?)<\/script>/.exec(html)[1])
    assert.equal(data.title, 'Embedded </script> board')
    assert.equal(data.boardUrl, `http://boards.test/b/${body.slug}?k=${k}`)
    assert.deepEqual(data.scene.elements.filter((e) => e.type === 'rectangle').map((e) => e.id).sort(), ['a', 'b'])
    assert.ok(!html.includes('id="board-config"'), 'no editor config: the embed never edits, even for a signed-in user')
    assert.match(html, /<pre id="embed-text">[\s\S]*Client/)

    const editor = await fetch(`${t.base}/b/${body.slug}?k=${k}`)
    assert.match(editor.headers.get('content-security-policy'), /frame-ancestors 'self' https:\/\/workspace\.example/)

    assert.equal((await fetch(`${t.base}/b/${body.slug}?k=wrong&embed=1`)).status, 404)
  } finally {
    await t.close()
  }
})

test('embed: asset URLs are absolute on the public origin when the build exists', async (t) => {
  const app = await startApp()
  try {
    const { body } = await app.createBoard()
    const html = await (await fetch(`${body.url.replace('http://boards.test', app.base)}&embed=1`)).text()
    if (html.includes('The viewer is not built')) return t.skip('run npm run build first')
    const scripts = [...html.matchAll(/<script type="module" crossorigin src="([^"]+)"/g)].map((m) => m[1])
    assert.equal(scripts.length, 2)
    assert.ok(scripts.every((src) => src.startsWith('http://boards.test/b/_static/assets/')))
    assert.match(scripts[0], /boot-/)
    assert.match(scripts[1], /embed-view-/)
  } finally {
    await app.close()
  }
})

test('server pages follow the locale: lang attribute and Russian text, English by default', async () => {
  const { renderBoardPage, renderEmbedPage, renderHome, renderNotFound, renderTokenLogin } = await import('../server/html.mjs')
  const { translator } = await import('../shared/locales/index.mjs')
  const ru = translator('ru')
  const state = { slug: 'plan-abc', meta: { title: 'План', key: 'K' } }
  const assets = { scripts: [], styles: [], modules: [], fonts: [] }
  const board = renderBoardPage({ state, text: 'TEXT', config: { homeUrl: '/b/' }, assets, staticBase: '/s', t: ru })
  assert.match(board, /<html lang="ru">/)
  assert.match(board, /Загружаем доску «План»…/)
  assert.match(board, /Эта страница — доска Excalidraw/)
  assert.match(renderBoardPage({ state, text: 'TEXT', config: {}, assets, staticBase: '/s' }), /<html lang="en">[\s\S]*Loading board "План"…/)
  assert.match(renderEmbedPage({ state, text: 'T', scene: {}, boardUrl: 'u', assets, staticUrl: 'S', t: ru }), /<html lang="ru">[\s\S]*Просмотрщик не собран/)
  assert.match(renderNotFound('/s', '/b/', ru), /<h1>Такой доски нет<\/h1>[\s\S]*<a href="\/b\/">список всех досок<\/a>/)
  assert.match(renderTokenLogin({ staticBase: '/s', next: '/b/', t: ru }), /Токен доступа[\s\S]*<button type="submit">Войти<\/button>/)
  const home = renderHome({ staticBase: '/s', boards: [{ slug: 'a', key: 'k', title: 'A', updatedAt: new Date(Date.now() - 5 * 60_000).toISOString() }], templates: [], user: { name: 'Ада' }, canSignOut: true, t: ru })
  assert.match(home, /<title>Доски<\/title>/)
  assert.match(home, /5 мин назад/)
  assert.match(home, /превью пока нет/)
  assert.match(home, />Выйти</)
  // The inline script gets the message as a JS string that cannot break out of the string or the tag.
  assert.match(home, /alert\(body\.error \|\| '[^'<]*'\)/)
  assert.match(renderHome({ staticBase: '/s', boards: [], templates: [], user: null, t: ru }), /Досок пока нет — создайте первую\./)
})

test('embed, guest view: only for an API token; the page carries no key, neither of this board nor of a linked one', async () => {
  const t = await startApp()
  try {
    const other = (await t.createBoard({ title: 'Roadmap' })).body
    const { body } = await t.createBoard({ title: 'Shared board', add: [{ type: 'rectangle', id: 'card', x: 0, y: 0, width: 200, height: 80, link: other.url }, { type: 'rectangle', id: 'out', x: 0, y: 200, width: 200, height: 80, link: 'https://example.org/page?k=keep' }] })
    const k = new URL(body.url).searchParams.get('k')
    const otherKey = new URL(other.url).searchParams.get('k')
    const guestUrl = `${t.base}/b/${body.slug}?k=${k}&embed=1&guest=1`

    // A person with the board's link, signed in or not, does not get the guest view: it is the platform's to fetch.
    assert.equal((await fetch(guestUrl)).status, 403)
    assert.equal((await fetch(guestUrl, { headers: { cookie: t.cookie() } })).status, 403)

    const res = await fetch(`${t.base}/b/${body.slug}?embed=1&guest=1`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get('cache-control'), 'no-store')
    assert.equal(res.headers.get('x-boards-view'), 'guest', 'the platform serves the page on only with this mark')
    const html = await res.text()
    assert.ok(!html.includes(k), 'the key of the board is not in the page')
    assert.ok(!html.includes(otherKey), 'the key of a board linked from the canvas is not in the page')
    const data = JSON.parse(/<script type="application\/json" id="embed-data">([\s\S]*?)<\/script>/.exec(html)[1])
    assert.equal(data.boardUrl, null)
    const link = (id) => data.scene.elements.find((e) => e.id === id)?.link
    assert.equal(link('card'), `http://boards.test/b/${other.slug}`)
    assert.equal(link('out'), 'https://example.org/page?k=keep', 'a link elsewhere is left as the author put it')

    // The ordinary embed is as it was: the link back with the key.
    const plainRes = await fetch(`${t.base}/b/${body.slug}?k=${k}&embed=1`)
    assert.equal(plainRes.headers.get('x-boards-view'), null)
    assert.ok((await plainRes.text()).includes(k))
  } finally {
    await t.close()
  }
})
