/**
 * Checkpoints: named snapshots of a board and a meaningful diff between them.
 *
 * The panel shows what changed since the last checkpoint plus the list of
 * checkpoints. The diff is highlighted right on the canvas: added, changed (with
 * a "was" label) and removed (a ghost in its old place). Pure moves are not part
 * of the diff — the rule is shared with the server, `shared/checkpoints.mjs`.
 *
 * A checkpoint can't be "restored over" the board: it opens read-only
 * (`?at=<id>`) or gets copied into a new board.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { CameraLayer, useSceneVersion } from './camera'
import type { StudioApi } from './studio'
import { diff, isEmpty, summarize, weekOutcome } from '../../shared/checkpoints.mjs'

export type Summary = { added: number; stickies: number; changed: number; removed: number; moved: number; byAuthor: Record<string, number> }
export type Week = { done: number; failed: number; open: number }
export type Checkpoint = { id: string; title: string; by: string | null; at: string; elements: number; summary: Summary; week?: Week }
type Unit = { id: string; text: string; fill: string | null; kind: string; author: string | null; x: number; y: number; width: number; height: number; before?: { text: string; fill: string | null } }
type Changes = { added: Unit[]; changed: Unit[]; removed: Unit[]; moved: number }
type SceneEl = { id: string; x: number; y: number; width: number; height: number; isDeleted?: boolean }

const day = (d: Date) => d.toLocaleDateString(undefined, { day: 'numeric', month: 'long' })
const when = (iso: string) => {
  const d = new Date(iso)
  if (Number.isNaN(d.valueOf())) return ''
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  return new Date().toDateString() === d.toDateString() ? `today ${time}` : `${day(d)}, ${time}`
}
const short = (name: string) => name.replace(/^guest:\s*/, '').split(' ')[0]
const cut = (text: string, n: number) => (text.length > n ? `${text.slice(0, n - 1)}…` : text)

function Chips({ summary }: { summary: Summary }) {
  if (isEmpty(summary)) return <span className="cp-chip">no changes</span>
  return (
    <>
      {summary.added > 0 && <span className="cp-chip cp-chip--add" title={summary.stickies ? `${summary.stickies} of them sticky notes` : undefined}>+{summary.added}</span>}
      {summary.changed > 0 && <span className="cp-chip cp-chip--chg">{summary.changed} changed</span>}
      {summary.removed > 0 && <span className="cp-chip cp-chip--del">{summary.removed} removed</span>}
    </>
  )
}

function Authors({ summary }: { summary: Summary }) {
  const rows = Object.entries(summary.byAuthor).sort((a, b) => b[1] - a[1])
  if (!rows.length) return null
  return <span className="cp-authors">{rows.map(([name, n]) => `${short(name)} ${n}`).join(' · ')}</span>
}

function WeekLine({ week }: { week: Week }) {
  return (
    <span className="cp-week">
      <span className="cp-chip cp-chip--add">{week.done} done</span>
      <span className="cp-chip cp-chip--del">{week.failed} missed</span>
      <span className="cp-chip">{week.open} in progress</span>
    </span>
  )
}

