/**
 * loader.js — get a ready-to-query SnapEngine for a PDF.js page.
 *
 *   const engine = await loadSnapEngine(page, pdfjsLib.OPS);
 *   const hit = engine.snap(x, y, radius, { pxPerUnit: zoom });
 *
 * Pipeline:
 *   1. page.getOperatorList()   — parsing happens in PDF.js's own worker. Annotations
 *                                 are disabled so markups/stamps aren't snapped to.
 *   2. pre-filter ops           — keep only the ~30 op types we interpret, so we post
 *                                 far less data to our worker (text/images are dropped).
 *   3. extract + index          — in our Worker (snapWorker.js) when available,
 *                                 otherwise time-sliced on the main thread (never blocks
 *                                 the UI for more than ~8 ms at a time).
 *
 * Results are cached per page object (WeakMap) — call as often as you like.
 */
import { extractLineworkAsync, findCircles } from './extract.js';
import { buildSegmentGrid, defaultInclude } from './grid.js';
import { SnapEngine } from './snap.js';

const cache = new WeakMap();

const KEEP = [
  'save', 'restore', 'transform', 'paintFormXObjectBegin', 'paintFormXObjectEnd',
  'beginAnnotation', 'endAnnotation', 'setLineWidth', 'setDash', 'setGState',
  'setFillRGBColor', 'setFillGray', 'setFillColor', 'setFillCMYKColor', 'setFillColorN',
  'beginMarkedContent', 'beginMarkedContentProps', 'endMarkedContent', 'constructPath',
  'stroke', 'closeStroke', 'fill', 'eoFill', 'fillStroke', 'eoFillStroke',
  'closeFillStroke', 'closeEOFillStroke', 'endPath',
];

function prefilter(ol, OPS) {
  const keep = new Set(KEEP.map((k) => OPS[k]).filter((v) => v !== undefined));
  const fn = [];
  const args = [];
  for (let i = 0; i < ol.fnArray.length; i++) {
    const f = ol.fnArray[i];
    if (!keep.has(f)) continue;
    fn.push(f);
    let a = ol.argsArray[i];
    // setGState can carry fonts/soft masks — only LW and D matter to us
    if (f === OPS.setGState && Array.isArray(a?.[0])) a = [a[0].filter((kv) => kv?.[0] === 'LW' || kv?.[0] === 'D')];
    args.push(a);
  }
  return { fnArray: Int32Array.from(fn), argsArray: args };
}

let worker = null;
let workerBroken = false;
let seq = 0;
const waiting = new Map();

function getWorker() {
  if (worker || workerBroken || typeof Worker === 'undefined') return worker;
  try {
    worker = new Worker(new URL('./snapWorker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      if (!w) return;
      waiting.delete(e.data.id);
      e.data.error ? w.reject(new Error(e.data.error)) : w.resolve(e.data);
    };
    worker.onerror = (e) => {
      // e.g. bundler/CSP doesn't allow module workers → fall back to main thread
      workerBroken = true;
      worker = null;
      for (const w of waiting.values()) w.reject(new Error('worker failed: ' + (e.message || 'unknown')));
      waiting.clear();
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

async function inWorker(data, opt) {
  const w = getWorker();
  if (!w) throw new Error('no worker');
  const id = ++seq;
  const OPS = { ...data.OPS };
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage({ id, fnArray: data.fnArray, argsArray: data.argsArray, OPS, opt }, [data.fnArray.buffer]);
  });
}

/**
 * @param {import('pdfjs-dist').PDFPageProxy} page
 * @param {Record<string,number>} OPS   pdfjsLib.OPS
 * @param {object} [opt]  extraction/index options (curveTolerance, minPathSize, includeFills, includeMasks, …)
 *                        plus useWorker (default true), annotationMode (default 0 = DISABLE)
 * @returns {Promise<SnapEngine & {stats:object}>}
 */
export function loadSnapEngine(page, OPS, opt = {}) {
  let p = cache.get(page);
  if (p) return p;
  p = (async () => {
    const t0 = performance.now();
    const ol = await page.getOperatorList({ annotationMode: opt.annotationMode ?? 0 });
    const t1 = performance.now();
    const data = { ...prefilter(ol, OPS), OPS };
    const { useWorker = true, annotationMode, ...xopt } = opt;
    let res;
    let where = 'worker';
    if (useWorker) {
      try {
        res = await inWorker({ ...data, fnArray: data.fnArray.slice() }, xopt);
      } catch {
        res = null;
      }
    }
    if (!res) {
      where = 'main';
      const geom = await extractLineworkAsync(data.fnArray, data.argsArray, OPS, xopt);
      const grid = buildSegmentGrid(geom, { ...xopt, include: defaultInclude(geom, xopt) });
      res = { geom, grid, circles: findCircles(geom) };
    }
    const engine = new SnapEngine(res.geom, res.grid, res.circles);
    engine.stats = {
      ops: ol.fnArray.length,
      polylines: res.geom.polyStart.length,
      segments: res.grid.segA.length,
      circles: res.circles.length / 4,
      layers: res.geom.layers.length,
      truncated: res.geom.truncated,
      operatorListMs: Math.round(t1 - t0),
      extractMs: Math.round(performance.now() - t1),
      where,
    };
    return engine;
  })();
  cache.set(page, p);
  p.catch(() => cache.delete(page));
  return p;
}
