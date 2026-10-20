/**
 * Live board state: process memory plus a debounced write to storage.
 *
 * While a board is being drawn, browsers send edits many times a second. Writing each one to object storage
 * would be wasteful, so an edit is merged into memory first — and is immediately visible to everyone on the
 * board, agents included — and the board is written a few seconds after the last edit, but at least every
 * `flushMaxMs` during continuous work.
 *
 * Restarts. Boards are flushed on SIGTERM, so a normal rollout loses nothing. If the process is killed hard, the
 * last seconds of in-memory edits are lost on the server — but open browsers still hold them: seeing a new server
 * "epoch", each client sends its whole scene and the per-element merge brings back everything that was drawn.
 *
 * Run a single replica: a board's live state must exist once. During a rolling update two processes overlap for a
 * few seconds; each writes with the scene's ETag as a precondition, and the loser merges the winner's scene into
 * its own instead of overwriting it.
 */
import { randomBytes } from 'node:crypto'
import { ConflictError, buildMeta } from './storage/boards.mjs'
import { byIndex, incomingWins, isMergeableElement, isMergeableFile } from './merge.mjs'
import { describeScene, summarize } from './summary.mjs'
import { diff as checkpointDiff, summarize as summarizeDiff, weekCleanup, weekOutcome, OPEN_FILL } from '../shared/checkpoints.mjs'
import { stickyStroke } from '../shared/palette.mjs'
import { openThread, changeThread } from './comments.mjs'

/** Deleted elements are kept for a week: a browser tab open longer than that is rare. */
const TOMBSTONE_TTL_MS = 7 * 24 * 3600 * 1000
const MAX_ELEMENTS = 20_000
const MAX_FILES_BYTES = 25 * 1024 * 1024
const PRESENCE_MS = 12_000
/** Checkpoints per board: a weekly ritual makes ~50 a year; the cap only guards against runaway loops. */
const MAX_CHECKPOINTS = 500
const MAX_CHECKPOINT_TITLE = 80
/** A timer longer than three hours is not a meeting timer. */
const MAX_TIMER_MIN = 180

export class LimitError extends Error {}

