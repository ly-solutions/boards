/**
 * Excalidraw render patches rely on exact pieces of the package code — see
 * scripts/excalidraw-patches.mjs. This test fails before the build does if the
 * package changed and any patch does not find its piece exactly once, or if a
 * patched module is no longer valid JavaScript.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { FILES, PATCHES, SNAP_COLOR, SNAP_COLOR_DARK, SNAP_CROSS, SNAP_LINE, STICKY_FONT_STEP, STICKY_MIN_FONT, applyPatches, fileOf } from '../scripts/excalidraw-patches.mjs'

const paths = {
  render: fileURLToPath(new URL('../node_modules/@excalidraw/excalidraw/dist/prod/chunk-K2UTITRG.js', import.meta.url)),
  app: fileURLToPath(new URL('../node_modules/@excalidraw/excalidraw/dist/prod/index.js', import.meta.url)),
}

test('patched Excalidraw files exist and match the plugin rules', () => {
  assert.deepEqual(Object.keys(paths).sort(), Object.keys(FILES).sort())
  for (const [file, path] of Object.entries(paths)) assert.equal(fileOf(path), file)
})

test('every render patch finds its code in the package exactly once', () => {
  for (const patch of PATCHES) {
    const code = readFileSync(paths[patch.file], 'utf8')
    assert.equal(code.split(patch.find).length - 1, 1, `patch ${patch.id}`)
  }
})

test('patched Excalidraw modules are valid JavaScript', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tb-patch-'))
  for (const [file, path] of Object.entries(paths)) {
    const out = join(dir, `${file}.mjs`)
    writeFileSync(out, applyPatches(readFileSync(path, 'utf8'), file))
    execFileSync(process.execPath, ['--check', out])
  }
})

test("snapping guides use our color instead of the package's pale red", () => {
  const code = readFileSync(paths.app, 'utf8')
  assert.match(code, /var c5="#ff6b6b",d5="#ff0000",G1=1,Y1=2,/)
  const patched = applyPatches(code, 'app')
  assert.doesNotMatch(patched, /#ff6b6b/)
  assert.match(patched, new RegExp(`var c5="${SNAP_COLOR}",d5="${SNAP_COLOR_DARK}",G1=${SNAP_LINE},Y1=${SNAP_CROSS},`))
})

test("snap gaps: comparing numbers gives the same answer as the package's ranges", () => {
  // The package's Lr means "ranges overlap"; the patch replaces it with a<=d&&c<=b.
  const overlaps = ([e, t], [n, r]) => (e <= n ? t >= n : e >= n && r >= e)
  for (let a = -3; a <= 3; a++)
    for (let len1 = 0; len1 <= 3; len1++)
      for (let c = -3; c <= 3; c++)
        for (let len2 = 0; len2 <= 3; len2++) {
          const b = a + len1
          const d = c + len2
          assert.equal(a <= d && c <= b, overlaps([a, b], [c, d]), `[${a},${b}] and [${c},${d}]`)
        }
})

test('sticky: the label font size is fitted to the size instead of growing the shape to the text', () => {
  const code = readFileSync(paths.render, 'utf8')
  const patched = applyPatches(code, 'render')
  // Fitting runs before the package grows the shape to fit the text, and only for stickies.
  const fit = patched.indexOf('e.customData.kind==="sticky"')
  const grow = patched.indexOf('if(s>l){U=qa(s,e.type);')
  assert.ok(fit > 0 && grow > fit, 'font fitting runs before the shape grows')
  assert.match(patched, new RegExp(`__f<=${STICKY_MIN_FONT}\\)break;__f=Math\\.max\\(${STICKY_MIN_FONT},Math\\.floor\\(__f\\*${STICKY_FONT_STEP}\\)\\)`))
  assert.match(patched, /stickyFont:__b/)
})


test('smooth camera hooks are silent while there is no camera', () => {
  // The board page installs the camera, but the package is also bundled where there is none
  // (server bundle, tests). Every hook must check that it exists first.
  const hooks = PATCHES.filter((p) => p.id.startsWith('motion-'))
  assert.deepEqual(hooks.map((p) => p.id).sort(), ['motion-action', 'motion-drag', 'motion-grab', 'motion-mount', 'motion-release', 'motion-wheel'])
  for (const hook of hooks) {
    const calls = hook.replace.match(/globalThis\.__tbMotion\.\w+\(/g) ?? []
    const guards = hook.replace.match(/globalThis\.__tbMotion&&/g) ?? []
    assert.equal(calls.length, 1, `patch ${hook.id}: one camera call`)
    assert.equal(guards.length, 1, `patch ${hook.id}: the call is guarded by a camera check`)
  }
})
