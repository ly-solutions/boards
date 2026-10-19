/**
 * Vite plugin: Excalidraw's fonts are served by boards itself, never by a third party.
 *
 * - `writeBundle` copies the package's font files to `<outDir>/fonts`, next to the editor (served at
 *   /b/_static/fonts/…; web/src/boot.ts points EXCALIDRAW_ASSET_PATH there).
 * - The package also lists a CDN copy of every font (esm.sh) as a second source. Browsers request it alongside
 *   ours; the page CSP (`font-src 'self'`) blocks it and the console fills with violations. `transform` makes that
 *   fallback base our own static base, so both sources point to our host.
 * - `generateBundle` fails the build if any emitted chunk still mentions the CDN, so a package upgrade that moves
 *   the code cannot silently bring the third-party requests back.
 */
import { cp } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const CDN_HOST = 'esm.sh'

/**
 * The package defines the fallback as a template literal that starts with the CDN origin and ends in `/dist/prod/`
 * (with a nested template for the package name in between), so match lazily up to that ending.
 */
const FALLBACK_LITERAL = /`https:\/\/esm\.sh\/[\s\S]{0,200}?\/dist\/prod\/`/g
const OWN_BASE = '(globalThis.EXCALIDRAW_ASSET_PATH||"/b/_static/")'

/** Replace the CDN fallback base in package source; returns null when the source does not contain it. */
export function pointFallbackHome(code) {
  if (!code.includes(`https://${CDN_HOST}/`)) return null
  const next = code.replace(FALLBACK_LITERAL, OWN_BASE)
  return next === code ? null : next
}

export function packageFontsDir() {
  return fileURLToPath(new URL('../node_modules/@excalidraw/excalidraw/dist/prod/fonts', import.meta.url))
}

export function selfHostedFonts() {
  let outDir = 'dist/web'
  let replaced = 0
  return {
    name: 'boards-self-hosted-fonts',
    configResolved(config) {
      outDir = config.build.outDir
    },
    transform(code, id) {
      if (!id.includes('@excalidraw/excalidraw')) return null
      const next = pointFallbackHome(code)
      if (next === null) return null
      replaced += 1
      return { code: next, map: null }
    },
    generateBundle(_, bundle) {
      const leaking = Object.values(bundle).filter((chunk) => chunk.type === 'chunk' && chunk.code.includes(`https://${CDN_HOST}/`))
      if (leaking.length) this.error(`third-party font CDN still referenced in: ${leaking.map((c) => c.fileName).join(', ')}`)
      if (!replaced) this.error('the Excalidraw font fallback was not found: check scripts/self-hosted-fonts.mjs against the pinned package version')
    },
    async writeBundle() {
      await cp(packageFontsDir(), join(outDir, 'fonts'), { recursive: true })
    },
  }
}
