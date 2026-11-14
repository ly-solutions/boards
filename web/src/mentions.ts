// Mentions in comments (HRN-1452): `@` opens a list of who can be called — the agent of the harnessly app view and
// the people of this board — and a picked name goes into the text as `@Name `. A sent message shows its mentions as
// chips. Pure rules only, so they are unit-tested; comments.tsx draws them.

/** The agent's handle: `@harnessly` calls the agent of the app view to the thread. */
export const AGENT = 'harnessly'

export type Candidate = { name: string; agent: boolean }

/** A name may hold letters, digits, `.`, `_`, `-` and one inner space («Sergey Chernyshev»). */
const QUERY_RE = /(^|\s)@([\p{L}\p{N}._-]*(?: [\p{L}\p{N}._-]*)?)$/u

/** The `@word` being typed right before the caret: where its `@` is and what follows it; null when there is none. */
export function mentionQuery(text: string, caret: number): { start: number; query: string } | null {
  const before = text.slice(0, caret)
  const m = QUERY_RE.exec(before)
  if (!m) return null
  const query = m[2]
  // A finished mention followed by a space is not being typed any more.
  if (query.endsWith(' ')) return null
  return { start: before.length - query.length - 1, query }
}

/** Who can be mentioned: the agent (only where it can answer), then the people of the board, without me. */
export function candidates(names: Iterable<string>, me: string | null, withAgent: boolean): Candidate[] {
  const seen = new Set<string>()
  const people: Candidate[] = []
  for (const raw of names) {
    const name = raw.trim()
    const key = name.toLowerCase()
    if (!name || name.startsWith('@') || key === AGENT || seen.has(key) || (me !== null && key === me.toLowerCase())) continue
    seen.add(key)
    people.push({ name, agent: false })
  }
  people.sort((a, b) => a.name.localeCompare(b.name))
  return withAgent ? [{ name: AGENT, agent: true }, ...people] : people
}

/** The candidates whose name, or a word of it, starts with the query; at most `limit`. */
export function suggest(query: string, list: readonly Candidate[], limit = 6): Candidate[] {
  const q = query.trim().toLowerCase()
  if (!q) return list.slice(0, limit)
  return list.filter((c) => c.name.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)) || c.name.toLowerCase().startsWith(q)).slice(0, limit)
}

/** The text with the typed `@query` replaced by `@Name `, and where the caret goes. */
export function insertMention(text: string, start: number, caret: number, name: string): { text: string; caret: number } {
  const piece = `@${name} `
  const after = text.slice(caret).replace(/^ /, '')
  return { text: text.slice(0, start) + piece + after, caret: start + piece.length }
}

export type Segment = { text: string; mention: Candidate | null }

/** The message split into plain text and the known mentions in it, longest names first. */
export function splitMentions(text: string, known: readonly Candidate[]): Segment[] {
  const byLength = [...known].sort((a, b) => b.name.length - a.name.length)
  const out: Segment[] = []
  let plain = ''
  let i = 0
  while (i < text.length) {
    const atStart = text[i] === '@' && (i === 0 || /\s/.test(text[i - 1]))
    const hit = atStart
      ? byLength.find((c) => {
          const end = i + 1 + c.name.length
          return text.slice(i + 1, end).toLowerCase() === c.name.toLowerCase() && (end === text.length || !/[\p{L}\p{N}_-]/u.test(text[end]))
        })
      : undefined
    if (!hit) {
      plain += text[i]
      i += 1
      continue
    }
    if (plain) out.push({ text: plain, mention: null })
    plain = ''
    out.push({ text: `@${text.slice(i + 1, i + 1 + hit.name.length)}`, mention: hit })
    i += 1 + hit.name.length
  }
  if (plain) out.push({ text: plain, mention: null })
  return out
}
