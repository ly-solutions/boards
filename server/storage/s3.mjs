/**
 * S3 driver: AWS S3 and any S3-compatible store (MinIO, Ceph RGW, Cloudflare R2, Selectel, Yandex Object
 * Storage, Backblaze B2, Wasabi, …).
 *
 * Credentials come from the standard AWS chain unless given explicitly: environment variables, a web identity
 * token (EKS IRSA / pod identity), ECS task role, EC2 instance metadata, shared config/profile.
 *
 * Optimistic concurrency uses conditional writes (`If-Match` / `If-None-Match: *` on PutObject). Support varies
 * between S3-compatible stores — some reject the headers, some silently ignore them — so in `auto` mode the
 * driver probes the store once: a write that must fail is attempted, and if it lands anyway the driver falls
 * back to compare-then-write (HEAD, compare ETag, PUT). That fallback has a small race window, which is fine for
 * the single-writer deployment boards runs as.
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { ConflictError } from './objects.mjs'

const status = (error) => error?.$metadata?.httpStatusCode ?? 0
const isMissing = (error) => status(error) === 404 || ['NoSuchKey', 'NotFound', 'NoSuchVersion'].includes(error?.name)
const isPrecondition = (error) => status(error) === 412 || status(error) === 409 || ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error?.name)
const isUnsupported = (error) => status(error) === 501 || error?.name === 'NotImplemented'

/** `s3://bucket/some/prefix` → { bucket, prefix }. */
export function parseS3Url(raw) {
  const url = new URL(raw)
  if (url.protocol !== 's3:') throw new Error(`not an s3:// URL: ${raw}`)
  const prefix = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
  return { bucket: url.hostname, prefix: prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix }
}

export function s3Objects({
  bucket,
  endpoint,
  region,
  forcePathStyle = false,
  accessKeyId,
  secretAccessKey,
  sessionToken,
  conditionalWrites = 'auto',
  createBucket = false,
  client,
  log = () => {},
} = {}) {
  if (!bucket) throw new Error('S3 storage needs a bucket (BOARDS_S3_BUCKET)')
  const s3 =
    client ??
    new S3Client({
      region: region || 'us-east-1',
      ...(endpoint ? { endpoint } : {}),
      forcePathStyle: Boolean(forcePathStyle),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) } } : {}),
      // Newer SDKs add CRC checksums to every request; many S3-compatible stores reject them.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })

  /** 'native' | 'emulated' — resolved on first conditional write in auto mode. */
  let conditional = conditionalWrites === 'on' ? 'native' : conditionalWrites === 'off' ? 'emulated' : null
  let probing = null

  async function head(key) {
    try {
      const res = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: key }))
      return { etag: res.ETag }
    } catch (error) {
      if (isMissing(error)) return null
      throw error
    }
  }

  async function rawPut(key, body, { contentType, ifMatch, ifNoneMatch } = {}) {
    const res = await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: contentType ?? 'application/octet-stream',
        ...(ifMatch ? { IfMatch: ifMatch } : {}),
        ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
      }),
    )
    return { etag: res.ETag, versionId: res.VersionId }
  }

  /** Decide once whether the store honours conditional writes. */
  async function probe() {
    const key = `.boards-probe/${Date.now()}-${Math.random().toString(36).slice(2)}`
    try {
      await rawPut(key, 'probe', { contentType: 'text/plain' })
      try {
        await rawPut(key, 'probe-2', { contentType: 'text/plain', ifMatch: '"00000000000000000000000000000000"' })
        conditional = 'emulated'
        log({ level: 'warn', event: 's3_conditional_writes_ignored', note: 'the store ignores If-Match; falling back to compare-then-write' })
      } catch (error) {
        if (isPrecondition(error)) conditional = 'native'
        else if (isUnsupported(error) || status(error) === 400) {
          conditional = 'emulated'
          log({ level: 'warn', event: 's3_conditional_writes_unsupported', error: String(error?.name ?? error) })
        } else throw error
      }
    } finally {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {})
    }
    log({ event: 's3_conditional_writes', mode: conditional })
    return conditional
  }

  async function mode() {
    if (conditional) return conditional
    probing ??= probe().finally(() => (probing = null))
    return probing
  }

  async function put(key, body, options = {}) {
    const { ifMatch, ifNoneMatch } = options
    if (!ifMatch && !ifNoneMatch) return rawPut(key, body, options)
    if ((await mode()) === 'native') {
      try {
        return await rawPut(key, body, options)
      } catch (error) {
        if (isPrecondition(error)) throw new ConflictError()
        if (!isUnsupported(error)) throw error
        conditional = 'emulated'
      }
    }
    const current = await head(key)
    if (ifNoneMatch === '*' && current) throw new ConflictError('the object already exists')
    if (ifMatch && (!current || current.etag !== ifMatch)) throw new ConflictError()
    return rawPut(key, body, { contentType: options.contentType })
  }

  return {
    kind: 's3',
    bucket,
    get conditionalMode() {
      return conditional
    },

    async ensureBucket() {
      try {
        await s3.send(new HeadBucketCommand({ Bucket: bucket }))
      } catch (error) {
        if (!createBucket || !isMissing(error)) throw error
        await s3.send(new CreateBucketCommand({ Bucket: bucket }))
        log({ event: 's3_bucket_created', bucket })
      }
    },

    async get(key) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        return { body: Buffer.from(await res.Body.transformToByteArray()), etag: res.ETag, versionId: res.VersionId }
      } catch (error) {
        if (isMissing(error)) return null
        throw error
      }
    },

    put,

    async delete(key) {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },

    async list(prefix = '', { delimiter } = {}) {
      const keys = []
      const prefixes = []
      let token
      do {
        const res = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ...(delimiter ? { Delimiter: delimiter } : {}), ...(token ? { ContinuationToken: token } : {}) }))
        for (const o of res.Contents ?? []) keys.push({ key: o.Key, etag: o.ETag, size: o.Size, lastModified: o.LastModified })
        for (const p of res.CommonPrefixes ?? []) prefixes.push(p.Prefix)
        token = res.IsTruncated ? res.NextContinuationToken : undefined
      } while (token)
      return { keys, prefixes }
    },

    async versioningEnabled() {
      try {
        const res = await s3.send(new GetBucketVersioningCommand({ Bucket: bucket }))
        return res.Status === 'Enabled'
      } catch (error) {
        log({ level: 'warn', event: 's3_versioning_unknown', error: String(error?.name ?? error) })
        return false
      }
    },

    async versions(key) {
      const out = []
      let keyMarker
      let versionMarker
      do {
        const res = await s3.send(new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, ...(keyMarker ? { KeyMarker: keyMarker, VersionIdMarker: versionMarker } : {}) }))
        for (const v of res.Versions ?? []) if (v.Key === key) out.push({ versionId: v.VersionId, lastModified: v.LastModified, etag: v.ETag, size: v.Size })
        keyMarker = res.IsTruncated ? res.NextKeyMarker : undefined
        versionMarker = res.IsTruncated ? res.NextVersionIdMarker : undefined
      } while (keyMarker)
      return out.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified))
    },

    async getVersion(key, versionId) {
      try {
        const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: versionId }))
        return { body: Buffer.from(await res.Body.transformToByteArray()), etag: res.ETag, versionId: res.VersionId }
      } catch (error) {
        if (isMissing(error) || status(error) === 400) return null
        throw error
      }
    },
  }
}
