/**
 * S3 driver: AWS S3 and any S3-compatible store (MinIO, Ceph RGW, Cloudflare R2, Selectel, Yandex Object
 * Storage, Backblaze B2, Wasabi, …).
 *
 * Credentials come from the standard AWS chain unless given explicitly: environment variables, a web identity
 * token (EKS IRSA / pod identity), ECS task role, EC2 instance metadata, shared config/profile.
 *
 * Optimistic concurrency uses conditional writes (`If-Match` / `If-None-Match: *` on PutObject). Support varies
 * between S3-compatible stores: some reject the headers, some silently ignore them, and some check them correctly
 * one request at a time but not when requests for one key overlap (seen on Selectel ru-3 in 2026: 8 parallel
 * `If-None-Match: *` creates of one key gave 7 or 8 successes). So:
 *
 * - inside this process every write is serialised per key, in both modes, so overlapping requests never reach the
 *   store for the same key at once;
 * - in `auto` mode the driver probes the store once with overlapping writes: 8 parallel creates of a fresh key and
 *   then 8 parallel `If-Match` replaces with the same ETag must each give exactly one success. Only then does it
 *   trust the store (`native`); otherwise it compares ETags itself before writing (`emulated`).
 *
 * Neither mode makes two processes safe on a store whose preconditions are not atomic: run one replica there,
 * with a `Recreate` rollout so two pods never overlap (docs/storage.md).
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
import { ConflictError, keyedLock } from './objects.mjs'

const status = (error) => error?.$metadata?.httpStatusCode ?? 0
const isMissing = (error) => status(error) === 404 || ['NoSuchKey', 'NotFound', 'NoSuchVersion'].includes(error?.name)
const isPrecondition = (error) => status(error) === 412 || status(error) === 409 || ['PreconditionFailed', 'ConditionalRequestConflict'].includes(error?.name)
const isUnsupported = (error) => status(error) === 501 || error?.name === 'NotImplemented'

/** Parallel writes per probe phase. */
export const PROBE_WRITES = 8

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
  const withLock = keyedLock()

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

  /**
   * Fire `PROBE_WRITES` conditional writes at once and count the outcomes. A store that answers with something
   * other than success or a failed precondition (501, 400) does not support the header at all.
   */
  async function burst(key, phase, options) {
    // Bodies differ between phases too: a replace that writes the same bytes keeps the ETag and would let a second
    // conditional replace through on a perfectly atomic store.
    const results = await Promise.allSettled(Array.from({ length: PROBE_WRITES }, (_, i) => rawPut(key, `${phase}-${i}`, { contentType: 'text/plain', ...options })))
    let ok = 0
    let unsupported = 0
    for (const result of results) {
      if (result.status === 'fulfilled') ok += 1
      else if (isUnsupported(result.reason) || status(result.reason) === 400) unsupported += 1
      else if (!isPrecondition(result.reason)) throw result.reason
    }
    return { ok, unsupported, of: PROBE_WRITES }
  }

  /**
   * Decide once whether the store honours conditional writes, including when requests for one key overlap:
   * parallel creates of a fresh key, then parallel replaces conditional on the same ETag, must each let exactly
   * one write through.
   */
  async function probe() {
    const key = `.boards-probe/${Date.now()}-${Math.random().toString(36).slice(2)}`
    let create = null
    let replace = null
    try {
      create = await burst(key, 'create', { ifNoneMatch: '*' })
      if (create.ok === 1 && !create.unsupported) {
        const current = await head(key)
        replace = await burst(key, 'replace', { ifMatch: current?.etag ?? '"00000000000000000000000000000000"' })
      }
    } finally {
      await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {})
    }
    const atomic = create.ok === 1 && !create.unsupported && replace?.ok === 1 && !replace.unsupported
    conditional = atomic ? 'native' : 'emulated'
    const counts = { create: `${create.ok}/${create.of}`, ...(replace ? { replace: `${replace.ok}/${replace.of}` } : {}) }
    if (atomic) log({ event: 's3_conditional_writes', mode: conditional, ...counts })
    else {
      const unsupported = create.unsupported || replace?.unsupported
      log({
        level: 'warn',
        event: 's3_conditional_writes',
        mode: conditional,
        ...counts,
        note: unsupported
          ? 'the store does not support conditional writes; comparing ETags before writing (run one replica)'
          : 'the store does not enforce If-Match / If-None-Match atomically under concurrency; comparing ETags before writing (run one replica with a Recreate rollout)',
      })
    }
    return conditional
  }

  async function mode() {
    if (conditional) return conditional
    probing ??= probe().finally(() => (probing = null))
    return probing
  }

  async function put(key, body, options = {}) {
    const { ifMatch, ifNoneMatch } = options
    const conditionalWrite = Boolean(ifMatch || ifNoneMatch)
    if (conditionalWrite) await mode()
    return withLock(key, async () => {
      if (!conditionalWrite) return rawPut(key, body, options)
      if (conditional === 'native') {
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
    })
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
      await withLock(key, () => s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key })))
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
