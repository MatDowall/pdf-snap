/**
 * snapWorker.js — runs extraction + indexing off the main thread.
 *
 * Message in:  { id, fnArray, argsArray, OPS, opt }
 * Message out: { id, geom, grid, circles, ms }   (typed arrays are TRANSFERRED, not copied)
 *          or  { id, error }
 */
import { extractLinework, findCircles } from './extract.js';
import { buildSegmentGrid, defaultInclude } from './grid.js';

self.onmessage = (e) => {
  const { id, fnArray, argsArray, OPS, opt } = e.data;
  try {
    const t0 = performance.now();
    const geom = extractLinework(fnArray, argsArray, OPS, opt);
    const grid = buildSegmentGrid(geom, { ...opt, include: defaultInclude(geom, opt) });
    const circles = findCircles(geom);
    const ms = performance.now() - t0;
    const transfer = [
      ...Object.values(geom).filter(ArrayBuffer.isView).map((a) => a.buffer),
      ...Object.values(grid).filter(ArrayBuffer.isView).map((a) => a.buffer),
      circles.buffer,
    ];
    self.postMessage({ id, geom, grid, circles, ms }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String(err?.stack || err) });
  }
};
