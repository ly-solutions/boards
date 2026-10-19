import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyDeletes, applyUpdates, EditError, layoutGraph, loadEngine, materialize, segmentHitsBox } from '../server/engine.mjs'
import { summarize } from '../server/summary.mjs'

const merge = (scene, changed) => {
  const map = new Map(scene.map((el) => [el.id, el]))
  for (const el of changed) map.set(el.id, el)
  return [...map.values()]
}

test('a graph becomes Excalidraw elements with bound arrows and a group frame', async () => {
  const { measureLine } = await loadEngine()
  const skeleton = layoutGraph({
    nodes: [{ id: 'a', label: 'Gateway', group: 'Cluster' }, { id: 'b', label: 'Billing', color: 'green' }],
    edges: [{ from: 'a', to: 'b', label: 'HTTP' }],
  }, { measureLine })
  const { created } = await materialize(skeleton, [])
  const arrow = created.find((el) => el.type === 'arrow')
  assert.equal(arrow.startBinding.elementId, 'a')
  assert.equal(arrow.endBinding.elementId, 'b')
  const a = created.find((el) => el.id === 'a')
  assert.ok(a.boundElements.some((b) => b.id === arrow.id), 'the shape knows its arrow, or Excalidraw will not drag it along')
  const frame = created.find((el) => el.type === 'frame')
  assert.equal(frame.name, 'Cluster')
  assert.equal(a.frameId, frame.id)
  assert.equal(created.find((el) => el.id === 'b').backgroundColor, '#f2fcf3')
  assert.equal(created.find((el) => el.id === 'b').strokeColor, '#b2f2bb')
  assert.equal(created.find((el) => el.id === 'b').roughness, 0)
  // Indices are unique and the frame comes before its children.
  assert.equal(new Set(created.map((el) => el.index)).size, created.length)
  assert.ok(frame.index < a.index)
  assert.match(summarize(created), /"Gateway" \[a\] → "Billing" \[b\] — "HTTP"/)
})

test('an addition connects to an existing shape without moving it', async () => {
  const { measureLine } = await loadEngine()
  const first = (await materialize(layoutGraph({ nodes: [{ id: 'old', label: 'Old' }] }, { measureLine }), [])).created
  const old = first.find((el) => el.id === 'old')
  const skeleton = layoutGraph({ nodes: [{ id: 'new', label: 'New' }], edges: [{ from: 'old', to: 'new' }] }, { measureLine, existing: first })
  const { created, changed } = await materialize(skeleton, first)
  const updatedOld = changed.find((el) => el.id === 'old')
  assert.equal(updatedOld.x, old.x)
  assert.equal(updatedOld.version, old.version + 1)
  assert.ok(updatedOld.boundElements.some((b) => b.type === 'arrow'))
  assert.ok(created.every((el) => el.index > old.index), 'new elements are drawn on top of old ones')
})

test('a taken id or an edge to nowhere is a clear error, not a silently broken board', async () => {
  const { measureLine } = await loadEngine()
  const scene = (await materialize(layoutGraph({ nodes: [{ id: 'x' }] }, { measureLine }), [])).created
  assert.throws(() => layoutGraph({ nodes: [{ id: 'x' }] }, { measureLine, existing: scene }), EditError)
  assert.throws(() => layoutGraph({ nodes: [{ id: 'y' }], edges: [{ from: 'y', to: 'nope' }] }, { measureLine, existing: scene }), /nope/)
})

test('label, move and colour edits bump versions; a move drags the label and arrows', async () => {
  const { measureLine } = await loadEngine()
  let scene = (await materialize(layoutGraph({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] }, { measureLine }), [])).created
  const arrowBefore = scene.find((el) => el.type === 'arrow')
  const labelBefore = scene.find((el) => el.containerId === 'a')
  const aBefore = scene.find((el) => el.id === 'a')
  scene = merge(scene, applyUpdates([{ id: 'a', label: 'New label', y: 500, color: 'red' }], scene))
  const label = scene.find((el) => el.containerId === 'a')
  assert.equal(label.text, 'New label')
  assert.equal(label.y - labelBefore.y, 500 - aBefore.y, 'the label moves with the shape')
  assert.equal(scene.find((el) => el.id === 'a').strokeColor, '#ffa8a8')
  const arrow = scene.find((el) => el.type === 'arrow')
  assert.ok(arrow.version > arrowBefore.version)
  assert.notDeepEqual(arrow.points, arrowBefore.points)
})

test('delete removes the label and unbinds arrows', async () => {
  const { measureLine } = await loadEngine()
  let scene = (await materialize(layoutGraph({ nodes: [{ id: 'a' }, { id: 'b' }], edges: [{ from: 'a', to: 'b' }] }, { measureLine }), [])).created
  scene = merge(scene, applyDeletes(['a'], scene))
  assert.equal(scene.find((el) => el.id === 'a').isDeleted, true)
  assert.equal(scene.find((el) => el.containerId === 'a').isDeleted, true)
  assert.equal(scene.find((el) => el.type === 'arrow').startBinding, null)
})

test('segment versus box intersection', () => {
  const box = { x: 10, y: 10, w: 10, h: 10 }
  assert.equal(segmentHitsBox({ x: 0, y: 15 }, { x: 30, y: 15 }, box), true)
  assert.equal(segmentHitsBox({ x: 0, y: 40 }, { x: 30, y: 40 }, box), false)
  assert.equal(segmentHitsBox({ x: 0, y: 0 }, { x: 5, y: 5 }, box, 0), false)
})
