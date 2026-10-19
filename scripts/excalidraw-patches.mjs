/**
 * Excalidraw 0.18.1 render patches applied when the editor is built.
 *
 * Excalidraw draws every shape from its raster copy. That is fast while the
 * copies exist and slow when they have to be redrawn. Below are the places
 * where the package does unnecessary work on every frame, or does all at once
 * what could be done gradually. All patches apply to the package's minified
 * prod build: an exact piece of code is replaced with ours. If a piece is not
 * found exactly once the build fails — the package changed and the patch must
 * be revisited, not silently skipped. The package version is pinned; upgrade
 * only with a full editor test run.
 *
 * 1. Copies after zoom are regenerated in the background. After every zoom
 *    Excalidraw redrew copies of all visible shapes in a single frame: seconds
 *    of freeze on an overview of a large board. Now a frame spends at most a
 *    budget on it and the rest go to a queue, drawn over the next frames from
 *    the screen center outwards; the scene is repainted when the queue drains
 *    (and every REPAINT_MS along the way so you can see it fill in). Until its
 *    turn a shape is drawn from its previous copy, scaled — which is what
 *    Excalidraw itself does during a zoom.
 * 2. Zoomed out by at most 2× — the previous, more detailed copy is fine as is;
 *    no need to redraw it.
 * 3. A second canvas per shape only for arrows with a label. The package
 *    created one with a context for every shape and never used it.
 * 4. An unrotated shape is drawn with a single drawImage, without the
 *    save/scale/translate/rotate/restore around it.
 * 5. The bounds of a curved arrow are remembered by its shape: the package
 *    recomputed them from curves on every frame for every arrow.
 * 6. Bound text bounds are remembered by the versions of the text and its
 *    container instead of being recomputed every frame.
 * 7. The properties panel computes the selected shapes once per frame, not once
 *    per property (see form-value-selection).
 * 8. Scene layers when hundreds of shapes are on screen: a frame is composed of
 *    cached layers of what did not change and live bands of the changed shapes,
 *    in the original stacking order; if nothing changed the canvas is not
 *    repainted (see __tbBands). A layered frame equals a full render — verified
 *    in the browser with the globalThis.__tbVerify flag.
 * 9. (retired: fonts are handled by scripts/self-hosted-fonts.mjs)
 * 10. Snapping guides are more visible: the package draws them as a pale red
 *    1px line that gets lost on pastel zones and red cards. The color is pink
 *    from the same open-color set as the board palette: it matches neither the
 *    violet selection nor the shape tones.
 * 11. Gaps between shapes for snapping are computed without garbage. At drag
 *    start the package walks all pairs of visible shapes and allocates two range
 *    arrays per pair just to check whether they overlap: on 560 shapes that is a
 *    300 ms hitch on the first frame. Same comparison, but on numbers — arrays
 *    are only allocated for pairs that actually have a gap.
 * 12. A sticky shrinks together with its text. The package does not let a shape
 *    get smaller than its label: on every mouse move it restores the label's
 *    initial font size and grows the shape to fit the text. For a sticky it is
 *    the other way round: the font size is fitted to the size — the largest, no
 *    bigger than the original, at which the text fits, but not below
 *    STICKY_MIN_FONT. The original size is stored on the label
 *    (customData.stickyFont), so enlarging the sticky brings it back. If the
 *    text does not fit even at the minimum, the shape grows as before.
 * 13. Smooth camera. The package moves the viewport immediately on every event:
 *    a wheel click jumps a hundred pixels and stops dead, a zoom step jumps ten
 *    percent, releasing a pan stops instantly. The camera itself lives in
 *    web/src/motion.ts; here are only six hooks through which the package hands
 *    it input: the wheel (motion-wheel), panning by hand (motion-grab,
 *    motion-drag, motion-release), view changes from actions — zoom buttons,
 *    "zoom to fit", reset (motion-action) — and the editor instance itself, so
 *    there is someone to set the view on (motion-mount). With no camera, or with
 *    smooth motion turned off, the hooks stay silent and the package behaves as
 *    before.
 * 14. A frame does not wait for new shapes. A shape that was never shown before
 *    is drawn into a copy right inside the frame, however many enter the screen
 *    at once. "Zoom to fit" on a board of five hundred shapes means hundreds of
 *    copies in one frame and a third-of-a-second hitch in the middle of a smooth
 *    zoom-out. Now, while the viewport is moving, a frame spends at most the
 *    same budget on new copies as on copies after zoom (item 1); the rest join
 *    the same queue and appear over the next frames, center first. When the
 *    viewport is still, everything is drawn at once as before: an edit must not
 *    flicker.
 */

