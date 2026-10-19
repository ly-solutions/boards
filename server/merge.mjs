/**
 * Element-level merge.
 *
 * People in browsers and agents over the API edit a board at the same time, and
 * nobody holds a lock. So the scene is merged per element, with the same rule
 * Excalidraw itself uses (`reconcileElements`): every element has a `version`
 * counter that grows on each edit and a random `versionNonce`. The higher version
 * wins; on a tie the lower nonce wins. The rule is deterministic, so the server
 * and every browser converge on the same scene whatever order edits arrive in.
 *
 * A delete is an edit too: the element stays with `isDeleted: true` and a bumped
 * version. If deleted elements simply vanished, a browser holding an old copy
 * would bring them back on its next sync.
 */

const TYPES = new Set([
  'rectangle', 'ellipse', 'diamond', 'arrow', 'line', 'freedraw', 'text', 'image',
  'frame', 'magicframe', 'embeddable', 'iframe', 'selection',
])

/** `true` when the incoming element should replace the stored one. */
export function incomingWins(stored, incoming) {
  if (!stored) return true
  if (incoming.version > stored.version) return true
  if (incoming.version < stored.version) return false
  return incoming.versionNonce < stored.versionNonce
}

/**
 * Checks the element's shape, not its content.
 *
 * The content is Excalidraw's format and changes between versions, so we leave
 * it alone. But merging is impossible without `id`, `version` and `versionNonce`,
 * and a huge `id` would turn the scene into arbitrary data storage.
 */
export function isMergeableElement(element) {
  return (
    element !== null &&
    typeof element === 'object' &&
    typeof element.id === 'string' &&
    element.id.length > 0 &&
    element.id.length <= 64 &&
    TYPES.has(element.type) &&
    Number.isFinite(element.version) &&
    Number.isFinite(element.versionNonce)
  )
}

/** Files (images) are immutable: the id is a content hash, so rewriting is never needed. */
export function isMergeableFile(file) {
  return (
    file !== null &&
    typeof file === 'object' &&
    typeof file.id === 'string' &&
    file.id.length <= 128 &&
    typeof file.dataURL === 'string' &&
    /^data:image\/(png|jpeg|gif|webp|svg\+xml|avif);base64,/.test(file.dataURL)
  )
}

/**
 * Z-order on the canvas.
 *
 * Excalidraw 0.18 keeps order in `index`, a fractional key compared as a string.
 * The scene is served already sorted, so older clients and third-party tools
 * opening an exported `.excalidraw` file draw it correctly too.
 */
export function byIndex(a, b) {
  const ai = a.index ?? ''
  const bi = b.index ?? ''
  if (ai === bi) return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  return ai < bi ? -1 : 1
}
