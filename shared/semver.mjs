/**
 * The plugin API version and a small semver range check, shared by the server's plugin loader and the editor's.
 *
 * Ranges: exact (`1.2.3`), caret (`^1.2`), tilde (`~1.2.0`), x-ranges (`1.x`, `*`), comparators (`>=1.1 <2`), and
 * alternatives joined by `||`. No imports: the editor bundles this file too.
 */

/** The plugin API version. Minor: additions only. Major: anything a plugin could notice breaking. */
export const PLUGIN_API_VERSION = '1.0.0'

const parseVersion = (text) => {
  const m = /^v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?(?:-[0-9A-Za-z.-]+)?$/.exec(String(text).trim())
  if (!m) return null
  const part = (p) => (p === undefined || p === 'x' || p === '*' ? null : Number(p))
  return [Number(m[1]), part(m[2]), part(m[3])]
}
const cmp = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2]

function comparators(token) {
  const m = /^(\^|~|>=|<=|>|<|=)?\s*(.+)$/.exec(token)
  const op = m[1] ?? ''
  if (m[2] === '*' || m[2] === 'x') return [['>=', [0, 0, 0]]]
  const v = parseVersion(m[2])
  if (!v) throw new Error(`"${token}" is not a version range`)
  const [major, minor, patch] = v
  const lo = [major, minor ?? 0, patch ?? 0]
  if (op === '^') {
    const hi = major > 0 || minor === null ? [major + 1, 0, 0] : minor > 0 || patch === null ? [0, minor + 1, 0] : [0, 0, patch + 1]
    return [['>=', lo], ['<', hi]]
  }
  if (op === '~') return [['>=', lo], ['<', minor === null ? [major + 1, 0, 0] : [major, minor + 1, 0]]]
  if (op === '' || op === '=') {
    if (minor === null) return [['>=', lo], ['<', [major + 1, 0, 0]]]
    if (patch === null) return [['>=', lo], ['<', [major, minor + 1, 0]]]
    return [['=', lo]]
  }
  return [[op, lo]]
}

/** Whether `version` (x.y.z) satisfies a semver `range`. Throws on a malformed range. */
export function satisfies(version, range) {
  const v = parseVersion(version)
  if (!v || v.includes(null)) throw new Error(`"${version}" is not a version`)
  return String(range)
    .split('||')
    .some((alternative) => {
      const tokens = alternative.trim().replace(/(\^|~|>=|<=|>|<|=)\s+/g, '$1').split(/\s+/).filter(Boolean)
      if (!tokens.length) return true
      return tokens.flatMap(comparators).every(([op, w]) => {
        const c = cmp(v, w)
        return op === '>=' ? c >= 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : op === '<' ? c < 0 : c === 0
      })
    })
}

