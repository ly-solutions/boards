/**
 * `boards migrate --from-git <repo> --to <target>`: move boards from a git repository (the original storage of
 * this project: one commit per save under `boards/<slug>/`) to object storage.
 *
 * For every board:
 *  1. each commit that touched `scene.excalidraw` becomes an immutable snapshot
 *     (`boards/<slug>/snapshots/<commit time>.excalidraw`, listed in the manifest with the commit id and author);
 *  2. the files at `--ref` (scene, meta, text, preview, notes, checkpoints) become the live board.
 *
 * Boards that already exist in the target are skipped unless `overwrite` is set; snapshots already imported are
 * not duplicated, so the command can be re-run after a partial failure.
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

async function git(repo, args, { buffer = false } = {}) {
  const { stdout } = await run('git', ['-C', repo, ...args], { encoding: buffer ? 'buffer' : 'utf8', maxBuffer: 512 * 1024 * 1024 })
  return stdout
}

export async function migrateFromGit({ repo, ref = 'HEAD', path = 'boards', target, overwrite = false, dryRun = false, only = null, log = () => {} }) {
  const root = path.replace(/\/+$/, '')
  const listing = await git(repo, ['ls-tree', '-d', '--name-only', `${ref}:${root}`]).catch(() => '')
  const slugs = listing.split('\n').map((s) => s.trim()).filter((s) => /^[a-z0-9][a-z0-9-]{2,63}$/.test(s)).filter((s) => !only || only.includes(s))
  const report = { boards: 0, skipped: 0, snapshots: 0, files: 0, failed: [] }

  for (const slug of slugs) {
    try {
      if (!overwrite && !dryRun && (await target.readMeta(slug))) {
        report.skipped += 1
        log({ event: 'skip_existing', slug })
        continue
      }
      const dir = `${root}/${slug}`
      const history = (await git(repo, ['log', ref, '--reverse', '--format=%H%x09%cI%x09%an', '--', `${dir}/scene.excalidraw`]))
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const [commit, at, author] = line.split('\t')
          return { commit, at, author }
        })
      const items = []
      for (const entry of history) {
        const body = await git(repo, ['show', `${entry.commit}:${dir}/scene.excalidraw`]).catch(() => null)
        if (body === null) continue // the scene was deleted in this commit
        items.push({ at: entry.at, body, extra: { commit: entry.commit.slice(0, 12), ...(entry.author ? { by: entry.author } : {}) } })
      }
      const files = (await git(repo, ['ls-tree', '-r', '--name-only', ref, '--', `${dir}/`])).split('\n').filter(Boolean)
      const current = {}
      for (const file of files) {
        const name = file.slice(dir.length + 1)
        if (!name || name.startsWith('snapshots/')) continue
        current[name] = await git(repo, ['show', `${ref}:${file}`], { buffer: true })
      }
      if (!current['meta.yaml']) {
        log({ level: 'warn', event: 'skip_no_meta', slug })
        report.skipped += 1
        continue
      }
      if (!dryRun) {
        report.snapshots += await target.importSnapshots(slug, items)
        // meta.yaml last: a board without it does not exist, so a half-copied board stays invisible.
        const { 'meta.yaml': meta, ...rest } = current
        await target.writeFiles(slug, rest)
        await target.writeFiles(slug, { 'meta.yaml': meta })
      } else {
        report.snapshots += items.length
      }
      report.files += Object.keys(current).length
      report.boards += 1
      log({ event: dryRun ? 'would_migrate' : 'migrated', slug, snapshots: items.length, files: Object.keys(current).length })
    } catch (error) {
      report.failed.push({ slug, error: String(error?.message ?? error) })
      log({ level: 'error', event: 'migrate_failed', slug, error: String(error?.message ?? error) })
    }
  }
  return report
}
