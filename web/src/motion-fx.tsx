/**
 * Canvas pulses: new things on the board do not appear silently.
 *
 * Shapes are drawn on a canvas, so their appearance cannot be animated there.
 * Instead an overlay in scene coordinates draws a ring that expands and fades
 * around each freshly added block. This shows where an agent drew: its edit
 * lands as a batch of blocks, which otherwise had to be hunted down by eye.
 */
import { useEffect, useState } from 'react'
import { CameraLayer } from './camera'
import { motionOn } from './motion'

type Box = { x: number; y: number; width: number; height: number }
type Pulse = Box & { id: number; tone: string }

/** More rings at once is noise, not guidance: beyond this, outline everything with one. */
const MAX_PULSES = 8
/** The ring waits for the view to reach the block before expanding — see .motion-pulse in motion.css. */
const PULSE_MS = 1300

let seq = 0
let emit: ((pulses: Pulse[]) => void) | null = null

/** Highlight newly added blocks. `tone` is the ring colour, the accent colour by default. */
export function pulse(boxes: readonly Box[], tone = 'var(--studio-accent)') {
  if (!emit || !motionOn() || !boxes.length) return
  let list = boxes.map((b) => ({ x: Math.min(b.x, b.x + b.width), y: Math.min(b.y, b.y + b.height), width: Math.abs(b.width), height: Math.abs(b.height) }))
  if (list.length > MAX_PULSES) {
    const x1 = Math.min(...list.map((b) => b.x))
    const y1 = Math.min(...list.map((b) => b.y))
    const x2 = Math.max(...list.map((b) => b.x + b.width))
    const y2 = Math.max(...list.map((b) => b.y + b.height))
    list = [{ x: x1, y: y1, width: x2 - x1, height: y2 - y1 }]
  }
  emit(list.map((b) => ({ ...b, id: (seq += 1), tone })))
}

export function PulseLayer() {
  const [pulses, setPulses] = useState<Pulse[]>([])
  useEffect(() => {
    emit = (fresh) => {
      setPulses((prev) => [...prev, ...fresh])
      const ids = new Set(fresh.map((p) => p.id))
      setTimeout(() => setPulses((prev) => prev.filter((p) => !ids.has(p.id))), PULSE_MS)
    }
    return () => {
      emit = null
    }
  }, [])
  return (
    <CameraLayer className="motion-layer">
      {pulses.map((p) => (
        <span key={p.id} className="motion-pulse" style={{ left: p.x, top: p.y, width: p.width, height: p.height, color: p.tone }} />
      ))}
    </CameraLayer>
  )
}
