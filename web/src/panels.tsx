/**
 * Panels of the studio that open on demand — palette, templates, board properties: a chunk of their own, loaded
 * when one opens rather than with the board (HRN-1515).
 */
import { useEffect, useMemo, useState } from 'react'
import { CaptureUpdateAction, exportToSvg, newElementWith, restoreElements } from '@excalidraw/excalidraw'
import { STICKY_COLORS, TONES, VARIANTS, paint, stickyStroke } from '../../shared/palette.mjs'
import { localized, t } from './i18n'
import { fieldView, usePluginRegistry, type ServerField } from './plugins'
import { SHAPES, isSticky, nameOf, type BoardMeta, type El, type StudioApi } from './studio'

// ── Palette ─────────────────────────────────────────────────────────────────

/** Paint the selection in a tone; each element type uses the tone in its own role. */
export function applyTone(api: StudioApi, toneId: string, variant: string) {
  const tone = TONES.find((item) => item.id === toneId)!
  const p = paint(tone, variant)
  const selected = api.getAppState().selectedElementIds as Record<string, boolean>
  const all = api.getSceneElementsIncludingDeleted()
  const ids = new Set(Object.keys(selected).filter((id) => selected[id]))
  if (!ids.size) {
    // Nothing selected: the palette sets the colour of the next shapes.
    api.updateScene({ appState: { currentItemStrokeColor: p.strokeColor, currentItemBackgroundColor: p.backgroundColor, currentItemFillStyle: 'solid' }, captureUpdate: CaptureUpdateAction.NEVER })
    const variantInfo = VARIANTS.find((v) => v.id === variant)
    api.setToast({ message: t('studio.nextShapes', { tone: nameOf('tone', tone.id, tone.name), variant: variantInfo ? nameOf('variant', variantInfo.id, variantInfo.name).toLowerCase() : '' }), duration: 2500 })
    return
  }
  const labelColor = new Map<string, string>()
  const next = all.map((el) => {
    if (!ids.has(el.id) || el.isDeleted || isSticky(el)) return el
    if (SHAPES.has(el.type)) {
      for (const b of el.boundElements ?? []) if (b.type === 'text') labelColor.set(b.id, p.text)
      return newElementWith(el as never, { strokeColor: p.strokeColor, backgroundColor: p.backgroundColor, fillStyle: 'solid' } as never) as unknown as El
    }
    if (el.type === 'text' && !el.containerId) return newElementWith(el as never, { strokeColor: variant === 'strong' ? tone.strong : tone.ink } as never) as unknown as El
    if (el.type === 'arrow' || el.type === 'line') {
      for (const b of el.boundElements ?? []) if (b.type === 'text') labelColor.set(b.id, tone.ink)
      return newElementWith(el as never, { strokeColor: variant === 'strong' ? tone.strong : tone.ink } as never) as unknown as El
    }
    return el
  })
  api.updateScene({
    elements: next.map((el) => (labelColor.has(el.id) ? (newElementWith(el as never, { strokeColor: labelColor.get(el.id) } as never) as unknown as El) : el)),
    captureUpdate: CaptureUpdateAction.IMMEDIATELY,
  })
}

export function paintStickies(api: StudioApi, fill: string) {
  const selected = api.getAppState().selectedElementIds as Record<string, boolean>
  let touched = 0
  const next = api.getSceneElementsIncludingDeleted().map((el) => {
    if (!selected[el.id] || !isSticky(el)) return el
    touched += 1
    return newElementWith(el as never, { backgroundColor: fill, strokeColor: stickyStroke(fill) } as never) as unknown as El
  })
  if (touched) api.updateScene({ elements: next, captureUpdate: CaptureUpdateAction.IMMEDIATELY })
  return touched
}

export function PalettePanel({ api, onClose, stickyColor, setStickyColor }: { api: StudioApi; onClose: () => void; stickyColor: string; setStickyColor: (c: string) => void }) {
  return (
    <div className="studio-panel studio-panel--palette" role="dialog" aria-label={t('studio.palette')}>
      <div className="studio-panel__head">
        <strong>{t('studio.palette')}</strong>
        <span>{t('studio.paletteHint')}</span>
        <button type="button" className="studio-panel__close" onClick={onClose} aria-label={t('studio.close')}>×</button>
      </div>
      <div className="studio-palette">
        {VARIANTS.map((variant) => (
          <div className="studio-palette__row" key={variant.id}>
            <span className="studio-palette__label">{nameOf('variant', variant.id, variant.name)}</span>
            {TONES.map((tone) => {
              const p = paint(tone, variant.id)
              return (
                <button
                  type="button"
                  key={tone.id}
                  className="studio-swatch"
                  title={t('studio.swatchTitle', { tone: nameOf('tone', tone.id, tone.name), variant: nameOf('variant', variant.id, variant.name).toLowerCase() })}
                  style={{ background: p.backgroundColor, borderColor: p.strokeColor, color: p.text }}
                  onClick={() => applyTone(api, tone.id, variant.id)}
                >
                  {t('studio.toneSample')}
                </button>
              )
            })}
          </div>
        ))}
        <div className="studio-palette__row">
          <span className="studio-palette__label">{t('studio.stickies')}</span>
          {STICKY_COLORS.map((c) => (
            <button
              type="button"
              key={c.id}
              className={`studio-swatch studio-swatch--sticky${stickyColor === c.fill ? ' is-on' : ''}`}
              title={nameOf('sticky', c.id, c.name)}
              style={{ background: c.fill }}
              onClick={() => {
                setStickyColor(c.fill)
                paintStickies(api, c.fill)
              }}
            />
          ))}
        </div>
      </div>
    </div>
  )
}


