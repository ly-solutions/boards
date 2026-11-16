/**
 * The context bar over the selection, its own for each kind of object: sticky, shape, arrow, text, pen, frame, site,
 * terminal, image, and several objects. Dense, as in FigJam: the frequent in the bar, groups in popovers, the rare in
 * «⋯». It stays inside the visible canvas — never under the islands or past the edge; with no room above the object it
 * goes under it.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw'
import { STICKY_COLORS, TONES } from '../../../shared/palette.mjs'
import { t } from '../i18n'
import { Icon } from './icons'
import { Pop, Swatches, useOpenKey } from './ui'
import { ACTIONS, STICKY_FONT_MAX, STICKY_FONT_MIN, apply, clickNative, isSticky, kindOf, paintSticky, patchSelected, patchText, sceneOf, screenBox, selectedOf, selectionKind, textOf, type El, type Kind } from './scene'
import { INK_COLORS, type Api } from './islands'

const FONTS = [
  { id: 5, key: 'hand' },
  { id: 6, key: 'normal' },
  { id: 9, key: 'strict' },
  { id: 8, key: 'mono' },
] as const
const SIZES = [
  { id: 'S', size: 16 },
  { id: 'M', size: 20 },
  { id: 'L', size: 28 },
  { id: 'XL', size: 36 },
] as const
const LINE_HEIGHTS = [1, 1.25, 1.5, 2] as const
const FILLS = ['transparent', '#ffffff', ...TONES.map((x) => x.zone), '#ced4da']
const STROKES = ['#1e1e1e', '#868e96', ...TONES.map((x) => x.strong), '#ffffff']
const WIDTHS = [1, 2, 4] as const

type PopKey = 'color' | 'fill' | 'stroke' | 'kind' | 'font' | 'size' | 'align' | 'tcolor' | 'link' | 'line' | 'acolor' | 'more' | 'react' | 'malign'

function Cell({ tip, keyHint, on, onClick, children, className = '' }: { tip: string; keyHint?: string; on?: boolean; onClick: () => void; children: ReactNode; className?: string }) {
  return (
    <button type="button" className={`isl-cell${on ? ' on' : ''} ${className}`} data-tip={tip} data-key={keyHint} aria-label={tip} aria-pressed={on} onClick={onClick}>
      {children}
    </button>
  )
}
const Chev = () => <Icon name="chevron" size={12} className="isl-chev" />
const Sep = () => <span className="isl-vs" />

export function ContextBar({ api, reactions, votes, me, onReact, onAsk }: { api: Api; reactions: string[]; votes: Record<string, Record<string, string[]>>; me: string | null; onReact: (id: string, emoji: string, on: boolean) => void; onAsk: ((text: string, ids: string[]) => void) | null }) {
  'use no memo' // reads the editor (api) while rendering: the compiler would cache it by the stable api (HRN-1515)
  const st = api.getAppState() as Record<string, unknown>
  const pop = useOpenKey<PopKey>()
  const ref = useRef<HTMLDivElement | null>(null)
  const [place, setPlace] = useState<{ left: number; top: number; below: boolean } | null>(null)
  const [link, setLink] = useState('')

  const editingText = st.editingTextElement as El | null
  let sel = selectedOf(api)
  if (editingText) {
    const all = sceneOf(api)
    const host = editingText.containerId ? all.find((e) => e.id === editingText.containerId) : all.find((e) => e.id === editingText.id)
    sel = host ? [host] : []
  }
  const kind: Kind | null = selectionKind(sel)
  const tool = (st.activeTool as { type: string } | undefined)?.type ?? 'selection'
  const busy = Boolean(st.selectedElementsAreBeingDragged || st.isResizing || st.isRotating || st.newElement || st.selectionElement || st.contextMenu || st.viewModeEnabled || st.multiElement)
  const show = Boolean(kind) && !busy && (tool === 'selection' || Boolean(editingText))
  const box = show ? screenBox(api, sel) : null
  const key = box ? `${Math.round(box.left)}:${Math.round(box.top)}:${Math.round(box.right)}:${Math.round(box.bottom)}:${kind}:${sel.length}` : ''
  const offsetLeft = (st.offsetLeft as number) ?? 0
  const offsetTop = (st.offsetTop as number) ?? 0

  useLayoutEffect(() => {
    if (!box || !ref.current) return
    const bar = ref.current.getBoundingClientRect()
    const w = window.innerWidth
    const h = window.innerHeight
    const side = document.documentElement.classList.contains('isl-side-open') && w > 760 ? 372 : 0
    const minTop = w <= 640 ? 62 : 66
    const maxBottom = h - (w <= 640 ? 76 : 72)
    const cx = offsetLeft + (box.left + box.right) / 2
    let left = cx - bar.width / 2
    left = Math.max(12, Math.min(left, w - side - 12 - bar.width))
    let top = offsetTop + box.top - 14 - bar.height
    let below = false
    if (top < minTop) {
      top = offsetTop + box.bottom + 14
      below = true
      // Taller than the screen: at the top edge, over the object.
      if (top + bar.height > maxBottom) top = minTop
    }
    setPlace((was) => (was && was.left === left && was.top === top && was.below === below ? was : { left, top, below }))
  }, [key, offsetLeft, offsetTop, sel.length])

  if (!show || !box) return null
  const first = sel[0]
  const text = textOf(api, first)
  const data = (text?.customData ?? {}) as Record<string, unknown>
  const ids = sel.map((e) => e.id)
  const close = pop.close
  const locked = sel.every((e) => e.locked)

  const textBar = () => {
    const fontId = text?.fontFamily ?? 6
    const size = text?.fontSize ?? 20
    const autoFit = kind === 'sticky' && data.fontAuto !== false
    const setSize = (n: number, auto = false) => {
      const v = Math.max(8, Math.min(120, Math.round(n)))
      patchText(api, (tx) => ({ fontSize: v, customData: { ...tx.customData, fontAuto: auto ? undefined : kind === 'sticky' ? false : undefined, stickyFont: v } }))
    }
    const mark = (k: 'fontWeight' | 'fontStyle' | 'underline' | 'strike', v: unknown) =>
      patchText(api, (tx) => ({ customData: { ...tx.customData, [k]: tx.customData?.[k] === v ? undefined : v } }), { remeasure: k === 'fontWeight' || k === 'fontStyle' })
    const align = (text?.textAlign ?? 'center') as string
    const valign = (text?.verticalAlign ?? 'middle') as string
    return (
      <>
        <div className="isl-tw">
          <Cell tip={t('islands.font')} on={pop.open === 'font'} onClick={() => pop.toggle('font')} className="isl-cell--font">
            <span className={`isl-fa isl-fa--${FONTS.find((f) => f.id === fontId)?.key ?? 'normal'}`}>{t(`islands.font_${FONTS.find((f) => f.id === fontId)?.key ?? 'normal'}`)}</span>
            <Chev />
          </Cell>
          <Pop open={pop.open === 'font'} onClose={close} place={place?.below ? 'down' : 'up'} align="start" className="isl-menu">
            {FONTS.map((f) => (
              <button type="button" key={f.id} className="isl-mi" onClick={() => (close(), patchText(api, () => ({ fontFamily: f.id })))}>
                <span className={`isl-fa isl-fa--${f.key}`}>{t(`islands.font_${f.key}`)}</span>
                {f.id === fontId && <Icon name="check" size={16} className="isl-mi__end" />}
              </button>
            ))}
          </Pop>
        </div>
        <div className="isl-stepper">
          <button type="button" data-tip={t('islands.smaller')} aria-label={t('islands.smaller')} onClick={() => setSize(size - 2)}>
            <Icon name="minus" size={14} />
          </button>
          <div className="isl-tw">
            <button type="button" className="isl-stepper__val" data-tip={t('islands.textSize')} onClick={() => pop.toggle('size')}>
              {autoFit ? <span className="isl-auto">A</span> : null}
              {Math.round(size)}
            </button>
            <Pop open={pop.open === 'size'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--pad">
              <div className="isl-mlab">{t('islands.textSize')}</div>
              <div className="isl-seg isl-seg--sm">
                {kind === 'sticky' && (
                  <button type="button" className={autoFit ? 'on' : ''} data-tip={t('islands.autoTip')} onClick={() => (close(), patchText(api, (tx) => ({ customData: { ...tx.customData, fontAuto: undefined } }), { remeasure: false }))}>
                    {t('islands.auto')}
                  </button>
                )}
                {SIZES.map((z) => (
                  <button type="button" key={z.id} className={!autoFit && Math.round(size) === z.size ? 'on' : ''} data-tip={`${z.size}px`} onClick={() => (close(), setSize(z.size))}>
                    {z.id}
                  </button>
                ))}
              </div>
            </Pop>
          </div>
          <button type="button" data-tip={t('islands.bigger')} aria-label={t('islands.bigger')} onClick={() => setSize(size + 2)}>
            <Icon name="plus" size={14} />
          </button>
        </div>
        <Sep />
        <Cell tip={t('islands.bold')} keyHint="⌘B" on={data.fontWeight === 'bold'} onClick={() => mark('fontWeight', 'bold')}>
          <Icon name="bold" size={16} />
        </Cell>
        <Cell tip={t('islands.italic')} keyHint="⌘I" on={data.fontStyle === 'italic'} onClick={() => mark('fontStyle', 'italic')}>
          <Icon name="italic" size={16} />
        </Cell>
        <div className="isl-tw">
          <Cell tip={t('islands.paragraph')} on={pop.open === 'align'} onClick={() => pop.toggle('align')}>
            <Icon name={align === 'left' ? 'alignLeft' : align === 'right' ? 'alignRight' : 'alignCenter'} size={16} />
            <Chev />
          </Cell>
          <Pop open={pop.open === 'align'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--pad">
            <div className="isl-mlab">{t('islands.alignH')}</div>
            <div className="isl-prow">
              {(['left', 'center', 'right'] as const).map((a) => (
                <Cell key={a} tip={t(`islands.align_${a}`)} on={align === a} onClick={() => patchText(api, () => ({ textAlign: a }))}>
                  <Icon name={a === 'left' ? 'alignLeft' : a === 'right' ? 'alignRight' : 'alignCenter'} size={16} />
                </Cell>
              ))}
              {text?.containerId &&
                (['top', 'middle', 'bottom'] as const).map((a) => (
                  <Cell key={a} tip={t(`islands.valign_${a}`)} on={valign === a} onClick={() => patchText(api, () => ({ verticalAlign: a }))}>
                    <Icon name={a === 'top' ? 'alignTop' : a === 'bottom' ? 'alignBottom' : 'alignMiddle'} size={16} />
                  </Cell>
                ))}
            </div>
            <div className="isl-mlab">{t('islands.decoration')}</div>
            <div className="isl-prow">
              <Cell tip={t('islands.underline')} on={Boolean(data.underline)} onClick={() => mark('underline', true)}>
                <Icon name="underline" size={16} />
              </Cell>
              <Cell tip={t('islands.strike')} on={Boolean(data.strike)} onClick={() => mark('strike', true)}>
                <Icon name="strike" size={16} />
              </Cell>
            </div>
            <div className="isl-mlab">{t('islands.lineHeight')}</div>
            <div className="isl-seg isl-seg--sm">
              {LINE_HEIGHTS.map((lh) => (
                <button type="button" key={lh} className={Math.abs((text?.lineHeight ?? 1.25) - lh) < 0.01 ? 'on' : ''} onClick={() => patchText(api, () => ({ lineHeight: lh }))}>
                  {String(lh).replace('.', ',')}
                </button>
              ))}
            </div>
          </Pop>
        </div>
        <div className="isl-tw">
          <Cell tip={t('islands.textColor')} on={pop.open === 'tcolor'} onClick={() => pop.toggle('tcolor')}>
            <span className="isl-tca" style={{ borderColor: text?.strokeColor ?? '#1e1e1e' }}>
              A
            </span>
            <Chev />
          </Cell>
          <Pop open={pop.open === 'tcolor'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--pad">
            <div className="isl-mlab">{t('islands.textColor')}</div>
            <Swatches colors={INK_COLORS} value={text?.strokeColor ?? null} onPick={(c) => patchText(api, () => ({ strokeColor: c }), { remeasure: false })} />
          </Pop>
        </div>
      </>
    )
  }

  const moreMenu = () => {
    const opacity = first.opacity ?? 100
    return (
      <div className="isl-tw">
        <Cell tip={t('islands.more')} on={pop.open === 'more'} onClick={() => pop.toggle('more')}>
          <Icon name="dots" size={16} />
        </Cell>
        <Pop open={pop.open === 'more'} onClose={close} place={place?.below ? 'down' : 'up'} align="end" className="isl-menu isl-menu--wide">
          <div className="isl-mrow">
            <span>{t('islands.opacity')}</span>
            <small>{opacity}%</small>
          </div>
          <div className="isl-range">
            <input type="range" min={10} max={100} step={5} value={opacity} onChange={(e) => patchSelected(api, () => ({ opacity: Number(e.target.value) }))} aria-label={t('islands.opacity')} />
          </div>
          <button type="button" className="isl-mi" onClick={() => (close(), ACTIONS.toggleLock())}>
            <Icon name="lock" />
            {t('islands.lock')}
            <span className={`isl-tgl${locked ? ' on' : ''}`} />
          </button>
          <div className="isl-msep" />
          <button type="button" className="isl-mi" onClick={ACTIONS.forward}>
            <Icon name="layersUp" />
            {t('islands.forward')}
            <kbd>⌘]</kbd>
          </button>
          <button type="button" className="isl-mi" onClick={ACTIONS.backward}>
            <Icon name="layersUp" />
            {t('islands.backward')}
            <kbd>⌘[</kbd>
          </button>
          <button type="button" className="isl-mi" onClick={ACTIONS.front}>
            <Icon name="toFront" />
            {t('islands.toFront')}
            <kbd>⇧⌘]</kbd>
          </button>
          <button type="button" className="isl-mi" onClick={ACTIONS.back}>
            <Icon name="toBack" />
            {t('islands.toBack')}
            <kbd>⇧⌘[</kbd>
          </button>
          <div className="isl-msep" />
          <button type="button" className="isl-mi" onClick={() => (close(), ACTIONS.duplicate())}>
            <Icon name="copy" />
            {t('islands.duplicate')}
            <kbd>⌘D</kbd>
          </button>
          <button type="button" className="isl-mi" onClick={() => (close(), ACTIONS.copyStyle())}>
            <Icon name="brush" />
            {t('islands.copyStyle')}
            <kbd>⌥⌘C</kbd>
          </button>
          <button type="button" className="isl-mi" onClick={() => (close(), ACTIONS.pasteStyle())}>
            <Icon name="pipette" />
            {t('islands.pasteStyle')}
            <kbd>⌥⌘V</kbd>
          </button>
          {sel.length === 1 && (
            <button type="button" className="isl-mi" onClick={() => (setLink(first.link ?? ''), pop.setOpen('link'))}>
              <Icon name="link" />
              {first.link ? t('islands.linkEdit') : t('islands.linkAdd')}
            </button>
          )}
          <div className="isl-msep" />
          <button type="button" className="isl-mi dg" onClick={() => (close(), ACTIONS.remove())}>
            <Icon name="trash" />
            {t('islands.delete')}
            <kbd>⌫</kbd>
          </button>
        </Pop>
        <Pop open={pop.open === 'link'} onClose={close} place={place?.below ? 'down' : 'up'} align="end" className="isl-pop--pad">
          <form
            className="isl-linkin"
            onSubmit={(e) => {
              e.preventDefault()
              const v = link.trim()
              patchSelected(api, () => ({ link: v ? (/^[a-z]+:/i.test(v) || v.startsWith('/') ? v : `https://${v}`) : null }))
              close()
            }}
          >
            <input autoFocus value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://" onKeyDown={(e) => e.stopPropagation()} />
            <button type="submit" className="isl-btn isl-btn--pri">
              {t('islands.apply')}
            </button>
          </form>
        </Pop>
      </div>
    )
  }

  const reactCell = () => {
    if (sel.length !== 1 || first.type === 'text' || kind === 'terminal') return null
    const mineVotes = votes[first.id] ?? {}
    return (
      <div className="isl-tw">
        <Cell tip={t('islands.reaction')} keyHint="E" on={pop.open === 'react'} onClick={() => pop.toggle('react')}>
          <Icon name="smilePlus" size={16} />
        </Cell>
        <Pop open={pop.open === 'react'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--row">
          {reactions.map((e) => {
            const on = Boolean(me && mineVotes[e]?.includes(me))
            return (
              <button type="button" key={e} className={`isl-ebtn${on ? ' on' : ''}`} onClick={() => (close(), onReact(first.id, e, !on))}>
                {e}
              </button>
            )
          })}
        </Pop>
      </div>
    )
  }

  const askCell = () =>
    onAsk && (
      <button type="button" className="isl-ask" data-tip={t('islands.askTip')} onClick={() => onAsk('', ids)}>
        <Icon name="sparkles" size={16} />
        <span>{t('islands.ask')}</span>
      </button>
    )

  const body = (): ReactNode => {
    if (locked) {
      return (
        <Cell tip={t('islands.unlock')} on onClick={ACTIONS.toggleLock} className="isl-cell--wide">
          <Icon name="lock" size={16} />
          {t('islands.locked')}
        </Cell>
      )
    }
    switch (kind) {
      case 'sticky': {
        const fill = first.backgroundColor ?? STICKY_COLORS[0].fill
        return (
          <>
            <div className="isl-tw">
              <Cell tip={t('islands.stickyColor')} on={pop.open === 'color'} onClick={() => pop.toggle('color')}>
                <span className="isl-swb" style={{ background: fill }} />
                <Chev />
              </Cell>
              <Pop open={pop.open === 'color'} onClose={close} place={place?.below ? 'down' : 'up'} align="start" className="isl-pop--pad">
                <div className="isl-mlab">{t('islands.stickyColor')}</div>
                <Swatches colors={STICKY_COLORS.map((c) => c.fill)} value={fill} onPick={(c) => patchSelected(api, (el) => (isSticky(el) ? paintSticky(c) : null))} />
              </Pop>
            </div>
            <Sep />
            {textBar()}
          </>
        )
      }
      case 'shape': {
        const kinds = [
          { type: 'rectangle', round: false, icon: 'square' },
          { type: 'rectangle', round: true, icon: 'squareRound' },
          { type: 'diamond', round: false, icon: 'diamond' },
          { type: 'ellipse', round: false, icon: 'circle' },
        ]
        const isRound = Boolean(first.roundness)
        const now = kinds.findIndex((k) => k.type === first.type && (k.type !== 'rectangle' || k.round === isRound))
        return (
          <>
            <div className="isl-tw">
              <Cell tip={t('islands.fill')} on={pop.open === 'fill'} onClick={() => pop.toggle('fill')}>
                <span className={`isl-swb${first.backgroundColor === 'transparent' ? ' is-none' : ''}`} style={{ background: first.backgroundColor === 'transparent' ? undefined : first.backgroundColor }} />
                <Chev />
              </Cell>
              <Pop open={pop.open === 'fill'} onClose={close} place={place?.below ? 'down' : 'up'} align="start" className="isl-pop--pad">
                <div className="isl-mlab">{t('islands.fill')}</div>
                <Swatches colors={FILLS} value={first.backgroundColor ?? null} onPick={(c) => patchSelected(api, () => ({ backgroundColor: c, fillStyle: 'solid' }))} />
              </Pop>
            </div>
            <div className="isl-tw">
              <Cell tip={t('islands.stroke')} on={pop.open === 'stroke'} onClick={() => pop.toggle('stroke')}>
                <span className="isl-strk" style={{ borderColor: first.strokeColor }} />
                <Chev />
              </Cell>
              <Pop open={pop.open === 'stroke'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--pad">
                <div className="isl-mlab">{t('islands.stroke')}</div>
                <Swatches colors={STROKES} value={first.strokeColor ?? null} onPick={(c) => patchSelected(api, () => ({ strokeColor: c }))} />
                <LineOptions api={api} first={first} />
              </Pop>
            </div>
            <div className="isl-tw">
              <Cell tip={t('islands.shapeKind')} on={pop.open === 'kind'} onClick={() => pop.toggle('kind')}>
                <Icon name={kinds[now]?.icon ?? 'square'} size={16} />
                <Chev />
              </Cell>
              <Pop open={pop.open === 'kind'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--row">
                {kinds.map((k, i) => (
                  <Cell key={i} tip={t(`islands.shape_${i}`)} on={i === now} onClick={() => (close(), changeShape(api, k.type, k.round))}>
                    <Icon name={k.icon} size={16} />
                  </Cell>
                ))}
              </Pop>
            </div>
            <Sep />
            {textBar()}
          </>
        )
      }
      case 'text':
        return (
          <>
            {textBar()}
            <div className="isl-tw">
              <Cell tip={t('islands.link')} on={Boolean(first.link)} onClick={() => (setLink(first.link ?? ''), pop.toggle('link'))}>
                <Icon name="link" size={16} />
              </Cell>
            </div>
          </>
        )
      case 'arrow':
      case 'line': {
        const type = first.elbowed ? 'elbow' : first.roundness ? 'round' : 'sharp'
        return (
          <>
            {kind === 'arrow' && (
              <div className="isl-seg isl-seg--sm isl-seg--ic">
                {(['sharp', 'round', 'elbow'] as const).map((k) => (
                  <button type="button" key={k} className={type === k ? 'on' : ''} data-tip={t(`islands.arrow_${k}`)} onClick={() => changeArrowType(api, k)}>
                    <Icon name={k === 'sharp' ? 'arrow' : k === 'round' ? 'arrowCurve' : 'arrowElbow'} size={16} />
                  </button>
                ))}
              </div>
            )}
            {kind === 'arrow' && (
              <>
                <Sep />
                <Cell tip={t('islands.headStart')} on={Boolean(first.startArrowhead)} onClick={() => patchSelected(api, (el) => ({ startArrowhead: el.startArrowhead ? null : 'arrow' }))}>
                  <Icon name="headStart" size={16} />
                </Cell>
                <Cell tip={t('islands.headEnd')} on={Boolean(first.endArrowhead)} onClick={() => patchSelected(api, (el) => ({ endArrowhead: el.endArrowhead ? null : 'arrow' }))}>
                  <Icon name="headEnd" size={16} />
                </Cell>
              </>
            )}
            <Sep />
            <div className="isl-tw">
              <Cell tip={t('islands.lineStyle')} on={pop.open === 'line'} onClick={() => pop.toggle('line')}>
                <i className={`isl-lsbar${first.strokeStyle === 'dashed' ? ' is-dash' : first.strokeStyle === 'dotted' ? ' is-dot' : ''}`} style={{ height: Math.min(4, first.strokeWidth ?? 2) }} />
                <Chev />
              </Cell>
              <Pop open={pop.open === 'line'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--pad">
                <LineOptions api={api} first={first} />
              </Pop>
            </div>
            <div className="isl-tw">
              <Cell tip={t('islands.color')} on={pop.open === 'acolor'} onClick={() => pop.toggle('acolor')}>
                <span className="isl-swb" style={{ background: first.strokeColor }} />
                <Chev />
              </Cell>
              <Pop open={pop.open === 'acolor'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--pad">
                <div className="isl-mlab">{t('islands.color')}</div>
                <Swatches colors={STROKES} value={first.strokeColor ?? null} onPick={(c) => patchSelected(api, () => ({ strokeColor: c }))} />
              </Pop>
            </div>
            {kind === 'arrow' && (
              <Cell tip={t('islands.arrowLabel')} keyHint="Enter" onClick={() => editLabel()}>
                <span className="isl-fa">Аа</span>
              </Cell>
            )}
          </>
        )
      }
      case 'pen':
        return (
          <>
            <div className="isl-tw">
              <Cell tip={t('islands.color')} on={pop.open === 'acolor'} onClick={() => pop.toggle('acolor')}>
                <span className="isl-swb" style={{ background: first.strokeColor }} />
                <Chev />
              </Cell>
              <Pop open={pop.open === 'acolor'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--pad">
                <Swatches colors={INK_COLORS} value={first.strokeColor ?? null} onPick={(c) => patchSelected(api, () => ({ strokeColor: c }))} />
              </Pop>
            </div>
            {WIDTHS.map((w) => (
              <Cell key={w} tip={t(`islands.width_${w}`)} on={first.strokeWidth === w} onClick={() => patchSelected(api, () => ({ strokeWidth: w }))}>
                <i className="isl-wbar" style={{ height: w + 1 }} />
              </Cell>
            ))}
          </>
        )
      case 'frame':
        return (
          <>
            <Cell tip={t('islands.rename')} keyHint={t('islands.dblclick')} onClick={() => renameFrame(api, first)} className="isl-cell--wide">
              <Icon name="pencil" size={16} />
              {t('islands.frameName')}
            </Cell>
            <div className="isl-tw">
              <Cell tip={t('islands.frameFill')} on={pop.open === 'fill'} onClick={() => pop.toggle('fill')}>
                <span className={`isl-swb${!first.backgroundColor || first.backgroundColor === 'transparent' ? ' is-none' : ''}`} style={{ background: first.backgroundColor === 'transparent' ? undefined : first.backgroundColor }} />
                <Chev />
              </Cell>
              <Pop open={pop.open === 'fill'} onClose={close} place={place?.below ? 'down' : 'up'} className="isl-pop--pad">
                <Swatches colors={FILLS} value={first.backgroundColor ?? null} onPick={(c) => patchSelected(api, () => ({ backgroundColor: c, fillStyle: 'solid' }))} />
              </Pop>
            </div>
          </>
        )
      case 'site':
        return <SiteBar api={api} el={first} />
      case 'terminal':
        return (
          <>
            <Cell tip={t('islands.terminalPaneTip')} onClick={() => toParent({ type: 'board-pane', target: 'terminal' })} className="isl-cell--wide">
              <Icon name="panelRight" size={16} />
              {t('islands.terminalPane')}
            </Cell>
            {onAsk && (
              <button type="button" className="isl-ask" data-tip={t('islands.giveAgentTip')} onClick={() => onAsk(t('islands.giveAgentText'), ids)}>
                <Icon name="sparkles" size={16} />
                <span>{t('islands.giveAgent')}</span>
              </button>
            )}
          </>
        )
      case 'image':
        return (
          <Cell tip={t('islands.replaceImage')} onClick={() => api.setActiveTool({ type: 'image' })} className="isl-cell--wide">
            <Icon name="upload" size={16} />
            {t('islands.replace')}
          </Cell>
        )
      case 'multi': {
        const grouped = sel.length > 1 && sel.every((e) => e.groupIds?.length && e.groupIds[e.groupIds.length - 1] === sel[0].groupIds?.[sel[0].groupIds.length - 1])
        return (
          <>
            <div className="isl-tw">
              <Cell tip={t('islands.align')} on={pop.open === 'malign'} onClick={() => pop.toggle('malign')} className="isl-cell--wide">
                <Icon name="alignTop" size={16} />
                {t('islands.align')}
                <Chev />
              </Cell>
              <Pop open={pop.open === 'malign'} onClose={close} place={place?.below ? 'down' : 'up'} align="start" className="isl-menu">
                <button type="button" className="isl-mi" onClick={() => (close(), ACTIONS.alignLeft())}>
                  <Icon name="alignLeft" />
                  {t('islands.alignLeft')}
                </button>
                <button type="button" className="isl-mi" onClick={() => (close(), ACTIONS.alignTop())}>
                  <Icon name="alignTop" />
                  {t('islands.alignTop')}
                </button>
                <button type="button" className="isl-mi" onClick={() => (close(), ACTIONS.distributeX())}>
                  <Icon name="columns" />
                  {t('islands.distribute')}
                </button>
              </Pop>
            </div>
            <Cell tip={grouped ? t('islands.ungroupTip') : t('islands.groupTip')} keyHint={grouped ? '⇧⌘G' : '⌘G'} onClick={grouped ? ACTIONS.ungroup : ACTIONS.group} className="isl-cell--wide">
              <Icon name="group" size={16} />
              {grouped ? t('islands.ungroup') : t('islands.group')}
            </Cell>
            <Cell tip={t('islands.toFrameTip')} onClick={() => wrapInFrame(api, sel)} className="isl-cell--wide">
              <Icon name="frame" size={16} />
              {t('islands.toFrame')}
            </Cell>
            <span className="isl-who">{sel.length}</span>
          </>
        )
      }
      default:
        return null
    }
  }

  const editLabel = () => {
    // Enter on a selected arrow or shape is the editor's own way into its label.
    const target = document.querySelector('.excalidraw') ?? document
    target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true }))
  }

  const content = body()
  const react = !locked && reactCell()
  const ask = askCell()
  return (
    <div
      ref={ref}
      className={`isl isl-ctx isl-tips-${place?.below ? 'down' : 'up'}${place ? '' : ' is-measuring'}`}
      style={place ? { left: place.left, top: place.top } : { left: -9999, top: 0 }}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      {content}
      {(react || ask) && content ? <Sep /> : null}
      {react}
      {ask}
      {moreMenu()}
    </div>
  )
}

function LineOptions({ api, first }: { api: Api; first: El }) {
  return (
    <>
      <div className="isl-mlab">{t('islands.width')}</div>
      <div className="isl-prow">
        {WIDTHS.map((w) => (
          <Cell key={w} tip={t(`islands.width_${w}`)} on={first.strokeWidth === w} onClick={() => patchSelected(api, () => ({ strokeWidth: w }))}>
            <i className="isl-wbar" style={{ height: w + 1 }} />
          </Cell>
        ))}
      </div>
      <div className="isl-mlab">{t('islands.lineStyle')}</div>
      <div className="isl-prow">
        {(['solid', 'dashed', 'dotted'] as const).map((s) => (
          <Cell key={s} tip={t(`islands.stroke_${s}`)} on={(first.strokeStyle ?? 'solid') === s} onClick={() => patchSelected(api, () => ({ strokeStyle: s }))}>
            <i className={`isl-lsbar${s === 'dashed' ? ' is-dash' : s === 'dotted' ? ' is-dot' : ''}`} />
          </Cell>
        ))}
      </div>
    </>
  )
}

function SiteBar({ api, el }: { api: Api; el: El }) {
  'use no memo' // reads the editor (api) while rendering: the compiler would cache it by the stable api (HRN-1515)
  const [url, setUrl] = useState(el.link ?? '')
  const st = api.getAppState() as { activeEmbeddable?: { element: { id: string }; state: string } | null }
  const active = st.activeEmbeddable?.element?.id === el.id && st.activeEmbeddable.state === 'active'
  const setLink = (next: string) => {
    const v = next.trim()
    if (!v) return
    apply(api, new Map([[el.id, { link: /^[a-z]+:/i.test(v) ? v : `https://${v}` }]]))
  }
  return (
    <>
      <form
        className="isl-urlf"
        onSubmit={(e) => {
          e.preventDefault()
          setLink(url)
        }}
      >
        <Icon name="globe" size={14} />
        <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" onKeyDown={(e) => e.stopPropagation()} aria-label={t('islands.siteUrl')} />
      </form>
      <Cell
        tip={t('islands.reload')}
        onClick={() => {
          const base = (el.link ?? '').replace(/#tb-reload-\d+$/, '')
          apply(api, new Map([[el.id, { link: `${base}#tb-reload-${Date.now() % 100000}` }]]))
        }}
      >
        <Icon name="rotate" size={16} />
      </Cell>
      <Sep />
      <div className="isl-seg isl-seg--sm">
        <button type="button" className={!active ? 'on' : ''} data-tip={t('islands.siteMoveTip')} onClick={() => api.updateScene({ appState: { activeEmbeddable: null } })}>
          {t('islands.siteMove')}
        </button>
        <button type="button" className={active ? 'on' : ''} data-tip={t('islands.siteClickTip')} onClick={() => api.updateScene({ appState: { activeEmbeddable: { element: el, state: 'active' } } as never })}>
          {t('islands.siteClick')}
        </button>
      </div>
      <Sep />
      <Cell tip={t('islands.sitePaneTip')} onClick={() => toParent({ type: 'board-pane', target: el.link ?? '' })} className="isl-cell--wide">
        <Icon name="panelRight" size={16} />
        {t('islands.sitePane')}
      </Cell>
    </>
  )
}

/** To the harnessly app view around the editor, when there is one. */
export function toParent(message: Record<string, unknown>) {
  if (window.parent === window || !document.documentElement.classList.contains('board-app')) return
  window.parent.postMessage(message, location.origin)
}