export function createStore({
  storage,
  flushDelayMs = Number(process.env.BOARDS_FLUSH_DELAY_MS ?? 8_000),
  flushMaxMs = Number(process.env.BOARDS_FLUSH_MAX_MS ?? 90_000),
  baseUrl = process.env.BOARDS_PUBLIC_URL ?? 'http://localhost:8080',
  now = () => Date.now(),
  log = (event) => console.log(JSON.stringify({ at: new Date().toISOString(), ...event })),
  /** Language of the words in the board text (headings, kinds, colours): BOARDS_LOCALE. Content is never translated. */
  locale = 'en',
} = {}) {
  /** Identifies this process lifetime: when it changes, clients resend their whole scene. */
  const epoch = randomBytes(6).toString('hex')
  const boards = new Map()
  const loading = new Map()
  /**
   * Subscribers to board changes — the live channel (live.mjs). Events are emitted synchronously, in the order
   * edits were accepted, so a live client may treat the revision of the last event it received as its `since`.
   */
  const listeners = new Set()
  const emit = (event) => {
    for (const listener of listeners) {
      try {
        listener(event)
      } catch (error) {
        log({ level: 'error', event: 'listener_failed', error: String(error?.message ?? error) })
      }
    }
  }
  const onChange = (listener) => {
    listeners.add(listener)
    return () => listeners.delete(listener)
  }

  const boardUrl = (state) => `${baseUrl}/b/${state.slug}?k=${state.meta.key}`

  function fromLoaded(slug, loaded) {
    const state = {
      slug,
      meta: loaded.meta,
      appState: loaded.scene?.appState ?? {},
      elements: new Map(),
      elRev: new Map(),
      files: new Map(),
      fileRev: new Map(),
      rev: 1,
      preview: loaded.preview ?? null,
      previewDirty: false,
      // Previews are rendered by browsers, but agent edits arrive without one. The flag tells the next person
      // who opens the board that the thumbnail is out of date.
      previewStale: !loaded.preview,
      dirty: false,
      firstDirtyAt: null,
      flushTimer: null,
      flushing: null,
      version: loaded.version ?? null,
      existing: loaded.existing,
      viewers: new Map(),
      edits: [],
      notes: {
        reactions: loaded.notes?.reactions && typeof loaded.notes.reactions === 'object' ? loaded.notes.reactions : {},
        comments: Array.isArray(loaded.notes?.comments) ? loaded.notes.comments : [],
      },
      notesDirty: false,
    }
    for (const el of loaded.scene?.elements ?? []) {
      if (!isMergeableElement(el)) continue
      state.elements.set(el.id, el)
      state.elRev.set(el.id, 1)
    }
    // Older boards kept reactions in the sticky's customData — move them into notes once.
    for (const el of state.elements.values()) {
      const legacy = el.customData?.kind === 'sticky' ? el.customData.reactions : null
      if (legacy && Object.keys(legacy).length && !state.notes.reactions[el.id]) {
        state.notes.reactions[el.id] = legacy
        state.notesDirty = true
      }
    }
    for (const file of Object.values(loaded.scene?.files ?? {})) {
      if (!isMergeableFile(file)) continue
      state.files.set(file.id, file)
      state.fileRev.set(file.id, 1)
    }
    return state
  }

  async function get(slug) {
    if (boards.has(slug)) return boards.get(slug)
    if (!loading.has(slug)) {
      loading.set(
        slug,
        storage
          .readBoard(slug)
          .then((loaded) => {
            if (!loaded) return null
            const state = fromLoaded(slug, loaded)
            boards.set(slug, state)
            return state
          })
          .finally(() => loading.delete(slug)),
      )
    }
    return loading.get(slug)
  }

  function elementsSorted(state, { includeDeleted = false } = {}) {
    const out = []
    for (const el of state.elements.values()) if (includeDeleted || !el.isDeleted) out.push(el)
    return out.sort(byIndex)
  }

  function stats(state) {
    const scene = describeScene(elementsSorted(state))
    return {
      shapes: scene.shapes.length - scene.images.length,
      edges: scene.edges.length,
      texts: scene.texts.length,
      elements: scene.live.length,
      preview: state.preview ? 1 : 0,
    }
  }

  function schedule(state) {
    const at = now()
    state.dirty = true
    state.firstDirtyAt ??= at
    state.meta.updatedAt = new Date(at).toISOString().replace(/\.\d+Z$/, 'Z')
    clearTimeout(state.flushTimer)
    const waited = at - state.firstDirtyAt
    const delay = Math.max(0, Math.min(flushDelayMs, flushMaxMs - waited))
    state.flushTimer = setTimeout(() => {
      flush(state).catch((error) => log({ level: 'error', event: 'flush_failed', slug: state.slug, error: String(error?.message ?? error) }))
    }, delay)
    state.flushTimer.unref?.()
  }

  /**
   * Merge elements into a board; returns how many were accepted.
   *
   * The merge rule lives in merge.mjs; this only does the bookkeeping — at which server revision each element
   * changed, so clients receive only what they lack. Accepted elements go to subscribers at once, except to
   * `origin`, which already has them.
   */
  function apply(state, elements, files = [], { acceptedIds = null, by = null, origin = null } = {}) {
    let accepted = 0
    const acceptedElements = []
    const acceptedFiles = []
    for (const el of elements) {
      if (!isMergeableElement(el)) continue
      const stored = state.elements.get(el.id)
      if (!stored && state.elements.size >= MAX_ELEMENTS) throw new LimitError(`a board holds at most ${MAX_ELEMENTS} elements`)
      if (!incomingWins(stored, el)) continue
      state.rev += 1
      // Who edited the element last. The version is not bumped: the signature is server metadata, not an edit,
      // and clients that already have the element must not receive it again.
      let stamped = by ? { ...el, customData: { ...(el.customData ?? {}), editedBy: by } } : el
      // Stickies: the server sets the author when the sticky first appears and later edits never change it.
      // Reactions are not stored in the element but in the board notes — otherwise whoever moved a sticky
      // would carry stale votes over fresh ones.
      if (stamped.customData?.kind === 'sticky') {
        const kept = stored?.customData?.kind === 'sticky' ? stored.customData : null
        const { reactions: _legacy, ...customData } = stamped.customData
        // The author is whoever created the sticky. Stickies from templates have none, and moving one does not
        // make you its author.
        const author = kept ? kept.author ?? null : by || customData.author || null
        stamped = { ...stamped, customData: { ...customData, author } }
      }
      state.elements.set(el.id, stamped)
      state.elRev.set(el.id, state.rev)
      acceptedIds?.add(el.id)
      acceptedElements.push(stamped)
      accepted += 1
    }
    let size = 0
    for (const file of state.files.values()) size += file.dataURL.length
    for (const file of files) {
      if (!isMergeableFile(file) || state.files.has(file.id)) continue
      size += file.dataURL.length
      if (size > MAX_FILES_BYTES) throw new LimitError('images on a board are limited to 25 MB — compress them or link to them instead')
      state.rev += 1
      const stored = { id: file.id, mimeType: file.mimeType, dataURL: file.dataURL, created: file.created ?? now() }
      state.files.set(file.id, stored)
      state.fileRev.set(file.id, state.rev)
      acceptedFiles.push(stored)
      accepted += 1
    }
    if (accepted > 0) {
      state.previewStale = true
      schedule(state)
      emit({ type: 'elements', slug: state.slug, rev: state.rev, origin, elements: acceptedElements.sort(byIndex), files: acceptedFiles })
    }
    return accepted
  }

  function changesSince(state, since) {
    const elements = []
    for (const [id, rev] of state.elRev) if (rev > since) elements.push(state.elements.get(id))
    const files = []
    for (const [id, rev] of state.fileRev) if (rev > since) files.push(state.files.get(id))
    return { elements: elements.sort(byIndex), files }
  }

  /**
   * Polling exchange with a browser: accept its edits, return everyone else's.
   *
   * The client remembers the last revision it saw (`since`) and the server epoch. A different epoch means the
   * server restarted and revisions started over: we send everything and the client sends everything back.
   */
  function sync(state, { since = 0, epoch: clientEpoch, elements = [], files = [], client } = {}, who = null) {
    const fresh = clientEpoch !== epoch || !Number.isFinite(since) || since > state.rev
    const own = new Set()
    const origin = client ? String(client).slice(0, 64) : null
    const accepted = apply(state, Array.isArray(elements) ? elements : [], Array.isArray(files) ? files : [], { acceptedIds: own, by: who?.name ?? null, origin })
    if (origin) {
      const seen = state.viewers.get(origin)
      if (seen) seen.at = now()
      else join(state, origin, { name: who?.name ?? null, kind: who?.kind ?? 'viewer' })
    }
    sweep(state)
    const changes = changesSince(state, fresh ? 0 : since)
    // Do not echo the client's own just-accepted edits: it has them, and a freehand stroke is hundreds of points.
    if (!fresh) changes.elements = changes.elements.filter((el) => !own.has(el.id))
    return {
      epoch,
      rev: state.rev,
      full: fresh,
      accepted,
      elements: changes.elements,
      files: changes.files,
      viewers: presence(state),
      access: state.meta.access ?? 'team',
      edits: state.edits.filter((e) => e.rev > (fresh ? state.rev : since)),
      title: state.meta.title,
      notes: notesView(state),
      // Timer plus the server clock, so every client counts down the same time.
      timer: state.timer ?? null,
      now: now(),
    }
  }

  // ── Notes: reactions and comments ─────────────────────────────────────────
  //
  // A layer over the scene, not elements. No Excalidraw versions and no "newest wins": every change is a server
  // operation (vote, reply) and the server broadcasts the notes whole. They are small, and whole means everyone
  // sees exactly the same thing.

  const notesView = (state) => ({ reactions: state.notes.reactions, comments: state.notes.comments })

  function notesChanged(state) {
    state.notesDirty = true
    schedule(state)
    emit({ type: 'notes', slug: state.slug, notes: notesView(state) })
  }

  /** Toggle a reaction on a sticky. Two simultaneous 👍 both count. */
  function react(state, id, emoji, name, on) {
    const el = state.elements.get(id)
    if (!el || el.isDeleted || el.customData?.kind !== 'sticky') return null
    const reactions = { ...(state.notes.reactions[id] ?? {}) }
    const names = new Set(reactions[emoji] ?? [])
    if (on) names.add(name)
    else names.delete(name)
    if (names.size) reactions[emoji] = [...names]
    else delete reactions[emoji]
    if (Object.keys(reactions).length) state.notes.reactions[id] = reactions
    else delete state.notes.reactions[id]
    notesChanged(state)
    return reactions
  }

  /** Comments: see comments.mjs. The store persists and broadcasts; permissions are the caller's. */
  function comment(state, input, who) {
    const thread = openThread(state.notes, state.elements, input, { author: who.name, kind: who.kind, now: now() })
    notesChanged(state)
    return thread
  }

  function changeComment(state, id, change, who, mayDelete) {
    const result = changeThread(state.notes, state.elements, id, change, { author: who.name, kind: who.kind, now: now(), mayDelete })
    notesChanged(state)
    return result
  }

  /** An agent edit: marked so open editors can say "the agent edited". */
  function applyAgentEdit(state, elements, { by = 'agent', note } = {}) {
    const accepted = apply(state, elements, [], { by })
    if (accepted > 0) {
      const edit = { rev: state.rev, by, count: accepted, note: note ?? null, at: now() }
      state.edits.push(edit)
      if (state.edits.length > 50) state.edits.splice(0, state.edits.length - 50)
      emit({ type: 'edit', slug: state.slug, edit, ids: elements.map((el) => el.id) })
    }
    return accepted
  }

  /**
   * Who is on the board. A live-channel participant counts while its socket is open; a polling participant while
   * it keeps calling `/sync` (every 1.5 s) and disappears after PRESENCE_MS of silence.
   */
  function presence(state) {
    return [...state.viewers.entries()].map(([id, v]) => ({ id, name: v.name, kind: v.kind, live: Boolean(v.live), state: v.state ?? 'active' }))
  }

  function join(state, id, { name = null, kind = 'viewer', live = false } = {}) {
    state.viewers.set(id, { at: now(), name, kind, live, state: 'active' })
    emit({ type: 'presence', slug: state.slug, viewers: presence(state) })
  }

  function leave(state, id) {
    if (state.viewers.delete(id)) emit({ type: 'presence', slug: state.slug, viewers: presence(state) })
  }

  function setViewerState(state, id, value) {
    const seen = state.viewers.get(id)
    if (!seen || seen.state === value) return
    seen.state = value
    emit({ type: 'presence', slug: state.slug, viewers: presence(state) })
  }

  function sweep(state) {
    let changed = false
    for (const [id, seen] of state.viewers) {
      if (!seen.live && now() - seen.at > PRESENCE_MS) {
        state.viewers.delete(id)
        changed = true
      }
    }
    if (changed) emit({ type: 'presence', slug: state.slug, viewers: presence(state) })
  }

  function scene(state) {
    const files = {}
    for (const file of state.files.values()) files[file.id] = file
    return {
      type: 'excalidraw',
      version: 2,
      source: baseUrl,
      elements: elementsSorted(state),
      appState: { viewBackgroundColor: state.appState?.viewBackgroundColor ?? '#ffffff', gridSize: state.appState?.gridSize ?? null },
      files,
    }
  }

  /**
   * The board text is needed by the editor page, the agent's .md and every write to storage. On a large board it
   * takes hundreds of milliseconds (the slop check compares pairs of shapes), during which the server is blocked
   * for every board, live channel included. So it is cached until the next change, keyed by scene revision,
   * metadata and notes.
   */
  const textCache = new WeakMap()
  function text(state) {
    const notes = notesView(state)
    const key = `${state.rev}|${JSON.stringify(state.meta)}|${JSON.stringify(notes)}`
    const cached = textCache.get(state)
    if (cached?.key === key) return cached.value
    const value = summarize(elementsSorted(state), {
      title: state.meta.title,
      author: state.meta.author,
      access: state.meta.access ?? 'team',
      description: state.meta.description,
      tags: state.meta.tags,
      task: state.meta.task,
      notes,
      url: boardUrl(state),
      updatedAt: state.meta.updatedAt,
      locale,
    })
    textCache.set(state, { key, value })
    return value
  }

  /** What gets stored: live elements plus recently deleted ones, so stale copies cannot resurrect them. */
  function snapshot(state) {
    const cutoff = now() - TOMBSTONE_TTL_MS
    const elements = elementsSorted(state, { includeDeleted: true }).filter((el) => !el.isDeleted || (el.updated ?? 0) > cutoff)
    const referenced = new Set(elements.filter((el) => !el.isDeleted && el.fileId).map((el) => el.fileId))
    const files = {}
    for (const file of state.files.values()) if (referenced.has(file.id)) files[file.id] = file
    return {
      type: 'excalidraw',
      version: 2,
      source: baseUrl,
      elements,
      appState: { viewBackgroundColor: state.appState?.viewBackgroundColor ?? '#ffffff', gridSize: state.appState?.gridSize ?? null },
      files,
    }
  }

  async function writeOnce(state) {
    const files = {
      'scene.excalidraw': `${JSON.stringify(snapshot(state), null, 1)}\n`,
      'meta.yaml': buildMeta({ ...state.meta, stats: stats(state) }),
      'board.md': text(state),
    }
    if (state.previewDirty && state.preview) files['preview.svg'] = state.preview
    if (state.notesDirty || state.existing.has('notes.json')) files['notes.json'] = `${JSON.stringify(notesView(state), null, 1)}\n`
    const { version } = await storage.writeBoard(state.slug, files, { existing: state.existing, version: state.version })
    state.version = version
    state.previewDirty = false
    state.notesDirty = false
  }

  /**
   * Write the board. A conflict means someone else wrote it — the other process during a rollout, or a person by
   * hand. Then we read their version, merge element by element and write again: neither side loses edits.
   */
  async function flush(state) {
    // A write is in flight: edits made since it started are not in it. Wait for it, then write again if needed —
    // otherwise flushAll() on shutdown would resolve with those edits still only in memory.
    if (state.flushing) return state.flushing.then(() => flush(state))
    if (!state.dirty) return undefined
    clearTimeout(state.flushTimer)
    state.flushing = (async () => {
      state.dirty = false
      state.firstDirtyAt = null
      try {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            await writeOnce(state)
            log({ event: 'flushed', slug: state.slug, rev: state.rev })
            return
          } catch (error) {
            if (!(error instanceof ConflictError) || attempt === 2) throw error
            const theirs = await storage.readBoard(state.slug)
            if (theirs?.scene) apply(state, theirs.scene.elements ?? [], Object.values(theirs.scene.files ?? {}))
            state.version = theirs?.version ?? state.version
            state.existing = theirs?.existing ?? state.existing
            log({ event: 'flush_conflict_merged', slug: state.slug })
          }
        }
      } catch (error) {
        // Not written, so it is still needed: try again on the timer.
        state.dirty = true
        schedule(state)
        throw error
      } finally {
        state.flushing = null
      }
    })()
    return state.flushing
  }

  async function flushAll() {
    await Promise.allSettled([...boards.values()].map((state) => flush(state)))
  }

  // ── Shared timer ───────────────────────────────────────────────────────────
  // One per board, in memory only: it is meeting state, not board state. A restart resets it.

  /** Timer action: start (minutes), pause, resume, add (minutes), stop. Returns the new state. */
  function timerAct(state, action, { minutes, by = null } = {}) {
    const t = now()
    const cur = state.timer ?? null
    const ms = (m, fallback) => Math.round(Math.min(MAX_TIMER_MIN, Math.max(1 / 6, Number.isFinite(m) ? m : fallback)) * 60_000)
    if (action === 'start') {
      const durationMs = ms(minutes, 5)
      state.timer = { endsAt: t + durationMs, leftMs: null, durationMs, by }
    } else if (action === 'stop') {
      state.timer = null
    } else if (!cur) {
      throw new LimitError('the timer is not running')
    } else if (action === 'pause') {
      if (cur.endsAt !== null) state.timer = { ...cur, leftMs: Math.max(0, cur.endsAt - t), endsAt: null }
    } else if (action === 'resume') {
      if (cur.leftMs !== null) state.timer = { ...cur, endsAt: t + cur.leftMs, leftMs: null }
    } else if (action === 'add') {
      const extra = ms(minutes, 1)
      // Time can be added after it ran out: "one more minute" after the bell.
      if (cur.endsAt !== null) state.timer = { ...cur, endsAt: Math.max(cur.endsAt, t) + extra, durationMs: cur.durationMs + extra }
      else state.timer = { ...cur, leftMs: cur.leftMs + extra, durationMs: cur.durationMs + extra }
    } else {
      throw new LimitError('timer action: start, pause, resume, add or stop')
    }
    emit({ type: 'timer', slug: state.slug, timer: state.timer, now: t })
    return state.timer
  }

  // ── Checkpoints ────────────────────────────────────────────────────────────
  // A checkpoint is a named snapshot: `checkpoints/<id>.excalidraw` next to the board plus an entry in
  // `checkpoints.json`. Unlike automatic history it is created on purpose and can be diffed and copied.

  /** Scene for a checkpoint: live elements and only the images they use. */
  function checkpointSnapshot(state) {
    const elements = elementsSorted(state)
    const referenced = new Set(elements.filter((el) => el.fileId).map((el) => el.fileId))
    const files = {}
    for (const file of state.files.values()) if (referenced.has(file.id)) files[file.id] = file
    return { type: 'excalidraw', version: 2, source: baseUrl, elements, appState: { viewBackgroundColor: state.appState?.viewBackgroundColor ?? '#ffffff', gridSize: state.appState?.gridSize ?? null }, files }
  }

  async function checkpoints(state) {
    if (!state.checkpoints) {
      let list = []
      try {
        const parsed = JSON.parse((await storage.readFile(state.slug, 'checkpoints.json')) ?? '[]')
        if (Array.isArray(parsed)) list = parsed
      } catch {
        list = []
      }
      state.checkpoints = list
    }
    return state.checkpoints
  }

  /** A checkpoint's scene; recent ones are cached because every diff reads them. */
  async function checkpointScene(state, id) {
    state.checkpointScenes ??= new Map()
    if (state.checkpointScenes.has(id)) return state.checkpointScenes.get(id)
    if (!(await checkpoints(state)).some((c) => c.id === id)) return null
    const raw = await storage.readFile(state.slug, `checkpoints/${id}.excalidraw`)
    if (raw === null) return null
    const scene = JSON.parse(raw)
    state.checkpointScenes.set(id, scene)
    if (state.checkpointScenes.size > 4) state.checkpointScenes.delete(state.checkpointScenes.keys().next().value)
    return scene
  }

  /**
   * What checkpoint `id` changed relative to the previous one. `id === 'now'`: what changed since the last
   * checkpoint.
   */
  async function checkpointChanges(state, id) {
    const list = await checkpoints(state)
    if (id === 'now') {
      const last = list.at(-1)
      const before = last ? await checkpointScene(state, last.id) : null
      return checkpointDiff(before?.elements ?? [], elementsSorted(state))
    }
    const i = list.findIndex((c) => c.id === id)
    if (i < 0) return null
    const [before, after] = await Promise.all([i > 0 ? checkpointScene(state, list[i - 1].id) : null, checkpointScene(state, id)])
    if (!after) return null
    return checkpointDiff(before?.elements ?? [], after.elements ?? [])
  }

  /**
   * Save a checkpoint. `closeWeek` is the planning-board ritual: after the checkpoint, done stickies leave the
   * board and failed ones go back to "in progress". The done ones remain in the checkpoint itself.
   */
  async function addCheckpoint(state, { title, by = null, closeWeek = false } = {}) {
    const list = await checkpoints(state)
    if (list.length >= MAX_CHECKPOINTS) throw new LimitError(`a board holds at most ${MAX_CHECKPOINTS} checkpoints`)
    const name = String(title ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_CHECKPOINT_TITLE)
    if (!name) throw new LimitError('a checkpoint needs a title')
    const snapshot = checkpointSnapshot(state)
    const changes = await checkpointChanges(state, 'now')
    const entry = {
      id: randomBytes(5).toString('hex'),
      title: name,
      by,
      at: new Date(now()).toISOString(),
      elements: snapshot.elements.length,
      summary: summarizeDiff(changes),
      ...(closeWeek ? { week: weekOutcome(snapshot.elements) } : {}),
    }
    const next = [...list, entry]
    await storage.writeFiles(state.slug, { [`checkpoints/${entry.id}.excalidraw`]: `${JSON.stringify(snapshot, null, 1)}\n`, 'checkpoints.json': `${JSON.stringify(next, null, 1)}\n` })
    state.checkpoints = next
    state.checkpointScenes ??= new Map()
    state.checkpointScenes.set(entry.id, snapshot)
    if (closeWeek) {
      const { remove, reset } = weekCleanup(snapshot.elements)
      const gone = new Set(remove)
      const back = new Set(reset)
      const edits = []
      for (const el of snapshot.elements) {
        const bump = { version: el.version + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: now() }
        if (gone.has(el.id)) edits.push({ ...el, ...bump, isDeleted: true })
        else if (back.has(el.id)) edits.push({ ...el, ...bump, backgroundColor: OPEN_FILL, strokeColor: stickyStroke(OPEN_FILL) })
      }
      if (edits.length) apply(state, edits, [], { by })
    }
    emit({ type: 'checkpoints', slug: state.slug, checkpoints: next })
    return entry
  }

  /** A new board is written immediately: its link is handed out the same second. */
  async function create({ slug, meta, elements = [] }) {
    const state = fromLoaded(slug, { meta, scene: null, version: null, preview: null, existing: new Set() })
    boards.set(slug, state)
    apply(state, elements)
    state.dirty = true
    try {
      await flush(state)
    } catch (error) {
      // Not written even after retries: the board does not exist. Otherwise it would live in memory only, and
      // the person, having seen an error, would create a second one.
      clearTimeout(state.flushTimer)
      boards.delete(slug)
      throw error
    }
    return state
  }

  function setPreview(state, svg) {
    state.preview = svg
    state.previewDirty = true
    state.previewStale = false
    schedule(state)
  }

  function setMeta(state, changes) {
    for (const key of ['title', 'description', 'task', 'access', 'tags']) if (changes[key] !== undefined) state.meta[key] = changes[key]
    metaCache.delete(state.slug)
    schedule(state)
    emit({ type: 'meta', slug: state.slug, title: state.meta.title, access: state.meta.access ?? 'team', description: state.meta.description ?? '', tags: state.meta.tags ?? [], task: state.meta.task ?? null })
  }

  /**
   * Metadata of boards that are not in memory. Only this service writes it, so re-reading every board on every
   * list request is unnecessary; the short TTL covers edits made directly in storage.
   */
  const metaCache = new Map()
  const META_TTL_MS = 5 * 60_000

  async function cachedMeta(slug) {
    const hit = metaCache.get(slug)
    if (hit && now() - hit.at < META_TTL_MS) return hit.meta
    const meta = await storage.readMeta(slug).catch(() => null)
    if (meta) metaCache.set(slug, { meta, at: now() })
    return meta
  }

  // ── History (automatic snapshots / bucket versions) ───────────────────────

  async function history(state) {
    return storage.listSnapshots ? storage.listSnapshots(state.slug) : []
  }

  async function historyScene(state, id) {
    return storage.readSnapshot ? storage.readSnapshot(state.slug, id) : null
  }

  /**
   * Bring the board back to snapshot `id`. Nothing is overwritten in place: every element of the snapshot is
   * re-applied with a version above the current one, and elements that appeared later are deleted the same way.
   * The restore is therefore just another edit — it merges with open browsers and can itself be undone from
   * history. Returns the number of elements changed, or null when the snapshot does not exist.
   */
  async function restore(state, id, { by = null } = {}) {
    const scene = await historyScene(state, id)
    if (!scene) return null
    const t = now()
    const bump = (el, current) => ({ ...el, version: Math.max(el.version ?? 1, current?.version ?? 0) + 1, versionNonce: Math.floor(Math.random() * 2 ** 31), updated: t })
    const wanted = new Map((scene.elements ?? []).filter(isMergeableElement).map((el) => [el.id, el]))
    const edits = []
    for (const [elId, el] of wanted) {
      const current = state.elements.get(elId)
      if (current && !current.isDeleted && !el.isDeleted && JSON.stringify({ ...current, version: 0, versionNonce: 0, updated: 0, customData: undefined }) === JSON.stringify({ ...el, version: 0, versionNonce: 0, updated: 0, customData: undefined })) continue
      edits.push(bump(el, current))
    }
    for (const current of state.elements.values()) if (!current.isDeleted && !wanted.has(current.id)) edits.push({ ...bump(current, current), isDeleted: true })
    const files = Object.values(scene.files ?? {})
    const accepted = edits.length || files.length ? apply(state, edits, files, { by }) : 0
    // Keep an explicit marker in history so "restored from X" is visible there too.
    if (accepted && storage.addSnapshot) {
      storage.addSnapshot(state.slug, `${JSON.stringify(snapshot(state), null, 1)}\n`, { source: 'restore', extra: { from: id, ...(by ? { by } : {}) } }).catch((error) => log({ level: 'warn', event: 'restore_snapshot_failed', slug: state.slug, error: String(error?.message ?? error) }))
    }
    return accepted
  }

  async function list() {
    const slugs = new Set(await storage.listSlugs())
    // A board whose first write is still pending is listed too.
    for (const slug of boards.keys()) slugs.add(slug)
    const metas = await Promise.all(
      [...slugs].map(async (slug) => {
        const live = boards.get(slug)
        if (live) return { slug, ...live.meta, stats: stats(live), hasPreview: Boolean(live.preview) }
        const meta = await cachedMeta(slug)
        return meta ? { slug, ...meta, hasPreview: Boolean(meta.stats?.preview) } : null
      }),
    )
    return metas.filter(Boolean).sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
  }

  return {
    epoch,
    get,
    create,
    sync,
    onChange,
    presence,
    join,
    leave,
    setViewerState,
    sweep,
    apply,
    applyAgentEdit,
    react,
    comment,
    changeComment,
    notes: notesView,
    timerAct,
    now,
    /** Metadata of another board, for link cards. */
    boardMeta: cachedMeta,
    history,
    historyScene,
    restore,
    checkpoints,
    checkpointScene,
    checkpointChanges,
    addCheckpoint,
    elements: elementsSorted,
    scene,
    text,
    stats,
    flush,
    flushAll,
    setPreview,
    setMeta,
    list,
    boardUrl,
    _boards: boards,
  }
}
