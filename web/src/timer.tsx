/**
 * Shared board timer: one per board, ticking in sync for everyone, ending with a
 * soft chime and a wiggle of the pill.
 *
 * The server holds the state: when the timer ends (`endsAt`, server clock) or how
 * much is left while paused (`leftMs`). Each client knows its clock offset from
 * the server and computes the remainder itself, so someone joining mid-countdown
 * sees the same time as everyone else, and the network is only needed for actions.
 */
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export type TimerState = { endsAt: number | null; leftMs: number | null; durationMs: number; by: string | null } | null
export type TimerAction = { do: 'start' | 'pause' | 'resume' | 'add' | 'stop'; minutes?: number }

const PRESETS = [3, 5, 10, 15]
/** How long the pill shows "00:00" after the end before turning back into a button. */
const DONE_SHOW_MS = 20_000
/** Last seconds: the pill changes colour, time to wrap up. */
const LAST_MS = 30_000
const SOUND_KEY = 'boards-timer-sound'

const readSound = () => {
  try {
    return localStorage.getItem(SOUND_KEY) !== '0'
  } catch {
    return true
  }
}

// The sound is synthesized in the browser, no files needed. Browsers only allow
// audio after a user gesture, so the context is unlocked on the first pointer
// press anywhere, not at the moment of the chime.
let audio: AudioContext | null = null
function unlockAudio() {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    if (!Ctx) return
    audio ??= new Ctx()
    if (audio.state === 'suspended') void audio.resume()
  } catch {
    audio = null
  }
}
if (typeof document !== 'undefined') document.addEventListener('pointerdown', unlockAudio, { capture: true })

/** Three soft rising notes, under a second: audible on a call, but not startling. */
export function chime() {
  if (!audio || audio.state !== 'running') return
  const start = audio.currentTime
  for (const [delay, frequency] of [
    [0, 659.25],
    [0.17, 880],
    [0.36, 1318.51],
  ]) {
    const osc = audio.createOscillator()
    const gain = audio.createGain()
    osc.type = 'sine'
    osc.frequency.value = frequency
    gain.gain.setValueAtTime(0.0001, start + delay)
    gain.gain.linearRampToValueAtTime(0.14, start + delay + 0.025)
    gain.gain.exponentialRampToValueAtTime(0.0001, start + delay + 0.85)
    osc.connect(gain).connect(audio.destination)
    osc.start(start + delay)
    osc.stop(start + delay + 0.9)
  }
}

const clock = (ms: number) => {
  const total = Math.max(0, Math.ceil(ms / 1000))
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function TimerIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 13V9 M9.5 2.5h5 M12 2.5V5 M18.4 6.6 20 5" />
      <circle cx="12" cy="13" r="8" />
    </svg>
  )
}

type Props = {
  timer: TimerState
  /** Server clock minus browser clock, ms. */
  offset: number
  canEdit: boolean
  onAct: (action: TimerAction) => void
  /** Bottom dock on narrow screens: labelled button, popover above the dock. Otherwise the top-right island. */
  dock?: boolean
  /** No button: the popover is opened from the island's "More" menu. A running timer always shows as a pill. */
  quiet?: boolean
  /** Whether the popover is open, when controlled from outside (the "More" menu). */
  open?: boolean
  onOpen?: (open: boolean) => void
}

