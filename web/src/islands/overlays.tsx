// Layers over the canvas, in scene coordinates (they follow the camera): reactions under any object (stickies keep
// theirs in StickyOverlay), the one terminal of the machine, and the outline of what the agent has just changed.
import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { CameraLayer, inWindow, useSceneVersion, useSceneWindow } from '../camera'
import { t } from '../i18n'
import { isSticky, isTerminal, type El } from './scene'
import type { StudioApi } from '../studio'

type Box = { id: string; x: number; y: number; width: number; height: number }

function boxOf(el: El): Box {
  if (el.points?.length) {
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    for (const [px, py] of el.points) {
      x0 = Math.min(x0, el.x + px)
      y0 = Math.min(y0, el.y + py)
      x1 = Math.max(x1, el.x + px)
      y1 = Math.max(y1, el.y + py)
    }
    return { id: el.id, x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
  }
  return { id: el.id, x: Math.min(el.x, el.x + el.width), y: Math.min(el.y, el.y + el.height), width: Math.abs(el.width), height: Math.abs(el.height) }
}

/** Reactions under objects that are not stickies: a row of counters, a click takes one's own back or adds it. */
export const ReactionLayer = memo(function ReactionLayer({ api, me, votes, canReact, onReact }: { api: StudioApi; me: string | null; votes: Record<string, Record<string, string[]>>; canReact: boolean; onReact: (id: string, emoji: string, on: boolean) => void }) {
  const version = useSceneVersion()
  const [boxes, setBoxes] = useState<Box[]>([])
  const sig = useRef('')
  const ids = Object.keys(votes).filter((id) => Object.values(votes[id] ?? {}).some((n) => n.length))
  const want = ids.join(',')
  useLayoutEffect(() => {
    const set = new Set(ids)
    const out: Box[] = []
    let s = ''
    for (const el of api.getSceneElements() as unknown as El[]) {
      if (!set.has(el.id) || el.isDeleted || isSticky(el)) continue
      const b = boxOf(el)
      out.push(b)
      s += `${b.id}:${b.x}:${b.y}:${b.width}:${b.height}|`
    }
    if (s === sig.current) return
    sig.current = s
    setBoxes(out)
  }, [api, version, want])
  const near = useSceneWindow()
  return (
    <CameraLayer className="isl-reactions">
      {boxes
        .filter((b) => inWindow(near, b.x, b.y, b.x + b.width, b.y + b.height + 40))
        .map((b) => (
          <div key={b.id} className="isl-reacts" style={{ left: b.x, top: b.y + b.height + 8 }}>
            {Object.entries(votes[b.id] ?? {})
              .filter(([, names]) => names.length)
              .map(([emoji, names]) => {
                const mine = Boolean(me && names.includes(me))
                return (
                  <button type="button" key={emoji} className={`isl-react${mine ? ' is-mine' : ''}`} title={names.map((n) => n.replace(/^guest:\s*/, '')).join(', ')} disabled={!canReact} onClick={() => onReact(b.id, emoji, !mine)}>
                    {emoji} {names.length}
                  </button>
                )
              })}
          </div>
        ))}
    </CameraLayer>
  )
})

/** The one terminal of the machine on the board: its last lines, as harnessly reads them. */
export const TerminalLayer = memo(function TerminalLayer({ api, text, live }: { api: StudioApi; text: string | null; live: boolean }) {
  const version = useSceneVersion()
  const [box, setBox] = useState<(Box & { title: string }) | null>(null)
  useLayoutEffect(() => {
    const el = (api.getSceneElements() as unknown as El[]).find((e) => isTerminal(e) && !e.isDeleted)
    const next = el ? { ...boxOf(el), title: String(el.customData?.title ?? t('islands.terminalTitle')) } : null
    setBox((was) => (JSON.stringify(was) === JSON.stringify(next) ? was : next))
  }, [api, version])
  if (!box) return null
  return (
    <CameraLayer className="isl-terminals">
      <div className="isl-term" style={{ left: box.x, top: box.y, width: box.width, height: box.height }}>
        <div className="isl-term__bar">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden>
            <path d="M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z M7 9l3 3-3 3 M12 15h5" />
          </svg>
          <b>{box.title}</b>
          <span className={`isl-term__live${live ? '' : ' is-off'}`}>
            <i />
            {live ? t('islands.terminalLive') : t('islands.terminalOff')}
          </span>
        </div>
        <pre>{text ?? t('islands.terminalHint')}</pre>
      </div>
    </CameraLayer>
  )
})

// ── What the agent changed, outlined for a moment ────────────────────────────

let emitGlow: ((boxes: (Box & { key: number })[]) => void) | null = null
let glowSeq = 0

/** Outlines changed objects (an agent's edit) for a few seconds. */
export function glow(elements: readonly El[]) {
  if (!emitGlow) return
  const list = elements.filter((el) => !el.isDeleted && !(el.type === 'text' && el.containerId)).slice(0, 24)
  if (!list.length) return
  emitGlow(list.map((el) => ({ ...boxOf(el), key: (glowSeq += 1) })))
}

export function GlowLayer() {
  const [items, setItems] = useState<(Box & { key: number })[]>([])
  useEffect(() => {
    emitGlow = (fresh) => {
      setItems((prev) => [...prev, ...fresh])
      const keys = new Set(fresh.map((f) => f.key))
      setTimeout(() => setItems((prev) => prev.filter((p) => !keys.has(p.key))), 2700)
    }
    return () => {
      emitGlow = null
    }
  }, [])
  if (!items.length) return null
  return (
    <CameraLayer className="isl-glows">
      {items.map((b) => (
        <div key={b.key} className="isl-glow" style={{ left: b.x - 6, top: b.y - 6, width: b.width + 12, height: b.height + 12 }} />
      ))}
    </CameraLayer>
  )
}
