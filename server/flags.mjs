/**
 * Feature flags per person.
 *
 * A flags provider answers "which flags are on for this user": `{ id, flags(user, ctx) → { name: value } }`, sync
 * or async, values `true`/`false` or short strings (a variant). The default provider is static, from BOARDS_FLAGS
 * (`beta-cards,new-menu=false,layout=compact`); plugins add their own (a flag service, a group lookup) with
 * `api.addFlags(provider)`. Later providers override earlier ones, flag by flag.
 *
 * Flags named after an editor feature (`live`, `studio`, `workboard`, `snap`, `motion`) switch it per user: `false`
 * turns it off for them. A flag cannot turn on a feature the operator disabled with BOARDS_DISABLE_FEATURES.
 *
 * The editor receives the flags of the person who opened it (web plugins read them via `api.flags`). A provider that
 * throws or takes longer than `timeoutMs` is skipped — flags fall back to the rest, the page never waits on them.
 */

const NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/

/** `a,b=false,c=compact` → `{ a: true, b: false, c: 'compact' }`. Throws on a malformed entry. */
export function parseFlags(raw) {
  const out = {}
  for (const item of String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [name, ...rest] = item.split('=')
    const key = name.trim().replace(/^!/, '')
    if (!NAME.test(key)) throw new Error(`"${item}" is not a flag (letters, digits, . _ : -)`)
    if (name.trim().startsWith('!')) out[key] = false
    else if (!rest.length) out[key] = true
    else {
      const value = rest.join('=').trim()
      out[key] = /^(true|on|yes|1)$/i.test(value) ? true : /^(false|off|no|0)$/i.test(value) ? false : value.slice(0, 64)
    }
  }
  return out
}

/** Keep only well-formed names and boolean or short string values. */
export function cleanFlags(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [name, value] of Object.entries(raw)) {
    if (!NAME.test(name)) continue
    if (typeof value === 'boolean') out[name] = value
    else if (typeof value === 'string' && value.length <= 64) out[name] = value
    else if (typeof value === 'number' && Number.isFinite(value)) out[name] = String(value)
  }
  return out
}

/** The default provider: the same flags for everyone. */
export function staticFlags(flags = {}) {
  const fixed = cleanFlags(flags)
  return { id: 'static', flags: () => fixed }
}

/** Who a flag provider is asked about; never the session or token itself. */
export const flagUser = (who) => (who ? { kind: who.kind, name: who.name ?? null, email: who.email ?? null } : { kind: 'anonymous', name: null, email: null })

export function createFlags({ providers = [], timeoutMs = 1500, log = () => {} } = {}) {
  const list = [...providers]

  function add(provider) {
    if (!provider || typeof provider.flags !== 'function') throw new Error('a flags provider needs flags(user, ctx)')
    list.push({ id: String(provider.id ?? `provider-${list.length}`), flags: provider.flags.bind(provider) })
  }

  /** All flags for one person: every provider, in order, later ones winning. */
  async function forUser(who, ctx = {}) {
    const user = flagUser(who)
    const results = await Promise.all(
      list.map(async (provider) => {
        let timer
        try {
          return cleanFlags(
            await Promise.race([
              provider.flags(user, ctx),
              new Promise((_, reject) => {
                timer = setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs)
              }),
            ]),
          )
        } catch (error) {
          log({ level: 'warn', event: 'flags_failed', provider: provider.id, error: String(error?.message ?? error) })
          return {}
        } finally {
          clearTimeout(timer)
        }
      }),
    )
    return Object.assign({}, ...results)
  }

  /** Editor features for one person: the operator's switches, narrowed by that person's flags. */
  function features(base, flags) {
    return Object.fromEntries(Object.entries(base ?? {}).map(([name, on]) => [name, Boolean(on) && flags[name] !== false]))
  }

  return { add, forUser, features, providers: () => list.map((p) => p.id) }
}
