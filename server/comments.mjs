/**
 * Comment threads — pure operations on a board's notes.
 *
 * Threads are not scene elements: they sit in `notes.comments` next to sticky reactions, never appear in exports,
 * and are sent to clients whole after each change. A thread is pinned to a canvas point; when the point is on a
 * shape the pin is anchored to it with an offset, so the pin travels with the shape.
 *
 * Everything here works on plain data and throws CommentError with an HTTP status; the store adds persistence and
 * broadcasting, the HTTP layer adds permissions.
 */
import { randomBytes } from 'node:crypto'

export const COMMENT_LIMITS = Object.freeze({ text: 2000, threads: 500, messages: 200 })

export class CommentError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

const newId = () => randomBytes(5).toString('hex')
const cleanText = (value) => (typeof value === 'string' ? value.trim().slice(0, COMMENT_LIMITS.text) : '')

/** Pin position and anchor for a point: `elementId` counts only if that element is on the board. */
export function placePin(elements, x, y, elementId) {
  const target = typeof elementId === 'string' ? elements.get(elementId) : null
  const anchored = target && !target.isDeleted ? target : null
  return {
    x: Math.round(x),
    y: Math.round(y),
    elementId: anchored ? anchored.id : null,
    dx: anchored ? Math.round(x - anchored.x) : 0,
    dy: anchored ? Math.round(y - anchored.y) : 0,
  }
}

const message = (author, kind, text, at, replyTo) => ({ id: newId(), author, authorKind: kind === 'agent' ? 'agent' : 'person', text, at, ...(replyTo ? { replyTo } : {}) })

/** Start a thread. Returns the new thread (already appended to `notes.comments`). */
export function openThread(notes, elements, { text, x, y, elementId = null }, { author, kind = 'person', now = new Date() }) {
  const body = cleanText(text)
  if (!body) throw new CommentError(400, 'text: the comment text')
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new CommentError(400, 'x, y: the canvas point to pin the comment to')
  if (notes.comments.length >= COMMENT_LIMITS.threads) throw new CommentError(400, `a board holds at most ${COMMENT_LIMITS.threads} threads — delete resolved ones`)
  const at = new Date(now).toISOString()
  const thread = { id: newId(), ...placePin(elements, x, y, elementId), author, createdAt: at, resolved: false, messages: [message(author, kind, body, at)] }
  notes.comments.push(thread)
  return thread
}

/**
 * Apply one request to a thread: reply, resolve/reopen, move the pin, delete a message or the whole thread.
 * Returns `{ thread, removed, replied, resolvedChanged }`. Throws 404 for an unknown thread or message.
 * `mayDelete(author)` decides whether the caller may delete content written by `author`.
 */
export function changeThread(notes, elements, id, change, { author, kind = 'person', now = new Date(), mayDelete = () => true }) {
  const index = notes.comments.findIndex((t) => t.id === id)
  if (index < 0) throw new CommentError(404, 'no such thread')
  const thread = notes.comments[index]

  if (change.remove) {
    if (!mayDelete(thread.author)) throw new CommentError(403, "only signed-in users can delete someone else's thread")
    notes.comments.splice(index, 1)
    return { thread, removed: true }
  }
  if (typeof change.removeMessage === 'string') {
    const position = thread.messages.findIndex((m) => m.id === change.removeMessage)
    if (position < 0) throw new CommentError(404, 'no such message in the thread')
    if (!mayDelete(thread.messages[position].author)) throw new CommentError(403, "only signed-in users can delete someone else's message")
    // The first message is the thread itself: without it there is nothing to reply to.
    if (position === 0) {
      notes.comments.splice(index, 1)
      return { thread, removed: true }
    }
    thread.messages.splice(position, 1)
    return { thread, removed: false }
  }

  let replied = null
  const reply = cleanText(change.reply)
  if (reply) {
    if (thread.messages.length >= COMMENT_LIMITS.messages) throw new CommentError(400, `a thread holds at most ${COMMENT_LIMITS.messages} replies`)
    const quoted = typeof change.replyTo === 'string' && thread.messages.some((m) => m.id === change.replyTo) ? change.replyTo : null
    replied = message(author, kind, reply, new Date(now).toISOString(), quoted)
    thread.messages.push(replied)
  }
  let resolvedChanged = false
  if (typeof change.resolved === 'boolean') {
    resolvedChanged = thread.resolved !== change.resolved
    thread.resolved = change.resolved
    thread.resolvedBy = change.resolved ? author : null
  }
  if (Number.isFinite(change.x) && Number.isFinite(change.y)) Object.assign(thread, placePin(elements, change.x, change.y, change.elementId))
  return { thread, removed: false, replied, resolvedChanged }
}
