/**
 * Slop check: how much a board looks generated "to look pretty" (the AI-slop score).
 *
 * Ask an agent to "make the board beautiful" and it often produces the same
 * thing: a rainbow of colors, emoji instead of bullets, three fonts and five
 * sizes, cards that are "almost aligned" and arrows to nowhere. Each is minor;
 * together they make a board people recognize at a glance and stop trusting.
 *
 * The module only looks at scene structure and geometry: colors, fonts, sizes,
 * bindings, intersections. It never judges words — whether the text is
 * appropriate is for the model reading the board to decide, not for a list of
 * banned words. That is also why emoji are a Unicode character class here, not
 * a dictionary.
 *
 * Shared by the server (board text for agents) and the editor (the badge that
 * highlights offending elements), so it has no Node imports or dependencies.
 *
 * Each rule yields a weight and the offending ids. The score is a saturating sum
 * of weights: one or two nits do not make a board slop, five different rules at
 * once almost certainly do.
 */

const SHAPE_TYPES = new Set(['rectangle', 'ellipse', 'diamond'])
const BOX_TYPES = new Set(['rectangle', 'ellipse', 'diamond', 'image', 'embeddable', 'iframe'])

/**
 * Score: 100·(1 − e^(−sum/SCALE)). Sum 20 → ~30, 50 → ~60, 90 → ~80.
 *
 * Calibrated on real boards: a hand-made board with tidy pastel sections that
 * people considered good-looking scored 89 at SCALE 35 — small imperfections of
 * manual layout added up to "slop". So tidiness nits (almost aligned, uneven
 * sizes, font sizes) weigh little, while generation tells — emoji, a loud
 * rainbow, mixed styles, extra fonts — weigh a lot.
 */
const SCALE = 60
const LEVEL_WARN = 30
const LEVEL_SLOP = 60

/**
 * More than three bright color families is a rainbow. A diagram needs a neutral,
 * one accent and two or three meaningful colors (error, success, external);
 * beyond that a hue encodes nothing and only adds noise.
 */
const MAX_HUE_FAMILIES = 3
/**
 * Quiet pastel section fills are not a rainbow but color-coded zones (pastel
 * zones with a heading rule, as in FigJam boards). We tolerate more of them.
 */
const MAX_QUIET_FAMILIES = 7
const LOUD_AREA_SHARE = 0.02
/** A family is a 30° sector of the color wheel: a light-blue fill and a blue stroke are one color. */
const HUE_BUCKET = 30
/**
 * Emoji count when they appear in a noticeable share of labels: one icon on a
 * board is an accent, emoji in every third label is decoration for its own sake.
 */
const EMOJI_SHARE = 0.3
const EMOJI_MIN_TEXTS = 3
/** Emoji at the start of a line as a list bullet — the most recognizable generation tell. */
const EMOJI_BULLETS_MIN = 3
/** A hand-drawn and a regular font are already two families; a third is a mess. */
const MAX_FONT_FAMILIES = 2
/** A type scale needs about four sizes: title, subtitle, body, note. */
const MAX_FONT_SIZES = 5
/** A style minority counts only if it is more than one shape: a single hand-drawn one is a sketch, not a mix. */
const STYLE_MINORITY_MIN = 2
const STYLE_MINORITY_SHARE = 0.1
const MAX_STROKE_WIDTHS = 2
/**
 * "Almost aligned": edges or centers are 1–6 px apart. Under half a pixel is
 * aligned, over six is visibly intentional. The eye notices a 2–4 px miss but
 * does not read it as intent.
 */
const ALIGN_EXACT = 0.5
const ALIGN_MISS = 6
/** Alignment matters between neighbours: further apart than this on the other axis, elements do not read as one line. */
const ALIGN_NEIGHBOR = 300
const ALIGN_MIN_PAIRS = 2
/** A row of cards: centers within 12 px on the axis, gap between neighbours under 200 px. */
const ROW_TOLERANCE = 12
const ROW_GAP = 200
const ROW_MIN = 3
/** A size difference in a row is noticeable from 15% and 8 px. */
const SIZE_RATIO = 1.15
const SIZE_DIFF = 8
/** An arrow end further than this from any shape points to nowhere. */
const DANGLING_SNAP = 8
/** An arrow goes through a shape if it enters deeper than this. */
const CROSS_INSET = 4
/** Overlap counts from 5% of the smaller element's area: touching edges is not overlap. */
const OVERLAP_SHARE = 0.05
const OVERLAP_MIN_AREA = 16
/** A card label longer than ~180 chars is a paragraph; it belongs in a document, not on a diagram. */
const LABEL_WALL = 180
const FREE_TEXT_WALL = 400
/** Text sticks out of its container by more than 2 px. */
const OVERFLOW = 2
/** A small shape without text or connections is decor; four or more make a pattern. */
const DECOR_AREA = 40 * 40
const DECOR_MIN = 4
/** More than 55% of the area covered by shapes — no whitespace. */
const CROWD_COVERAGE = 0.55
const CROWD_MIN_ELEMENTS = 8
/** A frame with more than 40 elements cannot be taken in at a glance. */
const FRAME_CROWD = 40

