/**
 * The people of a board and the mentions a comment sends (HRN-1469, server/people.mjs): a stable id per signed-in
 * person, kept in storage and never sent to editors; the webhook names a mentioned person with that id, the agent
 * apart, the author never.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { mentionsIn, peopleNames, personId, rememberPerson } from '../server/people.mjs'
import { createWebhook } from '../server/hooks.mjs'
import { startApp } from './helpers/app.mjs'

const mailId = (secret, email) => `mail:${createHmac('sha256', secret).update(email).digest('hex')}`

test('personId: the hub id from the harnessly app view, a keyed hash of the e-mail otherwise, none for guests and tokens', () => {
  assert.equal(personId({ via: 'harnessly', sub: 'u_42', email: 'a@x.ru' }, 's'), 'hub:u_42')
  assert.equal(personId({ via: 'oidc', sub: 'z1', email: 'A@X.ru ' }, 's'), mailId('s', 'a@x.ru'))
  assert.equal(personId({ via: 'oidc', sub: 'z1', email: 'a@x.ru' }, ''), null, 'no secret: nobody could read the id')
  assert.equal(personId({ via: 'oidc', sub: 'z1', email: null }, 's'), null)
  assert.equal(personId({ via: 'token', sub: 'token:bot', email: 'bot@x.ru' }, 's'), null)
  assert.equal(personId({ via: 'none', sub: 'local', email: null }, 's'), null)
  assert.equal(personId(null, 's'), null)
  assert.doesNotMatch(personId({ via: 'oidc', email: 'a@x.ru' }, 's'), /@/, 'the e-mail is not in the id')
})

test('rememberPerson keeps a person once and follows a new name; peopleNames shows names only', () => {
  const notes = { comments: [] }
  assert.equal(rememberPerson(notes, 'hub:1', 'Ада'), true)
  assert.equal(rememberPerson(notes, 'hub:1', 'Ада'), false)
  assert.equal(rememberPerson(notes, 'hub:1', 'Ада Л.'), true)
  assert.equal(rememberPerson(notes, null, 'Гость'), false)
  assert.deepEqual(peopleNames(notes), ['Ада Л.'])
})

test('mentionsIn: the agent apart, people with their id, the author never, a name inside a word is not a mention', () => {
  const notes = {
    people: { 'hub:1': { name: 'Ada Lovelace' }, 'hub:2': { name: 'Bob' }, 'hub:3': { name: 'Bobby' } },
    comments: [{ messages: [{ author: 'Kim', authorKind: 'person', text: 'old' }, { author: 'guest: Joe', authorKind: 'person' }] }],
  }
  assert.deepEqual(mentionsIn('@harnessly и @Ada Lovelace, глянь', notes, { authorId: 'hub:2', authorName: 'Bob' }), [
    { name: 'harnessly', agent: true },
    { name: 'Ada Lovelace', id: 'hub:1' },
  ])
  assert.deepEqual(mentionsIn('@bob посмотри', notes, { authorId: 'hub:2', authorName: 'Bob' }), [], 'the author does not call themself')
  assert.deepEqual(mentionsIn('mail@Bob.ru', notes), [])
  assert.deepEqual(mentionsIn('@Kim и @guest: Joe', notes), [{ name: 'Kim', id: null }], 'an old author without an id is named, a guest is not')
})

function recordingWebhook(secret) {
  const calls = []
  const webhook = createWebhook({
    url: 'https://hooks.example/boards',
    secret,
    fetchImpl: async (url, init) => {
      calls.push(JSON.parse(init.body))
      return new Response('{}', { status: 200 })
    },
    log: () => {},
  })
  return { webhook, calls }
}

test('HTTP: a signed-in person is remembered, a mention carries their id, editors never see ids', async () => {
  const secret = 's3cret'
  const { webhook, calls } = recordingWebhook(secret)
  const t = await startApp({ config: { webhook: { url: 'https://hooks.example/boards', secret } }, appOptions: { webhook } })
  try {
    const { body } = await t.createBoard({ title: 'Mentions' })
    const k = new URL(body.url).searchParams.get('k')
    const ada = { 'content-type': 'application/json', cookie: t.cookie({ name: 'Ada Lovelace', email: 'ada@example.com', via: 'oidc', sub: 'z-ada' }) }
    const bob = { 'content-type': 'application/json', cookie: t.cookie({ name: 'Bob', email: 'bob@example.com', via: 'harnessly', sub: 'u_bob' }) }
    const post = (path, payload, headers) => fetch(`${t.base}/b/${body.slug}/${path}?k=${k}`, { method: 'POST', headers, body: JSON.stringify(payload) })

    let res = await post('comments', { text: 'Кто делает шлюз?', x: 0, y: 0 }, ada)
    assert.equal(res.status, 201)
    const created = await res.json()
    assert.equal(created.thread.messages[0].authorId, undefined, 'the answer to the editor has no ids')
    assert.deepEqual(created.notes.people, ['Ada Lovelace'])

    res = await post(`comments/${created.thread.id}`, { reply: '@Ada Lovelace я, и @harnessly поможет' }, bob)
    assert.equal(res.status, 200)
    const replied = await res.json()
    assert.ok(replied.notes.comments[0].messages.every((m) => m.authorId === undefined))

    await webhook.settle()
    const [first, second] = calls
    assert.equal(first.message.authorId, mailId(secret, 'ada@example.com'))
    assert.deepEqual(first.message.mentions, [])
    assert.equal(second.message.authorId, 'hub:u_bob')
    assert.deepEqual(second.message.mentions, [
      { name: 'harnessly', agent: true },
      { name: 'Ada Lovelace', id: mailId(secret, 'ada@example.com') },
    ])

    // What the editor loads has names only; storage keeps the ids.
    const scene = await (await fetch(`${t.base}/b/${body.slug}/scene.excalidraw?k=${k}`)).json()
    assert.deepEqual(scene.notes.people.sort(), ['Ada Lovelace', 'Bob'])
    assert.doesNotMatch(JSON.stringify(scene), /hub:u_bob|mail:/)
    await t.store.flushAll()
    t.store._boards.clear()
    const again = await (await fetch(`${t.base}/b/${body.slug}/scene.excalidraw?k=${k}`)).json()
    assert.deepEqual(again.notes.people.sort(), ['Ada Lovelace', 'Bob'], 'people survive a restart')
    res = await post(`comments/${created.thread.id}`, { reply: '@Bob спасибо' }, ada)
    await webhook.settle()
    assert.deepEqual(calls.at(-1).message.mentions, [{ name: 'Bob', id: 'hub:u_bob' }], 'ids come back from storage')
  } finally {
    await t.close()
  }
})

test('mentionsIn: a name is a whole word — @Bobby does not call Bob; two people with one name are both called', () => {
  const notes = { people: { 'hub:2': { name: 'Bob' }, 'hub:3': { name: 'Bobby' }, 'hub:4': { name: 'Bob' } }, comments: [] }
  assert.deepEqual(mentionsIn('@Bobby, привет', notes).map((m) => m.id), ['hub:3'])
  assert.deepEqual(mentionsIn('@Bob.', notes).map((m) => m.id), ['hub:2', 'hub:4'])
})
