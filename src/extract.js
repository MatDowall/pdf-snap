/**
 * extract.js — turn a PDF.js operator list into snappable linework.
 *
 * WHY THE OPERATOR LIST?
 * PDF.js parses the page in its worker and produces a flat list of drawing
 * commands (`fnArray` = op codes, `argsArray` = their arguments). That's the
 * same list the renderer executes. By interpreting it ourselves — tracking
 * the graphics state like a renderer would, but recording geometry instead of
 * drawing pixels — we get every line of the drawing in exact PDF coordinates.
 * No image processing, no guessing: snap points land exactly on the CAD vertex.
 *
 *     const ol = await page.getOperatorList({ annotationMode: AnnotationMode.DISABLE });
 *     const geom = extractLinework(ol.fnArray, ol.argsArray, pdfjsLib.OPS);
 *
 * WHAT WE TRACK (the bits a naive extractor gets wrong)
 *  - CTM stack: save / restore / transform (`cm`), and form XObjects
 *    (paintFormXObjectBegin carries the form's /Matrix). Without this, title
 *    blocks, blocks/xrefs and anything inside a form land in the wrong place.
 *  - Paint operator: only paths that are actually STROKED or FILLED count.
 *    Clipping paths (`W n`) are painted with endPath and must be discarded —
 *    otherwise every viewport/clip rectangle becomes a snap target.
 *  - Curves: flattened into short segments; only the true ends of a curve are
 *    "vertices" (endpoint snaps), not the flattening points.
 *  - Line width (× CTM scale), dash state, white fills (wipeouts/masks),
 *    and optional content (PDF layers) so callers can filter.
 *
 * PDF.js FORMAT DIFFERENCES (handled automatically)
 *  - 4.x:  constructPath args = [opsArray, coordsArray, minMax]; the paint op
 *          (stroke/fill/endPath…) arrives as a SEPARATE following operator;
 *          path ops use OPS.moveTo/lineTo/curveTo/curveTo2/curveTo3/rectangle/closePath.
 *  - 5.x+: constructPath args = [paintOp, [Float32Array pathData], minMax];
 *          pathData uses DrawOPS codes: 0 moveTo, 1 lineTo, 2 curveTo, 3 quadraticCurveTo, 4 closePath.
 *
 * OUTPUT — "packed geometry": flat typed arrays (fast, small, transferable to/from a Worker).
 * All coordinates are PDF user space (points, y up, unrotated) — the same space
 * PdfViewport.pageToPdf() returns, so it's independent of rotation and zoom.
 */

export const POLY = {
  STROKE: 1, // path was stroked
  FILL: 2, // path was filled
  CLOSED: 4,
  CURVE: 8, // contains flattened curve segments
  DASH: 16, // stroked with a dash pattern
  MASK: 32, // filled white (wipeout / masking) — usually not real linework
};

/** per-point flag: this point is a real vertex (not an interior curve-flattening point) */
export const PT_VERTEX = 1;

const IDENTITY = [1, 0, 0, 1, 0, 0];

const mul = (m, t) => [
  m[0] * t[0] + m[2] * t[1],
  m[1] * t[0] + m[3] * t[1],
  m[0] * t[2] + m[2] * t[3],
  m[1] * t[2] + m[3] * t[3],
  m[0] * t[4] + m[2] * t[5] + m[4],
  m[1] * t[4] + m[3] * t[5] + m[5],
];

/** Number of segments to flatten a bezier into, from its control-polygon length (in user units). */
function curveSteps(len, tol) {
  // error of a chord ≈ L²/(8·R·n²); a length-based heuristic is plenty for snapping
  return Math.max(4, Math.min(64, Math.ceil(Math.sqrt(len / tol))));
}

function isWhite(args) {
  const a = args?.[0];
  if (typeof a === 'string') return /^#?f{6}$/i.test(a.trim()); // pdf.js 5+: '#ffffff'
  if (args && args.length >= 3) return args[0] >= 250 && args[1] >= 250 && args[2] >= 250; // 4.x: [255,255,255]
  return false;
}

function isDashed(args) {
  const arr = args?.[0];
  return Array.isArray(arr) && arr.some((v) => typeof v === 'number' && v > 0);
}

function ocKey(props) {
  // pdf.js gives { type: 'OCG', id: '6R' } (or an OCMD object). Use a stable string.
  if (props == null) return null;
  if (typeof props === 'string') return props;
  return props.id ?? JSON.stringify(props);
}