const EMOJI_RE = /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u
const EMOJI_BULLET_RE = /^\s*(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)/u

const round = (n) => Math.round(Number(n) || 0)

function parseColor(value) {
  const s = String(value ?? '').trim().toLowerCase()
  if (!s || s === 'transparent') return null
  let m = /^#([0-9a-f]{3})$/.exec(s)
  if (m) return `#${[...m[1]].map((c) => c + c).join('')}`
  m = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/.exec(s)
  if (m) return `#${m[1]}`
  return null
}

/** A loud color: saturated and of medium lightness — a fill that shouts rather than tints. */
export function isLoud(hex) {
  const c = parseColor(hex)
  if (!c) return false
  const n = parseInt(c.slice(1), 16)
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => v / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d < 0.08) return false
  const s = d / (1 - Math.abs(2 * l - 1))
  return s > 0.45 && l < 0.8
}

/** Color family, or null for neutrals (greys, near-white, near-black). */
export function hueFamily(hex) {
  const c = parseColor(hex)
  if (!c) return null
  const n = parseInt(c.slice(1), 16)
  const r = ((n >> 16) & 255) / 255
  const g = ((n >> 8) & 255) / 255
  const b = (n & 255) / 255
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d < 0.08 || l < 0.08 || l > 0.97) return null
  const s = d / (1 - Math.abs(2 * l - 1))
  if (s < 0.2) return null
  let h
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h = (h * 60 + 360) % 360
  return Math.floor(((h + HUE_BUCKET / 2) % 360) / HUE_BUCKET)
}

function box(el) {
  if ((el.type === 'arrow' || el.type === 'line' || el.type === 'freedraw') && Array.isArray(el.points) && el.points.length) {
    const xs = el.points.map((p) => el.x + p[0])
    const ys = el.points.map((p) => el.y + p[1])
    return { x1: Math.min(...xs), y1: Math.min(...ys), x2: Math.max(...xs), y2: Math.max(...ys) }
  }
  const x1 = Math.min(el.x, el.x + el.width)
  const y1 = Math.min(el.y, el.y + el.height)
  return { x1, y1, x2: x1 + Math.abs(el.width), y2: y1 + Math.abs(el.height) }
}

const area = (b) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)
const cx = (b) => (b.x1 + b.x2) / 2
const cy = (b) => (b.y1 + b.y2) / 2

function intersection(a, b) {
  return { x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), x2: Math.min(a.x2, b.x2), y2: Math.min(a.y2, b.y2) }
}

const contains = (outer, inner) => outer.x1 <= inner.x1 + 0.5 && outer.y1 <= inner.y1 + 0.5 && outer.x2 >= inner.x2 - 0.5 && outer.y2 >= inner.y2 - 0.5

function distanceToBox(px, py, b) {
  return Math.hypot(Math.max(b.x1 - px, 0, px - b.x2), Math.max(b.y1 - py, 0, py - b.y2))
}

/** Whether a segment crosses the interior of a rectangle (Liang–Barsky clipping). */
function segmentHitsBox(ax, ay, bx, by, b) {
  let t0 = 0
  let t1 = 1
  const dx = bx - ax
  const dy = by - ay
  const edges = [
    [-dx, ax - b.x1],
    [dx, b.x2 - ax],
    [-dy, ay - b.y1],
    [dy, b.y2 - ay],
  ]
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      if (t > t0) t0 = t
    } else {
      if (t < t0) return false
      if (t < t1) t1 = t
    }
  }
  return t1 - t0 > 1e-6
}

/**
 * Box pairs without comparing all against all: boxes are sorted by left edge, and
 * for each one we only look at those starting within `reach` of its right edge.
 * Pairs come out in the same order a double loop over the original list would
 * give — the offending ids in the result depend on it.
 */
