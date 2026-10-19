/**
 * Live channel of a board: WebSocket `/b/<slug>/live?k=…`.
 *
 * Polling `/sync` every 1.5 s keeps a board consistent, but it doesn't feel like
 * working together: you can't see where others are, and someone else's shape
 * pops in already finished. The channel adds three things on top of the same
 * store:
 *
 * - edits are broadcast immediately, while a shape is still being dragged;
 * - each participant's cursor, laser and selection are relayed to the others;
 *   they are not edits and are never persisted;
 * - "follow a participant": the leader sends its viewport only to its followers.
 *
 * Edits go through `store.apply`, the same version-based merge that `/sync` and
 * the agent API use. So live clients, polling clients and agents coexist on one
 * board: the store reports every accepted edit and the channel fans it out to
 * every socket of the board except the author's.
 *
 * The server, not the client, names the cursor: the name comes from the sign-in
 * cookie or the guest's chosen name, so nobody can impersonate a signed-in user.
 *
 * The service runs as a single replica, so rooms are just process memory. On a
 * restart sockets drop, the client reconnects, sees the new epoch and resends
 * its whole scene, exactly as with polling.
 */
import { WebSocketServer } from 'ws'

const HEARTBEAT_MS = 25_000
const MAX_SOCKETS_PER_BOARD = 60
const MAX_SOCKETS = 600
const MAX_PAYLOAD = 30 * 1024 * 1024
/** Cursors arrive ~30 times a second; anything above 60 is a loop, not a mouse. */
const VOLATILE_PER_SECOND = 60
const CLIENT_RE = /^[a-z0-9]{4,32}$/i
const USER_STATES = new Set(['active', 'idle', 'away'])

const finite = (value) => typeof value === 'number' && Number.isFinite(value)