export const EXCALIDRAW_VERSION = '0.18.1'
/** Per-frame budget for redrawing copies: smaller while the user moves the board, larger at rest. */
export const BUDGET_BUSY_MS = 4
export const BUDGET_IDLE_MS = 10
/** How long after the last input a frame still counts as "busy". */
export const INPUT_WINDOW_MS = 150
/** How often to show freshly drawn copies before the queue drains. */
export const REPAINT_MS = 120
/** Quiet period after a layered render, after which one full frame is drawn. */
export const HEAL_MS = 300
/** Changed shapes no further apart than this in stacking order form one live band. */
export const BAND_GAP = 8
/** More bands mean more full-canvas cached layers; beyond this the closest ones are merged. */
export const MAX_BANDS = 3
/** Layers only pay off with many shapes on screen; otherwise compositing costs more than drawing. */
export const BANDS_MIN_VISIBLE = 300
/** Snapping guides: color in light and dark theme, line width and the size of the cross at the snap point (screen px). */
export const SNAP_COLOR = '#e64980'
export const SNAP_COLOR_DARK = '#f783ac'
export const SNAP_LINE = 1.25
export const SNAP_CROSS = 3
/** A sticky label never gets smaller than this: below it is unreadable. */
export const STICKY_MIN_FONT = 8
/** Font-size fitting step: each step multiplies the size by this factor. */
export const STICKY_FONT_STEP = 0.92


/** Package files we patch: the scene renderer and the app (properties panel). */
export const FILES = {
  render: /@excalidraw\/excalidraw\/dist\/prod\/chunk-K2UTITRG\.js$/,
  app: /@excalidraw\/excalidraw\/dist\/prod\/index\.js$/,
}

