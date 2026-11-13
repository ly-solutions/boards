/**
 * MCP tools of boards: a thin layer over the same operations as the HTTP API (`/b/api/boards`, `/b/<slug>.md`,
 * `/edit`, `/comments`, `/react`, `/b/api/templates`). Who edits is decided by the caller: `ctx.who` is the person
 * from a platform token or an agent with a static API token.
 */
import { ToolError } from './mcp.mjs'

const GRAPH_HELP = `graph — a diagram; the server lays it out:
{ "direction": "LR|TB|RL|BT", "frame": "frame around the diagram",
  "nodes": [{ "id": "api", "label": "Gateway", "shape": "rectangle|ellipse|diamond",
              "color": "purple|blue|teal|green|amber|orange|rose|red|slate", "style": "zone|card|strong", "group": "frame", "link": "https://…" }],
  "edges": [{ "from": "api", "to": "db", "label": "SQL", "dashed": false, "bidirectional": false }] }
Edges may point at ids of shapes already on the board (board_read shows them).
A color means one thing across the board; after an edit read the board and look at the slop check.`

const ADD_HELP = 'add — an Excalidraw skeleton with coordinates, when precision matters: { "type": "rectangle|ellipse|diamond|text|arrow", "id", "x", "y", "width", "height", "label": { "text" } }; a sticky is a rectangle with "customData": { "kind": "sticky" }.'

const boardArg = { type: 'string', description: 'The board: its slug or a link like https://…/b/<slug>?k=…' }
const graphArg = { type: 'object', description: GRAPH_HELP, additionalProperties: true }
const addArg = { type: 'array', description: ADD_HELP, items: { type: 'object', additionalProperties: true } }
const atArg = { type: 'object', description: 'Where to put a new diagram: { "x": 0, "y": 600 }; without it, to the right of what is there', properties: { x: { type: 'number' }, y: { type: 'number' } } }