export function createLive({ store, resolveBoard, editorFor, allowedOrigin, log = () => {} }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: { threshold: 4096 } })
  /** slug → Map<clientId, peer> */
  const rooms = new Map()
  let total = 0

  const send = (peer, message) => {
    if (peer.ws.readyState === peer.ws.OPEN) peer.ws.send(typeof message === 'string' ? message : JSON.stringify(message))
  }

  const broadcast = (slug, message, { except = null, only = null } = {}) => {
    const room = rooms.get(slug)
    if (!room) return
    const raw = JSON.stringify(message)
    for (const peer of room.values()) {
      if (peer.id === except) continue
      if (only && !only.has(peer.id)) continue
      send(peer, raw)
    }
  }

  store.onChange((event) => {
    if (!rooms.has(event.slug)) return
    if (event.type === 'elements') {
      broadcast(event.slug, { t: 'elements', rev: event.rev, elements: event.elements, files: event.files }, { except: event.origin })
    } else if (event.type === 'edit') {
      broadcast(event.slug, { t: 'edit', edit: event.edit, ids: event.ids })
    } else if (event.type === 'presence') {
      broadcast(event.slug, { t: 'presence', viewers: event.viewers })
    } else if (event.type === 'meta') {
      broadcast(event.slug, { t: 'meta', title: event.title, access: event.access, description: event.description, tags: event.tags, task: event.task })
    } else if (event.type === 'timer') {
      broadcast(event.slug, { t: 'timer', timer: event.timer, now: event.now })
    } else if (event.type === 'checkpoints') {
      broadcast(event.slug, { t: 'checkpoints', checkpoints: event.checkpoints })
    } else if (event.type === 'notes') {
      // Reactions and comments go out whole and to everyone, author included: all see the same state.
      broadcast(event.slug, { t: 'notes', notes: event.notes })
    }
  })

  /** Polling participants leave by going silent; this sweep tells live clients they're gone. */
  const sweeper = setInterval(() => {
    for (const room of rooms.values()) {
      const state = [...room.values()][0]?.state
      if (state) store.sweep(state)
    }
  }, 5_000)
  sweeper.unref?.()

  const heartbeat = setInterval(() => {
    for (const room of rooms.values()) {
      for (const peer of room.values()) {
        if (!peer.alive) {
          peer.ws.terminate()
          continue
        }
        peer.alive = false
        peer.ws.ping()
      }
    }
  }, HEARTBEAT_MS)
  heartbeat.unref?.()

  function reject(socket, status, reason) {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  function followersOf(slug, leaderId) {
    const ids = []
    for (const peer of rooms.get(slug)?.values() ?? []) if (peer.following === leaderId) ids.push(peer.id)
    return ids
  }

  function notifyFollowers(slug, leaderId) {
    const leader = rooms.get(slug)?.get(leaderId)
    if (leader) send(leader, { t: 'followers', ids: followersOf(slug, leaderId) })
  }

  /** Rate limit for volatile messages: cursor, selection, viewport. */
  function allowVolatile(peer) {
    const second = Math.floor(Date.now() / 1000)
    if (peer.bucketSecond !== second) {
      peer.bucketSecond = second
      peer.bucket = 0
    }
    peer.bucket += 1
    return peer.bucket <= VOLATILE_PER_SECOND
  }

  function onMessage(peer, raw) {
    let msg
    try {
      msg = JSON.parse(raw)
    } catch {
      return send(peer, { t: 'error', message: 'message must be JSON' })
    }
    const { state } = peer
    switch (msg?.t) {
      case 'ping':
        return send(peer, { t: 'pong' })
      case 'hello': {
        // A client back after a drop reports how it looked on its side: the server
        // only sees a closed socket, while "the channel went silent" is known only to the browser.
        if (typeof msg.dropped === 'string') {
          log({ level: 'info', event: 'live_reconnect', slug: peer.slug, who: peer.identity, reason: msg.dropped.slice(0, 20), aliveMs: finite(msg.aliveMs) ? Math.round(msg.aliveMs) : null })
        }
        // Like the first `/sync`: everything the client lacks, or everything on an
        // epoch mismatch. Plus current cursors of others: otherwise a newcomer
        // doesn't see people who stand still until they move the mouse.
        const data = store.sync(state, { since: msg.since, epoch: msg.epoch })
        const pointers = []
        for (const other of rooms.get(peer.slug)?.values() ?? []) if (other.id !== peer.id && other.pointer) pointers.push({ id: other.id, ...other.pointer })
        return send(peer, { t: 'sync', ...data, viewers: store.presence(state), pointers })
      }
      case 'push': {
        const elements = Array.isArray(msg.elements) ? msg.elements : []
        const files = Array.isArray(msg.files) ? msg.files : []
        if (!elements.length && !files.length) return send(peer, { t: 'ack', seq: msg.seq, rev: state.rev, accepted: 0 })
        const who = editorFor(peer.req, state, { guest: peer.guest })
        if (!who) return send(peer, { t: 'ack', seq: msg.seq, rev: state.rev, accepted: 0, error: 'this board is view-only: sign in to edit' })
        try {
          const accepted = store.apply(state, elements, files, { by: who.name, origin: peer.id })
          return send(peer, { t: 'ack', seq: msg.seq, rev: state.rev, accepted })
        } catch (error) {
          return send(peer, { t: 'ack', seq: msg.seq, rev: state.rev, accepted: 0, error: String(error?.message ?? error) })
        }
      }
      case 'pointer': {
        if (!finite(msg.x) || !finite(msg.y) || !allowVolatile(peer)) return undefined
        peer.pointer = { x: msg.x, y: msg.y, tool: msg.tool === 'laser' ? 'laser' : 'pointer', button: msg.button === 'down' ? 'down' : 'up' }
        return broadcast(peer.slug, { t: 'pointer', id: peer.id, ...peer.pointer }, { except: peer.id })
      }
      case 'select': {
        if (!Array.isArray(msg.ids) || !allowVolatile(peer)) return undefined
        const ids = msg.ids.filter((id) => typeof id === 'string' && id.length <= 64).slice(0, 2000)
        return broadcast(peer.slug, { t: 'select', id: peer.id, ids }, { except: peer.id })
      }
      case 'state': {
        if (USER_STATES.has(msg.state)) store.setViewerState(state, peer.id, msg.state)
        return undefined
      }
      case 'follow': {
        const target = typeof msg.target === 'string' ? msg.target : null
        const previous = peer.following
        peer.following = msg.on && target && target !== peer.id && rooms.get(peer.slug)?.has(target) ? target : null
        if (previous && previous !== peer.following) notifyFollowers(peer.slug, previous)
        if (peer.following) notifyFollowers(peer.slug, peer.following)
        return undefined
      }
      case 'viewport': {
        const b = msg.bounds
        if (!Array.isArray(b) || b.length !== 4 || !b.every(finite) || !allowVolatile(peer)) return undefined
        const followers = new Set(followersOf(peer.slug, peer.id))
        if (followers.size) broadcast(peer.slug, { t: 'viewport', id: peer.id, bounds: b }, { only: followers })
        return undefined
      }
      default:
        return send(peer, { t: 'error', message: 'unknown message' })
    }
  }

  function attach(ws, req, state, url) {
    const slug = state.slug
    const requested = url.searchParams.get('client') ?? ''
    let room = rooms.get(slug)
    if (!room) rooms.set(slug, (room = new Map()))
    const guest = (url.searchParams.get('guest') ?? '').trim().slice(0, 40)
    const who = editorFor(req, state, { guest })
    const identity = `${who?.kind ?? 'viewer'}:${who?.email ?? who?.name ?? ''}`
    // The same tab reconnects before the server notices the old socket died (up to
    // two pings, ~50 s). It used to get a new id while the old one lingered as a
    // ghost cursor. Now the same person reclaims their own id; someone else's id is
    // never handed out, so two people's cursors can't merge.
    const holder = CLIENT_RE.test(requested) ? room.get(requested) : undefined
    if (holder && holder.identity === identity) {
      room.delete(requested)
      holder.ws.terminate()
    }
    const id = CLIENT_RE.test(requested) && !room.has(requested) ? requested : Math.random().toString(36).slice(2, 12)
    const peer = { id, ws, req, state, slug, guest, identity, alive: true, following: null, bucket: 0, bucketSecond: 0, pointer: null }
    room.set(id, peer)
    total += 1

    // Show the name even without edit rights: a signed-in user viewing a
    // team-only board is still a colleague, not an anonymous viewer.
    const name = who?.name ?? null
    store.join(state, id, { name, kind: who?.kind ?? 'viewer', live: true })
    send(peer, { t: 'welcome', id, epoch: store.epoch, canEdit: Boolean(who) })

    ws.on('pong', () => {
      peer.alive = true
    })
    ws.on('message', (data, isBinary) => {
      peer.alive = true
      if (isBinary) return
      onMessage(peer, data.toString('utf8'))
    })
    const openedAt = Date.now()
    ws.on('close', (code) => {
      total -= 1
      log({ level: 'info', event: 'live_close', slug, who: identity, code, aliveMs: Date.now() - openedAt })
      // A reconnected twin already took the slot; don't leave on its behalf.
      if (room.get(id) !== peer) return
      room.delete(id)
      const led = [...room.values()].filter((p) => p.following === id)
      for (const follower of led) follower.following = null
      if (peer.following) notifyFollowers(slug, peer.following)
      if (!room.size) rooms.delete(slug)
      store.leave(state, id)
    })
    ws.on('error', (error) => log({ level: 'warn', event: 'live_socket_error', slug, error: String(error?.message ?? error) }))
  }

  /**
   * HTTP upgrade. Board and key are checked by the same `resolveBoard` as every
   * other endpoint: a wrong key is indistinguishable from a missing board.
   *
   * Origin is checked against the service address: the sign-in cookie is sent on
   * a WebSocket opened from any page, and without this check a foreign site could
   * edit a board as the signed-in user. Non-browser clients send no Origin; the
   * key is enough for them.
   */
  async function upgrade(req, socket, head) {
    socket.on('error', () => {})
    try {
      const url = new URL(req.url, 'http://boards.local')
      const origin = req.headers.origin
      if (origin && allowedOrigin && origin !== allowedOrigin) return reject(socket, 403, 'Forbidden')
      if (total >= MAX_SOCKETS) return reject(socket, 503, 'Service Unavailable')
      const state = await resolveBoard(req, url)
      if (!state) return reject(socket, 404, 'Not Found')
      if ((rooms.get(state.slug)?.size ?? 0) >= MAX_SOCKETS_PER_BOARD) return reject(socket, 503, 'Service Unavailable')
      wss.handleUpgrade(req, socket, head, (ws) => attach(ws, req, state, url))
    } catch (error) {
      log({ level: 'warn', event: 'live_upgrade_failed', error: String(error?.message ?? error) })
      reject(socket, 404, 'Not Found')
    }
  }

  function close() {
    clearInterval(heartbeat)
    clearInterval(sweeper)
    for (const room of rooms.values()) for (const peer of room.values()) peer.ws.close(1001, 'restart')
    wss.close()
  }

  return { upgrade, close, stats: () => ({ sockets: total, boards: rooms.size }) }
}
