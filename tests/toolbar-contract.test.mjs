/**
 * Contract with Excalidraw internals.
 *
 * The studio buttons are injected into the Excalidraw top toolbar around its API:
 * 0.18 has no way to add a custom button to the shapes toolbar. So the package is
 * pinned, and this test fails if an upgrade drops the markup or behaviour that
 * web/src/studio.tsx relies on. Policy: don't upgrade Excalidraw casually; when
 * you do, run through the whole editor in a browser.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// The package does not export package.json, so read it straight from node_modules.
const root = fileURLToPath(new URL('../node_modules/@excalidraw/excalidraw/', import.meta.url))
const pkgPath = join(root, 'package.json')

test('Excalidraw is pinned to 0.18.1 — upgrade only with a full in-browser editor run', () => {
  const ours = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(ours.devDependencies['@excalidraw/excalidraw'], '0.18.1', 'version in package.json without ^ or ~')
  assert.equal(JSON.parse(readFileSync(pkgPath, 'utf8')).version, '0.18.1')
})

test('the package has the toolbar markup and custom-tool behaviour the studio relies on', () => {
  const dist = join(root, 'dist', 'prod')
  const code = readdirSync(dist).filter((f) => f.endsWith('.js')).map((f) => readFileSync(join(dist, f), 'utf8')).join('\n')
  const css = readdirSync(dist).filter((f) => f.endsWith('.css')).map((f) => readFileSync(join(dist, f), 'utf8')).join('\n')
  const both = code + css
  // TOOLBAR_ROW in studio.tsx and ToolButton classes (the size class is built as ToolIcon_size_${size}).
  for (const cls of ['App-toolbar', 'App-toolbar--mobile', 'App-toolbar__divider', 'Stack_horizontal', 'ToolIcon', 'ToolIcon__icon', 'ToolIcon_type_radio', 'ToolIcon_size_', 'sidebar-trigger__label', 'layer-ui__wrapper__top-right', 'UserList__wrapper']) {
    assert.ok(both.includes(cls), `class ${cls} is gone from Excalidraw — check how the studio buttons are injected`)
  }
  // Right island: the laser island is hidden by its button class, the editor's Library button
  // joins the row by its wrapper class and opens from the "More" menu via toggleSidebar,
  // and the package counts avatars by wrapper width — 38 px per avatar.
  for (const cls of ['ToolIcon__LaserPointer', 'sidebar-trigger__label-element', 'App-toolbar-container', 'UserList__collaborator']) {
    assert.ok(both.includes(cls), `class ${cls} is gone from Excalidraw — check the right island in editor.css`)
  }
  assert.match(code, /toggleSidebar/)
  assert.match(code, /Math\.floor\(\w+\/38\)/, 'avatar slot width in the participant list is 38 px')
  // Sticky and comment are activeTool {type: 'custom'}: Excalidraw draws no shape
  // for it and passes the point to onPointerDown.
  assert.match(code, /"custom"/)
  assert.match(code, /onPointerDown/)
  assert.match(code, /setActiveTool/)
})