export function TimerTool({ timer, offset, canEdit, onAct, dock, quiet, open: openProp, onOpen }: Props) {
  const [openOwn, setOpenOwn] = useState(false)
  const open = openProp ?? openOwn
  const setOpen = onOpen ?? setOpenOwn
  const [, tick] = useState(0)
  const [sound, setSound] = useState(readSound)
  const [custom, setCustom] = useState('')
  const chimed = useRef<number | null>(null)

  const left = timer ? (timer.endsAt !== null ? timer.endsAt - (Date.now() + offset) : timer.leftMs ?? 0) : 0
  const running = Boolean(timer && timer.endsAt !== null)
  const paused = Boolean(timer && timer.endsAt === null)
  const done = running && left <= 0
  const stale = done && left < -DONE_SHOW_MS
  const shown = Boolean(timer) && !stale

  // Tick four times a second, and only while there is something to show.
  useEffect(() => {
    if (!running || stale) return
    const timerId = setInterval(() => tick((n) => n + 1), 250)
    return () => clearInterval(timerId)
  }, [running, stale, timer?.endsAt])

  // Chime once per end, and only if it happened while we were here, not before the board was opened.
  useEffect(() => {
    if (!done || !timer?.endsAt || chimed.current === timer.endsAt) return
    chimed.current = timer.endsAt
    if (left > -2_000 && sound) chime()
  }, [done, timer?.endsAt, left, sound])

  const toggleSound = (on: boolean) => {
    setSound(on)
    try {
      localStorage.setItem(SOUND_KEY, on ? '1' : '0')
    } catch {
      // Storage unavailable: the sound just stays on.
    }
  }
  const start = (minutes: number) => {
    if (!Number.isFinite(minutes) || minutes <= 0) return
    onAct({ do: 'start', minutes })
    setCustom('')
  }

  const state = done ? ' is-done' : paused ? ' is-paused' : left <= LAST_MS ? ' is-last' : ''
  const trigger = shown ? (
    <button type="button" className={`timer-pill${state}${dock ? ' timer-pill--dock' : ' timer-pill--bar'}`} onClick={() => setOpen(!open)} title={`Timer${timer?.by ? ` · started by ${timer.by.replace(/^guest:\s*/, '')}` : ''}`} aria-label={`Timer: ${clock(left)} left`}>
      <TimerIcon />
      <span className="timer-pill__time">{clock(left)}</span>
    </button>
  ) : canEdit && !quiet ? (
    dock ? (
      <button type="button" className={`studio-dock__btn${open ? ' is-on' : ''}`} onClick={() => setOpen(!open)} title="Shared timer">
        <TimerIcon />
        <span className="studio-dock__label">Timer</span>
      </button>
    ) : (
      <button type="button" className={`bar-btn${open ? ' is-on' : ''}`} onClick={() => setOpen(!open)} title="Shared timer: runs for everyone on the board" aria-label="Timer" aria-pressed={open}>
        <TimerIcon />
      </button>
    )
  ) : null

  return (
    <>
      {trigger}
      {open &&
        createPortal(
          <div className={`timer-pop${dock ? ' timer-pop--dock' : ' timer-pop--bar'}`} role="dialog" aria-label="Timer" onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}>
            <div className="timer-pop__head">
              <strong>Timer{shown && timer?.by ? ` · started by ${timer.by.replace(/^guest:\s*/, '').split(' ')[0]}` : ''}</strong>
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Close">
                ✕
              </button>
            </div>
            {shown && <div className={`timer-pop__time${state}`}>{done ? 'Time is up' : clock(left)}</div>}
            {shown && canEdit && (
              <div className="timer-pop__row">
                {!done && (
                  <button type="button" className="board-button board-button--ghost" onClick={() => onAct({ do: paused ? 'resume' : 'pause' })}>
                    {paused ? 'Resume' : 'Pause'}
                  </button>
                )}
                <button type="button" className="board-button board-button--ghost" onClick={() => onAct({ do: 'add', minutes: 1 })}>
                  +1 min
                </button>
                <button type="button" className="board-button board-button--ghost" onClick={() => onAct({ do: 'stop' })}>
                  Stop
                </button>
              </div>
            )}
            {canEdit && (
              <div className="timer-pop__row timer-pop__presets">
                {PRESETS.map((m) => (
                  <button type="button" key={m} className="timer-preset" onClick={() => start(m)} title={`Start for ${m} min`}>
                    {m}
                  </button>
                ))}
                <form
                  onSubmit={(e) => {
                    e.preventDefault()
                    start(Number(custom.replace(',', '.')))
                  }}
                >
                  <input
                    id="timer-custom"
                    className="timer-custom"
                    inputMode="decimal"
                    placeholder="custom"
                    aria-label="Custom number of minutes"
                    value={custom}
                    maxLength={5}
                    onChange={(e) => setCustom(e.target.value)}
                    onKeyDown={(e) => e.stopPropagation()}
                  />
                </form>
                <span className="timer-pop__unit">minutes</span>
              </div>
            )}
            <label className="timer-pop__sound">
              <input type="checkbox" checked={sound} onChange={(e) => toggleSound(e.target.checked)} />
              Chime at the end (for me)
            </label>
          </div>,
          document.body,
        )}
    </>
  )
}