/** The slug of a board link, or the value itself. */
export function slugOf(ref) {
  const value = String(ref ?? '').trim()
  const m = /\/b\/([a-z0-9-]+?)(?:\.md)?(?:[/?#]|$)/.exec(value)
  return m ? m[1] : value
}

const str = (value) => (typeof value === 'string' ? value : undefined)

const matches = (words) => (b) => {
  const hay = [b.title, b.description ?? '', ...(b.tags ?? [])].join(' ').toLowerCase()
  return words.every((w) => hay.includes(w))
}
const wordsOf = (query) => String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)

export function boardTools(ops) {
  const reactions = ops.reactions
  return [
    {
      name: 'board_read',
      title: 'Read a board',
      description: 'The board as text: frames, shapes with labels and ids, connections, stickies with votes, open comment threads and the slop check. Read before an edit and after it.',
      inputSchema: { type: 'object', properties: { board: boardArg }, required: ['board'] },
      annotations: { readOnlyHint: true },
      run: async (args) => ops.text(await ops.board(args.board)),
    },
    {
      name: 'board_create',
      title: 'Create a board',
      description: `A new board: empty, from a template (board_templates) or with a diagram right away. Answers with the link and the board text.\n${GRAPH_HELP}`,
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Title, at least two characters' },
          description: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' } },
          template: { type: 'string', description: 'A template id from board_templates' },
          graph: graphArg,
          add: addArg,
          at: atArg,
          access: { type: 'string', enum: ['team', 'link'], description: 'link — anyone with the link may edit; team by default' },
        },
        required: ['title'],
      },
      run: async (args, { who }) => {
        const state = await ops.create({ ...args, author: who.name }, who)
        const d = ops.describe(state)
        return `Board created: ${d.url}\nslug: ${d.slug}\n\n${ops.text(state)}`
      },
    },
    {
      name: 'board_edit',
      title: 'Add to or change a board',
      description: `One edit, one revision: graph (a diagram laid out by the server), add (a skeleton with coordinates), update ([{ "id", "label", "x", "y", "color", "link" }]), delete (["id", …]). Editors open in browsers show it at once; the edit is signed by whoever the agent works for.\n${GRAPH_HELP}`,
      inputSchema: {
        type: 'object',
        properties: {
          board: boardArg,
          graph: graphArg,
          add: addArg,
          update: { type: 'array', items: { type: 'object', additionalProperties: true } },
          delete: { type: 'array', items: { type: 'string' } },
          at: atArg,
          note: { type: 'string', description: 'What was done, in one line' },
        },
        required: ['board'],
      },
      run: async (args, { who }) => {
        const state = await ops.board(args.board)
        const result = await ops.edit(state, { graph: args.graph, add: args.add, update: args.update, delete: args.delete, at: args.at, note: str(args.note), author: who.name })
        const created = result.created.length ? `, new ids: ${result.created.join(', ')}` : ''
        return `Edit accepted (revision ${state.rev}${created}).\n\n${ops.text(state)}`
      },
    },
    {
      name: 'board_comment',
      title: 'Comment on a board',
      description: 'A new thread (text and a shape elementId or a point x, y) or a reply to an existing one (thread and reply, optionally replyTo — a message id). resolved: true closes a thread, false reopens it. Answer where you were asked — in the thread, not with a label on the board.',
      inputSchema: {
        type: 'object',
        properties: {
          board: boardArg,
          text: { type: 'string', description: 'Text of a new thread' },
          elementId: { type: 'string', description: 'The shape to pin the thread to' },
          x: { type: 'number' },
          y: { type: 'number' },
          thread: { type: 'string', description: 'Thread id to reply to or resolve' },
          reply: { type: 'string' },
          replyTo: { type: 'string' },
          resolved: { type: 'boolean' },
        },
        required: ['board'],
      },
      run: async (args, { who }) => {
        const state = await ops.board(args.board)
        if (args.thread) {
          const thread = ops.changeThread(state, who, String(args.thread), { reply: str(args.reply), replyTo: str(args.replyTo), resolved: typeof args.resolved === 'boolean' ? args.resolved : undefined })
          return `Thread ${thread.id}: ${thread.resolved ? 'resolved' : 'open'}, ${thread.messages.length} message(s).`
        }
        const thread = ops.comment(state, who, { text: args.text, elementId: str(args.elementId), x: args.x, y: args.y })
        return `Thread ${thread.id} opened${thread.elementId ? ` at shape ${thread.elementId}` : ''}, author: ${thread.author}.`
      },
    },
    {
      name: 'board_react',
      title: 'React to a sticky',
      description: `Add or remove a reaction on a sticky (${reactions.join(' ')}). The vote is signed by whoever the agent works for.`,
      inputSchema: {
        type: 'object',
        properties: { board: boardArg, id: { type: 'string', description: 'Sticky id' }, emoji: { type: 'string', enum: reactions }, on: { type: 'boolean', description: 'false — remove' } },
        required: ['board', 'id', 'emoji'],
      },
      run: async (args, { who }) => {
        const state = await ops.board(args.board)
        const votes = ops.react(state, who, { id: args.id, emoji: args.emoji, on: args.on })
        const line = Object.entries(votes).map(([emoji, names]) => `${emoji} ${names.length} (${names.join(', ')})`).join(' · ')
        return line || 'No reactions on this sticky.'
      },
    },
    {
      name: 'board_list',
      title: 'List boards',
      description: 'Boards, newest first. query — words from the title, description or tags.',
      inputSchema: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'number', description: 'How many, 30 by default, at most 200' } } },
      annotations: { readOnlyHint: true },
      run: async (args) => {
        const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 200)
        const boards = (await ops.list()).filter(matches(wordsOf(args.query))).slice(0, limit)
        if (!boards.length) return 'No boards found.'
        return boards.map((b) => `- ${b.title} — ${b.url}${b.tags?.length ? ` — ${b.tags.join(', ')}` : ''}${b.updatedAt ? ` — ${b.updatedAt}` : ''}`).join('\n')
      },
    },
    {
      name: 'board_library',
      title: 'Board library for the app home',
      description: 'Boards as JSON for the app home: slug, title, tags, author, whether the board is mine (the person in the token), link and preview. board — one board; query — words from the title, description or tags.',
      inputSchema: { type: 'object', properties: { board: boardArg, query: { type: 'string' }, limit: { type: 'number', description: 'How many, 200 by default, at most 500' } } },
      annotations: { readOnlyHint: true },
      run: async (args, ctx) => {
        const me = ctx?.who?.sub ? { name: ctx.who.name, email: ctx.who.email } : null
        const rows = await ops.library(me)
        if (args.board) {
          const slug = slugOf(args.board)
          const row = rows.find((b) => b.slug === slug)
          if (!row) throw new ToolError(`no board ${slug}`)
          return JSON.stringify({ boards: [row] })
        }
        const limit = Math.min(Math.max(Number(args.limit) || 200, 1), 500)
        return JSON.stringify({ boards: rows.filter(matches(wordsOf(args.query))).slice(0, limit) })
      },
    },
    {
      name: 'board_signin',
      title: 'Sign the app view in',
      description: 'For the app view only, not for an agent: a one-time pass (a minute) that signs the person of the token in to the boards site inside the view, so the view reads its library and opens boards by itself.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      run: async (_args, ctx) => {
        if (!ctx?.who?.sub) throw new ToolError('sign-in needs a harnessly platform token: it names the person')
        return JSON.stringify({ pass: ops.signin(ctx.who) })
      },
    },
    {
      name: 'board_templates',
      title: 'Board templates',
      description: 'Templates for board_create: id, title and what each is for.',
      inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
      run: async () => ops.templates().map((t) => `- ${t.id} — ${t.title}: ${t.description}`).join('\n'),
    },
  ]
}