// ── Templates and library ───────────────────────────────────────────────────

type TemplateInfo = { id: string; title: string; description: string }

/** Copy elements with new ids and an offset, so a template can be inserted twice. */
export function cloneWithNewIds(elements: El[], dx: number, dy: number): El[] {
  const ids = new Map<string, string>()
  const fresh = () => Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 6)
  for (const el of elements) ids.set(el.id, fresh())
  const groups = new Map<string, string>()
  const group = (g: string) => {
    if (!groups.has(g)) groups.set(g, fresh())
    return groups.get(g)!
  }
  return elements.map((el) => ({
    ...el,
    id: ids.get(el.id)!,
    x: el.x + dx,
    y: el.y + dy,
    containerId: el.containerId ? ids.get(el.containerId) ?? null : el.containerId,
    boundElements: el.boundElements?.map((b) => ({ ...b, id: ids.get(b.id) ?? b.id })) ?? el.boundElements,
    startBinding: el.startBinding ? { ...el.startBinding, elementId: ids.get(el.startBinding.elementId) ?? el.startBinding.elementId } : el.startBinding,
    endBinding: el.endBinding ? { ...el.endBinding, elementId: ids.get(el.endBinding.elementId) ?? el.endBinding.elementId } : el.endBinding,
    frameId: el.frameId ? ids.get(el.frameId) ?? null : el.frameId,
    groupIds: (el.groupIds ?? []).map(group),
    customData: isSticky(el) ? { ...el.customData, reactions: {} } : el.customData,
  }))
}

function TemplatePreview({ id, staticBase }: { id: string; staticBase: string }) {
  const [svg, setSvg] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    fetch(`/b/api/templates/${id}`)
      .then((r) => r.json())
      .then(async (body) => {
        if (!body.elements?.length) return setSvg('')
        const node = await exportToSvg({ elements: body.elements, appState: { exportBackground: true, viewBackgroundColor: '#ffffff' }, files: null, exportPadding: 16, skipInliningFonts: true } as never)
        if (!cancelled) setSvg(node.outerHTML)
      })
      .catch(() => !cancelled && setSvg(''))
    return () => {
      cancelled = true
    }
  }, [id, staticBase])
  if (svg === null) return <span className="studio-template__loading">…</span>
  if (!svg) return <span className="studio-template__blank">{t('studio.templateBlank')}</span>
  return <span className="studio-template__svg" dangerouslySetInnerHTML={{ __html: svg }} />
}

