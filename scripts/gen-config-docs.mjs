/** Regenerate the variables table in docs/configuration.md from server/config.mjs (between the markers). */
import { readFile, writeFile } from 'node:fs/promises'
import { optionsMarkdown } from '../server/config.mjs'

const file = new URL('../docs/configuration.md', import.meta.url)
const doc = await readFile(file, 'utf8')
const start = '<!-- options:start -->'
const end = '<!-- options:end -->'
const next = doc.replace(new RegExp(`${start}[\\s\\S]*${end}`), `${start}\n\n${optionsMarkdown()}\n${end}`)
if (process.argv.includes('--check')) {
  if (next !== doc) {
    console.error('docs/configuration.md is out of date: run npm run docs:config')
    process.exit(1)
  }
} else await writeFile(file, next)
