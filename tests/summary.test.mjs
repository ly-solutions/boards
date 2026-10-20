import { test } from 'node:test'
import assert from 'node:assert/strict'
import { colorName, plural, summarize } from '../server/summary.mjs'

const base = { version: 1, versionNonce: 1, isDeleted: false, strokeColor: '#1e1e1e', backgroundColor: 'transparent', strokeStyle: 'solid' }
const rect = (id, x, y, over = {}) => ({ ...base, id, type: 'rectangle', x, y, width: 100, height: 60, boundElements: [], ...over })
const label = (id, containerId, text) => ({ ...base, id, type: 'text', x: 0, y: 0, width: 50, height: 20, text, originalText: text, containerId })

test('labelled shapes and a bound arrow become a connection', () => {
  const md = summarize([
    rect('a', 0, 0), label('ta', 'a', 'Gateway'),
    rect('b', 300, 0), label('tb', 'b', 'Billing'),
    { ...base, id: 'ar', type: 'arrow', x: 100, y: 30, width: 200, height: 0, points: [[0, 0], [200, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, endArrowhead: 'arrow' },
    label('tar', 'ar', 'HTTP'),
  ], { title: 'Diagram' })
  assert.match(md, /# Board "Diagram"/)
  assert.match(md, /## Shapes\n- \[a\] rectangle "Gateway"/)
  assert.match(md, /## Connections\n- \[ar\] "Gateway" \[a\] → "Billing" \[b\] — "HTTP"/)
  assert.match(md, /2 shapes, 1 connection, 0 texts/)
})

test('an unbound arrow dropped next to a shape still reads as a connection', () => {
  const md = summarize([
    rect('a', 0, 0), label('ta', 'a', 'A'),
    rect('b', 300, 0), label('tb', 'b', 'B'),
    { ...base, id: 'ar', type: 'arrow', x: 110, y: 30, width: 180, height: 0, points: [[0, 0], [175, 0]], endArrowhead: 'arrow' },
  ])
  assert.match(md, /"A" \[a\] → "B" \[b\]/)
})

test('deleted elements are skipped, free text is listed', () => {
  const md = summarize([rect('a', 0, 0, { isDeleted: true }), { ...base, id: 't', type: 'text', x: 10, y: 400, width: 80, height: 20, text: 'Question:\nwho pays?' }])
  assert.doesNotMatch(md, /\[a\]/)
  assert.match(md, /## Text\n- \[t\] "Question: \/ who pays\?" \(10,400\)/)
})

test('meta: author, access, reference and tags', () => {
  const md = summarize([], { title: 'Plan', author: 'alice', access: 'link', task: 'PROJ-12', tags: ['q3', 'infra'], url: 'https://boards.example.com/b/plan' })
  assert.match(md, /URL: https:\/\/boards\.example\.com\/b\/plan · 0 shapes/)
  assert.match(md, /Author: alice · anyone with the link can edit/)
  assert.match(md, /Reference: PROJ-12 · Tags: q3, infra/)
  assert.match(md, /The board is empty\./)
  assert.doesNotMatch(summarize([], { access: 'team' }), /Reference:/)
})

test('edited-by suffix, colours and stickies', () => {
  const md = summarize([
    rect('a', 0, 0, { backgroundColor: '#ffc9c9', strokeColor: '#e03131', customData: { editedBy: 'agent' } }),
    rect('s', 0, 200, { backgroundColor: '#ffec99', customData: { kind: 'sticky', author: 'bob' } }), label('st', 's', 'Ship it'),
  ], { notes: { reactions: { s: { '👍': ['alice', 'bob'] } } } })
  assert.match(md, /\[a\] rectangle \(0,0 100×60\) — fill light red, stroke red · edited by agent/)
  assert.match(md, /## Stickies\n- \[s\] sticky "Ship it" \(0,200\) — light yellow · by bob · 👍 2 \(alice, bob\)/)
})

test('link cards read as links: board card on this server, bookmark elsewhere', () => {
  const card = (id, x, url, text) => [rect(id, x, 0, { link: url, customData: { kind: 'card', url } }), label(`${id}t`, id, text)]
  const md = summarize([
    ...card('c1', 0, 'https://boards.example.com/b/roadmap', 'Board · Roadmap'),
    ...card('c2', 300, 'https://example.org/post', 'example.org/post'),
  ], { url: 'https://boards.example.com/b/plan' })
  assert.match(md, /- \[c1\] board card "Board · Roadmap" \(0,0\) — https:\/\/boards\.example\.com\/b\/roadmap/)
  assert.match(md, /- \[c2\] bookmark "example\.org\/post" \(300,0\) — https:\/\/example\.org\/post/)
  assert.doesNotMatch(md, /fill white/)
})

test('comments: open threads with replies, resolved as a count', () => {
  const md = summarize([rect('a', 0, 0), label('ta', 'a', 'API')], {
    notes: {
      comments: [
        { id: 'c1', elementId: 'a', messages: [{ id: 'm1', author: 'alice', text: 'Why REST?' }, { id: 'm2', author: 'bob', text: 'Legacy', replyTo: 'm1' }] },
        { id: 'c2', resolved: true, x: 0, y: 0, messages: [] },
      ],
    },
  })
  assert.match(md, /## Comments — 1 open thread, 1 resolved\n- \[c1\] on "API" \[a\] — alice: "Why REST\?"\n {2}- bob \(replying to alice: "Why REST\?"\): "Legacy"/)
})

test('colour is named in words', () => {
  assert.equal(colorName('#e03131'), 'red')
  assert.equal(colorName('#ffc9c9'), 'light red')
  assert.equal(colorName('#a5d8ff'), 'light blue')
  assert.equal(colorName('#1e1e1e'), 'black')
  assert.equal(colorName('transparent'), null)
})

test('counter plurals', () => {
  assert.equal(plural(1, 'shape'), '1 shape')
  assert.equal(plural(0, 'shape'), '0 shapes')
  assert.equal(plural(3, 'shape'), '3 shapes')
  assert.equal(plural(2, 'child', 'children'), '2 children')
})

test('BOARDS_LOCALE=ru: the words around the content are Russian, ids, labels and structure are not', () => {
  const md = summarize([
    rect('a', 0, 0, { backgroundColor: '#ffc9c9', customData: { editedBy: 'Claude' } }), label('ta', 'a', 'Gateway'),
    rect('b', 300, 0), label('tb', 'b', 'Billing'),
    { ...base, id: 'ar', type: 'arrow', x: 100, y: 30, width: 200, height: 0, points: [[0, 0], [200, 0]], startBinding: { elementId: 'a' }, endBinding: { elementId: 'b' }, endArrowhead: 'arrow' },
  ], {
    title: 'Схема',
    task: 'PROJ-12',
    locale: 'ru',
    notes: { comments: [{ id: 'c1', elementId: 'a', x: 0, y: 0, messages: [{ id: 'm1', author: 'alice', text: 'Почему?' }] }, { id: 'c2', resolved: true, x: 0, y: 0, messages: [] }] },
  })
  assert.match(md, /^# Доска "Схема"/)
  assert.match(md, /2 фигуры, 1 связь, 0 текстов/)
  assert.match(md, /## Фигуры\n- \[a\] прямоугольник "Gateway" \(0,0 100×60\) — заливка: светло-красный · правил Claude/)
  assert.match(md, /## Связи\n- \[ar\] "Gateway" \[a\] → "Billing" \[b\]/)
  assert.match(md, /## Комментарии — 1 открытое обсуждение, закрытых: 1\n- \[c1\] на "Gateway" \[a\] — alice: "Почему\?"/)
  assert.match(md, /Проверка на нейрослоп/)
  assert.doesNotMatch(md, /Board|Shapes|Connections|Comments|Slop check/)
})

test('Russian counters use all three plural forms', () => {
  const many = Array.from({ length: 5 }, (_, i) => rect(`r${i}`, i * 200, 0))
  assert.match(summarize(many.slice(0, 1), { locale: 'ru' }), /1 фигура,/)
  assert.match(summarize(many.slice(0, 3), { locale: 'ru' }), /3 фигуры,/)
  assert.match(summarize(many, { locale: 'ru' }), /5 фигур,/)
  assert.match(summarize([], { locale: 'ru' }), /Доска пуста\./)
})
