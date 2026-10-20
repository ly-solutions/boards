/**
 * An in-process S3 endpoint implementing exactly the calls boards uses (path-style): HeadBucket, CreateBucket,
 * Get/PutBucketVersioning, ListObjectsV2, ListObjectVersions, GetObject (incl. versionId), HeadObject, PutObject
 * (with If-Match / If-None-Match), DeleteObject. Signatures are not checked.
 *
 * Used by tests when Docker (and therefore MinIO) is not available. Knobs simulate real-world stores:
 *   conditionals: 'native' | 'ignore' (accepts and ignores the headers) | 'reject' (501 NotImplemented)
 *                 | 'racy' (checks the headers, then stores after a pause: correct one request at a time, but
 *                   overlapping requests for one key all pass the check, as seen on a real S3-compatible store)
 *   pageSize: ListObjectsV2 page size, to exercise pagination
 */
import { createHash } from 'node:crypto'
import { createServer } from 'node:http'

const xml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c])
const NS = 'xmlns="http://s3.amazonaws.com/doc/2006-03-01/"'

export async function startFakeS3({ conditionals = 'native', pageSize = 1000 } = {}) {
  const buckets = new Map() // name → { versioning: bool, objects: Map<key, [versions newest first]> }
  let counter = 0
  const calls = []
  const requests = [] // { method, key } for object requests, to count what reached the store

  const error = (res, status, code, message = code) => {
    res.writeHead(status, { 'content-type': 'application/xml' })
    res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>${xml(message)}</Message></Error>`)
  }
  const ok = (res, body, headers = {}) => {
    res.writeHead(200, { 'content-type': 'application/xml', ...headers })
    res.end(`<?xml version="1.0" encoding="UTF-8"?>${body}`)
  }

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://s3.local')
    const [, bucketName, ...keyParts] = url.pathname.split('/')
    const key = decodeURIComponent(keyParts.join('/'))
    const q = url.searchParams
    calls.push(`${req.method} ${key ? 'object' : 'bucket'}${q.has('versioning') ? ' versioning' : ''}${q.has('versions') ? ' versions' : ''}`)
    if (key) requests.push({ method: req.method, key })
    const bucket = buckets.get(bucketName)

    if (!key) {
      if (req.method === 'PUT' && q.has('versioning')) {
        if (!bucket) return error(res, 404, 'NoSuchBucket')
        bucket.versioning = /<Status>Enabled<\/Status>/.test(body.toString())
        return ok(res, '')
      }
      if (req.method === 'PUT') {
        if (bucket) return error(res, 409, 'BucketAlreadyOwnedByYou')
        buckets.set(bucketName, { versioning: false, objects: new Map() })
        res.writeHead(200, { location: `/${bucketName}` })
        return res.end()
      }
      if (!bucket) return req.method === 'HEAD' ? (res.writeHead(404), res.end()) : error(res, 404, 'NoSuchBucket')
      if (req.method === 'HEAD') return res.writeHead(200), res.end()
      if (req.method === 'GET' && q.has('versioning')) return ok(res, `<VersioningConfiguration ${NS}>${bucket.versioning ? '<Status>Enabled</Status>' : ''}</VersioningConfiguration>`)
      if (req.method === 'GET' && q.has('versions')) {
        const prefix = q.get('prefix') ?? ''
        const rows = []
        for (const [k, versions] of [...bucket.objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
          if (!k.startsWith(prefix)) continue
          versions.forEach((v, i) => !v.deleted && rows.push(`<Version><Key>${xml(k)}</Key><VersionId>${v.versionId}</VersionId><IsLatest>${i === 0}</IsLatest><LastModified>${v.lastModified.toISOString()}</LastModified><ETag>${xml(v.etag)}</ETag><Size>${v.body.length}</Size><StorageClass>STANDARD</StorageClass></Version>`))
        }
        return ok(res, `<ListVersionsResult ${NS}><Name>${bucketName}</Name><Prefix>${xml(prefix)}</Prefix><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>${rows.join('')}</ListVersionsResult>`)
      }
      if (req.method === 'GET') {
        const prefix = q.get('prefix') ?? ''
        const delimiter = q.get('delimiter') ?? ''
        const start = Number(q.get('continuation-token') ?? 0)
        const entries = []
        const prefixes = new Set()
        for (const [k, versions] of [...bucket.objects.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
          if (!k.startsWith(prefix) || versions[0].deleted) continue
          const rest = k.slice(prefix.length)
          if (delimiter && rest.includes(delimiter)) {
            const p = prefix + rest.slice(0, rest.indexOf(delimiter) + delimiter.length)
            if (!prefixes.has(p)) {
              prefixes.add(p)
              entries.push({ prefix: p })
            }
          } else entries.push({ key: k, v: versions[0] })
        }
        const page = entries.slice(start, start + pageSize)
        const truncated = start + pageSize < entries.length
        const contents = page.filter((e) => e.key).map((e) => `<Contents><Key>${xml(e.key)}</Key><LastModified>${e.v.lastModified.toISOString()}</LastModified><ETag>${xml(e.v.etag)}</ETag><Size>${e.v.body.length}</Size><StorageClass>STANDARD</StorageClass></Contents>`)
        const common = page.filter((e) => e.prefix).map((e) => `<CommonPrefixes><Prefix>${xml(e.prefix)}</Prefix></CommonPrefixes>`)
        return ok(res, `<ListBucketResult ${NS}><Name>${bucketName}</Name><Prefix>${xml(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><MaxKeys>${pageSize}</MaxKeys><IsTruncated>${truncated}</IsTruncated>${truncated ? `<NextContinuationToken>${start + pageSize}</NextContinuationToken>` : ''}${contents.join('')}${common.join('')}</ListBucketResult>`)
      }
      return error(res, 405, 'MethodNotAllowed')
    }

    if (!bucket) return error(res, 404, 'NoSuchBucket')
    const versions = bucket.objects.get(key)
    const latest = versions && !versions[0].deleted ? versions[0] : null

    if (req.method === 'PUT') {
      const ifMatch = req.headers['if-match']
      const ifNoneMatch = req.headers['if-none-match']
      if ((ifMatch || ifNoneMatch) && conditionals === 'reject') return error(res, 501, 'NotImplemented', 'conditional writes are not supported')
      if (conditionals === 'native' || conditionals === 'racy') {
        if (ifNoneMatch === '*' && latest) return error(res, 412, 'PreconditionFailed')
        if (ifMatch && (!latest || latest.etag !== ifMatch)) return error(res, 412, 'PreconditionFailed')
      }
      if (conditionals === 'racy') await new Promise((resolve) => setTimeout(resolve, 30))
      const current = bucket.objects.get(key)
      const entry = { body, etag: `"${createHash('md5').update(body).digest('hex')}"`, lastModified: new Date(), versionId: `v${String(++counter).padStart(6, '0')}`, contentType: req.headers['content-type'] }
      bucket.objects.set(key, bucket.versioning ? [entry, ...(current ?? [])] : [entry])
      res.writeHead(200, { etag: entry.etag, ...(bucket.versioning ? { 'x-amz-version-id': entry.versionId } : {}) })
      return res.end()
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
      const versionId = q.get('versionId')
      const hit = versionId ? versions?.find((v) => v.versionId === versionId) : latest
      if (!hit) return req.method === 'HEAD' ? (res.writeHead(404), res.end()) : error(res, 404, versionId ? 'NoSuchVersion' : 'NoSuchKey')
      res.writeHead(200, { etag: hit.etag, 'content-length': hit.body.length, 'content-type': hit.contentType ?? 'application/octet-stream', 'last-modified': hit.lastModified.toUTCString(), ...(bucket.versioning ? { 'x-amz-version-id': hit.versionId } : {}) })
      return res.end(req.method === 'HEAD' ? undefined : hit.body)
    }
    if (req.method === 'DELETE') {
      if (versions) {
        if (bucket.versioning) versions.unshift({ deleted: true, body: Buffer.alloc(0), lastModified: new Date(), versionId: `d${++counter}`, etag: '' })
        else bucket.objects.delete(key)
      }
      res.writeHead(204)
      return res.end()
    }
    return error(res, 405, 'MethodNotAllowed')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    calls,
    requests,
    /** Object requests by method since `from` (an index into `requests`), optionally only for keys matching `match`. */
    count(method, { from = 0, match } = {}) {
      return requests.slice(from).filter((r) => r.method === method && (!match || match.test(r.key))).length
    },
    buckets,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
