/**
 * shared/links.mjs: which URLs become board cards, which become bookmarks and
 * which are left to Excalidraw's own embeds.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classify, fallbackLabel, refsOf, singleUrl } from '../shared/links.mjs'
import * as links from '../shared/links.mjs'

const origin = 'https://boards.example.com'

test('a /b/<slug> link is a board', () => {
  assert.deepEqual(classify('https://boards.example.com/b/q4-plan'), { kind: 'board', slug: 'q4-plan', ref: 'board:q4-plan', url: 'https://boards.example.com/b/q4-plan' })
  assert.equal(classify('  https://boards.example.com/b/q4-plan/  ').slug, 'q4-plan')
  assert.equal(classify('http://localhost:3000/b/abc').kind, 'board')
})

test('with boardOrigin only links on that origin are boards', () => {
  assert.equal(classify('https://boards.example.com/b/q4-plan', { boardOrigin: origin }).kind, 'board')
  const foreign = classify('https://other.example.org/b/q4-plan', { boardOrigin: origin })
  assert.deepEqual(foreign, { kind: 'link', ref: 'link:https://other.example.org/b/q4-plan', url: 'https://other.example.org/b/q4-plan', host: 'other.example.org' })
  // Same host, different port or scheme — a different origin.
  assert.equal(classify('http://boards.example.com/b/q4-plan', { boardOrigin: origin }).kind, 'link')
})

test('slug rules: lowercase, 3–121 chars, no nested paths', () => {
  assert.equal(classify('https://x.dev/b/ab').kind, 'link')
  assert.equal(classify('https://x.dev/b/abc').kind, 'board')
  assert.equal(classify('https://x.dev/b/-abc').kind, 'link')
  assert.equal(classify('https://x.dev/b/Plan').kind, 'link')
  assert.equal(classify('https://x.dev/b/plan/edit').kind, 'link')
  assert.equal(classify(`https://x.dev/b/a${'b'.repeat(120)}`).kind, 'board')
  assert.equal(classify(`https://x.dev/b/a${'b'.repeat(121)}`).kind, 'link')
})

test('any other http(s) URL is a bookmark', () => {
  assert.deepEqual(classify('https://www.example.com/docs/intro?x=1'), { kind: 'link', ref: 'link:https://www.example.com/docs/intro?x=1', url: 'https://www.example.com/docs/intro?x=1', host: 'example.com' })
})

test('non-links and sites Excalidraw embeds itself are null', () => {
  for (const raw of ['', null, undefined, 'not a url', 'mailto:a@b.c', 'ftp://example.com/file', 'javascript:alert(1)']) assert.equal(classify(raw), null, String(raw))
  for (const raw of ['https://www.youtube.com/watch?v=x', 'https://youtu.be/x', 'https://vimeo.com/1', 'https://www.figma.com/file/x', 'https://x.com/a/status/1', 'https://excalidraw.com/#room=1']) assert.equal(classify(raw), null, raw)
})

test('singleUrl accepts exactly one URL', () => {
  assert.equal(singleUrl('  https://example.com/a  '), 'https://example.com/a')
  assert.equal(singleUrl('see https://example.com'), null)
  assert.equal(singleUrl('https://a.com https://b.com'), null)
  assert.equal(singleUrl('example.com'), null)
  assert.equal(singleUrl(null), null)
})

test('refsOf collects element links and card URLs, skipping deleted elements', () => {
  const elements = [
    { id: 'a', link: 'https://boards.example.com/b/roadmap' },
    { id: 'b', customData: { url: 'https://example.com/page' } },
    { id: 'c', link: 'https://boards.example.com/b/gone', isDeleted: true },
    { id: 'd', link: 'https://www.youtube.com/watch?v=x' },
    { id: 'e', text: 'mentions https://boards.example.com/b/in-text only in text' },
    null,
  ]
  assert.deepEqual([...refsOf(elements)].sort(), ['board:roadmap', 'link:https://example.com/page'])
  assert.deepEqual([...refsOf([{ id: 'x', link: 'https://elsewhere.dev/b/roadmap' }], { boardOrigin: origin })], ['link:https://elsewhere.dev/b/roadmap'])
  assert.equal(refsOf(undefined).size, 0)
})

test('fallbackLabel', () => {
  const board = classify('https://boards.example.com/b/roadmap')
  assert.equal(fallbackLabel({ kind: 'board', slug: 'roadmap', title: 'Roadmap' }, board), 'Board · Roadmap')
  assert.equal(fallbackLabel(null, board), board.url)
  const link = classify('https://www.example.com/docs/intro/')
  assert.equal(fallbackLabel(null, link), 'example.com/docs/intro')
  const long = classify(`https://example.com/${'x'.repeat(200)}`)
  assert.equal(fallbackLabel(null, long).length, 80)
})

test('issue-tracker exports are gone', () => {
  assert.deepEqual(Object.keys(links).sort(), ['classify', 'fallbackLabel', 'refsOf', 'singleUrl'])
})
