#!/usr/bin/env node
/**
 * boards command line.
 *
 *   boards [serve]                       start the server (configured by environment variables)
 *   boards migrate --from-git <repo> --to <s3://bucket/prefix | ./dir> [options]
 *   boards config                        print the configuration reference (markdown)
 *   boards version
 */
import { parseArgs } from 'node:util'
import { readFile } from 'node:fs/promises'

const HELP = `boards — Excalidraw whiteboards that people draw and AI agents read and edit.

Usage:
  boards [serve]           Start the server. Configure it with environment variables (boards config).
  boards migrate --from-git <repo> --to <target> [options]
                           Copy boards from a git repository (boards/<slug>/ folders) to object storage,
                           turning every commit of a board's scene into a history snapshot.
  boards config            Print every environment variable with its default.
  boards version           Print the version.

migrate options:
  --from-git <path>        Local clone of the git repository.
  --to <target>            s3://bucket[/prefix] or a local directory (fs driver layout).
  --ref <ref>              Git ref to read (default HEAD).
  --path <dir>             Folder with boards inside the repository (default boards).
  --endpoint <url>         S3 endpoint for S3-compatible stores (default $BOARDS_S3_ENDPOINT).
  --region <region>        S3 region (default $BOARDS_S3_REGION, $AWS_REGION or us-east-1).
  --path-style             Path-style S3 URLs (MinIO and most self-hosted stores).
  --create-bucket          Create the bucket if it does not exist.
  --only <slug,slug>       Migrate only these boards.
  --overwrite              Replace boards that already exist in the target.
  --dry-run                Show what would be copied.
S3 credentials come from BOARDS_S3_ACCESS_KEY_ID/BOARDS_S3_SECRET_ACCESS_KEY or the standard AWS chain.
`

const [command = 'serve', ...rest] = process.argv.slice(2)

if (command === 'serve') {
  const { main } = await import('../server/index.mjs')
  await main()
} else if (command === 'version' || command === '--version' || command === '-v') {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  console.log(pkg.version)
} else if (command === 'config') {
  const { optionsMarkdown } = await import('../server/config.mjs')
  console.log(optionsMarkdown())
} else if (command === 'migrate') {
  const { values } = parseArgs({
    args: rest,
    options: {
      'from-git': { type: 'string' },
      to: { type: 'string' },
      ref: { type: 'string', default: 'HEAD' },
      path: { type: 'string', default: 'boards' },
      endpoint: { type: 'string' },
      region: { type: 'string' },
      'path-style': { type: 'boolean', default: false },
      'create-bucket': { type: 'boolean', default: false },
      only: { type: 'string' },
      overwrite: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  })
  if (!values['from-git'] || !values.to) {
    console.error('migrate needs --from-git <repo> and --to <target>\n')
    console.error(HELP)
    process.exit(2)
  }
  const { createBoardStorage, fsObjects, parseS3Url, s3Objects } = await import('../server/storage/index.mjs')
  const { migrateFromGit } = await import('../server/migrate.mjs')
  const env = process.env
  let objects
  let prefix = ''
  if (values.to.startsWith('s3://')) {
    const parsed = parseS3Url(values.to)
    prefix = parsed.prefix
    objects = s3Objects({
      bucket: parsed.bucket,
      endpoint: values.endpoint ?? env.BOARDS_S3_ENDPOINT,
      region: values.region ?? env.BOARDS_S3_REGION ?? env.AWS_REGION ?? 'us-east-1',
      forcePathStyle: values['path-style'] || /^(1|true)$/i.test(env.BOARDS_S3_FORCE_PATH_STYLE ?? ''),
      accessKeyId: env.BOARDS_S3_ACCESS_KEY_ID,
      secretAccessKey: env.BOARDS_S3_SECRET_ACCESS_KEY,
      createBucket: values['create-bucket'],
      log: (e) => console.error(JSON.stringify(e)),
    })
    if (!values['dry-run']) await objects.ensureBucket()
  } else {
    objects = fsObjects({ dir: values.to.replace(/^file:\/\//, '') })
  }
  const target = createBoardStorage({ objects, prefix, snapshots: 'objects', snapshotKeep: Number.POSITIVE_INFINITY })
  const report = await migrateFromGit({
    repo: values['from-git'],
    ref: values.ref,
    path: values.path,
    target,
    overwrite: values.overwrite,
    dryRun: values['dry-run'],
    only: values.only ? values.only.split(',').map((s) => s.trim()) : null,
    log: (e) => console.error(JSON.stringify(e)),
  })
  console.log(JSON.stringify(report, null, 2))
  process.exit(report.failed.length ? 1 : 0)
} else {
  console.log(HELP)
  process.exit(command === 'help' || command === '--help' || command === '-h' ? 0 : 2)
}