function sweeper(list) {
  const order = list.map((_, i) => i).sort((p, q) => list[p].x1 - list[q].x1 || p - q)
  const lefts = order.map((i) => list[i].x1)
  const pairs = (reach, test) => {
    const out = []
    for (let s = 0; s < order.length; s += 1) {
      const a = list[order[s]]
      for (let t = s + 1; t < order.length; t += 1) {
        const b = list[order[t]]
        // b starts no further left than a: the x gap is at least b.x1 − a.x2 and only grows from here.
        if (reach === 0 ? b.x1 >= a.x2 : b.x1 - a.x2 > reach) break
        const i = Math.min(order[s], order[t])
        const j = Math.max(order[s], order[t])
        if (test(list[i], list[j])) out.push([i, j])
      }
    }
    return out.sort((p, q) => p[0] - q[0] || p[1] - q[1])
  }
  /** Indices of boxes whose left edge lies in [from, to]. */
  pairs.within = function* (from, to) {
    let lo = 0
    let hi = lefts.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (lefts[mid] < from) lo = mid + 1
      else hi = mid
    }
    for (let k = lo; k < lefts.length && lefts[k] <= to; k += 1) yield order[k]
  }
  return pairs
}

/**
 * Grid for "what lies near this box". Cells are large; huge shapes (a background
 * for the whole board) go to a separate list that is always checked. Candidate
 * order does not matter: we only ask "is there at least one".
 */
const CELL = 512
const MAX_CELLS = 256
function grid(items, pad) {
  const cells = new Map()
  const big = []
  const range = (lo, hi) => [Math.floor(lo / CELL), Math.floor(hi / CELL)]
  items.forEach((item, k) => {
    const [cx1, cx2] = range(item.outer.x1 + pad, item.outer.x2 - pad)
    const [cy1, cy2] = range(item.outer.y1 + pad, item.outer.y2 - pad)
    // Shape narrower than 2·pad — no interior, nothing to cross.
    if (cx2 < cx1 || cy2 < cy1) return
    if ((cx2 - cx1 + 1) * (cy2 - cy1 + 1) > MAX_CELLS) return big.push(k)
    for (let x = cx1; x <= cx2; x += 1) for (let y = cy1; y <= cy2; y += 1) {
      const key = `${x}:${y}`
      if (!cells.has(key)) cells.set(key, [])
      cells.get(key).push(k)
    }
  })
  return {
    near(b) {
      const seen = new Set(big)
      const [cx1, cx2] = range(b.x1, b.x2)
      const [cy1, cy2] = range(b.y1, b.y2)
      if ((cx2 - cx1 + 1) * (cy2 - cy1 + 1) > cells.size) {
        // An arrow across the whole board — cheaper to walk all cells than its rectangle.
        for (const list of cells.values()) for (const k of list) seen.add(k)
      } else {
        for (let x = cx1; x <= cx2; x += 1) for (let y = cy1; y <= cy2; y += 1) for (const k of cells.get(`${x}:${y}`) ?? []) seen.add(k)
      }
      return [...seen].map((k) => items[k])
    },
  }
}

/** "Almost aligned" on one axis: one of the three lines is off by 1–ALIGN_MISS and none match. */
function nearMiss(p1, q1, p2, q2, p3, q3) {
  const d1 = Math.abs(p1 - q1)
  const d2 = Math.abs(p2 - q2)
  const d3 = Math.abs(p3 - q3)
  if (d1 <= ALIGN_EXACT || d2 <= ALIGN_EXACT || d3 <= ALIGN_EXACT) return false
  return d1 <= ALIGN_MISS || d2 <= ALIGN_MISS || d3 <= ALIGN_MISS
}

const inset = (b, by) => ({ x1: b.x1 + by, y1: b.y1 + by, x2: b.x2 - by, y2: b.y2 - by })

/** Rule weight: `each` per offender, capped at `cap`. */
const weigh = (count, each, cap) => Math.min(cap, count * each)

const uniq = (ids) => [...new Set(ids)]

const mode = (values) => {
  const counts = new Map()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best = null
  let bestCount = -1
  for (const [v, c] of counts) if (c > bestCount) [best, bestCount] = [v, c]
  return best
}

/** Minority by `key`: elements whose value differs from the most common one. */
function minority(list, key) {
  const main = mode(list.map(key))
  return list.filter((el) => key(el) !== main)
}

/**
 * Run the slop check on a board.
 *
 * `palette` is an optional list of palette colors; colors outside it are
 * reported as a separate rule.
 */
