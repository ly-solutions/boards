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
