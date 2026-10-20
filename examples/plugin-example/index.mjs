/**
 * Example boards plugin — everything the plugin API offers, in one small file.
 *
 *   BOARDS_PLUGINS=./examples/plugin-example/index.mjs npm run dev
 *
 * - card resolver: GitHub issue and pull request links (and `owner/repo#123` typed on the board) become cards with
 *   title, state and assignee, read from the public GitHub API (GITHUB_TOKEN raises the rate limit; optional);
 * - block action: "Turn into a checklist" — selected sticky notes become one checklist text, done on the server;
 * - meta field: a deadline, edited in Board properties and shown on the boards list;
 * - webhook: GitHub `issues` events refresh the matching cards at once (GITHUB_WEBHOOK_SECRET);
 * - route: GET /b/<slug>/plugins/example/stats — counts of stickies and cards on a board;
 * - flags: `example-beta` for people whose e-mail is in EXAMPLE_BETA_DOMAIN (`*`: everyone);
 * - events: logs new comment threads;
 * - web code: ./web/index.mjs draws GitHub cards and adds a toolbar button.
 *
 * Tests: tests/plugin-example.test.mjs (GitHub is faked there; nothing goes over the network).
 */

const GITHUB_URL = /^https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\/(issues|pull)\/(\d{1,9})\/?(?:[?#].*)?$/
const GITHUB_REF = /[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}#\d{1,9}/

/** A neutral issue glyph (a circle with a dot) as a data URI: no third-party assets on the board. */
const ICON = `data:image/svg+xml;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.25" fill="none" stroke="#57606a" stroke-width="1.5"/><circle cx="8" cy="8" r="1.75" fill="#57606a"/></svg>').toString('base64')}`

const MESSAGES = {
  en: {
    'example.checklist': 'Turn into a checklist',
    'example.checklistDone': { one: '{count} sticky became a checklist', other: '{count} stickies became a checklist' },
    'example.deadline': 'Deadline',
    'example.assignee': 'Assignee',
    'example.open': 'open',
    'example.closed': 'closed',
    'example.merged': 'merged',
    'example.draft': 'draft',
  },
  ru: {
    'example.checklist': 'Сделать чек-лист',
    'example.checklistDone': { one: '{count} стикер стал чек-листом', few: '{count} стикера стали чек-листом', many: '{count} стикеров стали чек-листом', other: '{count} стикера стали чек-листом' },
    'example.deadline': 'Дедлайн',
    'example.assignee': 'Исполнитель',
    'example.open': 'открыта',
    'example.closed': 'закрыта',
    'example.merged': 'влита',
    'example.draft': 'черновик',
  },
}

/** `{ owner, repo, number }` from a GitHub issue/PR URL or an `owner/repo#123` reference. */
export function parseIssue(input) {
  const url = GITHUB_URL.exec(input)
  if (url) return { owner: url[1], repo: url[2], number: Number(url[4]) }
  const ref = /^([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})#(\d{1,9})$/.exec(input)
  return ref ? { owner: ref[1], repo: ref[2], number: Number(ref[3]) } : null
}

/** The card resolver. `fetchImpl` is injectable so tests never touch the network. */
export function githubResolver({ token = '', fetchImpl = globalThis.fetch, t = (key) => key, apiBase = 'https://api.github.com' } = {}) {
  return {
    id: 'github',
    ttlMs: 5 * 60_000,
    missTtlMs: 60_000,
    timeoutMs: 4000,
    match: (url) => (GITHUB_URL.test(url) ? url : null),
    pattern: GITHUB_REF,
    async resolve(input, { signal }) {
      const issue = parseIssue(input)
      if (!issue) return null
      const response = await fetchImpl(`${apiBase}/repos/${issue.owner}/${issue.repo}/issues/${issue.number}`, {
        headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        signal,
      })
      if (response.status === 404) return null
      if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
      const data = await response.json()
      const pull = Boolean(data.pull_request)
      const state = data.pull_request?.merged_at ? 'merged' : data.draft ? 'draft' : data.state === 'closed' ? 'closed' : 'open'
      const tone = { open: 'success', merged: 'info', closed: 'neutral', draft: 'neutral' }[state]
      return {
        kind: 'github.issue',
        title: `#${issue.number} ${data.title}`,
        site: `${issue.owner}/${issue.repo}${pull ? ' · PR' : ''}`,
        status: { label: t(`example.${state}`), tone },
        icon: ICON,
        url: data.html_url,
        updatedAt: data.updated_at,
        subtitle: (data.labels ?? []).map((l) => (typeof l === 'string' ? l : l.name)).filter(Boolean).slice(0, 4).join(' · ') || null,
        fields: data.assignee?.login ? [{ label: t('example.assignee'), value: data.assignee.login }] : [],
      }
    },
  }
}

/**
 * The block action: stickies, top to bottom and left to right, become one checklist text where the first one was.
 * The server applies the returned edit as a single revision — undo, history and live updates work as usual.
 */
export function stickiesToChecklist({ selection, t }) {
  const stickies = selection.filter((el) => el.customData?.kind === 'sticky' && el.text)
  if (!stickies.length) return { toast: t('example.checklistDone', { count: 0 }) }
  stickies.sort((a, b) => Math.round(a.y / 40) - Math.round(b.y / 40) || a.x - b.x)
  const x = Math.min(...stickies.map((el) => el.x))
  const y = Math.min(...stickies.map((el) => el.y))
  const text = stickies.map((el) => `☐ ${el.text.replace(/\s*\n\s*/g, ' ')}`).join('\n')
  return {
    edit: { add: [{ type: 'text', x, y, text, fontSize: 20 }], delete: stickies.map((el) => el.id) },
    toast: t('example.checklistDone', { count: stickies.length }),
  }
}

/** Build the plugin; the default export below uses the real environment. */
export function examplePlugin({ fetchImpl = globalThis.fetch } = {}) {
  return {
    name: 'example',
    version: '1.0.0',
    apiVersion: '^1.0.0',
    web: './web/index.mjs',

    register(api) {
      for (const [locale, messages] of Object.entries(MESSAGES)) api.addMessages(locale, messages)

      api.addCardResolver(githubResolver({ token: api.env.GITHUB_TOKEN ?? '', fetchImpl, t: api.t }))

      api.addBlockAction({
        id: 'checklist',
        label: 'example.checklist',
        icon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6h9M11 12h9M11 18h9"/></svg>',
        when: { kinds: ['sticky'], min: 1 },
        run: stickiesToChecklist,
      })

      api.addMetaField({ id: 'deadline', label: 'example.deadline', type: 'date', home: true })

      const secret = api.env.GITHUB_WEBHOOK_SECRET
      if (secret) {
        api.addWebhook({
          path: '/github',
          verify: api.hmacVerifier({ secret, header: 'x-hub-signature-256', prefix: 'sha256=' }),
          async handler(ctx) {
            const event = await ctx.json()
            const url = event.issue?.html_url ?? event.pull_request?.html_url
            if (!url) return { ignored: true }
            const issue = parseIssue(url)
            const short = issue ? `ref:github:${issue.owner}/${issue.repo}#${issue.number}` : null
            api.cards.invalidate((ref) => ref === `link:${url}` || ref === short)
            return { refreshed: url }
          },
        })
      }

      api.addRoute({
        method: 'GET',
        path: '/stats',
        scope: 'board',
        handler(ctx) {
          const elements = ctx.board.elements().filter((el) => !el.isDeleted)
          return {
            board: ctx.board.slug,
            stickies: elements.filter((el) => el.customData?.kind === 'sticky').length,
            cards: elements.filter((el) => el.customData?.kind === 'card').length,
            deadline: ctx.board.meta.fields.deadline ?? null,
          }
        },
      })

      const betaDomain = String(api.env.EXAMPLE_BETA_DOMAIN ?? '').toLowerCase()
      api.addFlags({ id: 'beta', flags: (user) => ({ 'example-beta': betaDomain === '*' || Boolean(betaDomain && user.email?.toLowerCase().endsWith(`@${betaDomain}`)) }) })

      api.on('thread.created', (event) => api.log({ event: 'comment_thread', slug: event.slug, anchor: event.thread.anchor.label }))
    },
  }
}

export default examplePlugin()