export function TemplatesPanel({ api, onClose, staticBase }: { api: StudioApi; onClose: () => void; staticBase: string }) {
  const [list, setList] = useState<TemplateInfo[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    fetch('/b/api/templates')
      .then((r) => r.json())
      .then((body) => setList((body.templates ?? []).filter((tpl: TemplateInfo) => tpl.id !== 'blank')))
      .catch(() => setList([]))
  }, [])
  const insert = async (id: string) => {
    setBusy(id)
    try {
      const body = await (await fetch(`/b/api/templates/${id}`)).json()
      const elements = body.elements as El[]
      const app = api.getAppState() as { scrollX: number; scrollY: number; width: number; height: number; zoom: { value: number } }
      const minX = Math.min(...elements.map((el) => el.x))
      const minY = Math.min(...elements.map((el) => el.y))
      // Put the template's top-left in the left third of the screen so it reads at once.
      const dx = -app.scrollX + (app.width * 0.15) / app.zoom.value - minX
      const dy = -app.scrollY + (app.height * 0.15) / app.zoom.value - minY
      const clones = restoreElements(cloneWithNewIds(elements, Math.round(dx), Math.round(dy)) as never, null) as unknown as El[]
      api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), ...clones], captureUpdate: CaptureUpdateAction.IMMEDIATELY })
      api.scrollToContent(clones as never, { fitToContent: true, animate: true })
      onClose()
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="studio-panel studio-panel--templates" role="dialog" aria-label={t('studio.templates')}>
      <div className="studio-panel__head">
        <strong>{t('studio.templates')}</strong>
        <span>{t('studio.templatesHint')}</span>
        <button type="button" className="studio-panel__close" onClick={onClose} aria-label={t('studio.close')}>×</button>
      </div>
      <div className="studio-templates">
        {list.map((tpl) => (
          <button type="button" key={tpl.id} className="studio-template" onClick={() => insert(tpl.id)} disabled={busy !== null}>
            <span className="studio-template__preview">
              <TemplatePreview id={tpl.id} staticBase={staticBase} />
            </span>
            <span className="studio-template__title">{busy === tpl.id ? t('studio.inserting') : nameOf('template', `${tpl.id}Title`, tpl.title)}</span>
            <span className="studio-template__desc">{nameOf('template', `${tpl.id}Description`, tpl.description)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}


/** Board properties added by server plugins (e.g. a deadline), edited in the same dialog. */
export function PropertiesDialog({ meta, canEdit, onSave, onClose, fields = [] }: { meta: BoardMeta; canEdit: boolean; onSave: (m: Partial<BoardMeta>) => Promise<boolean>; onClose: () => void; fields?: ServerField[] }) {
  usePluginRegistry()
  const [description, setDescription] = useState(meta.description)
  const [tags, setTags] = useState(meta.tags.join(', '))
  const [task, setTask] = useState(meta.task ?? '')
  const [extra, setExtra] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((f) => [f.id, meta.fields?.[f.id] === undefined || meta.fields?.[f.id] === null ? '' : String(meta.fields[f.id])])))
  const [error, setError] = useState<string | null>(null)
  const parsed = useMemo(() => tags.split(',').map((tag) => tag.trim()).filter(Boolean), [tags])
  const save = async () => {
    const ref = task.trim()
    if (ref.length > 64) return setError(t('studio.referenceTooLong'))
    // Only the plugin fields that changed go to the server; an emptied one is removed.
    const changedFields = Object.fromEntries(fields.filter((f) => extra[f.id].trim() !== (meta.fields?.[f.id] === undefined || meta.fields?.[f.id] === null ? '' : String(meta.fields[f.id]))).map((f) => [f.id, extra[f.id].trim() || null]))
    if (await onSave({ description: description.trim(), tags: parsed, task: ref || null, ...(Object.keys(changedFields).length ? { fields: changedFields } : {}) })) onClose()
  }
  return (
    <div className="board-dialog__backdrop" onClick={onClose}>
      <div className="board-dialog" role="dialog" aria-label={t('studio.properties')} onClick={(e) => e.stopPropagation()}>
        <div className="board-dialog__head">
          <h2>{t('studio.properties')}</h2>
          <button type="button" className="board-dialog__close" onClick={onClose} aria-label={t('studio.close')}>×</button>
        </div>
        <fieldset className="studio-form" disabled={!canEdit}>
          <label>
            <span>{t('studio.description')}</span>
            <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={3} maxLength={500} placeholder={t('studio.descriptionPlaceholder')} />
          </label>
          <label>
            <span>{t('studio.tags')}</span>
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('studio.tagsPlaceholder')} />
          </label>
          {parsed.length > 0 && (
            <span className="studio-tags">
              {parsed.slice(0, 10).map((tag) => (
                <span key={tag} className="studio-tag">{tag}</span>
              ))}
            </span>
          )}
          <label>
            <span>{t('studio.reference')}</span>
            <input value={task} onChange={(e) => setTask(e.target.value)} maxLength={64} placeholder={t('studio.referencePlaceholder')} />
          </label>
          {fields.map((f) => {
            const view = fieldView(f.id)
            const name = view?.label ? localized(view.label) : f.label
            const hint = view?.placeholder ? localized(view.placeholder) : (f.placeholder ?? '')
            const set = (value: string) => setExtra((prev) => ({ ...prev, [f.id]: value }))
            return (
              <label key={f.id}>
                <span>{name}</span>
                {f.type === 'select' ? (
                  <select value={extra[f.id]} onChange={(e) => set(e.target.value)}>
                    <option value="">—</option>
                    {(f.options ?? []).map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                ) : (
                  <input type={f.type === 'text' ? 'text' : f.type} value={extra[f.id]} onChange={(e) => set(e.target.value)} placeholder={hint} />
                )}
                {view?.format && extra[f.id] && <small className="studio-form__hint">{view.format(extra[f.id])}</small>}
              </label>
            )
          })}
          {error && <p className="studio-form__error">{error}</p>}
        </fieldset>
        <div className="board-dialog__foot">
          {canEdit ? (
            <button type="button" className="board-button" onClick={save}>{t('studio.save')}</button>
          ) : (
            <span>{t('studio.propertiesReadOnly')}</span>
          )}
        </div>
      </div>
    </div>
  )
}
