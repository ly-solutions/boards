// Excalidraw's «To move canvas, hold mouse wheel or spacebar…» hint stands under the toolbar whenever the selection
// tool has nothing selected — that is, almost always (HRN-1452). A person reads it once: it shows for a few seconds on
// their first board and never again; every other hint (text editing, line points) stays as Excalidraw shows it.

const KEY = 'boards.panHintSeen'
const SHOW_MS = 6000

let seen = false
let timer: ReturnType<typeof setTimeout> | undefined

function read(): boolean {
  try {
    return window.localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

function markSeen() {
  seen = true
  document.documentElement.classList.add('pan-hint-seen')
  try {
    window.localStorage.setItem(KEY, '1')
  } catch {
    // Private mode: it shows again next time, nothing breaks.
  }
}

/** Whether Excalidraw shows the panning hint for this state: the selection tool and nothing selected. */
export const panHintShown = (appState: Record<string, unknown>): boolean =>
  (appState.activeTool as { type?: string } | undefined)?.type === 'selection' &&
  Object.values((appState.selectedElementIds ?? {}) as Record<string, boolean>).every((on) => !on) &&
  !appState.selectionElement &&
  !appState.editingTextElement

/** Called on every scene change: marks the hint on screen, and counts its first few seconds once. */
export function followPanHint(appState: Record<string, unknown>): void {
  if (!seen && read()) markSeen()
  const on = panHintShown(appState)
  document.documentElement.classList.toggle('pan-hint-on', on)
  if (seen || !on || timer) return
  timer = setTimeout(markSeen, SHOW_MS)
}
