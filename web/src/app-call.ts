// The editor inside the harnessly app view (`?app=1`): it tells the view (our parent, same origin) what the person has
// selected and where, and when they call the agent on the board — `@harnessly` written in a text or a comment. The view
// passes it on to harnessly, which opens its chat beside that place with the board and the selection in its context.
// Nothing here runs outside the app view, and nothing is sent anywhere but the parent page of our own origin.

/** `@harnessly` at the start of the words or after a space, not inside an address. */
export const MENTION = /(^|\s)@harnessly\b/i

/** The request: the words around the call, without it. */
export const callWords = (text: string): string =>
  text
    .replace(/(^|\s)@harnessly\b[\s,:]*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 600)

/** A rectangle in the editor's own pixels. */
export type Rect = { x: number; y: number; w: number; h: number }

export type ViewMessage =
  | { type: 'board-selection'; text: string; count: number; rect: Rect | null }
  | { type: 'board-call'; text: string; rect: Rect | null }

/** To the app view; nothing when the editor is not inside it. */
export function toView(message: ViewMessage): void {
  if (window.parent === window || !document.documentElement.classList.contains('board-app')) return
  window.parent.postMessage(message, location.origin)
}

/** A comment written with a call: the comments panel says so, the editor (which knows the view) passes it on. */
export const CALL_EVENT = 'board-call'
export type CallDetail = { text: string; x: number; y: number }

export function commentCall(text: string, at: { x: number; y: number }): void {
  if (!MENTION.test(text)) return
  window.dispatchEvent(new CustomEvent<CallDetail>(CALL_EVENT, { detail: { text: callWords(text), x: at.x, y: at.y } }))
}

type View = { scrollX: number; scrollY: number; zoom: { value: number }; offsetLeft?: number; offsetTop?: number }

/** A box of the scene on the editor's screen. */
export function onScreen(box: { x: number; y: number; w: number; h: number }, view: View): Rect {
  const z = view.zoom.value
  return {
    x: Math.round((box.x + view.scrollX) * z + (view.offsetLeft ?? 0)),
    y: Math.round((box.y + view.scrollY) * z + (view.offsetTop ?? 0)),
    w: Math.round(box.w * z),
    h: Math.round(box.h * z),
  }
}

type El = { id: string; type: string; x?: number; y?: number; width?: number; height?: number; text?: string; containerId?: string | null; isDeleted?: boolean }

/** What the selected elements say (their own text, or the text bound in them), and the box around them. */
export function selectionOf(elements: readonly El[], selected: Record<string, boolean>): { text: string; count: number; box: { x: number; y: number; w: number; h: number } | null } {
  const picked = elements.filter((e) => selected[e.id] && !e.isDeleted)
  if (!picked.length) return { text: '', count: 0, box: null }
  const ids = new Set(picked.map((e) => e.id))
  const words: string[] = []
  for (const e of elements) {
    if (e.type !== 'text' || e.isDeleted || !e.text) continue
    if (ids.has(e.id) || (e.containerId && ids.has(e.containerId))) words.push(e.text.replace(/\s+/g, ' ').trim())
  }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const e of picked) {
    const x = e.x ?? 0
    const y = e.y ?? 0
    x0 = Math.min(x0, x, x + (e.width ?? 0))
    y0 = Math.min(y0, y, y + (e.height ?? 0))
    x1 = Math.max(x1, x, x + (e.width ?? 0))
    y1 = Math.max(y1, y, y + (e.height ?? 0))
  }
  return {
    text: [...new Set(words)].filter(Boolean).join(', ').slice(0, 600),
    count: picked.length,
    box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
  }
}
