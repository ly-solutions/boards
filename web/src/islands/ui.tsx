// Small parts every island shares: a popover that animates out before it unmounts, colour swatches, a segmented
// control. Tooltips are CSS only (`data-tip` with an optional `data-key`), see islands.css.
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'

/** Keeps a closing node mounted for its exit animation. */
export function useClosing(open: boolean, ms = 140) {
  const [shown, setShown] = useState(open)
  const [closing, setClosing] = useState(false)
  useEffect(() => {
    if (open) {
      setShown(true)
      setClosing(false)
      return
    }
    if (!shown) return
    setClosing(true)
    const timer = setTimeout(() => {
      setShown(false)
      setClosing(false)
    }, ms)
    return () => clearTimeout(timer)
  }, [open])
  return { shown, closing }
}

/**
 * A popover above (or below) its trigger, kept inside the window. Rendered inside a `.isl-tw` wrapper that holds the
 * trigger. Clicks outside it and the wrapper close it.
 */
export function Pop({ open, onClose, place = 'up', align = 'center', className = '', style, children }: { open: boolean; onClose: () => void; place?: 'up' | 'down'; align?: 'center' | 'start' | 'end'; className?: string; style?: CSSProperties; children: ReactNode }) {
  const { shown, closing } = useClosing(open)
  const ref = useRef<HTMLDivElement | null>(null)
  const [dx, setDx] = useState(0)
  const [side, setSide] = useState(place)
  const [maxH, setMaxH] = useState<number | null>(null)
  useLayoutEffect(() => {
    if (!shown || closing) return
    const node = ref.current
    if (!node) return
    node.style.setProperty('--pop-dx', '0px')
    const r = node.getBoundingClientRect()
    const room = 8
    let shift = 0
    if (r.left < room) shift = room - r.left
    else if (r.right > window.innerWidth - room) shift = window.innerWidth - room - r.right
    setDx(shift)
    // Up or down, whichever has the room; too tall for both — it scrolls.
    const anchor = node.parentElement?.getBoundingClientRect()
    if (!anchor) return
    const above = anchor.top - room - 8
    const below = window.innerHeight - anchor.bottom - room - 8
    const h = node.scrollHeight
    let next = place
    if (place === 'up' && h > above && below > above) next = 'down'
    if (place === 'down' && h > below && above > below) next = 'up'
    setSide(next)
    const space = next === 'up' ? above : below
    setMaxH(h > space ? Math.max(120, space) : null)
  }, [shown, closing, place])
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      const wrap = ref.current?.parentElement
      if (wrap && wrap.contains(e.target as Node)) return
      onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    // After the click that opened it.
    const timer = setTimeout(() => document.addEventListener('pointerdown', onDown, true))
    window.addEventListener('keydown', onKey, true)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open, onClose])
  if (!shown) return null
  return (
    <div
      ref={ref}
      className={`isl-pop isl-pop--${side} isl-pop--${align}${closing ? ' is-closing' : ''} ${className}`}
      style={{ ...style, ['--pop-dx' as string]: `${dx}px`, ...(maxH ? { maxHeight: maxH, overflowY: 'auto' as const } : null) }} onPointerDown={(e) => e.stopPropagation()}>
      {children}
    </div>
  )
}

/** A row of colour swatches; `custom` adds a hex field. */
export function Swatches({ colors, value, onPick, custom = true, round = false, labels }: { colors: readonly string[]; value: string | null; onPick: (c: string) => void; custom?: boolean; round?: boolean; labels?: Record<string, string> }) {
  const [hex, setHex] = useState(value && /^#/.test(value) ? value : '')
  useEffect(() => setHex(value && /^#/.test(value) ? value : ''), [value])
  return (
    <div className="isl-pal">
      <div className={`isl-pal__grid${round ? ' is-round' : ''}`}>
        {colors.map((c) => (
          <button
            type="button"
            key={c}
            className={`isl-sw${value?.toLowerCase() === c.toLowerCase() ? ' on' : ''}${c === 'transparent' ? ' is-none' : ''}`}
            style={{ background: c === 'transparent' ? undefined : c }}
            data-tip={labels?.[c] ?? (c === 'transparent' ? undefined : c)}
            aria-label={labels?.[c] ?? c}
            onClick={() => onPick(c)}
          />
        ))}
      </div>
      {custom && (
        <form
          className="isl-hex"
          onSubmit={(e) => {
            e.preventDefault()
            const v = hex.trim().replace(/^([0-9a-f]{3,8})$/i, '#$1')
            if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(v)) onPick(v)
          }}
        >
          <span className="isl-hex__chip" style={{ background: /^#/.test(hex) ? hex : 'transparent' }} />
          <input value={hex} onChange={(e) => setHex(e.target.value)} placeholder="#hex" spellCheck={false} maxLength={9} aria-label="hex" />
        </form>
      )}
    </div>
  )
}

/** A segmented control of a few options. */
export function Seg<T extends string | number>({ options, value, onPick, small = false }: { options: readonly { id: T; label?: ReactNode; tip?: string; keyHint?: string }[]; value: T | null; onPick: (v: T) => void; small?: boolean }) {
  return (
    <div className={`isl-seg${small ? ' isl-seg--sm' : ''}`}>
      {options.map((o) => (
        <button type="button" key={String(o.id)} className={o.id === value ? 'on' : ''} data-tip={o.tip} data-key={o.keyHint} aria-label={o.tip} onClick={() => onPick(o.id)}>
          {o.label ?? String(o.id)}
        </button>
      ))}
    </div>
  )
}

/** Which popover of an island is open: one at a time. */
export function useOpenKey<K extends string>() {
  const [open, setOpen] = useState<K | null>(null)
  const toggle = useCallback((k: K) => setOpen((cur) => (cur === k ? null : k)), [])
  const close = useCallback(() => setOpen(null), [])
  return { open, setOpen, toggle, close }
}
