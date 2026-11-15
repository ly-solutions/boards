// A sticky's text shrinks while it is typed so that it fits, as in FigJam; when even the smallest size does not fit,
// the sticky grows in height. A size picked by hand in the text bar turns this off for that sticky (fontAuto: false).
import { useEffect } from 'react'
import { STICKY_FONT_MIN, apply, autoFont, fitStickyFont, isSticky, type El } from './scene'
import type { Api } from './islands'

export function useStickyFit(api: Api, enabled: boolean) {
  useEffect(() => {
    if (!enabled || !api.onChange) return
    const done = new Map<string, string>()
    let pending = 0
    const off = api.onChange((elements, appState) => {
      const editing = appState.editingTextElement as El | null
      if (!editing?.containerId) return
      const list = elements as El[]
      const text = list.find((e) => e.id === editing.id)
      const sticky = list.find((e) => e.id === editing.containerId)
      if (!text || !sticky || !isSticky(sticky) || !autoFont(text)) return
      const key = `${text.originalText ?? text.text}|${Math.round(sticky.width)}|${Math.round(sticky.height)}|${text.fontFamily}`
      if (done.get(text.id) === key) return
      done.set(text.id, key)
      cancelAnimationFrame(pending)
      // After the editor has finished this change.
      pending = requestAnimationFrame(() => {
        const now = (api.getSceneElements() as unknown as El[]).find((e) => e.id === text.id)
        const box = (api.getSceneElements() as unknown as El[]).find((e) => e.id === sticky.id)
        if (!now || !box) return
        const size = fitStickyFont(now, box) ?? STICKY_FONT_MIN
        if (size === now.fontSize) return
        apply(api, new Map([[now.id, { fontSize: size, customData: { ...now.customData, stickyFont: size } }]]), { relayout: [now.id], capture: false })
      })
    })
    return () => {
      cancelAnimationFrame(pending)
      off()
    }
  }, [api, enabled])
}