// Names in `find` are the minified names of package 0.18.1: F1 — a shape's copy
// from the cache, K1 — draw a copy, Jo — copy cache, dp — render the scene, x7 —
// the same throttled to a frame, ya — copy onto the canvas, ee — "is an arrow",
// oe — a shape's bound text, It/Hr — shape curves and their bounds, he — shape cache.
export const PATCHES = [
  {
    id: 'regen-defer',
    file: 'render',
    // The copy is stale only because of zoom, and we are drawing the canvas (not an export).
    find: 'l=We(e,t)?.opacity||100;if(!i||a||',
    replace:
      // No copy at all while the viewport moves (or the shape is already queued): the frame
      // does not wait for it — see item 14 above. Selected shapes are always drawn: they are being edited.
      'l=We(e,t)?.opacity||100;if(!i&&n&&__tbRegen.budget!==1/0&&__tbRegen.spent>=__tbRegen.budget&&(__tbRegen.moved||__tbRegen.jobs.has(e))&&!r.selectedElementIds[e.id]){__tbDefer(e,t,o,n,r);return null}' +
      'if(a&&n&&__tbRegen.budget!==1/0&&i.theme===r.theme&&i.boundTextElementVersion===d&&i.imageCrop===c&&i.containingFrameOpacity===l&&!(ee(e)&&s&&e.angle!==i.angle)){if(i.zoomValue>=o.value&&i.zoomValue<=o.value*2)return i;if(__tbRegen.spent>=__tbRegen.budget){__tbDefer(e,t,o,n,r);return i}}if(!i||a||',
  },
  {
    id: 'regen-spent',
    file: 'render',
    // The budget counts only time spent redrawing copies, not the whole frame: otherwise
    // on a large board the frame would use up the budget before getting to copies.
    find: '{let U=K1(e,t,o,n,r);return U?(Jo.set(e,U),U):null}return i}',
    replace: '{let __t=performance.now(),U=K1(e,t,o,n,r);__tbRegen.spent+=performance.now()-__t;return U?(Jo.set(e,U),U):null}return i}',
  },
  {
    id: 'regen-frame',
    file: 'render',
    find: 'dp=({canvas:e,rc:t,elementsMap:n,allElementsMap:r,visibleElements:o,scale:i,appState:a,renderConfig:s})=>{if(e===null)return;',
    replace:
      'dp=__tbCfg=>__tbRenderStatic(__tbCfg,__tbDp),__tbDp=({canvas:e,rc:t,elementsMap:n,allElementsMap:r,visibleElements:o,scale:i,appState:a,renderConfig:s})=>{if(e===null)return;',
  },
  {
    id: 'keep-canvas',
    file: 'render',
    // "Draw on top" mode: render the scene without clearing the canvas or drawing the
    // background — for bands of changed shapes between cached layers (__tbBands).
    find: 'p=rp({canvas:e,scale:i,normalizedWidth:l,normalizedHeight:U,theme:a.theme,isExporting:c,viewBackgroundColor:a.viewBackgroundColor});',
    replace: 'p=s.__tbKeep?__tbKeepContext(e,i):rp({canvas:e,scale:i,normalizedWidth:l,normalizedHeight:U,theme:a.theme,isExporting:c,viewBackgroundColor:a.viewBackgroundColor});',
  },
  {
    id: 'regen-queued',
    file: 'render',
    // Mark that React already scheduled a scene render: it will show the fresh copies,
    // so there is no extra render in the same frame.
    find: 'x7=pd(e=>{dp(e)},{trailing:!0})',
    replace: 'x7=__tbQueued(pd(e=>{dp(e)},{trailing:!0}))',
  },
  {
    id: 'lazy-bound-text-canvas',
    file: 'render',
    find: 'let b=oe(e,t),E=document.createElement("canvas"),g=E.getContext("2d");if(ee(e)&&b){',
    replace: 'let b=oe(e,t),E=null,g=null;if(ee(e)&&b){E=document.createElement("canvas"),g=E.getContext("2d");',
  },
  {
    id: 'draw-fast-path',
    file: 'render',
    find: 't.save(),t.scale(1/window.devicePixelRatio,1/window.devicePixelRatio);let b=oe(i,o);if(ee(i)&&b){',
    replace:
      'if(i.angle===0&&!("scale"in i)&&!(ee(i)&&oe(i,o))){let q=window.devicePixelRatio;t.drawImage(e.canvas,((d+r.scrollX)*q-a)/q,((c+r.scrollY)*q-a)/q,e.canvas.width/e.scale/q,e.canvas.height/e.scale/q);return}t.save(),t.scale(1/window.devicePixelRatio,1/window.devicePixelRatio);let b=oe(i,o);if(ee(i)&&b&&e.boundTextCanvas){',
  },
  {
    id: 'curve-bounds-cache',
    file: 'render',
    find: 'let p=he.generateElementShape(t,null),m=It(p[0]),[b,E,g,h]=Hr(m);',
    replace: 'let p=he.generateElementShape(t,null),[b,E,g,h]=__tbCurveBounds(p[0],It,Hr);',
  },
  {
    id: 'bound-text-bounds-cache',
    file: 'render',
    // The package did not cache bound text bounds at all and computed them every frame
    // for every label. A label's bounds depend on the label and its container (for an
    // arrow, on the arrow's points), so we key the cache by both versions.
    // Without an elements map we compute as before.
    find: 'static getBounds(t,n){let r=rr.boundsCache.get(t);if(r?.version&&r.version===t.version&&!Ne(t))return r.bounds;let o=rr.calculateBounds(t,n);return rr.boundsCache.set(t,{version:t.version,bounds:o}),o}',
    replace:
      'static getBounds(t,n){let r=rr.boundsCache.get(t),cv=Ne(t)?n?.get?.(t.containerId)?.version??-1:0;if(r?.version&&r.version===t.version&&r.cv===cv&&cv!==-1)return r.bounds;let o=rr.calculateBounds(t,n);return rr.boundsCache.set(t,{version:t.version,cv,bounds:o}),o}',
  },
  {
    id: 'snap-gaps-horizontal',
    file: 'render',
    // Lr(Oe(a,b),Oe(c,d)) means "ranges [a,b] and [c,d] overlap", same as a<=d&&c<=b.
    // Pair bounds are read by index: array destructuring per pair, in code that runs once
    // per drag and never gets optimized, is the most expensive part here.
    find: 'let b=a[m],[,E,g,h]=p,[x,y,,w]=b;g<x&&Lr(Oe(E,h),Oe(y,w))&&s.push(',
    replace: 'let b=a[m],E=p[1],g=p[2],h=p[3],x=b[0],y=b[1],w=b[3];g<x&&E<=w&&y<=h&&s.push(',
  },
  {
    id: 'snap-gaps-vertical',
    file: 'render',
    find: 'let b=c[m],[E,,g,h]=p,[x,y,w]=b;h<y&&Lr(Oe(E,g),Oe(x,w))&&l.push(',
    replace: 'let b=c[m],E=p[0],g=p[2],h=p[3],x=b[0],y=b[1],w=b[2];h<y&&E<=w&&x<=g&&l.push(',
  },
  {
    id: 'sticky-text-fit',
    file: 'render',
    // _n — handleBindTextResize(shape e, …): i — the label, c and l — width and height
    // available to it, a/s/d — its wrapped text, height and width; en — wrap, ht — measure,
    // Ee — font string, Y — mutate element.
    find: 's=p.height,d=p.width}if(s>l){U=qa(s,e.type);',
    replace:
      's=p.height,d=p.width}' +
      'if(e.customData&&e.customData.kind==="sticky"&&i.originalText){' +
      'let __b=Math.max(i.fontSize,i.customData&&i.customData.stickyFont||0),__f=__b,__t,__m;' +
      'for(;;){let __s=Ee({fontSize:__f,fontFamily:i.fontFamily});__t=en(i.originalText,__s,c);__m=ht(__t,__s,i.lineHeight);' +
      `if(__m.height<=l||__f<=${STICKY_MIN_FONT})break;__f=Math.max(${STICKY_MIN_FONT},Math.floor(__f*${STICKY_FONT_STEP}))}` +
      'a=__t;s=__m.height;d=__m.width;' +
      'if(__f!==i.fontSize||__f!==__b)Y(i,{fontSize:__f,customData:{...i.customData,stickyFont:__b}})}' +
      'if(s>l){U=qa(s,e.type);',
  },
  {
    id: 'motion-mount',
    file: 'app',
    // An editor field declared in the constructor: this is how the camera learns whose view to set.
    find: 'C(this,"cancelInProgressAnimation",null);',
    replace: 'C(this,"cancelInProgressAnimation",null);globalThis.__tbMotion&&globalThis.__tbMotion.mount(this);',
  },
  {
    id: 'motion-wheel',
    file: 'app',
    // handleWheel: past this point the package pans or zooms by the whole delta at once.
    find: 'if(t.preventDefault(),ll)return;let{deltaX:r,deltaY:n}=t;',
    replace: 'if(t.preventDefault(),ll)return;if(globalThis.__tbMotion&&globalThis.__tbMotion.wheel(t,this))return;let{deltaX:r,deltaY:n}=t;',
  },
  {
    id: 'motion-grab',
    file: 'app',
    // handleCanvasPanUsingWheelOrSpaceDrag: the board is grabbed — any coasting stops.
    find: 'll=!0,this.focusContainer(),this.state.editingTextElement||t.preventDefault();',
    replace: 'll=!0,globalThis.__tbMotion&&globalThis.__tbMotion.grab(this),this.focusContainer(),this.state.editingTextElement||t.preventDefault();',
  },
  {
    id: 'motion-drag',
    file: 'app',
    // m and d — how many screen pixels the hand moved since the last frame.
    find: 'if(i=c.clientX,a=c.clientY,n&&!r&&',
    replace: 'if(i=c.clientX,a=c.clientY,globalThis.__tbMotion&&globalThis.__tbMotion.drag(m,d),n&&!r&&',
  },
  {
    id: 'motion-release',
    file: 'app',
    // Released: l.flush() plays the last move, then the fling.
    find: 'window.removeEventListener("blur",s),l.flush()});return window.addEventListener("blur",s)',
    replace: 'window.removeEventListener("blur",s),l.flush(),globalThis.__tbMotion&&globalThis.__tbMotion.release(this)});return window.addEventListener("blur",s)',
  },
  {
    id: 'motion-action',
    file: 'app',
    // syncActionResult: an action returned a new view (zoom buttons, "fit", reset) — the camera
    // takes it and animates there, while the state keeps the previous view for now.
    find: 'n?.isDeleted&&(n=null),this.setState(m=>{let d=t.appState||{};',
    replace: 'n?.isDeleted&&(n=null),t.appState&&globalThis.__tbMotion&&(t={...t,appState:globalThis.__tbMotion.action(t.appState,this)}),this.setState(m=>{let d=t.appState||{};',
  },
  {
    id: 'snap-guides',
    file: 'app',
    // Guide colors (light and dark theme), line width and half-size of the cross.
    find: 'var c5="#ff6b6b",d5="#ff0000",G1=1,Y1=2,',
    replace: `var c5="${SNAP_COLOR}",d5="${SNAP_COLOR_DARK}",G1=${SNAP_LINE},Y1=${SNAP_CROSS},`,
  },
  {
    id: 'form-value-selection',
    file: 'app',
    // The properties panel asks for the value of each property (about fifteen) on every
    // mouse move and each time re-filtered the whole scene: non-deleted, then selected,
    // then matching. The package has a selection cache, but it never hit — it got a new
    // array every time. Now selected shapes are computed once per scene and selection;
    // the answer is the same.
    find: 'gt=function(e,o,t,r,n){let i=o.editingTextElement,a=se(e),l=null;return i&&(l=t(i)),l||(ke(a,o)?l=UE(r===!0?a:a.filter(c=>r(c)),o,t)??(typeof n=="function"?n(!0):n):l=typeof n=="function"?n(!1):n),l}',
    replace:
      'gt=function(e,o,t,r,n){let i=o.editingTextElement,l=null;if(i&&(l=t(i)),l)return l;let a=__tbSelected(e,o);if(a.length){let s=r===!0?a:a.filter(c=>r(c)),u=new Set;for(let c of s)u.add(t(c));l=(u.size===1?u.values().next().value:null)??(typeof n=="function"?n(!0):n)}else l=typeof n=="function"?n(!1):n;return l}',
  },
]

