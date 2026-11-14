/**
 * Mentions in comments (HRN-1452, web/src/mentions.ts): `@` lists the agent and the people of the board, a pick puts
 * `@Name ` in the text, and a sent message shows its mentions as chips.
 */
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { transform } from 'esbuild'

let m
before(async () => {
  const source = readFileSync(fileURLToPath(new URL('../web/src/mentions.ts', import.meta.url)), 'utf8')
  const { code } = await transform(source, { loader: 'ts', format: 'esm', target: 'es2022' })
  const file = join(mkdtempSync(join(tmpdir(), 'tb-mentions-')), 'mentions.mjs')
  writeFileSync(file, code)
  m = await import(pathToFileURL(file).href)
})

test('the word being typed after @ is found before the caret, not inside an address', () => {
  assert.deepEqual(m.mentionQuery('@', 1), { start: 0, query: '' })
  assert.deepEqual(m.mentionQuery('привет @har', 11), { start: 7, query: 'har' })
  assert.deepEqual(m.mentionQuery('hi @Sergey Ch', 13), { start: 3, query: 'Sergey Ch' })
  assert.equal(m.mentionQuery('mail a@b.ru', 11), null)
  assert.equal(m.mentionQuery('@harnessly ', 11), null)
  assert.equal(m.mentionQuery('без собаки', 10), null)
})

test('the agent comes first where it can answer, then the people, without me and without twins', () => {
  const list = m.candidates(['Roman Kalmykov', 'Sergey Chernyshev', 'roman kalmykov', 'agent', 'harnessly'], 'agent', true)
  assert.deepEqual(list.map((c) => c.name), ['harnessly', 'Roman Kalmykov', 'Sergey Chernyshev'])
  assert.equal(list[0].agent, true)
  assert.deepEqual(m.candidates(['Ann'], null, false).map((c) => c.name), ['Ann'])
})

test('suggestions match the start of any word of a name', () => {
  const list = m.candidates(['Roman Kalmykov', 'Sergey Chernyshev'], null, true)
  assert.deepEqual(m.suggest('ch', list).map((c) => c.name), ['Sergey Chernyshev'])
  assert.deepEqual(m.suggest('h', list).map((c) => c.name), ['harnessly'])
  assert.equal(m.suggest('', list).length, 3)
})

test('a pick replaces the typed @word with @Name and a space, the caret after it', () => {
  assert.deepEqual(m.insertMention('эй @ser как дела', 3, 7, 'Sergey Chernyshev'), { text: 'эй @Sergey Chernyshev как дела', caret: 22 })
  assert.deepEqual(m.insertMention('@h', 0, 2, 'harnessly'), { text: '@harnessly ', caret: 11 })
})

test('a sent message splits into text and chips of the known names only', () => {
  const known = m.candidates(['Sergey Chernyshev', 'Sergey'], null, true)
  const parts = m.splitMentions('@harnessly как дела? @Sergey Chernyshev, глянь; a@harnessly.ru @nobody', known)
  assert.deepEqual(parts.map((p) => [p.text, p.mention?.name ?? null]), [
    ['@harnessly', 'harnessly'],
    [' как дела? ', null],
    ['@Sergey Chernyshev', 'Sergey Chernyshev'],
    [', глянь; a@harnessly.ru @nobody', null],
  ])
})
