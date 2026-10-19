/**
 * Board checkpoints and a meaningful diff between them.
 *
 * A board is saved every few seconds while it is edited: one planning call can
 * produce over a hundred saves. Nobody needs that history — it cannot tell you
 * what changed during the week. A checkpoint is a snapshot a person named, and
 * the diff between two checkpoints is computed by content, not coordinates:
 * which blocks appeared, changed or were removed. A moved or resized block is
 * not a change.
 *
 * The unit of the diff is a labelled block: a shape with a label, a free text
 * or an image. Arrows, lines, frames and empty shapes are decoration, not
 * agreements, so they are left out.
 *
 * Shared by the server (summary when a checkpoint is created) and the editor
 * (highlighting on the board), so it has no imports.
 */

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
/** A shift smaller than this is a shaky hand, not a move. */
const MOVE_EPS = 2

const clean = (text) => String(text ?? '').replace(/\s+/g, ' ').trim()

/** Sticky outcome colors — the same as in the "Weekly plan" template legend. */
export const OUTCOME_FILL = { done: '#b3efbd', failed: '#ffb8a8' }
/** The "in progress" color that unfinished stickies return to when the week is closed. */
export const OPEN_FILL = '#ffe299'

/**
 * Labelled blocks of a scene: id → its text, fill, position and author. A bound
 * label belongs to its container shape.
 */
export function units(elements) {
  const live = (elements ?? []).filter((el) => el && !el.isDeleted)
  const byId = new Map(live.map((el) => [el.id, el]))
  const out = new Map()
  for (const el of live) {
    if (el.type === 'text') {
      const host = el.containerId ? byId.get(el.containerId) : null
      // An arrow label decorates the connection; it is not a block.
      if (host && !SHAPES.has(host.type)) continue
      const target = host ?? el
      const text = clean(el.originalText ?? el.text)
      if (!text) continue
      out.set(target.id, {
        id: target.id,
        text,
        fill: host ? host.backgroundColor ?? null : null,
        kind: host?.customData?.kind === 'sticky' ? 'sticky' : host ? 'shape' : 'text',
        author: target.customData?.author ?? target.customData?.editedBy ?? null,
        x: target.x,
        y: target.y,
        width: target.width,
        height: target.height,
      })
    } else if (el.type === 'image') {
      out.set(el.id, { id: el.id, text: 'image', fill: null, kind: 'image', author: el.customData?.editedBy ?? null, x: el.x, y: el.y, width: el.width, height: el.height })
    }
  }
  return out
}

const sameContent = (a, b) => a.text === b.text && (a.fill ?? null) === (b.fill ?? null)

/**
 * Diff between two scenes: what was added, changed and removed.
 * `moved` counts blocks that were only moved; they are not part of the diff.
 */
export function diff(before, after) {
  const a = units(before)
  const b = units(after)
  const added = []
  const changed = []
  const removed = []
  let moved = 0
  for (const [id, unit] of b) {
    const was = a.get(id)
    if (!was) added.push(unit)
    else if (!sameContent(was, unit)) changed.push({ ...unit, before: { text: was.text, fill: was.fill } })
    else if (Math.abs(was.x - unit.x) > MOVE_EPS || Math.abs(was.y - unit.y) > MOVE_EPS || Math.abs(was.width - unit.width) > MOVE_EPS || Math.abs(was.height - unit.height) > MOVE_EPS) moved += 1
  }
  for (const [id, unit] of a) if (!b.has(id)) removed.push(unit)
  return { added, changed, removed, moved }
}

/** Short diff summary for the checkpoint list: counts and contribution per author. */
export function summarize({ added, changed, removed, moved }) {
  const byAuthor = {}
  for (const unit of [...added, ...changed]) {
    if (!unit.author) continue
    byAuthor[unit.author] = (byAuthor[unit.author] ?? 0) + 1
  }
  return {
    added: added.length,
    stickies: added.filter((u) => u.kind === 'sticky').length,
    changed: changed.length,
    removed: removed.length,
    moved,
    byAuthor,
  }
}

/** Whether the diff is empty — nothing to checkpoint. */
export const isEmpty = (summary) => !summary.added && !summary.changed && !summary.removed

/** Week outcome by stickies: a sticky's color is its outcome (the "Weekly plan" template legend). */
export function weekOutcome(elements) {
  const out = { done: 0, failed: 0, open: 0 }
  for (const el of elements ?? []) {
    if (el.isDeleted || el.customData?.kind !== 'sticky') continue
    const fill = String(el.backgroundColor ?? '').toLowerCase()
    if (fill === OUTCOME_FILL.done) out.done += 1
    else if (fill === OUTCOME_FILL.failed) out.failed += 1
    else out.open += 1
  }
  return out
}

/**
 * What closing the week does to the scene: done stickies leave the board with
 * their labels (they stay in the checkpoint), missed ones get the "in progress"
 * color back. Returns ids to remove and ids to recolor.
 */
export function weekCleanup(elements) {
  const remove = new Set()
  const reset = []
  for (const el of elements ?? []) {
    if (el.isDeleted || el.customData?.kind !== 'sticky') continue
    const fill = String(el.backgroundColor ?? '').toLowerCase()
    if (fill === OUTCOME_FILL.done) remove.add(el.id)
    else if (fill === OUTCOME_FILL.failed) reset.push(el.id)
  }
  for (const el of elements ?? []) if (!el.isDeleted && el.containerId && remove.has(el.containerId)) remove.add(el.id)
  return { remove: [...remove], reset }
}