/**
 * Growable typed-array builder (avoids millions of JS number pushes into normal arrays).
 */
class Buf {
  constructor(Type, cap = 1024) {
    this.Type = Type;
    this.a = new Type(cap);
    this.n = 0;
  }
  push(v) {
    if (this.n === this.a.length) {
      const b = new this.Type(this.a.length * 2);
      b.set(this.a);
      this.a = b;
    }
    this.a[this.n++] = v;
  }
  done() {
    return this.a.slice(0, this.n);
  }
}

/**
 * Walk an operator list. This is a GENERATOR so the same code can run
 * synchronously (in a Worker) or time-sliced on the main thread: it yields
 * every `sliceOps` operators.
 *
 * @param {ArrayLike<number>} fnArray
 * @param {any[]} argsArray
 * @param {Record<string, number>} OPS   pdfjsLib.OPS
 * @param {object} [opt]
 * @param {number} [opt.curveTolerance=0.5]   flattening tolerance-ish (user units)
 * @param {number} [opt.minPathSize=0.05]     drop paths whose bbox is smaller than this (dots, specks)
 * @param {number} [opt.maxPoints=4e6]        safety cap
 * @param {number} [opt.sliceOps=4000]
 */
export function* walkOperatorList(fnArray, argsArray, OPS, opt = {}) {
  const curveTol = opt.curveTolerance ?? 0.5;
  const minPathSize = opt.minPathSize ?? 0.05;
  const maxPoints = opt.maxPoints ?? 4e6;
  const sliceOps = opt.sliceOps ?? 4000;

  const coords = new Buf(Float64Array, 1 << 16);
  const ptFlags = new Buf(Uint8Array, 1 << 15);
  const polyStart = new Buf(Int32Array);
  const polyLength = new Buf(Int32Array);
  const polyFlags = new Buf(Uint8Array);
  const polyWidth = new Buf(Float32Array);
  const polyLayer = new Buf(Int32Array);
  const polyBBox = new Buf(Float64Array, 4096);

  /** layer combos: each entry = array of OC keys active (nested BDC/EMC) */
  const layers = [];
  const layerIndex = new Map();

  let gs = { ctm: IDENTITY, lw: 1, dashed: false, whiteFill: false };
  const stack = [];
  const ocStack = []; // null for non-OC marked content
  let annotDepth = 0;
  let pending = []; // 4.x: subpaths waiting for their paint op
  let truncated = false;

  // ---- current run (polyline) being built
  let runStart = -1;
  let hasCurve = false;
  let bx0, by0, bx1, by1;
  let subStartX = 0,
    subStartY = 0; // untransformed start of current subpath (for closePath)
  let cx = 0,
    cy = 0; // untransformed current point
  let m = IDENTITY;

  const addPt = (x, y, vertex) => {
    // transform user → page user space with the CTM captured for this path
    const X = m[0] * x + m[2] * y + m[4];
    const Y = m[1] * x + m[3] * y + m[5];
    if (runStart < 0) {
      runStart = coords.n >> 1;
      bx0 = bx1 = X;
      by0 = by1 = Y;
    } else {
      // skip exact duplicates (zero-length segments)
      const i = coords.n;
      if (coords.a[i - 2] === X && coords.a[i - 1] === Y) {
        if (vertex) ptFlags.a[ptFlags.n - 1] |= PT_VERTEX;
        return;
      }
      if (X < bx0) bx0 = X;
      if (X > bx1) bx1 = X;
      if (Y < by0) by0 = Y;
      if (Y > by1) by1 = Y;
    }
    coords.push(X);
    coords.push(Y);
    ptFlags.push(vertex ? PT_VERTEX : 0);
  };

  /** finish the current run; paint = {stroked, filled} */
  const endRun = (closed, paint, width, layer) => {
    if (runStart < 0) return;
    const n = (coords.n >> 1) - runStart;
    const big = bx1 - bx0 >= minPathSize || by1 - by0 >= minPathSize;
    if (n >= 2 && big) {
      let f = 0;
      if (paint.stroked) f |= POLY.STROKE;
      if (paint.filled) f |= POLY.FILL;
      // CAD exports often end a shape back at its start without a closePath ('h') —
      // treat "first point == last point" as closed too (matters for circle detection, areas).
      const e = (runStart + n - 1) * 2;
      const geomClosed =
        n >= 3 && Math.abs(coords.a[runStart * 2] - coords.a[e]) < 1e-6 && Math.abs(coords.a[runStart * 2 + 1] - coords.a[e + 1]) < 1e-6;
      if (closed || geomClosed || paint.filled) f |= POLY.CLOSED;
      if (hasCurve) f |= POLY.CURVE;
      if (paint.stroked && gs.dashed) f |= POLY.DASH;
      if (paint.filled && !paint.stroked && gs.whiteFill) f |= POLY.MASK;
      polyStart.push(runStart);
      polyLength.push(n);
      polyFlags.push(f);
      polyWidth.push(width);
      polyLayer.push(layer);
      polyBBox.push(bx0);
      polyBBox.push(by0);
      polyBBox.push(bx1);
      polyBBox.push(by1);
      if (coords.n >> 1 > maxPoints) truncated = true;
    } else {
      // discard: roll back the points
      coords.n = runStart * 2;
      ptFlags.n = runStart;
    }
    runStart = -1;
    hasCurve = false;
  };

  const curve = (x1, y1, x2, y2, x3, y3) => {
    const len = Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x3 - x2, y3 - y2);
    // scale tolerance into local units so flattening is consistent after transforms
    const s = Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2])) || 1;
    const n = curveSteps(len * s, curveTol);
    const x0 = cx,
      y0 = cy;
    for (let k = 1; k <= n; k++) {
      const t = k / n,
        u = 1 - t;
      const a = u * u * u,
        b = 3 * u * u * t,
        c = 3 * u * t * t,
        d = t * t * t;
      addPt(a * x0 + b * x1 + c * x2 + d * x3, a * y0 + b * y1 + c * y2 + d * y3, k === n);
    }
    hasCurve = true;
    cx = x3;
    cy = y3;
  };

  const currentLayer = () => {
    const ids = ocStack.filter((v) => v != null);
    if (!ids.length) return -1;
    const key = ids.join('\u0000');
    let i = layerIndex.get(key);
    if (i === undefined) {
      i = layers.length;
      layers.push(ids);
      layerIndex.set(key, i);
    }
    return i;
  };

  /** Emit geometry for one path, given its painting. `segments` = list of {kind,...} */
  const emitV6 = (data, ctm, paint, width, layer) => {
    m = ctm;
    runStart = -1;
    for (let i = 0; i < data.length; ) {
      const op = data[i++];
      switch (op) {
        case 0: // moveTo
          endRun(false, paint, width, layer);
          cx = subStartX = data[i++];
          cy = subStartY = data[i++];
          addPt(cx, cy, true);
          break;
        case 1: // lineTo
          cx = data[i++];
          cy = data[i++];
          addPt(cx, cy, true);
          break;
        case 2: // curveTo
          curve(data[i], data[i + 1], data[i + 2], data[i + 3], data[i + 4], data[i + 5]);
          i += 6;
          break;
        case 3: {
          // quadraticCurveTo → cubic
          const qx = data[i],
            qy = data[i + 1],
            ex = data[i + 2],
            ey = data[i + 3];
          i += 4;
          curve(cx + (2 / 3) * (qx - cx), cy + (2 / 3) * (qy - cy), ex + (2 / 3) * (qx - ex), ey + (2 / 3) * (qy - ey), ex, ey);
          break;
        }
        case 4: // closePath
          if (runStart >= 0) {
            addPt(subStartX, subStartY, true);
            endRun(true, paint, width, layer);
          }
          cx = subStartX;
          cy = subStartY;
          break;
        default:
          i = data.length; // unknown → stop safely
      }
    }
    finishPath(paint, width, layer);
  };

  /** End of a painted path: closeStroke and fills implicitly close the last subpath. */
  const finishPath = (paint, width, layer) => {
    if (runStart >= 0 && paint.close) {
      addPt(subStartX, subStartY, true);
      endRun(true, paint, width, layer);
    } else endRun(false, paint, width, layer);
  };

  const emitV4 = (ops, args, ctm, paint, width, layer) => {
    m = ctm;
    runStart = -1;
    let j = 0;
    for (const op of ops) {
      if (op === OPS.moveTo) {
        endRun(false, paint, width, layer);
        cx = subStartX = args[j++];
        cy = subStartY = args[j++];
        addPt(cx, cy, true);
      } else if (op === OPS.lineTo) {
        cx = args[j++];
        cy = args[j++];
        addPt(cx, cy, true);
      } else if (op === OPS.curveTo) {
        curve(args[j], args[j + 1], args[j + 2], args[j + 3], args[j + 4], args[j + 5]);
        j += 6;
      } else if (op === OPS.curveTo2) {
        // first control point = current point
        curve(cx, cy, args[j], args[j + 1], args[j + 2], args[j + 3]);
        j += 4;
      } else if (op === OPS.curveTo3) {
        // second control point = end point
        curve(args[j], args[j + 1], args[j + 2], args[j + 3], args[j + 2], args[j + 3]);
        j += 4;
      } else if (op === OPS.rectangle) {
        endRun(false, paint, width, layer);
        const x = args[j],
          y = args[j + 1],
          w = args[j + 2],
          h = args[j + 3];
        j += 4;
        addPt(x, y, true);
        addPt(x + w, y, true);
        addPt(x + w, y + h, true);
        addPt(x, y + h, true);
        addPt(x, y, true);
        endRun(true, paint, width, layer);
        cx = subStartX = x;
        cy = subStartY = y;
      } else if (op === OPS.closePath) {
        if (runStart >= 0) {
          addPt(subStartX, subStartY, true);
          endRun(true, paint, width, layer);
        }
        cx = subStartX;
        cy = subStartY;
      } else break;
    }
    finishPath(paint, width, layer);
  };

  const paintFor = (op) => {
    switch (op) {
      case OPS.stroke:
      case OPS.closeStroke:
        return { stroked: true, filled: false, close: op === OPS.closeStroke };
      case OPS.fill:
      case OPS.eoFill:
        return { stroked: false, filled: true, close: true };
      case OPS.fillStroke:
      case OPS.eoFillStroke:
        return { stroked: true, filled: true, close: false };
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
        return { stroked: true, filled: true, close: true };
      default:
        return null; // endPath (clip) or unknown → not linework
    }
  };

  const widthNow = (paint) =>
    paint.stroked ? Math.max(0, gs.lw) * Math.sqrt(Math.abs(gs.ctm[0] * gs.ctm[3] - gs.ctm[1] * gs.ctm[2])) : 0;

  const flushV4 = (op) => {
    const paint = paintFor(op);
    const list = pending;
    pending = [];
    if (!paint || annotDepth) return;
    const layer = currentLayer();
    const w = widthNow(paint);
    for (const p of list) emitV4(p.ops, p.args, p.ctm, paint, w, layer);
  };

  const N = fnArray.length;
  for (let k = 0; k < N; k++) {
    if (truncated) break;
    if (k % sliceOps === 0 && k) yield k / N;
    const fn = fnArray[k];
    const a = argsArray[k];
    switch (fn) {
      case OPS.save:
        stack.push(gs);
        break;
      case OPS.restore:
        gs = stack.pop() ?? gs;
        break;
      case OPS.transform:
        if (a && a.length === 6) gs = { ...gs, ctm: mul(gs.ctm, a) };
        break;
      case OPS.paintFormXObjectBegin: {
        stack.push(gs);
        const mtx = a?.[0];
        if (mtx && mtx.length === 6) gs = { ...gs, ctm: mul(gs.ctm, Array.from(mtx)) };
        break;
      }
      case OPS.paintFormXObjectEnd:
        gs = stack.pop() ?? gs;
        break;
      // Annotation appearance streams (markups, stamps, form fields) are skipped:
      // they're positioned by the annotation rect, not the page CTM, and are
      // rarely real linework. Request the operator list with
      // annotationMode: AnnotationMode.DISABLE to skip them at the source too.
      case OPS.beginAnnotation:
        annotDepth++;
        stack.push(gs);
        break;
      case OPS.endAnnotation:
        annotDepth = Math.max(0, annotDepth - 1);
        gs = stack.pop() ?? gs;
        break;
      case OPS.setLineWidth: {
        const w = Number(a?.[0]);
        if (Number.isFinite(w)) gs = { ...gs, lw: w };
        break;
      }
      case OPS.setDash:
        gs = { ...gs, dashed: isDashed(a) };
        break;
      case OPS.setGState:
        if (Array.isArray(a?.[0])) {
          for (const kv of a[0]) {
            if (!Array.isArray(kv)) continue;
            if (kv[0] === 'LW' && Number.isFinite(Number(kv[1]))) gs = { ...gs, lw: Number(kv[1]) };
            else if (kv[0] === 'D') gs = { ...gs, dashed: isDashed(Array.isArray(kv[1]) ? kv[1] : undefined) };
          }
        }
        break;
      case OPS.setFillRGBColor:
      case OPS.setFillGray:
      case OPS.setFillColor:
      case OPS.setFillCMYKColor:
        gs = { ...gs, whiteFill: fn === OPS.setFillRGBColor ? isWhite(a) : false };
        break;
      case OPS.setFillColorN:
        gs = { ...gs, whiteFill: false };
        break;
      case OPS.beginMarkedContent:
        ocStack.push(null);
        break;
      case OPS.beginMarkedContentProps:
        ocStack.push(a?.[0] === 'OC' ? ocKey(a[1]) : null);
        break;
      case OPS.endMarkedContent:
        ocStack.pop();
        break;
      case OPS.constructPath: {
        if (!a) break;
        if (typeof a[0] === 'number') {
          // pdf.js 5+: [paintOp, [Float32Array], minMax]
          const paint = paintFor(a[0]);
          if (!paint || annotDepth) break;
          const data = a[1]?.[0];
          if (data && data.length) emitV6(data, gs.ctm, paint, widthNow(paint), currentLayer());
        } else if (a[0]?.length) {
          // pdf.js 4.x: accumulate until the paint operator
          pending.push({ ops: a[0], args: a[1], ctm: gs.ctm });
        }
        break;
      }
      case OPS.stroke:
      case OPS.closeStroke:
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke:
      case OPS.closeFillStroke:
      case OPS.closeEOFillStroke:
      case OPS.endPath:
        if (pending.length) flushV4(fn);
        break;
      default:
        break;
    }
  }

  return {
    coords: coords.done(),
    ptFlags: ptFlags.done(),
    polyStart: polyStart.done(),
    polyLength: polyLength.done(),
    polyFlags: polyFlags.done(),
    polyWidth: polyWidth.done(),
    polyLayer: polyLayer.done(),
    polyBBox: polyBBox.done(),
    layers,
    truncated,
  };
}