/** Code the patches above call. Appended to the end of the same module. */
const RENDER_RUNTIME = `
;var __tbRegen = (globalThis.__tbRegen ??= { budget: Infinity, spent: 0, last: null, render: null, queued: false, inputAt: 0, jobs: new Map(), frame: 0, shownAt: 0, view: null, moved: false });
if (typeof window !== 'undefined' && !__tbRegen.listening) {
  __tbRegen.listening = true;
  var __tbInput = function () { __tbRegen.inputAt = performance.now(); };
  for (var __tbType of ['pointermove', 'pointerdown', 'wheel', 'keydown']) window.addEventListener(__tbType, __tbInput, { capture: true, passive: true });
}
function __tbBudget() {
  return performance.now() - __tbRegen.inputAt < ${INPUT_WINDOW_MS} ? ${BUDGET_BUSY_MS} : ${BUDGET_IDLE_MS};
}
function __tbRenderStatic(cfg, render) {
  var tb = __tbRegen;
  // Exports (image, preview) are drawn fully and at once — the budget is for the canvas only.
  if (!cfg || !cfg.renderConfig || cfg.renderConfig.isExporting) return render(cfg);
  tb.last = cfg;
  tb.render = render;
  tb.queued = false;
  // The viewport moved since the last frame — new shapes may be drawn in later frames (item 14).
  var a = cfg.appState, v = tb.view;
  tb.moved = !v || v.x !== a.scrollX || v.y !== a.scrollY || v.z !== a.zoom.value || v.w !== cfg.canvas.width || v.h !== cfg.canvas.height;
  tb.view = { x: a.scrollX, y: a.scrollY, z: a.zoom.value, w: cfg.canvas.width, h: cfg.canvas.height };
  // The viewport moves on its own (coasting, zoom animation) — also a "busy" frame, though there is no input.
  if (tb.moved && v) tb.inputAt = performance.now();
  tb.spent = 0;
  tb.budget = __tbBudget();
  var startedAt = performance.now();
  try {
    if (!__tbBands(cfg, render)) render(cfg);
  } finally {
    // Outside a canvas frame (export, new shape) copies are drawn without limits.
    tb.budget = Infinity;
  }
  // Canvas render time and frame count, for measurements: globalThis.__tbRegen.time.
  var time = (tb.time ??= { frames: 0, ms: 0 });
  time.frames++;
  time.ms += performance.now() - startedAt;
}
function __tbDefer(element, elementsMap, zoom, renderConfig, appState) {
  var tb = __tbRegen;
  tb.jobs.set(element, { element: element, version: element.version, elementsMap: elementsMap, zoom: zoom, renderConfig: renderConfig, appState: appState });
  if (!tb.frame) tb.frame = requestAnimationFrame(__tbWork);
}
function __tbWork() {
  var tb = __tbRegen;
  tb.frame = 0;
  var last = tb.last;
  if (!last) return tb.jobs.clear();
  var zoom = last.appState.zoom.value;
  // Closest to the screen center first: that is where people look.
  var cx = -last.appState.scrollX + last.appState.width / 2 / zoom;
  var cy = -last.appState.scrollY + last.appState.height / 2 / zoom;
  var list = [];
  tb.jobs.forEach(function (job) {
    // The view or the shape changed since — the next render will request the copy.
    if (job.zoom.value !== zoom || job.element.version !== job.version) return;
    var dx = job.element.x + job.element.width / 2 - cx;
    var dy = job.element.y + job.element.height / 2 - cy;
    job.distance = dx * dx + dy * dy;
    list.push(job);
  });
  tb.jobs.clear();
  list.sort(function (a, b) { return a.distance - b.distance; });
  var budget = __tbBudget();
  var start = performance.now();
  var k = 0;
  for (; k < list.length && (k === 0 || performance.now() - start < budget); k++) {
    var job = list[k];
    var copy = null;
    try {
      // The shape is usually in the package cache already, but it may have been dropped
      // while queued (theme change, font loaded) — a copy cannot be drawn without it.
      if (job.element.type !== 'text' && job.element.type !== 'image') he.generateElementShape(job.element, job.renderConfig);
      copy = K1(job.element, job.elementsMap, job.zoom, job.renderConfig, job.appState);
    } catch (error) {
      // Failed now — the scene render will draw the shape once the queue is empty.
      console.warn('boards: background shape copy failed', job.element.id, error);
    }
    if (copy) {
      Jo.set(job.element, copy);
      // The copy changed without a shape version bump — cached layers with it are stale.
      tb.copies = (tb.copies || 0) + 1;
    }
  }
  for (; k < list.length; k++) tb.jobs.set(list[k].element, list[k]);
  var now = performance.now();
  if (tb.jobs.size) tb.frame = requestAnimationFrame(__tbWork);
  // Show what was drawn: when the queue drains and occasionally along the way. If React
  // already scheduled a scene render, it will show it.
  if ((!tb.jobs.size || now - tb.shownAt > ${REPAINT_MS}) && !tb.queued && tb.render) {
    tb.shownAt = now;
    // Copies changed without shape version bumps — cached layers are stale.
    tb.forceFull = true;
    __tbRenderStatic(last, tb.render);
  }
}
// ── Scene layers: redraw only the changed bands ────────────────────────────
// A frame is cached layers of unchanged shapes with live bands of changed shapes
// between them, all in the original stacking order. Drag a card on an overview of
// a thousand-shape board and the frame draws that card, its arrows and their
// stacking neighbours, not the whole board. Anything that can change the picture
// without a shape version bump is in the view key; anything drawn out of stacking
// order (embedded frames, eraser, frame highlight) disables layers.
// After HEAL_MS of quiet, one full render just in case.
var __tbB = { key: null, ids: null, vers: null, canvas: null, layers: [], heal: 0, fontEpoch: 0 };
if (typeof document !== 'undefined' && document.fonts && !__tbRegen.fontsWatched) {
  __tbRegen.fontsWatched = true;
  document.fonts.addEventListener('loadingdone', function () { __tbB.fontEpoch++; });
}
function __tbViewKey(cfg) {
  var a = cfg.appState, r = cfg.renderConfig, fr = a.frameRendering || {};
  return [cfg.scale, cfg.canvas.width, cfg.canvas.height, a.zoom.value, a.scrollX, a.scrollY, a.theme, a.viewBackgroundColor, a.gridSize, a.gridStep, r.renderGrid, fr.enabled, fr.clip, fr.name, fr.outline, a.editingTextElement ? a.editingTextElement.id : '', a.croppingElementId || '', a.shouldCacheIgnoreZoom, r.imageCache ? r.imageCache.size : 0, r.embedsValidationStatus ? r.embedsValidationStatus.size : 0, r.canvasBackgroundColor, __tbB.fontEpoch, __tbRegen.copies || 0].join('|');
}
function __tbKeepContext(canvas, scale) {
  var c = canvas.getContext('2d');
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.scale(scale, scale);
  return c;
}
/** How many frames were drawn which way, for measurements: globalThis.__tbRegen.stats. */
function __tbCount(why) {
  var st = (__tbRegen.stats ??= {});
  st[why || 'other'] = (st[why || 'other'] || 0) + 1;
}
function __tbFull(cfg, render, key, why) {
  var B = __tbB;
  __tbCount(why);
  render(cfg);
  B.layers = [];
  B.key = key;
  B.canvas = cfg.canvas;
  B.ids = cfg.visibleElements.map(function (el) { return el.id; });
  B.vers = cfg.visibleElements.map(function (el) { return el.version; });
  return true;
}
/**
 * Shape version for a layer. A bound label is drawn with its container, not at its
 * own stacking position, so its changes do not affect the layer: when the label
 * changes, its container goes into a live band.
 */
function __tbVersion(el, cfg) {
  return el.type === 'text' && el.containerId && cfg.elementsMap.has(el.containerId) ? -1 : el.version;
}
/** The previous layer vis[from..to), if nothing in it changed since. */
function __tbReuse(cfg, key, from, to) {
  var vis = cfg.visibleElements, B = __tbB;
  for (var k = 0; k < B.layers.length; k++) {
    var old = B.layers[k];
    if (old.key !== key || old.from !== from || old.to !== to) continue;
    var ok = true;
    for (var i = from; i < to && ok; i++) ok = old.ids[i - from] === vis[i].id && old.vers[i - from] === __tbVersion(vis[i], cfg);
    if (ok) return old;
  }
  return null;
}
/** A new layer vis[from..to) on a spare canvas. */
function __tbBuild(cfg, render, key, from, to, canvas) {
  __tbCount('layerBuild');
  var vis = cfg.visibleElements;
  canvas = canvas || document.createElement('canvas');
  canvas.width = cfg.canvas.width;
  canvas.height = cfg.canvas.height;
  var part = vis.slice(from, to);
  if (from === 0) {
    // The bottom layer has the background and grid, like a normal frame.
    render(Object.assign({}, cfg, { canvas: canvas, visibleElements: part }));
  } else {
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
    if (part.length) render(Object.assign({}, cfg, { canvas: canvas, visibleElements: part, renderConfig: Object.assign({}, cfg.renderConfig, { renderGrid: false, __tbKeep: true }) }));
  }
  return { key: key, from: from, to: to, canvas: canvas, ids: part.map(function (el) { return el.id; }), vers: part.map(function (el) { return __tbVersion(el, cfg); }) };
}
function __tbBands(cfg, render) {
  var B = __tbB, tb = __tbRegen, a = cfg.appState, r = cfg.renderConfig, vis = cfg.visibleElements, n = vis.length;
  var key = __tbViewKey(cfg);
  var force = tb.forceFull;
  tb.forceFull = false;
  clearTimeout(B.heal);
  if (n < ${BANDS_MIN_VISIBLE}) return __tbFull(cfg, render, key, 'few');
  if (force || tb.jobs.size || a.frameToHighlight || (a.openDialog && a.openDialog.name === 'elementLinkSelector') || (r.elementsPendingErasure && r.elementsPendingErasure.size) || (r.pendingFlowchartNodes && r.pendingFlowchartNodes.length)) return __tbFull(cfg, render, null, 'state');
  if (B.key !== key || B.canvas !== cfg.canvas) return __tbFull(cfg, render, key, 'view');
  if (!B.ids || B.ids.length !== n) return __tbFull(cfg, render, key, 'set');
  var changed = [], index = null;
  for (var i = 0; i < n; i++) {
    var el = vis[i];
    if (B.ids[i] !== el.id) return __tbFull(cfg, render, key, 'set');
    if (el.type === 'iframe' || el.type === 'embeddable') return __tbFull(cfg, render, key, 'embed');
    if (B.vers[i] === el.version) continue;
    if (el.type === 'frame' || el.type === 'magicframe') return __tbFull(cfg, render, key, 'frame');
    var at = i;
    // A label is drawn with its container, so it takes the container's stacking position.
    if (el.type === 'text' && el.containerId && cfg.elementsMap.has(el.containerId)) {
      if (!index) {
        index = new Map();
        for (var k = 0; k < n; k++) index.set(vis[k].id, k);
      }
      at = index.get(el.containerId);
      if (at === undefined) continue;
    }
    changed.push(at);
  }
  for (var j = 0; j < n; j++) B.vers[j] = vis[j].version;
  // Nothing changed — the canvas already shows this frame.
  if (!changed.length) return __tbCount('same'), true;
  // Live bands: changed shapes close in stacking order share a band; at most MAX_BANDS
  // bands, otherwise there are too many layers and too much memory.
  changed.sort(function (x, y) { return x - y; });
  var bands = [];
  for (var c = 0; c < changed.length; c++) {
    var last = bands[bands.length - 1];
    if (last && changed[c] - last.to <= ${BAND_GAP}) last.to = Math.max(last.to, changed[c] + 1);
    else bands.push({ from: changed[c], to: changed[c] + 1 });
  }
  while (bands.length > ${MAX_BANDS}) {
    var best = 0;
    for (var g = 1; g < bands.length - 1; g++) if (bands[g + 1].from - bands[g].to < bands[best + 1].from - bands[best].to) best = g;
    bands[best].to = bands[best + 1].to;
    bands.splice(best + 1, 1);
  }
  var live = 0;
  for (var b = 0; b < bands.length; b++) live += bands[b].to - bands[b].from;
  // Most of it changed — nothing for layers to save.
  if (live > n * 0.6) return __tbFull(cfg, render, key, 'wide');
  // First find which previous layers are reusable as is, and only then build new layers
  // on the remaining canvases: otherwise a new layer could land on the canvas of an old
  // one that is still going to be reused in this same frame.
  var ranges = [];
  var from = 0;
  for (var s = 0; s <= bands.length; s++) {
    var to = s < bands.length ? bands[s].from : n;
    ranges.push(from === 0 || to > from ? { from: from, to: to } : null);
    if (s < bands.length) from = bands[s].to;
  }
  var layers = ranges.map(function (rg) { return rg && __tbReuse(cfg, key, rg.from, rg.to); });
  var spare = B.layers.filter(function (l) { return layers.indexOf(l) < 0; }).map(function (l) { return l.canvas; });
  for (var q = 0; q < ranges.length; q++) if (ranges[q] && !layers[q]) layers[q] = __tbBuild(cfg, render, key, ranges[q].from, ranges[q].to, spare.pop());
  B.layers = layers.filter(Boolean);
  var ctx = cfg.canvas.getContext('2d');
  var blit = function (layer) {
    if (!layer) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.drawImage(layer.canvas, 0, 0);
  };
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, cfg.canvas.width, cfg.canvas.height);
  blit(layers[0]);
  for (var t = 0; t < bands.length; t++) {
    render(Object.assign({}, cfg, { visibleElements: vis.slice(bands[t].from, bands[t].to), renderConfig: Object.assign({}, r, { renderGrid: false, __tbKeep: true }) }));
    blit(layers[t + 1]);
  }
  __tbCount('bands');
  if (globalThis.__tbVerify) __tbCheck(cfg, render);
  B.heal = setTimeout(function () {
    if (tb.last && tb.render) {
      tb.forceFull = true;
      __tbRenderStatic(tb.last, tb.render);
    }
  }, ${HEAL_MS});
  return true;
}
// Layer verification in browser tests: with globalThis.__tbVerify = true every
// layered frame is compared with a full render of the same scene.
function __tbCheck(cfg, render) {
  var w = cfg.canvas.width, h = cfg.canvas.height;
  var scratch = document.createElement('canvas');
  scratch.width = w;
  scratch.height = h;
  render(Object.assign({}, cfg, { canvas: scratch }));
  var got = cfg.canvas.getContext('2d').getImageData(0, 0, w, h).data;
  var want = scratch.getContext('2d').getImageData(0, 0, w, h).data;
  var bad = 0, worst = 0;
  for (var i = 0; i < got.length; i++) {
    var d = Math.abs(got[i] - want[i]);
    if (d > worst) worst = d;
    if (d > 2) bad++;
  }
  var v = (__tbRegen.verify ??= { frames: 0, badFrames: 0, badPixels: 0, worst: 0 });
  v.frames++;
  if (bad) v.badFrames++;
  // Keep the worst frame for debugging: what we got, what we wanted and how it was composed.
  if (bad && (!globalThis.__tbBad || bad > globalThis.__tbBad.bad)) globalThis.__tbBad = { bad: bad, got: cfg.canvas.toDataURL(), want: scratch.toDataURL(), stats: JSON.stringify(__tbRegen.stats), n: cfg.visibleElements.length, zoom: cfg.appState.zoom.value };
  v.badPixels += bad;
  if (worst > v.worst) v.worst = worst;
}
function __tbQueued(throttled) {
  var queued = function () {
    __tbRegen.queued = true;
    return throttled.apply(this, arguments);
  };
  queued.flush = throttled.flush;
  queued.cancel = throttled.cancel;
  return queued;
}
var __tbCurveCache = new WeakMap();
function __tbCurveBounds(shape, toOps, minMax) {
  var bounds = __tbCurveCache.get(shape);
  if (!bounds) {
    bounds = minMax(toOps(shape));
    __tbCurveCache.set(shape, bounds);
  }
  return bounds;
}
`

