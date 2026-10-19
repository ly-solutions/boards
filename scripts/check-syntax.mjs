/** `npm run lint` part two: every server/shared/script module must parse (`node --check`). */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const roots = ['server', 'shared', 'scripts', 'engine', 'bin', 'tests']
const files = []
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    if (statSync(path).isDirectory()) walk(path)
    else if (/\.m?js$/.test(name)) files.push(path)
  }
}
for (const root of roots) walk(root)
let failed = 0
for (const file of files) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' })
  } catch (error) {
    failed += 1
    console.error(`${file}\n${error.stderr}`)
  }
}
console.log(`${files.length - failed}/${files.length} modules parse`)
process.exit(failed ? 1 : 0)
