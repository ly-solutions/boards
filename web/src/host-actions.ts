// harnessly draws no bar of its own above the boards app (HRN-1498): its actions — share, the right pane, its menu — come
// here, into the board's own ⋯. The editor asks the app view (our parent, same origin), which asks harnessly over the
// bridge (hl.host.actions); a harnessly without them, or no harnessly at all, gives none, and the menu stays as it was.
import { useEffect, useState } from 'react'

/** One of harnessly's actions; `icon` is a name from harnessly's set. */
export type HostAction = { id: string; label: string; icon: string; pressed?: boolean; danger?: boolean }

const ASK_WAIT_MS = 1500

/** The editor runs inside the app view (`?app=1`) of harnessly. */
const inAppView = (): boolean => window.parent !== window && new URLSearchParams(location.search).get('app') === '1'

/** harnessly's actions now, or none when it is not there or does not offer them. */
export function askHostActions(): Promise<HostAction[]> {
  if (!inAppView()) return Promise.resolve([])
  return new Promise((resolve) => {
    const done = (list: HostAction[]) => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
      resolve(list)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== window.parent || event.origin !== location.origin) return
      const m = event.data as { type?: string; actions?: unknown }
      if (m?.type !== 'host-actions') return
      done(Array.isArray(m.actions) ? (m.actions as HostAction[]).filter((a) => a && typeof a.id === 'string' && typeof a.label === 'string') : [])
    }
    const timer = setTimeout(() => done([]), ASK_WAIT_MS)
    window.addEventListener('message', onMessage)
    window.parent.postMessage({ type: 'board-host-actions' }, location.origin)
  })
}

/** Runs one of them, as harnessly's own button would. */
export function runHostAction(id: string): void {
  if (inAppView()) window.parent.postMessage({ type: 'board-host-run', id }, location.origin)
}

/** harnessly's actions, read again each time the menu opens (the right pane's state changes meanwhile). */
export function useHostActions(open: boolean): HostAction[] {
  const [list, setList] = useState<HostAction[]>([])
  useEffect(() => {
    if (!open) return
    let live = true
    void askHostActions().then((next) => {
      if (live) setList(next)
    })
    return () => {
      live = false
    }
  }, [open])
  return list
}

/** harnessly's icon names in the islands' own set. */
export const HOST_ICON: Record<string, string> = {
  share: 'link',
  'panel-right': 'panelRight',
  info: 'help',
  settings: 'settings',
  bug: 'terminal',
  x: 'x',
  plus: 'plus',
}