const APP_RUNTIME = `
;var __tbSelectedCache = { elements: null, length: -1, ids: null, result: [] };
function __tbSelected(elements, appState) {
  var c = __tbSelectedCache;
  if (c.elements !== elements || c.length !== elements.length || c.ids !== appState.selectedElementIds) {
    var result = [];
    for (var i = 0; i < elements.length; i++) {
      var el = elements[i];
      if (!el.isDeleted && appState.selectedElementIds[el.id]) result.push(el);
    }
    c.elements = elements;
    c.length = elements.length;
    c.ids = appState.selectedElementIds;
    c.result = result;
  }
  return c.result;
}
`

export const RUNTIME = { render: RENDER_RUNTIME, app: APP_RUNTIME }

/** Which of the patched package files this module is, or null. */
export function fileOf(id) {
  const path = id.split('?')[0].replaceAll('\\', '/')
  return Object.keys(FILES).find((key) => FILES[key].test(path)) ?? null
}

/** Apply a file's patches to its code; throws if any is not found exactly once. */
export function applyPatches(code, file) {
  let out = code
  for (const patch of PATCHES.filter((p) => p.file === file)) {
    const count = out.split(patch.find).length - 1
    if (count !== 1) throw new Error(`Excalidraw: patch "${patch.id}" found its code ${count} times instead of once — is the package not ${EXCALIDRAW_VERSION}?`)
    out = out.replace(patch.find, () => patch.replace)
  }
  return out + RUNTIME[file]
}

/** Vite plugin: patches the renderer module at build time. */
export function excalidrawPatches() {
  const applied = new Set()
  return {
    name: 'boards-excalidraw-patches',
    enforce: 'pre',
    transform(code, id) {
      const file = fileOf(id)
      if (!file) return null
      applied.add(file)
      return { code: applyPatches(code, file), map: null }
    },
    buildEnd(error) {
      const missing = Object.keys(FILES).filter((file) => !applied.has(file))
      if (!error && missing.length) this.error(`Excalidraw: files ${missing.join(', ')} were not part of the build — render patches were not applied`)
    },
  }
}