export function analyzeSlop(elements, { palette } = {}) {
  const live = (Array.isArray(elements) ? elements : []).filter((el) => el && !el.isDeleted && typeof el.id === 'string')
  const byId = new Map(live.map((el) => [el.id, el]))
  const issues = []
  const metrics = { elements: live.length }
  const add = (issue) => {
    if (issue.weight > 0) issues.push({ ...issue, elementIds: uniq(issue.elementIds), weight: Math.round(issue.weight * 10) / 10 })
  }

  const texts = live.filter((el) => el.type === 'text')
  const boundText = (el) => el.type === 'text' && el.containerId && byId.has(el.containerId)
  const shapes = live.filter((el) => SHAPE_TYPES.has(el.type))
  const boxes = live.filter((el) => BOX_TYPES.has(el.type))
  const arrows = live.filter((el) => el.type === 'arrow')
  const frames = live.filter((el) => el.type === 'frame' || el.type === 'magicframe')
  const labelOf = new Map()
  for (const t of texts) if (boundText(t)) labelOf.set(t.containerId, t)
  const boxOf = new Map(live.map((el) => [el.id, box(el)]))

  // ── Rainbow ───────────────────────────────────────────────────────────────
  // Fills shout when saturated and not light. Colored strokes and colored text
  // on white, like a pastel zone background, read calmly and are not a rainbow.
  const colored = live.filter((el) => el.type !== 'frame' && el.type !== 'magicframe')
  const familyUse = new Map()
  const familiesOf = new Map()
  const quietUse = new Map()
  for (const el of colored) {
    const fams = new Set()
    const fill = el.fillStyle === 'solid' || !el.fillStyle ? el.backgroundColor : null
    const f = hueFamily(fill)
    if (f !== null && isLoud(fill)) fams.add(f)
    else if (f !== null) quietUse.set(f, (quietUse.get(f) ?? 0) + 1)
    familiesOf.set(el.id, fams)
    for (const x of fams) familyUse.set(x, (familyUse.get(x) ?? 0) + area(boxOf.get(el.id)))
  }
  // A bright heading or column badge is an accent; a color becomes a rainbow when
  // it fills a noticeable share of the board. Families under LOUD_AREA_SHARE of
  // the shape area are ignored.
  const shapeArea = colored.filter((el) => BOX_TYPES.has(el.type)).reduce((sum, el) => sum + area(boxOf.get(el.id)), 0) || 1
  for (const [f, used] of familyUse) if (used / shapeArea < LOUD_AREA_SHARE) familyUse.delete(f)
  metrics.hueFamilies = familyUse.size
  metrics.quietFamilies = quietUse.size
  if (quietUse.size > MAX_QUIET_FAMILIES) {
    add({
      id: 'pastel-rainbow',
      title: 'Too many tints',
      detail: `${quietUse.size} pastel tints: a zone color should mean something, turn the extra ones neutral`,
      elementIds: [],
      weight: weigh(quietUse.size - MAX_QUIET_FAMILIES, 3, 9),
    })
  }
  if (familyUse.size > MAX_HUE_FAMILIES) {
    const ranked = [...familyUse.entries()].sort((a, b) => b[1] - a[1]).map(([f]) => f)
    const extra = new Set(ranked.slice(MAX_HUE_FAMILIES))
    add({
      id: 'rainbow',
      title: 'Color rainbow',
      detail: `${familyUse.size} bright fills of different colors where ${MAX_HUE_FAMILIES} is plenty: keep one accent and a couple of meaningful colors, make the rest palette pastels or neutral`,
      elementIds: colored.filter((el) => [...familiesOf.get(el.id)].some((f) => extra.has(f))).map((el) => el.id),
      weight: weigh(familyUse.size - MAX_HUE_FAMILIES, 7, 21),
    })
  }

  if (Array.isArray(palette) && palette.length) {
    const allowed = new Set(palette.map(parseColor).filter(Boolean))
    const off = colored.filter((el) => [el.strokeColor, el.backgroundColor].some((c) => {
      const p = parseColor(c)
      return p && !allowed.has(p)
    }))
    const offColors = new Set(off.flatMap((el) => [el.strokeColor, el.backgroundColor].map(parseColor).filter((p) => p && !allowed.has(p))))
    metrics.offPaletteColors = offColors.size
    if (offColors.size) {
      add({
        id: 'off-palette',
        title: 'Off-palette colors',
        detail: `${offColors.size} ${offColors.size === 1 ? 'color is' : 'colors are'} not from the palette (${[...offColors].slice(0, 5).join(', ')}): pick the closest palette color`,
        elementIds: off.map((el) => el.id),
        weight: weigh(offColors.size, 3, 15),
      })
    }
  }

  // ── Emoji ─────────────────────────────────────────────────────────────────
  const textOf = (t) => String(t.originalText ?? t.text ?? '')
  const withEmoji = texts.filter((t) => EMOJI_RE.test(textOf(t)))
  const bulletLines = texts.flatMap((t) => textOf(t).split('\n').filter((line) => EMOJI_BULLET_RE.test(line)).map(() => t.id))
  metrics.textsWithEmoji = withEmoji.length
  metrics.emojiBullets = bulletLines.length
  const emojiShare = texts.length ? withEmoji.length / texts.length : 0
  metrics.emojiShare = Math.round(emojiShare * 100) / 100
  const emojiHeavy = withEmoji.length >= EMOJI_MIN_TEXTS && emojiShare > EMOJI_SHARE
  if (emojiHeavy || bulletLines.length >= EMOJI_BULLETS_MIN) {
    add({
      id: 'emoji',
      title: 'Emoji instead of meaning',
      detail: `emoji in ${withEmoji.length} of ${texts.length} labels${bulletLines.length ? `, ${bulletLines.length} ${bulletLines.length === 1 ? 'line starts' : 'lines start'} with an emoji bullet` : ''}: words, color and shape carry meaning — remove the emoji or keep one meaningful symbol`,
      elementIds: withEmoji.map((t) => (boundText(t) ? t.containerId : t.id)),
      weight: 8 + Math.min(12, Math.round(emojiShare * 12) + bulletLines.length),
    })
  }

  // ── Fonts ─────────────────────────────────────────────────────────────────
  const families = new Set(texts.map((t) => t.fontFamily).filter((f) => f !== undefined && f !== null))
  // A sticky label's font size is fitted to the sticky, so it is not part of the board's type scale.
  const sized = texts.filter((t) => byId.get(t.containerId)?.customData?.kind !== 'sticky')
  const sizes = new Set(sized.map((t) => round(t.fontSize)).filter((s) => s > 0))
  metrics.fontFamilies = families.size
  metrics.fontSizes = sizes.size
  if (families.size > MAX_FONT_FAMILIES) {
    add({
      id: 'font-families',
      title: 'Font mix',
      detail: `${families.size} different fonts: one is enough, two at most (headings and body)`,
      elementIds: minority(texts, (t) => t.fontFamily).map((t) => t.id),
      weight: weigh(families.size - MAX_FONT_FAMILIES, 8, 16),
    })
  }
  if (sizes.size > MAX_FONT_SIZES) {
    const ranked = [...sizes].sort((a, b) => sized.filter((t) => round(t.fontSize) === b).length - sized.filter((t) => round(t.fontSize) === a).length)
    const keep = new Set(ranked.slice(0, MAX_FONT_SIZES))
    add({
      id: 'font-sizes',
      title: 'Too many font sizes',
      detail: `${sizes.size} text sizes (${[...sizes].sort((a, b) => a - b).join(', ')}): reduce to a scale of three or four`,
      elementIds: sized.filter((t) => !keep.has(round(t.fontSize))).map((t) => t.id),
      weight: weigh(sizes.size - MAX_FONT_SIZES, 3, 9),
    })
  }

  // ── Style mix ─────────────────────────────────────────────────────────────
  const styled = [...shapes, ...arrows]
  const mixed = (list, key) => {
    const odd = minority(list, key)
    return odd.length >= STYLE_MINORITY_MIN && odd.length / list.length >= STYLE_MINORITY_SHARE ? odd : []
  }
  const roughOdd = mixed(styled, (el) => ((el.roughness ?? 1) > 0 ? 'rough' : 'straight'))
  const filled = shapes.filter((el) => parseColor(el.backgroundColor))
  const fillOdd = mixed(filled, (el) => (el.fillStyle === 'solid' ? 'solid' : el.fillStyle ?? 'solid'))
  const widths = new Set(styled.map((el) => el.strokeWidth).filter((w) => w !== undefined))
  metrics.roughnessMixed = roughOdd.length
  metrics.fillStyleMixed = fillOdd.length
  metrics.strokeWidths = widths.size
  const styleParts = []
  const styleIds = []
  if (roughOdd.length) {
    styleParts.push('some shapes hand-drawn, some straight')
    styleIds.push(...roughOdd.map((el) => el.id))
  }
  if (fillOdd.length) {
    styleParts.push('hatching mixed with solid fills')
    styleIds.push(...fillOdd.map((el) => el.id))
  }
  if (widths.size > MAX_STROKE_WIDTHS) {
    styleParts.push(`${widths.size} stroke widths`)
    styleIds.push(...minority(styled, (el) => el.strokeWidth).map((el) => el.id))
  }
  if (styleParts.length) {
    add({
      id: 'style-mix',
      title: 'Style mix',
      detail: `${styleParts.join('; ')}: pick one shape style and keep it across the board`,
      elementIds: styleIds,
      weight: styleParts.length * 6,
    })
  }

  // Top-level elements: what a person sees as separate blocks.
  const blocks = live.filter((el) => (BOX_TYPES.has(el.type) || (el.type === 'text' && !boundText(el))) && area(boxOf.get(el.id)) > 0)

  // Block pairs grow quadratically: a board with 1,500 elements has hundreds of
  // thousands of pairs, and every extra allocation here costs a second of server
  // time and freezes the editor. So boxes are computed once, distant pairs are
  // dropped before any checks, and the loop has no closures or arrays. The result
  // is the same — a test on random scenes verifies that.
  const blockBoxes = blocks.map((el) => boxOf.get(el.id))
  const sweep = sweeper(blockBoxes)

  // ── Almost aligned ────────────────────────────────────────────────────────
  // Lines matching on one axis means the blocks overlap along it, so only blocks
  // within ALIGN_NEIGHBOR on both axes form a pair.
  const nearPairs = sweep(ALIGN_NEIGHBOR, (a, b) => {
    const vGap = Math.max(0, Math.max(a.y1, b.y1) - Math.min(a.y2, b.y2))
    const hGap = Math.max(0, Math.max(a.x1, b.x1) - Math.min(a.x2, b.x2))
    if (vGap > ALIGN_NEIGHBOR && hGap > ALIGN_NEIGHBOR) return false
    if (contains(a, b) || contains(b, a)) return false
    const column = vGap <= ALIGN_NEIGHBOR && nearMiss(a.x1, b.x1, cx(a), cx(b), a.x2, b.x2)
    const row = hGap <= ALIGN_NEIGHBOR && nearMiss(a.y1, b.y1, cy(a), cy(b), a.y2, b.y2)
    return column || row
  }).map(([i, j]) => [blocks[i].id, blocks[j].id])
  metrics.nearMissPairs = nearPairs.length
  if (nearPairs.length >= ALIGN_MIN_PAIRS) {
    add({
      id: 'near-miss',
      title: 'Almost aligned',
      detail: `${nearPairs.length} element pairs are off by 1–${ALIGN_MISS} px at an edge or center: align them exactly`,
      elementIds: nearPairs.flat(),
      weight: weigh(nearPairs.length, 1, 6),
    })
  }

  // ── Same-role neighbours of different size ────────────────────────────────
  const cards = shapes.filter((el) => labelOf.has(el.id))
  const uneven = []
  const lines = (axis) => {
    const center = axis === 'row' ? (el) => cy(boxOf.get(el.id)) : (el) => cx(boxOf.get(el.id))
    const along = axis === 'row' ? (el) => boxOf.get(el.id).x1 : (el) => boxOf.get(el.id).y1
    const groups = []
    for (const card of [...cards].sort((p, q) => center(p) - center(q))) {
      const g = groups.find((grp) => grp.type === card.type && Math.abs(grp.center - center(card)) <= ROW_TOLERANCE)
      if (g) g.items.push(card)
      else groups.push({ type: card.type, center: center(card), items: [card] })
    }
    // A row means neighbours: split the group where the gap exceeds ROW_GAP.
    const out = []
    for (const g of groups) {
      const items = g.items.sort((p, q) => along(p) - along(q))
      let run = [items[0]]
      for (let k = 1; k < items.length; k += 1) {
        const prev = boxOf.get(items[k - 1].id)
        const cur = boxOf.get(items[k].id)
        const gap = axis === 'row' ? cur.x1 - prev.x2 : cur.y1 - prev.y2
        if (gap > ROW_GAP) {
          out.push(run)
          run = []
        }
        run.push(items[k])
      }
      out.push(run)
    }
    return out.filter((run) => run.length >= ROW_MIN)
  }
  for (const [axis, size] of [['row', (el) => Math.abs(el.height)], ['column', (el) => Math.abs(el.width)]]) {
    for (const run of lines(axis)) {
      const values = run.map(size)
      const max = Math.max(...values)
      const min = Math.min(...values)
      if (min > 0 && max / min > SIZE_RATIO && max - min > SIZE_DIFF) {
        const main = mode(values.map(round))
        uneven.push({ axis, ids: run.filter((el) => round(size(el)) !== main).map((el) => el.id) })
      }
    }
  }
  metrics.unevenRuns = uneven.length
  if (uneven.length) {
    add({
      id: 'uneven-siblings',
      title: 'Uneven neighbours',
      detail: `${uneven.length} ${uneven.length === 1 ? 'row' : 'rows'} of same-type cards with different ${uneven.some((u) => u.axis === 'row') ? 'heights' : 'widths'}: make cards of one role the same size`,
      elementIds: uneven.flatMap((u) => u.ids),
      weight: weigh(uneven.length, 3, 9),
    })
  }

  // A zone is a shape containing two or more others: a group background, not a
  // block of its own. Arrows may leave a zone, and its area is not crowding.
  // A shape containing something much smaller than itself is a zone too: a retro
  // column with a single sticky is a zone, not "crowded" (template calibration).
  const zones = new Set()
  for (let i = 0; i < blocks.length; i += 1) {
    const outer = blockBoxes[i]
    const half = area(outer) / 2
    let inside = 0
    // A nested block starts no further left than the zone and no further right than its edge.
    for (const j of sweep.within(outer.x1 - 0.5, outer.x2 + 0.5)) {
      if (j === i || !contains(outer, blockBoxes[j])) continue
      inside += 1
      if (inside >= 2 || area(blockBoxes[j]) < half) {
        zones.add(blocks[i].id)
        break
      }
    }
  }

  // ── Arrows: to nowhere and through shapes ─────────────────────────────────
  const targets = [...boxes, ...texts.filter((t) => !boundText(t))]
  const obstacles = grid(boxes.filter((shape) => !zones.has(shape.id)).map((shape) => ({ shape, outer: boxOf.get(shape.id) })), CROSS_INSET)
  const dangling = []
  const crossing = []
  for (const arrow of arrows) {
    const pts = (Array.isArray(arrow.points) && arrow.points.length ? arrow.points : [[0, 0]]).map((p) => [arrow.x + p[0], arrow.y + p[1]])
    const endTarget = (binding, [px, py]) => {
      if (binding?.elementId && byId.has(binding.elementId)) return byId.get(binding.elementId)
      return targets.find((t) => distanceToBox(px, py, boxOf.get(t.id)) <= DANGLING_SNAP) ?? null
    }
    const from = endTarget(arrow.startBinding, pts[0])
    const to = endTarget(arrow.endBinding, pts[pts.length - 1])
    if (!from || !to) dangling.push(arrow.id)
    const ends = new Set([from?.id, to?.id].filter(Boolean))
    const span = boxOf.get(arrow.id)
    // Arrow segments lie within its box: shapes the box does not touch are skipped.
    const hit = obstacles.near(span).some(({ shape, outer }) => {
      if (ends.has(shape.id)) return false
      if (span.x2 < outer.x1 + CROSS_INSET || span.x1 > outer.x2 - CROSS_INSET || span.y2 < outer.y1 + CROSS_INSET || span.y1 > outer.y2 - CROSS_INSET) return false
      const inner = inset(outer, CROSS_INSET)
      if (inner.x2 <= inner.x1 || inner.y2 <= inner.y1) return false
      // A shape that fully contains the arrow is a group background, not an obstacle.
      if (contains(outer, span)) return false
      for (let k = 1; k < pts.length; k += 1) if (segmentHitsBox(pts[k - 1][0], pts[k - 1][1], pts[k][0], pts[k][1], inner)) return true
      return false
    })
    if (hit) crossing.push(arrow.id)
  }
  metrics.danglingArrows = dangling.length
  metrics.crossingArrows = crossing.length
  if (dangling.length) {
    add({
      id: 'dangling-arrows',
      title: 'Arrows to nowhere',
      detail: `${dangling.length} ${dangling.length === 1 ? 'arrow is' : 'arrows are'} not bound to a shape at one end or both: bind both ends or remove the arrow`,
      elementIds: dangling,
      weight: weigh(dangling.length, 4, 16),
    })
  }
  if (crossing.length) {
    add({
      id: 'crossing-arrows',
      title: 'Arrows through shapes',
      detail: `${crossing.length} ${crossing.length === 1 ? 'arrow passes' : 'arrows pass'} through other shapes: move the shapes apart or route the arrow around`,
      elementIds: crossing,
      weight: weigh(crossing.length, 3, 12),
    })
  }

  // ── Overlaps ──────────────────────────────────────────────────────────────
  // An overlap is an intersection, so the blocks overlap along x.
  const overlaps = sweep(0, (a, b) => {
    if (a.x2 <= b.x1 || b.x2 <= a.x1 || a.y2 <= b.y1 || b.y2 <= a.y1) return false
    if (contains(a, b) || contains(b, a)) return false
    const inter = area(intersection(a, b))
    return inter > OVERLAP_MIN_AREA && inter > OVERLAP_SHARE * Math.min(area(a), area(b))
  }).map(([i, j]) => [blocks[i].id, blocks[j].id])
  metrics.overlaps = overlaps.length
  if (overlaps.length) {
    add({
      id: 'overlap',
      title: 'Overlapping elements',
      detail: `${overlaps.length} ${overlaps.length === 1 ? 'pair' : 'pairs'} of shapes or texts partly overlap: move them apart or nest one fully inside the other`,
      elementIds: overlaps.flat(),
      weight: weigh(overlaps.length, 4, 16),
    })
  }

  // ── Walls of text and text past the edge ──────────────────────────────────
  const walls = texts.filter((t) => textOf(t).length > (boundText(t) ? LABEL_WALL : FREE_TEXT_WALL))
  const overflow = texts.filter((t) => {
    // An arrow label sits on top of the line, not inside it: it is expected to stick out.
    if (!boundText(t) || !BOX_TYPES.has(byId.get(t.containerId).type)) return false
    const c = boxOf.get(t.containerId)
    const b = boxOf.get(t.id)
    return b.x1 < c.x1 - OVERFLOW || b.y1 < c.y1 - OVERFLOW || b.x2 > c.x2 + OVERFLOW || b.y2 > c.y2 + OVERFLOW
  })
  metrics.textWalls = walls.length
  metrics.textOverflow = overflow.length
  if (walls.length || overflow.length) {
    const parts = []
    if (walls.length) parts.push(`${walls.length} ${walls.length === 1 ? 'label is' : 'labels are'} longer than ${LABEL_WALL} characters — move paragraphs to a document and keep the gist on the diagram`)
    if (overflow.length) parts.push(`${overflow.length} ${overflow.length === 1 ? 'label sticks' : 'labels stick'} out of its shape`)
    add({
      id: 'text-walls',
      title: 'Walls of text',
      detail: parts.join('; '),
      elementIds: [...walls, ...overflow].map((t) => (boundText(t) ? t.containerId : t.id)),
      weight: weigh(walls.length, 4, 12) + weigh(overflow.length, 3, 9),
    })
  }

  // ── Decor ─────────────────────────────────────────────────────────────────
  const linked = new Set()
  for (const a of arrows) for (const b of [a.startBinding, a.endBinding]) if (b?.elementId) linked.add(b.elementId)
  // A legend marker — a small square next to a "done" label — is meaning, not decor.
  const freeTexts = texts.filter((t) => !boundText(t)).map((t) => boxOf.get(t.id))
  const nearText = (b) => freeTexts.some((t) => t && Math.max(0, Math.max(b.x1, t.x1) - Math.min(b.x2, t.x2)) <= 16 && Math.max(0, Math.max(b.y1, t.y1) - Math.min(b.y2, t.y2)) <= 16)
  const decor = shapes.filter((el) => area(boxOf.get(el.id)) < DECOR_AREA && !labelOf.has(el.id) && !linked.has(el.id) && !(el.boundElements ?? []).some((b) => b?.type === 'arrow') && !nearText(boxOf.get(el.id)))
  metrics.decor = decor.length
  if (decor.length >= DECOR_MIN) {
    add({
      id: 'decor',
      title: 'Meaningless decor',
      detail: `${decor.length} small shapes without labels or connections: if they mean nothing, remove them`,
      elementIds: decor.map((el) => el.id),
      weight: weigh(decor.length, 2, 8),
    })
  }

  // ── Crowding ──────────────────────────────────────────────────────────────
  // Zone area is excluded, otherwise any tidy grouping would look crowded.
  const solid = blocks.filter((el) => !zones.has(el.id))
  let coverage = 0
  if (solid.length) {
    const all = solid.map((el) => boxOf.get(el.id))
    const whole = { x1: Math.min(...all.map((b) => b.x1)), y1: Math.min(...all.map((b) => b.y1)), x2: Math.max(...all.map((b) => b.x2)), y2: Math.max(...all.map((b) => b.y2)) }
    coverage = area(whole) > 0 ? all.reduce((s, b) => s + area(b), 0) / area(whole) : 0
  }
  metrics.coverage = Math.round(coverage * 100) / 100
  const crowdedFrames = frames.filter((f) => live.filter((el) => el.frameId === f.id && !boundText(el)).length > FRAME_CROWD)
  if ((solid.length >= CROWD_MIN_ELEMENTS && coverage > CROWD_COVERAGE) || crowdedFrames.length) {
    const parts = []
    if (coverage > CROWD_COVERAGE && solid.length >= CROWD_MIN_ELEMENTS) parts.push(`shapes cover ${Math.round(coverage * 100)}% of the board area`)
    if (crowdedFrames.length) parts.push(`${crowdedFrames.length} ${crowdedFrames.length === 1 ? 'frame has' : 'frames have'} more than ${FRAME_CROWD} elements`)
    add({
      id: 'crowded',
      title: 'Crowded',
      detail: `${parts.join('; ')}: add whitespace — increase spacing or split into frames`,
      elementIds: crowdedFrames.length ? crowdedFrames.map((f) => f.id) : [],
      weight: 10,
    })
  }

  issues.sort((a, b) => b.weight - a.weight)
  const total = issues.reduce((s, i) => s + i.weight, 0)
  const score = Math.round(100 * (1 - Math.exp(-total / SCALE)))
  metrics.weight = Math.round(total * 10) / 10
  return { score, level: score < LEVEL_WARN ? 'clean' : score < LEVEL_SLOP ? 'warn' : 'slop', issues, metrics }
}
