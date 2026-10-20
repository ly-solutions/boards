/**
 * Fetching URLs that people paste: the SSRF guard.
 *
 * A link card that shows a page's title means the server opens a URL somebody typed. Without care that is a way
 * to make the server read what only it can reach: cloud metadata (169.254.169.254), the cluster's own services,
 * localhost admin ports. So `safeFetch`:
 *
 *   - allows only http(s) on the default ports (or the ones listed);
 *   - resolves the host itself and refuses if ANY address is private, loopback, link-local, multicast or otherwise
 *     reserved — IPv4, IPv6 and IPv4 embedded in IPv6 alike;
 *   - connects to exactly the address it checked (no second DNS lookup an attacker could answer differently —
 *     DNS rebinding);
 *   - follows redirects by hand, checking every hop the same way;
 *   - caps time and bytes, and never sends cookies or credentials.
 */
import { lookup as dnsLookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import http from 'node:http'
import https from 'node:https'

export class BlockedUrlError extends Error {
  constructor(message) {
    super(message)
    this.code = 'BLOCKED_URL'
  }
}

const v4ToInt = (ip) => ip.split('.').reduce((n, part) => (n << 8) + Number(part), 0) >>> 0

/** [network, prefix length] — everything that is not the public internet. */
const V4_BLOCKED = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, cloud metadata
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
].map(([net, bits]) => [v4ToInt(net), bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0])

function isPublicV4(ip) {
  const n = v4ToInt(ip)
  return !V4_BLOCKED.some(([net, mask]) => ((n & mask) >>> 0) === net)
}

/** Expand an IPv6 address to eight 16-bit groups; handles `::` and a trailing dotted IPv4. */
function v6Groups(ip) {
  let text = ip.toLowerCase().replace(/%.*$/, '')
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (dotted) {
    const n = v4ToInt(dotted[1])
    text = `${text.slice(0, -dotted[1].length)}${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`
  }
  const [head, tail] = text.split('::')
  const parse = (part) => (part ? part.split(':').map((g) => parseInt(g, 16)) : [])
  const a = parse(head)
  const b = tail === undefined ? [] : parse(tail)
  const zeros = tail === undefined ? 0 : 8 - a.length - b.length
  return [...a, ...Array(Math.max(0, zeros)).fill(0), ...b]
}

const groupsToV4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`

function isPublicV6(ip) {
  const g = v6Groups(ip)
  if (g.length !== 8 || g.some((x) => !Number.isInteger(x) || x < 0 || x > 0xffff)) return false
  if (g.every((x) => x === 0)) return false // ::
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return false // ::1
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible (::a.b.c.d): judge the IPv4 inside.
  if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return isPublicV4(groupsToV4(g[6], g[7]))
  // NAT64 (64:ff9b::/96) carries an IPv4 address in the last 32 bits.
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0)) return isPublicV4(groupsToV4(g[6], g[7]))
  // 6to4 (2002::/16) embeds an IPv4 address in bits 16–48.
  if (g[0] === 0x2002) return isPublicV4(groupsToV4(g[1], g[2]))
  if ((g[0] & 0xfe00) === 0xfc00) return false // unique local fc00::/7
  if ((g[0] & 0xffc0) === 0xfe80) return false // link-local fe80::/10
  if ((g[0] & 0xffc0) === 0xfec0) return false // site-local (deprecated) fec0::/10
  if ((g[0] & 0xff00) === 0xff00) return false // multicast ff00::/8
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false // documentation 2001:db8::/32
  if (g[0] === 0x0100 && g.slice(1, 4).every((x) => x === 0)) return false // discard 100::/64
  if (g[0] === 0x2001 && g[1] < 0x0200) return false // 2001::/23 IETF protocol assignments (Teredo, ORCHID, …)
  return true
}

/** Whether an IP address (v4 or v6) is on the public internet. Anything unparsable counts as not public. */
export function isPublicAddress(ip) {
  const family = isIP(String(ip ?? ''))
  if (family === 4) return isPublicV4(ip)
  if (family === 6) return isPublicV6(ip)
  return false
}

/**
 * Check a URL before fetching: scheme, port, credentials, and every address its host resolves to.
 * Returns `{ url, address, family }` — the address to connect to. Throws BlockedUrlError.
 */
export async function checkUrl(raw, { lookup = dnsLookup, ports = [80, 443], allowAddress = isPublicAddress } = {}) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw new BlockedUrlError('not a URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new BlockedUrlError(`scheme ${url.protocol} is not allowed`)
  if (url.username || url.password) throw new BlockedUrlError('URLs with credentials are not fetched')
  const port = Number(url.port || (url.protocol === 'https:' ? 443 : 80))
  if (!ports.includes(port)) throw new BlockedUrlError(`port ${port} is not allowed`)
  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }]
  else {
    if (!host || /^(localhost|.*\.localhost|.*\.local|.*\.internal)$/i.test(host)) throw new BlockedUrlError(`host ${host} is not public`)
    try {
      addresses = await lookup(host, { all: true, verbatim: true })
    } catch {
      throw new BlockedUrlError(`host ${host} does not resolve`)
    }
  }
  if (!addresses?.length) throw new BlockedUrlError(`host ${host} does not resolve`)
  // Every address must be public: a name that resolves to one public and one private address is a rebinding trick.
  const bad = addresses.find((a) => !allowAddress(a.address))
  if (bad) throw new BlockedUrlError(`host ${host} resolves to a non-public address`)
  return { url, address: addresses[0].address, family: addresses[0].family, port }
}

/**
 * GET a public URL. Resolves to `{ status, url, headers, body }` with the body as a string (at most `maxBytes`,
 * the rest is dropped). Redirects are followed up to `maxRedirects`, each hop re-checked.
 */
export async function safeFetch(raw, { timeoutMs = 5000, maxBytes = 512 * 1024, maxRedirects = 3, accept = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1', userAgent = 'boards-link-preview/1.0 (+https://github.com/ly-solutions/boards)', lookup, ports, allowAddress, signal } = {}) {
  const deadline = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])])
  let current = raw
  for (let hop = 0; hop <= maxRedirects; hop += 1) {
    const target = await checkUrl(current, { lookup, ports, allowAddress })
    const response = await request(target, { accept, userAgent, maxBytes, signal: deadline })
    if (response.status >= 300 && response.status < 400 && response.headers.location) {
      current = new URL(response.headers.location, target.url).href
      continue
    }
    return { ...response, url: target.url.href }
  }
  throw new BlockedUrlError('too many redirects')
}

function request({ url, address, family, port }, { accept, userAgent, maxBytes, signal }) {
  const lib = url.protocol === 'https:' ? https : http
  return new Promise((resolve, reject) => {
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname.replace(/^\[|\]$/g, ''),
        port,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: { accept, 'user-agent': userAgent, 'accept-encoding': 'identity' },
        // Connect to the address we checked, whatever DNS says now. TLS still verifies the certificate for the
        // host name (servername defaults to `hostname`).
        lookup: (_host, options, callback) => (options?.all ? callback(null, [{ address, family }]) : callback(null, address, family)),
        signal,
        agent: false,
      },
      (res) => {
        const chunks = []
        let size = 0
        res.on('data', (chunk) => {
          if (size >= maxBytes) return
          chunks.push(chunk)
          size += chunk.length
          if (size >= maxBytes) res.destroy()
        })
        const done = () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).subarray(0, maxBytes).toString('utf8') })
        res.on('end', done)
        res.on('close', done)
        res.on('error', (error) => (size ? done() : reject(error)))
      },
    )
    req.on('error', reject)
    req.end()
  })
}