/** Diff highlight on the canvas: frames follow live elements, removed ones stay as ghosts in their old place. */
export const CheckpointHighlights = memo(function CheckpointHighlights({ api, changes }: { api: StudioApi; changes: Changes }) {
  const version = useSceneVersion()
  const live = useMemo(() => {
    const wanted = new Set([...changes.added, ...changes.changed].map((u) => u.id))
    const map = new Map<string, SceneEl>()
    for (const el of api.getSceneElements() as unknown as SceneEl[]) if (wanted.has(el.id)) map.set(el.id, el)
    return map
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, changes, version])
  const box = (u: Unit) => {
    const el = live.get(u.id) ?? u
    return { left: Math.min(el.x, el.x + el.width), top: Math.min(el.y, el.y + el.height), width: Math.abs(el.width), height: Math.abs(el.height) }
  }
  return (
    <CameraLayer className="cp-marks">
      {changes.added.map((u) => (
        <div key={u.id} className="cp-mark cp-mark--add" style={box(u)}>
          <span className="camera-fixed"><span className="cp-mark__tag">new</span></span>
        </div>
      ))}
      {changes.changed.map((u) => (
        <div key={u.id} className="cp-mark cp-mark--chg" style={box(u)} title={`Was: ${u.before?.text ?? ''}`}>
          <span className="camera-fixed"><span className="cp-mark__tag">{u.before && u.before.text !== u.text ? `was: ${cut(u.before.text, 34)}` : 'colour changed'}</span></span>
        </div>
      ))}
      {changes.removed.map((u) => (
        <div key={u.id} className="cp-mark cp-mark--del" style={{ left: u.x, top: u.y, width: u.width, height: u.height, background: u.fill && u.fill !== 'transparent' ? u.fill : undefined }}>
          <span className="cp-mark__ghost">{cut(u.text, 80)}</span>
          <span className="camera-fixed"><span className="cp-mark__tag">removed</span></span>
        </div>
      ))}
    </CameraLayer>
  )
})

type Props = {
  api: StudioApi
  base: string
  q: string
  guest: string
  canEdit: boolean
  list: Checkpoint[] | null
  setList: (list: Checkpoint[]) => void
  onClose: () => void
}

