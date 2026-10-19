/** Small helpers shared by the floating popovers (context menu, link and board dialogs). */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react'

export type Anchor = { left: number; top: number }

/** Keep the popover on screen: after the first render, nudge it back inside the viewport. */
export function useFit(anchor: Anchor, deps: unknown[] = []) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState(anchor)
  useLayoutEffect(() => {
    const box = ref.current?.getBoundingClientRect()
    if (!box) return
    const gap = 8
    const left = Math.max(gap, Math.min(anchor.left, window.innerWidth - box.width - gap))
    const top = Math.max(gap, Math.min(anchor.top, window.innerHeight - box.height - gap))
    if (left !== pos.left || top !== pos.top) setPos({ left, top })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.left, anchor.top, ...deps])
  return { ref, pos }
}

/** A click outside or Escape closes the popover. Listen in the capture phase: the Excalidraw canvas stops bubbling. */
export function useDismiss(ref: RefObject<HTMLElement | null>, onClose: () => void) {
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey, true)
    }
  }, [ref, onClose])
}
