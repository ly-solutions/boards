/**
 * Quick edit (HRN-1466): a board as plain text that a host app can edit with exact replacements.
 *
 * `quick_read` gives one JSON object per line, one line per live element in z-order (the label of a shape is on the
 * shape's line); `quick_apply` takes `[{ old, new }]` replacements of that text, parses it back and saves the changed
 * lines through the same path as `board_edit`; `quick_undo` puts the last apply back. The version is a hash of the
 * text, so it changes exactly when something editable does.
 */
import { createHash, randomBytes } from 'node:crypto'

export class QuickError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}

const SHAPES = new Set(['rectangle', 'ellipse', 'diamond'])
const CREATABLE = new Set([...SHAPES, 'text'])
const FIELDS = ['id', 'type', 'text', 'stroke', 'bg', 'x', 'y', 'w', 'h', 'font', 'sw', 'rough', 'op']
const NUMBERS = new Set(['x', 'y', 'w', 'h', 'font', 'sw', 'rough', 'op'])
const HINT_MAX = 400

const round = (n) => Math.round(Number(n) * 10) / 10
const versionOf = (text) => createHash('sha1').update(text).digest('hex').slice(0, 12)

/** The label of a shape: its bound text element. */
const labelOf = (el, all) => (el.type === 'text' ? null : all.find((t) => t.type === 'text' && t.containerId === el.id && !t.isDeleted) ?? null)

/** The editable view of one element, keys in a stable order. */
function lineOf(el, all) {
  const label = labelOf(el, all)
  const row = { id: el.id, type: el.type }
  if (el.type === 'text') row.text = el.originalText ?? el.text ?? ''
  else if (el.type === 'frame' || el.type === 'magicframe') row.text = el.name ?? ''
  else if (label) row.text = label.originalText ?? label.text ?? ''
  if (el.strokeColor) row.stroke = el.strokeColor
  if (SHAPES.has(el.type)) row.bg = el.backgroundColor ?? 'transparent'
  if (el.type !== 'arrow' && el.type !== 'line' && el.type !== 'freedraw') {
    row.x = round(el.x)
    row.y = round(el.y)
    row.w = round(el.width ?? 0)
    row.h = round(el.height ?? 0)
  }
  const font = el.type === 'text' ? el.fontSize : label?.fontSize
  if (font) row.font = font
  if (el.type !== 'text' && el.strokeWidth !== undefined) row.sw = el.strokeWidth
  if (el.roughness !== undefined) row.rough = el.roughness
  if (el.opacity !== undefined) row.op = el.opacity
  return row
}

/** Everything a board's text is made of: the lines, in z-order, without bound labels and deleted elements. */
export function renderLines(elements) {
  const live = elements.filter((el) => !el.isDeleted)
  return live.filter((el) => !(el.type === 'text' && el.containerId && live.some((c) => c.id === el.containerId))).map((el) => lineOf(el, live))
}

export function renderText(elements) {
  return renderLines(elements).map((row) => JSON.stringify(row)).join('\n')
}

function parseLines(text) {
  const rows = new Map()
  for (const [i, raw] of text.split('\n').entries()) {
    if (!raw.trim()) continue
    let row
    try {
      row = JSON.parse(raw)
    } catch {
      throw new QuickError('bad_edit', `строка ${i + 1} не разбирается как JSON`)
    }
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new QuickError('bad_edit', `строка ${i + 1}: нужен объект`)
    if (row.id !== undefined && typeof row.id !== 'string') throw new QuickError('bad_edit', `строка ${i + 1}: id должен быть строкой`)
    if (typeof row.type !== 'string') throw new QuickError('bad_edit', `строка ${i + 1}: нет type`)
    for (const key of Object.keys(row)) {
      if (!FIELDS.includes(key)) throw new QuickError('bad_edit', `строка ${i + 1}: неизвестное поле ${key}`)
      if (NUMBERS.has(key) && !Number.isFinite(row[key])) throw new QuickError('bad_edit', `строка ${i + 1}: ${key} должно быть числом`)
      if (['text', 'stroke', 'bg'].includes(key) && typeof row[key] !== 'string') throw new QuickError('bad_edit', `строка ${i + 1}: ${key} должно быть строкой`)
    }
    const id = row.id ?? `q${randomBytes(5).toString('hex')}`
    if (rows.has(id)) throw new QuickError('bad_edit', `id ${id} повторяется`)
    rows.set(id, { ...row, id })
  }
  return rows
}

