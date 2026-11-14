import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sketchSvg } from '../server/sketch.mjs'

test('a sketch of a board no browser drew: its shapes, lines and text, fitted and escaped', () => {
  const svg = sketchSvg([
    { id: 'a', type: 'rectangle', x: 0, y: 0, width: 200, height: 100 },
    { id: 'b', type: 'ellipse', x: 400, y: 0, width: 100, height: 100 },
    { id: 'c', type: 'arrow', x: 200, y: 50, width: 200, height: 0, points: [[0, 0], [200, 0]] },
    { id: 'd', type: 'text', x: 10, y: 10, width: 80, height: 20, fontSize: 20, text: 'Оплата <script>' },
    { id: 'e', type: 'rectangle', x: 9000, y: 9000, width: 10, height: 10, isDeleted: true },
  ])
  assert.match(svg, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"/)
  assert.match(svg, /<rect /)
  assert.match(svg, /<ellipse /)
  assert.match(svg, /<polyline /)
  assert.match(svg, /Оплата &lt;script&gt;/)
  assert.doesNotMatch(svg, /<script/)
  // the deleted shape far away does not shrink the rest
  for (const [, v] of svg.matchAll(/x="(-?[\d.]+)"/g)) assert.ok(Number(v) >= 0 && Number(v) <= 400)
})

test('an empty board is an empty sketch', () => {
  assert.equal(sketchSvg([]), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300" width="400" height="300"></svg>')
})
