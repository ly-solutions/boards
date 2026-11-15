// HRN-1519: a harnessly hub decides who may view, comment on and edit a board it knows, and its links without sign-in
// open here as /b/<slug>?g=<token>.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { startApp } from './helpers/app.mjs'
import { createHubRights } from '../server/hub-rights.mjs'

const HUB = 'http://hub.test'
const SECRET = 'hub-secret'
const LINK_VIEW = 'v'.repeat(32)
const LINK_COMMENT = 'c'.repeat(32)

// What the fake hub holds: rights by address per board, the boards it knows, its guest links.
const hub = { rights: {}, known: new Set(), links: {}, calls: [], down: false }

async function fakeHub(url, init) {
  const body = JSON.parse(init.body)
  hub.calls.push({ url, body })
  if (hub.down) throw new Error('connection refused')
  if (init.headers.authorization !== `Bearer ${SECRET}`) return new Response('{}', { status: 401 })
  if (url === `${HUB}/api/platform/docs/_rights`) {
    const who = body.email ?? body.sub
    const rights = {}
    for (const slug of body.slugs) rights[slug] = hub.rights[slug]?.[who] ?? 'none'
    return Response.json({ rights, known: body.slugs.filter((s) => hub.known.has(s)) })
  }
  if (url === `${HUB}/api/platform/docs/_guest`) {
    const link = hub.links[body.token]
    if (!link || link.slug !== body.slug) return new Response('{}', { status: 404 })
    return Response.json({ slug: link.slug, rights: link.rights, forWhom: link.forWhom, linkId: 'l1' })
  }
  return new Response('{}', { status: 404 })
}

let t
before(async () => {
  t = await startApp({ appOptions: { hubRights: createHubRights({ issuer: HUB, token: SECRET, ttlMs: 0, fetchImpl: fakeHub }) } })
})
after(() => t.close())

const OWNER = { name: 'Owner', email: 'owner@example.com' }
const VIEWER = { name: 'Viewer', email: 'viewer@example.com' }
const COMMENTER = { name: 'Commenter', email: 'commenter@example.com' }
const STRANGER = { name: 'Stranger', email: 'stranger@example.com' }

async function knownBoard() {
  const { body } = await t.createBoard({ title: 'Shared plan' })
  hub.known.add(body.slug)
  hub.rights[body.slug] = { [OWNER.email]: 'edit', [VIEWER.email]: 'view', [COMMENTER.email]: 'comment' }
  return { slug: body.slug, key: new URL(body.url).searchParams.get('k') }
}

const pageConfig = async (path, user) => {
  const res = await fetch(`${t.base}${path}`, { headers: user ? { cookie: t.cookie(user) } : {} })
  if (res.status !== 200) return { status: res.status }
  const html = await res.text()
  const json = /<script[^>]*id="board-config"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1]
  return { status: 200, html, config: JSON.parse(json.replace(/\\u003c/g, '<')) }
}

const comment = (slug, cred, user) =>
  fetch(`${t.base}/b/${slug}/comments?k=${encodeURIComponent(cred)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { cookie: t.cookie(user) } : {}) },
    body: JSON.stringify({ text: 'A question', x: 10, y: 10 }),
  })

const push = (slug, cred, user) =>
  fetch(`${t.base}/b/${slug}/edit?k=${encodeURIComponent(cred)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(user ? { cookie: t.cookie(user) } : {}) },
    body: JSON.stringify({ graph: { nodes: [{ id: 'x', label: 'New' }] } }),
  })