const fresh = () => `q${randomBytes(5).toString('hex')}`

/**
 * `deps`: { materialize, applyUpdates, applyDeletes, bump, save(state, elements, { by, note }) → accepted, elementsOf(state) }.
 * The "before" snapshots live in memory, per process and per board.
 */
export function createQuickEdit(deps) {
  const undo = new Map() // slug → { version (after the apply), before: Map id → element | null }

  const snapshot = (state) => {
    const elements = deps.elementsOf(state)
    const text = renderText(elements)
    return { elements, text, version: versionOf(text) }
  }

  function read(state) {
    const { text, version } = snapshot(state)
    return { kind: 'board', title: state.meta.title, text, version }
  }

  async function apply(state, { version, edits, confirmed }, who) {
    const base = snapshot(state)
    if (typeof version !== 'string' || version !== base.version) throw new QuickError('conflict', 'доска изменилась, прочитайте её заново')
    if (!Array.isArray(edits) || !edits.length) throw new QuickError('bad_edit', 'нет замен')
    let text = base.text
    for (const [i, edit] of edits.entries()) {
      if (!edit || typeof edit.old !== 'string' || typeof edit.new !== 'string' || !edit.old) throw new QuickError('bad_edit', `замена ${i + 1}: нужны old и new`)
      const first = text.indexOf(edit.old)
      if (first < 0 || text.indexOf(edit.old, first + 1) >= 0) throw new QuickError('not_unique', `замена ${i + 1}: old должен встречаться ровно один раз`)
      text = text.slice(0, first) + edit.new + text.slice(first + edit.old.length)
    }

    const next = parseLines(text)
    const was = new Map(renderLines(base.elements).map((row) => [row.id, row]))
    const removed = [...was.keys()].filter((id) => !next.has(id))
    if (removed.length && confirmed !== true) throw new QuickError('needs_yes', `будут удалены элементы (${removed.length}), нужно подтверждение`)

    const now = Date.now()
    const byId = new Map(base.elements.map((el) => [el.id, el]))
    const takenIds = new Set(byId.keys())
    const updates = []
    const style = new Map() // id → raw changes
    const created = []
    const changedLines = []
    for (const [id, row] of next) {
      const old = was.get(id)
      if (!old) {
        if (!CREATABLE.has(row.type)) throw new QuickError('bad_edit', `тип ${row.type} создать нельзя (rectangle, ellipse, diamond, text)`)
        created.push({ ...row, id: takenIds.has(id) ? fresh() : id })
        continue
      }
      if (row.type !== old.type) throw new QuickError('bad_edit', `${id}: тип менять нельзя`)
      const diff = Object.keys(row).filter((key) => key !== 'id' && JSON.stringify(row[key]) !== JSON.stringify(old[key]))
      if (!diff.length) continue
      changedLines.push(id)
      const el = byId.get(id)
      const update = { id }
      const raw = {}
      for (const key of diff) {
        if (key === 'text') {
          if (el.type === 'frame' || el.type === 'magicframe') update.name = row.text
          else if (el.type === 'text' || labelOf(el, base.elements)) update.label = row.text
          else throw new QuickError('bad_edit', `${id}: у элемента нет подписи, текст не задать`)
        } else if (key === 'x' || key === 'y') update[key] = row[key]
        else if (key === 'w') update.width = row.w
        else if (key === 'h') update.height = row.h
        else if (key === 'stroke') raw.strokeColor = row.stroke
        else if (key === 'bg') Object.assign(raw, { backgroundColor: row.bg, ...(row.bg !== 'transparent' ? { fillStyle: 'solid' } : {}) })
        else if (key === 'sw') raw.strokeWidth = row.sw
        else if (key === 'rough') raw.roughness = row.rough
        else if (key === 'op') raw.opacity = row.op
        else if (key === 'font') raw.fontSize = row.font
        else throw new QuickError('bad_edit', `${id}: поле ${key} править нельзя`)
      }
      if (Object.keys(update).length > 1) updates.push(update)
      if (Object.keys(raw).length) style.set(id, raw)
    }

    const touched = new Map()
    const merged = () => [...new Map([...byId, ...touched]).values()]
    const put = (list) => list.forEach((el) => touched.set(el.id, el))
    try {
      if (updates.length) put(deps.applyUpdates(updates, merged(), { now }))
      for (const [id, raw] of style) {
        const el = touched.get(id) ?? byId.get(id)
        const { fontSize, ...rest } = raw
        if (Object.keys(rest).length) touched.set(id, deps.bump(el, rest, now))
        if (fontSize !== undefined) {
          const target = el.type === 'text' ? touched.get(id) : labelOf(touched.get(id) ?? el, merged())
          if (!target) throw new QuickError('bad_edit', `${id}: нет текста для размера шрифта`)
          const current = touched.get(target.id) ?? target
          touched.set(target.id, deps.bump(current, { fontSize, customData: { ...(current.customData ?? {}), remeasure: true } }, now))
        }
      }
      if (removed.length) put(deps.applyDeletes(removed, merged(), { now }))
      if (created.length) {
        const skeleton = created.map((row) => ({
          type: row.type,
          id: row.id,
          x: row.x ?? 0,
          y: row.y ?? 0,
          ...(row.type === 'text' ? { text: row.text ?? '' } : { width: row.w ?? 140, height: row.h ?? 70 }),
          ...(row.type !== 'text' && row.text ? { label: { text: row.text, ...(row.font ? { fontSize: row.font } : {}) } } : {}),
          ...(row.type === 'text' && row.font ? { fontSize: row.font } : {}),
          ...(row.stroke ? { strokeColor: row.stroke } : {}),
          ...(row.bg && row.type !== 'text' ? { backgroundColor: row.bg, fillStyle: row.bg === 'transparent' ? 'hachure' : 'solid' } : {}),
          ...(row.sw ? { strokeWidth: row.sw } : {}),
          ...(row.rough !== undefined ? { roughness: row.rough } : {}),
          ...(row.op !== undefined ? { opacity: row.op } : {}),
        }))
        const result = await deps.materialize(skeleton, merged(), { now })
        put(result.changed)
        put(result.created)
      }
    } catch (error) {
      if (error instanceof QuickError) throw error
      if (error?.name === 'EditError' || error?.constructor?.name === 'EditError') throw new QuickError('bad_edit', error.message)
      throw error
    }

    const list = [...touched.values()]
    if (!list.length) return { changed: 0, version: base.version, hint: '', ids: [] }
    // The board may have moved while the engine was loading: nothing is saved over a newer scene.
    if (snapshot(state).version !== base.version) throw new QuickError('conflict', 'доска изменилась, прочитайте её заново')

    const before = new Map(list.map((el) => [el.id, byId.has(el.id) ? structuredClone(byId.get(el.id)) : null]))
    deps.save(state, list, { by: who?.name ?? 'agent', note: 'quick edit' })
    const after = snapshot(state)
    undo.set(state.slug, { version: after.version, before })

    const nowRows = new Map(renderLines(after.elements).map((row) => [row.id, row]))
    const ids = [...new Set([...changedLines, ...created.map((row) => row.id), ...removed])]
    const hint = [...changedLines, ...created.map((row) => row.id)].map((id) => JSON.stringify(nowRows.get(id) ?? { id })).concat(removed.map((id) => `- ${id}`)).join('\n').slice(0, HINT_MAX)
    return { changed: ids.length, version: after.version, hint, ids }
  }

  function revert(state, { version }, who) {
    const kept = undo.get(state.slug)
    if (!kept) throw new QuickError('nothing_to_undo', 'нечего отменять')
    const base = snapshot(state)
    if (typeof version !== 'string' || version !== base.version || version !== kept.version) throw new QuickError('conflict', 'доска изменилась после правки')
    const now = Date.now()
    const byId = new Map(deps.elementsOf(state).map((el) => [el.id, el]))
    const back = []
    for (const [id, was] of kept.before) {
      const cur = byId.get(id)
      if (!cur) continue
      back.push(was ? deps.bump({ ...was, version: cur.version }, {}, now) : deps.bump(cur, { isDeleted: true }, now))
    }
    deps.save(state, back, { by: who?.name ?? 'agent', note: 'quick undo' })
    undo.delete(state.slug)
    return { changed: true, version: snapshot(state).version }
  }

  return { read, apply, undo: revert }
}