function changeShape(api: Api, type: string, round: boolean) {
  patchSelected(api, (el) => (el.type === type && Boolean(el.roundness) === round ? null : { type, roundness: round || type !== 'rectangle' ? { type: 3 } : null }))
  // The label's room changed with the outline.
  const sel = selectedOf(api)
  const relayout = sel.map((el) => textOf(api, el)?.id).filter(Boolean) as string[]
  apply(api, new Map(relayout.map((id) => [id, {}])), { relayout, capture: false })
}

function changeArrowType(api: Api, kind: 'sharp' | 'round' | 'elbow') {
  // The editor converts an arrow to and from an elbow one with routing; its own button does that.
  if (clickNative(`${kind}-arrow`)) return
  patchSelected(api, (el) => (el.type !== 'arrow' ? null : kind === 'round' ? { roundness: { type: 2 }, elbowed: false } : kind === 'sharp' ? { roundness: null, elbowed: false } : { roundness: null, elbowed: true }))
}

function renameFrame(api: Api, frame: El) {
  const next = window.prompt(t('islands.frameName'), (frame.name as string) ?? '')?.trim()
  if (next === undefined || next === null) return
  apply(api, new Map([[frame.id, { name: next || null }]]))
}

/** Puts the selection into a new frame around it. */
function wrapInFrame(api: Api, sel: El[]) {
  const box = sel.reduce(
    (b, el) => {
      const x0 = Math.min(el.x, el.x + el.width)
      const y0 = Math.min(el.y, el.y + el.height)
      return { x0: Math.min(b.x0, x0), y0: Math.min(b.y0, y0), x1: Math.max(b.x1, x0 + Math.abs(el.width)), y1: Math.max(b.y1, y0 + Math.abs(el.height)) }
    },
    { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity },
  )
  const pad = 32
  const [frame] = convertToExcalidrawElements([{ type: 'frame', x: box.x0 - pad, y: box.y0 - pad - 8, width: box.x1 - box.x0 + pad * 2, height: box.y1 - box.y0 + pad * 2 + 8, children: [] }] as never) as unknown as El[]
  const inside = new Set<string>()
  const all = sceneOf(api)
  for (const el of sel) {
    inside.add(el.id)
    for (const b of el.boundElements ?? []) if (b.type === 'text') inside.add(b.id)
  }
  for (const el of all) if (el.type === 'text' && el.containerId && inside.has(el.containerId)) inside.add(el.id)
  const elements = (api.getSceneElementsIncludingDeleted() as unknown as El[]).map((el) => (inside.has(el.id) ? { ...el, frameId: frame.id, version: el.version + 1 } : el))
  // A frame goes under what it holds.
  const first = elements.findIndex((el) => inside.has(el.id))
  elements.splice(Math.max(0, first), 0, frame)
  api.updateScene({ elements, appState: { selectedElementIds: { [frame.id]: true } }, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
}

export { kindOf, STICKY_FONT_MAX, STICKY_FONT_MIN }