/** Run the walker to completion synchronously (use inside a Worker). */
export function extractLinework(fnArray, argsArray, OPS, opt) {
  const it = walkOperatorList(fnArray, argsArray, OPS, opt);
  let r = it.next();
  while (!r.done) r = it.next();
  return r.value;
}

/**
 * Run the walker on the main thread without blocking it: yields to the event
 * loop whenever a slice has taken longer than `budgetMs`.
 * @param {AbortSignal} [signal]
 */
export async function extractLineworkAsync(fnArray, argsArray, OPS, opt = {}, signal) {
  const budget = opt.budgetMs ?? 8;
  const it = walkOperatorList(fnArray, argsArray, OPS, opt);
  let t0 = performance.now();
  let r = it.next();
  while (!r.done) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    if (performance.now() - t0 > budget) {
      await new Promise((res) => setTimeout(res, 0));
      t0 = performance.now();
    }
    r = it.next();
  }
  return r.value;
}

/**
 * Find circles (closed curved paths whose points all sit ~on a radius) and
 * return their centres — a "centre" snap for columns, piles, set-out points, etc.
 * @returns {Float64Array} [cx, cy, r, polyIndex, ...]
 */
export function findCircles(geom, relTol = 0.03) {
  const out = [];
  const { coords, polyStart, polyLength, polyFlags, polyBBox } = geom;
  for (let p = 0; p < polyStart.length; p++) {
    const f = polyFlags[p];
    if (!(f & POLY.CURVE) || !(f & POLY.CLOSED) || f & POLY.MASK) continue;
    const x0 = polyBBox[p * 4],
      y0 = polyBBox[p * 4 + 1],
      x1 = polyBBox[p * 4 + 2],
      y1 = polyBBox[p * 4 + 3];
    const w = x1 - x0,
      h = y1 - y0;
    if (w <= 0 || h <= 0 || Math.abs(w - h) > relTol * Math.max(w, h)) continue;
    const cx = (x0 + x1) / 2,
      cy = (y0 + y1) / 2,
      r = (w + h) / 4;
    let ok = true;
    const s = polyStart[p],
      n = polyLength[p];
    for (let i = 0; i < n && ok; i++) {
      const d = Math.hypot(coords[(s + i) * 2] - cx, coords[(s + i) * 2 + 1] - cy);
      if (Math.abs(d - r) > relTol * r + 1e-6) ok = false;
    }
    if (ok) out.push(cx, cy, r, p);
  }
  return Float64Array.from(out);
}
