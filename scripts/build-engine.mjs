/**
 * Server-side Excalidraw build: a single `dist/engine.mjs` file.
 *
 * The package cannot be imported from Node as is: it contains extensionless
 * imports (`roughjs/bin/rough`) that only a bundler understands. So esbuild
 * bundles it ahead of time, at image build, and the server loads the result.
 * jsdom stays external — it is a regular runtime dependency.
 */
import { build } from 'esbuild'

await build({
  entryPoints: ['engine/entry.mjs'],
  outfile: 'dist/engine.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  external: ['jsdom'],
  loader: { '.css': 'empty', '.woff2': 'empty', '.ttf': 'empty', '.scss': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.DEV': 'false', 'import.meta.env.PROD': 'true' },
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
  logLevel: 'warning',
  legalComments: 'none',
  minify: true,
})
console.log('dist/engine.mjs built')

// The editor's fonts for server pictures (server/picture.mjs): the package ships each font as woff2 subsets by
// script; resvg reads neither woff2 nor a family split across files, so each family is merged into one TTF named
// after the family. A font that does not merge (Nunito is a variable font) is left out: its text reads as a sans.
{
  const { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { decompress } = await import('wawoff2')
  const fe = await import('fonteditor-core')
  const Font = fe.Font ?? fe.default.Font
  const root = 'node_modules/@excalidraw/excalidraw/dist/prod/fonts'
  const FAMILIES = { Excalifont: 'Excalifont', Virgil: 'Virgil', Liberation: 'Liberation Sans', Lilita: 'Lilita One', ComicShanns: 'Comic Shanns', Cascadia: 'Cascadia Code' }
  mkdirSync('dist/fonts', { recursive: true })
  const done = []
  for (const [dir, family] of Object.entries(FAMILIES)) {
    if (!existsSync(join(root, dir))) continue
    try {
      let base = null
      for (const f of readdirSync(join(root, dir)).filter((x) => /\.(woff2|ttf)$/.test(x)).sort()) {
        const raw = readFileSync(join(root, dir, f))
        const font = Font.create(f.endsWith('.ttf') ? raw : Buffer.from(await decompress(raw)), { type: 'ttf', hinting: false })
        if (base) base.merge(font, { scale: 1 })
        else base = font
      }
      const data = base.get()
      Object.assign(data.name, { fontFamily: family, preferredFamily: family, fontSubFamily: 'Regular', fullName: family, postScriptName: family.replace(/ /g, '') })
      base.set(data)
      writeFileSync(join('dist/fonts', `${family}.ttf`), Buffer.from(base.write({ type: 'ttf' })))
      done.push(family)
    } catch (error) {
      console.warn(`font ${family} left out: ${String(error).slice(0, 120)}`)
    }
  }
  console.log(`dist/fonts: ${done.join(', ')}`)
}
