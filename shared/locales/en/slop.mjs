/** slop: en messages. Keys are prefixed with "slop." in the joined catalog. */
export default {
  pastelRainbowTitle: 'Too many tints',
  pastelRainbowDetail: {
    one: '{count} pastel tint: a zone color should mean something, turn the extra ones neutral',
    other: '{count} pastel tints: a zone color should mean something, turn the extra ones neutral',
  },
  rainbowTitle: 'Color rainbow',
  rainbowDetail: {
    one: '{count} bright fill of different colors where {max} is plenty: keep one accent and a couple of meaningful colors, make the rest palette pastels or neutral',
    other: '{count} bright fills of different colors where {max} is plenty: keep one accent and a couple of meaningful colors, make the rest palette pastels or neutral',
  },
  offPaletteTitle: 'Off-palette colors',
  offPaletteDetail: {
    one: '{count} color is not from the palette ({colors}): pick the closest palette color',
    other: '{count} colors are not from the palette ({colors}): pick the closest palette color',
  },
  emojiTitle: 'Emoji instead of meaning',
  emojiShare: {
    one: 'emoji in {used} of {count} label',
    other: 'emoji in {used} of {count} labels',
  },
  emojiBullets: {
    one: ', {count} line starts with an emoji bullet',
    other: ', {count} lines start with an emoji bullet',
  },
  emojiDetail: '{share}{bullets}: words, color and shape carry meaning — remove the emoji or keep one meaningful symbol',
  fontFamiliesTitle: 'Font mix',
  fontFamiliesDetail: {
    one: '{count} different font: one is enough, two at most (headings and body)',
    other: '{count} different fonts: one is enough, two at most (headings and body)',
  },
  fontSizesTitle: 'Too many font sizes',
  fontSizesDetail: {
    one: '{count} text size ({sizes}): reduce to a scale of three or four',
    other: '{count} text sizes ({sizes}): reduce to a scale of three or four',
  },
  styleMixTitle: 'Style mix',
  styleRough: 'some shapes hand-drawn, some straight',
  styleHatching: 'hatching mixed with solid fills',
  styleWidths: {
    one: '{count} stroke width',
    other: '{count} stroke widths',
  },
  styleMixDetail: '{parts}: pick one shape style and keep it across the board',
  partsSeparator: '; ',
  nearMissTitle: 'Almost aligned',
  nearMissDetail: {
    one: '{count} element pair is off by 1–{miss} px at an edge or center: align them exactly',
    other: '{count} element pairs are off by 1–{miss} px at an edge or center: align them exactly',
  },
  unevenTitle: 'Uneven neighbours',
  unevenHeightsDetail: {
    one: '{count} row of same-type cards with different heights: make cards of one role the same size',
    other: '{count} rows of same-type cards with different heights: make cards of one role the same size',
  },
  unevenWidthsDetail: {
    one: '{count} row of same-type cards with different widths: make cards of one role the same size',
    other: '{count} rows of same-type cards with different widths: make cards of one role the same size',
  },
  danglingTitle: 'Arrows to nowhere',
  danglingDetail: {
    one: '{count} arrow is not bound to a shape at one end or both: bind both ends or remove the arrow',
    other: '{count} arrows are not bound to a shape at one end or both: bind both ends or remove the arrow',
  },
  crossingTitle: 'Arrows through shapes',
  crossingDetail: {
    one: '{count} arrow passes through other shapes: move the shapes apart or route the arrow around',
    other: '{count} arrows pass through other shapes: move the shapes apart or route the arrow around',
  },
  overlapTitle: 'Overlapping elements',
  overlapDetail: {
    one: '{count} pair of shapes or texts partly overlap: move them apart or nest one fully inside the other',
    other: '{count} pairs of shapes or texts partly overlap: move them apart or nest one fully inside the other',
  },
  textWallsTitle: 'Walls of text',
  textWallsLong: {
    one: '{count} label is longer than {max} characters — move paragraphs to a document and keep the gist on the diagram',
    other: '{count} labels are longer than {max} characters — move paragraphs to a document and keep the gist on the diagram',
  },
  textWallsOverflow: {
    one: '{count} label sticks out of its shape',
    other: '{count} labels stick out of its shape',
  },
  decorTitle: 'Meaningless decor',
  decorDetail: {
    one: '{count} small shape without labels or connections: if they mean nothing, remove them',
    other: '{count} small shapes without labels or connections: if they mean nothing, remove them',
  },
  crowdedTitle: 'Crowded',
  crowdedCoverage: 'shapes cover {percent}% of the board area',
  crowdedFrames: {
    one: '{count} frame has more than {max} elements',
    other: '{count} frames have more than {max} elements',
  },
  crowdedDetail: '{parts}: add whitespace — increase spacing or split into frames',
}