test('the hub gives each signed-in person their role on a board it knows; the address opens without the key', async () => {
  const { slug } = await knownBoard()
  const owner = await pageConfig(`/b/${slug}`, OWNER)
  assert.equal(owner.status, 200)
  assert.equal(owner.config.canEdit, true)
  assert.equal(owner.config.canComment, true)
  assert.equal(owner.config.hubDecided, true)
  assert.match(owner.config.shareUrl, /^http:\/\/hub\.test\/docs\/.+\?share=1$/)
  const viewer = await pageConfig(`/b/${slug}`, VIEWER)
  assert.equal(viewer.config.canEdit, false)
  assert.equal(viewer.config.canComment, false)
  const commenter = await pageConfig(`/b/${slug}`, COMMENTER)
  assert.equal(commenter.config.canEdit, false)
  assert.equal(commenter.config.canComment, true)
  // Nobody gave the stranger anything: without the key the board is not there.
  assert.equal((await pageConfig(`/b/${slug}`, STRANGER)).status, 404)
})

test('view may not comment or edit, comment may comment but not edit, edit may both', async () => {
  const { slug, key } = await knownBoard()
  assert.equal((await comment(slug, key, VIEWER)).status, 403)
  assert.equal((await push(slug, key, VIEWER)).status, 403)
  assert.equal((await comment(slug, key, COMMENTER)).status, 201)
  assert.equal((await push(slug, key, COMMENTER)).status, 403)
  assert.equal((await comment(slug, key, OWNER)).status, 201)
  assert.equal((await push(slug, key, OWNER)).status, 200)
})

test('the board key alone reads and nothing more on a board the hub knows', async () => {
  const { slug, key } = await knownBoard()
  const anon = await pageConfig(`/b/${slug}?k=${key}`)
  assert.equal(anon.status, 200)
  assert.equal(anon.config.canEdit, false)
  assert.equal(anon.config.canComment, false)
  assert.equal((await comment(slug, key)).status, 403)
  // A stranger signed in with the key reads too, and only reads.
  const stranger = await pageConfig(`/b/${slug}?k=${key}`, STRANGER)
  assert.equal(stranger.config.canEdit, false)
})

test('a guest link opens the board with what it allows and never shows the board key', async () => {
  const { slug, key } = await knownBoard()
  hub.links[LINK_VIEW] = { slug, rights: 'view', forWhom: 'Partner' }
  hub.links[LINK_COMMENT] = { slug, rights: 'comment', forWhom: 'Client' }
  const view = await pageConfig(`/b/${slug}?g=${LINK_VIEW}`)
  assert.equal(view.status, 200)
  assert.equal(view.config.canEdit, false)
  assert.equal(view.config.canComment, false)
  assert.equal(view.config.key, `g.${LINK_VIEW}`)
  assert.ok(!view.html.includes(key), 'the board key is not on a guest page')
  assert.equal((await comment(slug, `g.${LINK_VIEW}`)).status, 403)
  const talk = await pageConfig(`/b/${slug}?g=${LINK_COMMENT}`)
  assert.equal(talk.config.canComment, true)
  assert.equal(talk.config.canEdit, false)
  const made = await comment(slug, `g.${LINK_COMMENT}`)
  assert.equal(made.status, 201)
  const first = (await made.json()).thread.messages[0]
  assert.equal(first.author?.name ?? first.author, 'guest: Client')
  assert.equal((await push(slug, `g.${LINK_COMMENT}`)).status, 403)
  // A link for another board, or one the hub switched off, opens nothing.
  const other = await knownBoard()
  assert.equal((await pageConfig(`/b/${other.slug}?g=${LINK_VIEW}`)).status, 404)
  delete hub.links[LINK_VIEW]
  assert.equal((await pageConfig(`/b/${slug}?g=${LINK_VIEW}`)).status, 404)
})

test('a board the hub has never heard of keeps the service rules', async () => {
  const { body } = await t.createBoard({ title: 'Old board' })
  const page = await pageConfig(`/b/${body.slug}?k=${new URL(body.url).searchParams.get('k')}`, STRANGER)
  assert.equal(page.config.canEdit, true)
  assert.equal(page.config.hubDecided, false)
})

test('a hub that does not answer closes the board rather than opening it to everyone', async () => {
  const { slug } = await knownBoard()
  hub.down = true
  try {
    assert.equal((await pageConfig(`/b/${slug}`, OWNER)).status, 503)
  } finally {
    hub.down = false
  }
})
