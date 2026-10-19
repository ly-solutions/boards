import { test } from 'node:test'
import assert from 'node:assert/strict'
import { byIndex, incomingWins, isMergeableElement } from '../server/merge.mjs'

const el = (over) => ({ id: 'a', type: 'rectangle', version: 1, versionNonce: 10, ...over })

test('the higher version wins, the lower does not', () => {
  assert.equal(incomingWins(el({ version: 2 }), el({ version: 3 })), true)
  assert.equal(incomingWins(el({ version: 3 }), el({ version: 2 })), false)
})

test('on equal versions the lower nonce wins, as in Excalidraw reconcileElements', () => {
  assert.equal(incomingWins(el({ versionNonce: 50 }), el({ versionNonce: 5 })), true)
  assert.equal(incomingWins(el({ versionNonce: 5 }), el({ versionNonce: 50 })), false)
  // The very same element again is not an edit.
  assert.equal(incomingWins(el(), el()), false)
})

test('a new element is always accepted', () => {
  assert.equal(incomingWins(undefined, el()), true)
})

test('an element without id or version, or of an unknown type, is rejected', () => {
  assert.equal(isMergeableElement(el()), true)
  assert.equal(isMergeableElement(el({ id: '' })), false)
  assert.equal(isMergeableElement(el({ id: 'x'.repeat(65) })), false)
  assert.equal(isMergeableElement(el({ version: 'one' })), false)
  assert.equal(isMergeableElement(el({ type: 'script' })), false)
  assert.equal(isMergeableElement(null), false)
})

test('canvas order follows the fractional index', () => {
  const list = [el({ id: 'c', index: 'a2' }), el({ id: 'a', index: 'a0' }), el({ id: 'b', index: 'a1' })]
  assert.deepEqual(list.sort(byIndex).map((e) => e.id), ['a', 'b', 'c'])
})