/** The checkpoints panel: what changed now, the checkpoint button and past checkpoints. */
export const Checkpoints = memo(function Checkpoints({ api, base, q, guest, canEdit, list, setList, onClose }: Props) {
  const version = useSceneVersion()
  const [selected, setSelected] = useState<string | null>('now')
  const [changes, setChanges] = useState<Changes | null>(null)
  const [form, setForm] = useState<null | 'plain' | 'week'>(null)
  const [title, setTitle] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const lastScene = useRef<{ id: string | null; elements: unknown[] } | null>(null)
  const [lastReady, setLastReady] = useState(0)
  const last = list?.at(-1) ?? null

  useEffect(() => {
    let off = false
    fetch(`${base}/checkpoints${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        if (off || !data) return
        setList(data.checkpoints)
      })
      .catch(() => {})
    return () => {
      off = true
    }
  }, [base, q, setList])

  // The last checkpoint's scene is the base for "what changed now"; fetched once per checkpoint.
  useEffect(() => {
    if (list === null) return
    const id = last?.id ?? null
    if (lastScene.current?.id === id) return
    if (!id) {
      lastScene.current = { id: null, elements: [] }
      setLastReady((n) => n + 1)
      return
    }
    let off = false
    fetch(`${base}/checkpoints/${id}/scene${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((scene) => {
        if (off || !scene) return
        lastScene.current = { id, elements: scene.elements ?? [] }
        setLastReady((n) => n + 1)
      })
      .catch(() => {})
    return () => {
      off = true
    }
  }, [base, q, list, last?.id])

  // The diff against the last checkpoint is computed locally, at most every 400 ms: typing changes the scene on every keystroke.
  const [pending, setPending] = useState<Changes | null>(null)
  useEffect(() => {
    if (!lastScene.current) return
    const timer = setTimeout(() => setPending(diff(lastScene.current!.elements, api.getSceneElements()) as Changes), pending ? 400 : 0)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, version, lastReady])

  // A past checkpoint's diff comes from the server: the browser has neither its scene nor the previous one.
  useEffect(() => {
    if (!selected || selected === 'now') {
      setChanges(null)
      return
    }
    let off = false
    fetch(`${base}/checkpoints/${selected}/diff${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => !off && setChanges(data))
      .catch(() => {})
    return () => {
      off = true
    }
  }, [base, q, selected])

  const pendingSummary = useMemo(() => (pending ? (summarize(pending) as Summary) : null), [pending])
  const week = useMemo(() => weekOutcome(api.getSceneElements()) as Week, [api, version])
  const hasStickies = week.done + week.failed + week.open > 0

  const openForm = (kind: 'plain' | 'week') => {
    setError(null)
    setTitle(kind === 'week' ? `Week to ${day(new Date())}` : `Checkpoint ${day(new Date())}`)
    setForm(kind)
  }
  const create = useCallback(async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      const response = await fetch(`${base}/checkpoints${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: title.trim(), closeWeek: form === 'week', guest: guest || undefined }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error ?? 'Checkpoint was not saved')
      setList(data.checkpoints)
      setForm(null)
      setSelected('now')
    } catch (e) {
      setError(String((e as Error).message))
    } finally {
      setBusy(false)
    }
  }, [base, q, title, form, guest, busy, setList])

  const copy = async (id: string) => {
    setBusy(true)
    try {
      const response = await fetch(`${base}/checkpoints/${id}/copy${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ guest: guest || undefined }) })
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error ?? 'Could not create a copy')
      const url = new URL(data.url)
      window.open(`${location.origin}${url.pathname}${url.search}`, '_blank')
    } catch (e) {
      api.setToast({ message: String((e as Error).message), closable: true, duration: 5000 })
    } finally {
      setBusy(false)
    }
  }

  const shown = selected === 'now' ? pending : changes
  return (
    <>
      {shown && !isEmpty(summarize(shown)) && <CheckpointHighlights api={api} changes={shown} />}
      {createPortal(
        <aside className="cp-panel" aria-label="Checkpoints">
          <div className="cp-panel__head">
            <strong>Checkpoints</strong>
            <button type="button" className="icon-button" onClick={onClose} aria-label="Close checkpoints panel">
              ✕
            </button>
          </div>
          <div className="cp-panel__body">
            <button type="button" className={`cp-row${selected === 'now' ? ' is-on' : ''}`} onClick={() => setSelected(selected === 'now' ? null : 'now')}>
              <span className="cp-row__title">Now</span>
              <span className="cp-row__meta">{last ? `since “${cut(last.title, 28)}”` : 'no checkpoints yet'}</span>
              <span className="cp-row__chips">{pendingSummary ? <Chips summary={pendingSummary} /> : <span className="cp-chip">counting…</span>}</span>
              {pendingSummary && <Authors summary={pendingSummary} />}
              {pendingSummary && pendingSummary.moved > 0 && <span className="cp-row__note">Moved without changes: {pendingSummary.moved}. Not part of the diff.</span>}
            </button>

            {canEdit && !form && (
              <div className="cp-actions">
                <button type="button" className="board-button" onClick={() => openForm('plain')}>
                  Save checkpoint
                </button>
                {hasStickies && (
                  <button type="button" className="board-button board-button--ghost" onClick={() => openForm('week')}>
                    Close week…
                  </button>
                )}
              </div>
            )}

            {form && (
              <form
                className="cp-form"
                onSubmit={(e) => {
                  e.preventDefault()
                  void create()
                }}
              >
                <strong>{form === 'week' ? 'Close week' : 'New checkpoint'}</strong>
                <input
                  type="text"
                  value={title}
                  maxLength={80}
                  autoFocus
                  aria-label="Checkpoint name"
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => {
                    e.stopPropagation()
                    if (e.key === 'Escape') setForm(null)
                  }}
                />
                {form === 'week' && (
                  <>
                    <WeekLine week={week} />
                    <span className="cp-row__note">Done (green) stickies leave the board and stay in this checkpoint. Missed ones go back to the “in progress” colour. Everything else stays as is.</span>
                  </>
                )}
                {error && <span className="cp-error">{error}</span>}
                <div className="cp-actions">
                  <button type="button" className="board-button board-button--ghost" onClick={() => setForm(null)}>
                    Cancel
                  </button>
                  <button type="submit" className="board-button" disabled={busy || !title.trim()}>
                    {form === 'week' ? 'Close week' : 'Save checkpoint'}
                  </button>
                </div>
              </form>
            )}

            {list === null && <p className="cp-empty">Loading…</p>}
            {list?.length === 0 && <p className="cp-empty">Save a checkpoint once you agree on something. A week later you'll see here what changed and what was merely moved.</p>}
            {[...(list ?? [])].reverse().map((c) => (
              <div key={c.id} className={`cp-row cp-row--past${selected === c.id ? ' is-on' : ''}`}>
                <button type="button" className="cp-row__main" onClick={() => setSelected(selected === c.id ? null : c.id)}>
                  <span className="cp-row__title">{c.title}</span>
                  <span className="cp-row__meta">
                    {when(c.at)}
                    {c.by ? ` · ${short(c.by)}` : ''}
                  </span>
                  <span className="cp-row__chips">
                    <Chips summary={c.summary} />
                  </span>
                  {c.week && <WeekLine week={c.week} />}
                </button>
                {selected === c.id && (
                  <div className="cp-row__more">
                    <Authors summary={c.summary} />
                    {changes && (changes.changed.length > 0 || changes.removed.length > 0) && (
                      <ul className="cp-list">
                        {changes.changed.slice(0, 6).map((u) => (
                          <li key={u.id}>
                            <s>{cut(u.before?.text ?? '', 40)}</s> → {cut(u.text, 40)}
                          </li>
                        ))}
                        {changes.removed.slice(0, 6).map((u) => (
                          <li key={u.id} className="is-del">
                            removed: {cut(u.text, 60)}
                          </li>
                        ))}
                      </ul>
                    )}
                    <div className="cp-actions">
                      <a className="board-button board-button--ghost" href={`${base}${q}&at=${c.id}`} target="_blank" rel="noopener">
                        Open as it was
                      </a>
                      {canEdit && (
                        <button type="button" className="board-button board-button--ghost" disabled={busy} onClick={() => copy(c.id)}>
                          Copy
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </aside>,
        document.body,
      )}
    </>
  )
})

/** A board opened "as it was": a top banner plus this checkpoint's diff against the previous one on the canvas. */
export function CheckpointView({ api, base, q, guest, at, canCopy, boardUrl }: { api: StudioApi; base: string; q: string; guest: string; at: { id: string; title: string; by: string | null; at: string }; canCopy: boolean; boardUrl: string }) {
  const [changes, setChanges] = useState<Changes | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    fetch(`${base}/checkpoints/${at.id}/diff${q}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setChanges)
      .catch(() => {})
  }, [base, q, at.id])
  const copy = async () => {
    setBusy(true)
    try {
      const response = await fetch(`${base}/checkpoints/${at.id}/copy${q}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ guest: guest || undefined }) })
      const data = await response.json().catch(() => ({}))
      if (response.ok) {
        const url = new URL(data.url)
        location.href = `${location.origin}${url.pathname}${url.search}`
      } else api.setToast({ message: data.error ?? 'Could not create a copy', closable: true, duration: 5000 })
    } finally {
      setBusy(false)
    }
  }
  const summary = changes ? (summarize(changes) as Summary) : null
  return (
    <>
      {changes && !isEmpty(summarize(changes)) && <CheckpointHighlights api={api} changes={changes} />}
      {createPortal(
        <div className="cp-banner" role="status">
          <span className="cp-banner__title">
            Checkpoint “{at.title}” · {when(at.at)}
            {at.by ? ` · ${short(at.by)}` : ''}
          </span>
          {summary && (
            <span className="cp-row__chips">
              <Chips summary={summary} />
            </span>
          )}
          <span className="cp-banner__note">read-only</span>
          <a className="board-button board-button--ghost" href={new URL(boardUrl, location.origin).pathname + new URL(boardUrl, location.origin).search}>
            Back to current board
          </a>
          {canCopy && (
            <button type="button" className="board-button" disabled={busy} onClick={copy}>
              Copy
            </button>
          )}
        </div>,
        document.body,
      )}
    </>
  )
}
