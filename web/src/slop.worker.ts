/**
 * The slop check (AI-slop score) runs in a worker. On a board with a couple of
 * thousand elements it takes half a second or more; on the main thread that
 * froze the canvas a second after every pause in editing.
 */
import { analyzeSlop } from '../../shared/slop.mjs'

self.onmessage = (event: MessageEvent<{ id: number; elements: unknown[] }>) => {
  const { id, elements } = event.data
  let result: unknown = null
  try {
    result = analyzeSlop(elements as never)
  } catch {
    // A malformed element must not kill the worker: the indicator just won't update.
  }
  ;(self as unknown as Worker).postMessage({ id, result })
}
