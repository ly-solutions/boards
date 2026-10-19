/** Static files and self-hosted fonts. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheControlFor, createStatic } from '../server/static.mjs'
import { CDN_HOST, packageFontsDir, pointFallbackHome } from '../scripts/self-hosted-fonts.mjs'
import { startApp } from './helpers/app.mjs'

test('cache policy follows hashed names', () => {
  assert.equal(cacheControlFor('assets/main-B2x9QaZk.js'), 'public, max-age=31536000, immutable')
  assert.equal(cacheControlFor('fonts/Excalifont/Excalifont-Regular-a88b72a24fb54c9f94e3b5fdaa7481c9.woff2'), 'public, max-age=31536000, immutable')
  assert.equal(cacheControlFor('fonts/Virgil/Virgil-Regular.woff2'), 'public, max-age=86400')
  assert.equal(cacheControlFor('favicon.svg'), 'public, max-age=300')
})

test('the handler serves files with type, CORS and compression, and refuses to leave its root', async () => {
  const root = await mkdtemp(join(tmpdir(), 'boards-static-'))
  await mkdir(join(root, 'assets'), { recursive: true })
  await mkdir(join(root, 'fonts', 'Virgil'), { recursive: true })
  await writeFile(join(root, 'assets', 'app-abcdef12.js'), `console.log(${JSON.stringify('x'.repeat(4000))})`)
  await writeFile(join(root, 'fonts', 'Virgil', 'Virgil-Regular.woff2'), Buffer.alloc(64, 1))
  await writeFile(join(tmpdir(), 'boards-static-secret.txt'), 'secret')
  const serve = createStatic({ root })
  const server = createServer(async (req, res) => {
    if (!(await serve(req, res, req.url.slice(1)))) {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const js = await fetch(`${base}/assets/app-abcdef12.js`, { headers: { 'accept-encoding': 'br, gzip' } })
    assert.equal(js.status, 200)
    assert.equal(js.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(js.headers.get('access-control-allow-origin'), '*')
    assert.equal(js.headers.get('content-encoding'), 'br')
    assert.match(await js.text(), /console\.log/)
    const font = await fetch(`${base}/fonts/Virgil/Virgil-Regular.woff2`)
    assert.equal(font.headers.get('content-type'), 'font/woff2')
    assert.equal(font.headers.get('cache-control'), 'public, max-age=86400')
    assert.equal((await fetch(`${base}/..%2Fboards-static-secret.txt`)).status, 404)
    assert.equal((await fetch(`${base}/nope.js`)).status, 404)
  } finally {
    server.close()
    await rm(root, { recursive: true, force: true })
    await rm(join(tmpdir(), 'boards-static-secret.txt'), { force: true })
  }
})

test('the package font fallback points home after the transform', () => {
  const pkg = join(packageFontsDir(), '..')
  const file = readdirSync(pkg).filter((f) => f.endsWith('.js')).map((f) => join(pkg, f)).find((f) => readFileSync(f, 'utf8').includes(`https://${CDN_HOST}/`))
  assert.ok(file, 'the pinned package still has a CDN fallback to replace')
  const patched = pointFallbackHome(readFileSync(file, 'utf8'))
  assert.ok(patched)
  assert.ok(!patched.includes(`https://${CDN_HOST}/`))
  assert.ok(patched.includes('globalThis.EXCALIDRAW_ASSET_PATH'))
  assert.equal(pointFallbackHome('const nothing = 1'), null)
  assert.ok(existsSync(join(packageFontsDir(), 'Excalifont')), 'fonts to copy exist in the package')
})

test('built output: fonts are copied and no chunk mentions the CDN; the page CSP allows only our fonts', async (t) => {
  const web = new URL('../dist/web/', import.meta.url).pathname
  if (!existsSync(join(web, '.vite/manifest.json'))) return t.skip('run npm run build first')
  assert.ok(existsSync(join(web, 'fonts', 'Excalifont')))
  for (const f of readdirSync(join(web, 'assets'))) if (f.endsWith('.js')) assert.ok(!readFileSync(join(web, 'assets', f), 'utf8').includes(`https://${CDN_HOST}/`), f)
  const app = await startApp()
  try {
    const { body } = await app.createBoard()
    const page = await fetch(body.url.replace('http://boards.test', app.base))
    const csp = page.headers.get('content-security-policy')
    assert.match(csp, /font-src 'self' data:/)
    assert.ok(!csp.includes(CDN_HOST))
    const html = await page.text()
    const boot = /<script type="module" src="(\/b\/_static\/assets\/boot-[^"]+\.js)"/.exec(html)
    assert.ok(boot, 'boot.ts is the first module script')
    assert.ok(html.indexOf(boot[1]) < html.indexOf('<script type="module" src="/b/_static/assets/main-'))
  } finally {
    await app.close()
  }
})
