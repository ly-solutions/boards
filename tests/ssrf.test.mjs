/**
 * The SSRF guard (server/ssrf.mjs) and the link preview built on it (server/link-preview.mjs).
 *
 * The rule: the server fetches a pasted URL only if every address its host resolves to is on the public internet,
 * connects to exactly the address it checked, and re-checks every redirect.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { BlockedUrlError, checkUrl, isPublicAddress, safeFetch } from '../server/ssrf.mjs'
import { linkPreviewResolver, parsePreview } from '../server/link-preview.mjs'
import { startApp, PUBLIC_URL } from './helpers/app.mjs'
import { createLinks } from '../server/links.mjs'

test('private, loopback, link-local, multicast and reserved addresses are not public', () => {
  const blocked = [
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '127.255.255.254', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.0.0.8', '192.0.2.10', '192.168.1.1', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '239.255.255.250', '240.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', 'ff02::1', '2001:db8::1', '100::1', '2001::1',
    '::ffff:127.0.0.1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '64:ff9b::a9fe:a9fe', '2002:7f00:0001::1', '2002:c0a8:0101::1',
    'fe80::1%eth0', 'not-an-ip', '', '1.2.3', '999.1.1.1',
  ]
  for (const ip of blocked) assert.equal(isPublicAddress(ip), false, ip)
  const allowed = ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.32.0.1', '100.128.0.1', '2606:4700:4700::1111', '2a00:1450:4001:80b::200e', '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:0808:0808::1']
  for (const ip of allowed) assert.equal(isPublicAddress(ip), true, ip)
})

const lookupOf = (table) => async (host) => {
  if (!(host in table)) throw new Error('ENOTFOUND')
  return table[host].map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
}

test('checkUrl refuses bad schemes, ports, credentials, local names and hosts that resolve to private addresses', async () => {
  const lookup = lookupOf({ 'example.org': ['93.184.216.34'], 'evil.example': ['93.184.216.34', '10.0.0.5'], 'metadata.example': ['169.254.169.254'], 'v6.example': ['::1'] })
  const refused = async (url, pattern) => assert.rejects(checkUrl(url, { lookup }), (error) => error instanceof BlockedUrlError && pattern.test(error.message), url)
  await refused('file:///etc/passwd', /scheme/)
  await refused('gopher://example.org/', /scheme/)
  await refused('ftp://example.org/', /scheme/)
  await refused('http://example.org:22/', /port 22/)
  await refused('https://user:pass@example.org/', /credentials/)
  await refused('http://localhost/', /not public/)
  await refused('http://printer.local/', /not public/)
  await refused('http://127.0.0.1/', /non-public/)
  await refused('http://[::1]/', /non-public/)
  await refused('http://[::ffff:169.254.169.254]/', /non-public/)
  await refused('http://2130706433/', /non-public/) // 127.0.0.1 written as a number; the URL parser normalises it
  await refused('http://0x7f.1/', /non-public/)
  await refused('http://metadata.example/latest/meta-data/', /non-public/)
  await refused('http://evil.example/', /non-public/) // one private answer is enough to refuse
  await refused('http://v6.example/', /non-public/)
  await refused('http://nowhere.example/', /does not resolve/)
  await refused('not a url', /not a URL/)
  const ok = await checkUrl('https://example.org/page', { lookup })
  assert.equal(ok.address, '93.184.216.34')
  assert.equal(ok.port, 443)
})

// A local HTTP server stands in for "the internet". The guard would refuse 127.0.0.1, so these tests allow exactly
// that one address for one fake host name — and prove that everything else is still checked hop by hop.
const pages = new Map()
const server = createServer((req, res) => {
  const page = pages.get(req.url)
  if (!page) {
    res.writeHead(404)
    return res.end()
  }
  res.writeHead(page.status ?? 200, page.headers ?? { 'content-type': 'text/html; charset=utf-8' })
  res.end(page.body ?? '')
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const port = server.address().port
after(() => server.close())

const testNet = {
  lookup: lookupOf({ 'site.test': ['127.0.0.1'], 'private.test': ['10.0.0.1'] }),
  ports: [port],
  allowAddress: (ip) => ip === '127.0.0.1' || isPublicAddress(ip),
}

test('safeFetch reads a page, caps its size and connects to the checked address', async () => {
  pages.set('/hello', { body: '<title>Hello</title>' })
  const page = await safeFetch(`http://site.test:${port}/hello`, testNet)
  assert.equal(page.status, 200)
  assert.equal(page.body, '<title>Hello</title>')
  pages.set('/big', { body: 'x'.repeat(100_000) })
  const big = await safeFetch(`http://site.test:${port}/big`, { ...testNet, maxBytes: 1000 })
  assert.equal(big.body.length, 1000)
})

test('every redirect hop is checked: a redirect to a private address or a bad scheme is refused', async () => {
  pages.set('/to-private', { status: 302, headers: { location: `http://private.test:${port}/secret` } })
  await assert.rejects(safeFetch(`http://site.test:${port}/to-private`, testNet), /non-public/)
  pages.set('/to-metadata', { status: 301, headers: { location: 'http://169.254.169.254/latest/meta-data/' } })
  await assert.rejects(safeFetch(`http://site.test:${port}/to-metadata`, testNet), BlockedUrlError)
  pages.set('/to-file', { status: 302, headers: { location: 'file:///etc/passwd' } })
  await assert.rejects(safeFetch(`http://site.test:${port}/to-file`, testNet), /scheme/)
  pages.set('/loop', { status: 302, headers: { location: '/loop' } })
  await assert.rejects(safeFetch(`http://site.test:${port}/loop`, testNet), /too many redirects/)
  pages.set('/to-ok', { status: 302, headers: { location: '/hello' } })
  const followed = await safeFetch(`http://site.test:${port}/to-ok`, testNet)
  assert.equal(followed.body, '<title>Hello</title>')
  assert.equal(new URL(followed.url).pathname, '/hello')
})

test('a slow page times out', async () => {
  const slow = createServer(() => {}) // never answers
  await new Promise((resolve) => slow.listen(0, '127.0.0.1', resolve))
  const slowPort = slow.address().port
  try {
    await assert.rejects(safeFetch(`http://site.test:${slowPort}/`, { ...testNet, ports: [slowPort], timeoutMs: 200 }))
  } finally {
    slow.closeAllConnections()
    slow.close()
  }
})

test('Open Graph parsing: og tags first, then <title> and description; only https images', () => {
  const html = `<html><head>
    <meta property="og:title" content="Payments &amp; refunds">
    <meta property='og:description' content='How money moves'>
    <meta property="og:site_name" content="Docs">
    <meta property="og:image" content="/img/cover.png">
    <title>ignored</title></head></html>`
  assert.deepEqual(parsePreview(html, 'https://docs.example.com/payments'), { kind: 'link', title: 'Payments & refunds', subtitle: 'How money moves', site: 'Docs', image: 'https://docs.example.com/img/cover.png', url: 'https://docs.example.com/payments' })
  const plain = parsePreview('<title> Just a page </title><meta name="description" content="About">', 'http://www.example.com/a')
  assert.deepEqual(plain, { kind: 'link', title: 'Just a page', subtitle: 'About', site: 'example.com', image: null, url: 'http://www.example.com/a' })
  assert.equal(parsePreview('<p>no title</p>', 'https://example.com/'), null)
  assert.equal(parsePreview('<meta property="og:image" content="http://x.example/i.png"><title>T</title>', 'http://x.example/').image, null)
})

test('the link preview resolver turns a bookmark into a card through the guarded fetch', async () => {
  pages.set('/article', { body: '<meta property="og:title" content="An article"><meta property="og:site_name" content="Site">' })
  const resolver = linkPreviewResolver({ fetchPage: (url, opts) => safeFetch(url, { ...testNet, ...opts }) })
  const links = createLinks({ linkPreview: resolver })
  const card = await links.meta(`link:http://site.test:${port}/article`)
  assert.equal(card.title, 'An article')
  assert.equal(card.site, 'Site')
  assert.equal(card.kind, 'link')
  // Private targets never become cards: the guard refuses, the registry answers null.
  const blocked = createLinks({ linkPreview: linkPreviewResolver(), log: () => {} })
  assert.equal(await blocked.meta('link:http://127.0.0.1:1/'), null)
  assert.equal(await blocked.meta('link:http://169.254.169.254/latest/meta-data/'), null)
})

test('link previews are off by default, and on only with BOARDS_LINK_PREVIEW', async () => {
  const { loadConfig } = await import('../server/config.mjs')
  assert.equal(loadConfig({ BOARDS_AUTH: 'none' }).linkPreview, false)
  assert.equal(loadConfig({ BOARDS_AUTH: 'none', BOARDS_LINK_PREVIEW: 'on' }).linkPreview, true)
  assert.throws(() => loadConfig({ BOARDS_AUTH: 'none', BOARDS_LINK_PREVIEW: 'sometimes' }), /BOARDS_LINK_PREVIEW/)
  const t = await startApp()
  try {
    assert.equal(t.app.links.claimsLinks(), false, 'without plugins or previews, bookmarks stay bookmarks')
  } finally {
    await t.close()
  }
  const on = await startApp({ config: { linkPreview: true, publicUrl: PUBLIC_URL } })
  try {
    assert.equal(on.app.links.claimsLinks(), true)
  } finally {
    await on.close()
  }
})
