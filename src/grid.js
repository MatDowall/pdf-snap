/**
 * grid.js — uniform-grid spatial index over line SEGMENTS.
 *
 * Why a uniform grid (not an R-tree / k-d tree)?
 *  - Drawing linework is spread fairly evenly over a sheet, which is the
 *    case where a grid beats trees: O(1) cell lookup, no tree walking.
 *  - It's built in one pass into two flat Int32Arrays (CSR layout), so it's
 *    tiny, fast to build (~tens of ms for 1M segments) and transferable
 *    between a Worker and the main thread with zero copying.
 *  - Queries touch only the few cells around the cursor.
 *
 * Long segments (borders, grid lines, long walls) would be copied into
 * hundreds of cells; instead they go into a small `oversize` list that every
 * query checks directly. (Same trick Nezo uses.)
 *
 * Layout:
 *   segA[s]      index of the segment's first POINT (second point = segA[s] + 1)
 *   segPoly[s]   polyline the segment belongs to
 *   cellStart[c] .. cellStart[c+1]  → range in cellItems of segment ids in cell c
 */

import { POLY } from './extract.js';

/**
 * @param {ReturnType<import('./extract.js').extractLinework>} geom
 * @param {object} [opt]
 * @param {number} [opt.segsPerCell=4]     target average density
 * @param {number} [opt.maxCellsPerSeg=32] segments spanning more cells go to `oversize`
 * @param {number} [opt.maxDim=2048]       max cells along one axis
 * @param {(polyIndex:number)=>boolean} [opt.include]  filter polylines at build time
 */
export function buildSegmentGrid(geom, opt = {}) {
  const { coords, polyStart, polyLength, polyBBox } = geom;
  const segsPerCell = opt.segsPerCell ?? 4;
  const maxCellsPerSeg = opt.maxCellsPerSeg ?? 32;
  const maxDim = opt.maxDim ?? 2048;
  const include = opt.include ?? (() => true);

  // 1. enumerate segments + overall bounds
  let nSeg = 0;
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (let p = 0; p < polyStart.length; p++) {
    if (polyLength[p] < 2 || !include(p)) continue;
    nSeg += polyLength[p] - 1;
    minX = Math.min(minX, polyBBox[p * 4]);
    minY = Math.min(minY, polyBBox[p * 4 + 1]);
    maxX = Math.max(maxX, polyBBox[p * 4 + 2]);
    maxY = Math.max(maxY, polyBBox[p * 4 + 3]);
  }
  const segA = new Int32Array(nSeg);
  const segPoly = new Int32Array(nSeg);
  let s = 0;
  for (let p = 0; p < polyStart.length; p++) {
    if (polyLength[p] < 2 || !include(p)) continue;
    for (let i = 0; i + 1 < polyLength[p]; i++) {
      segA[s] = polyStart[p] + i;
      segPoly[s] = p;
      s++;
    }
  }
  if (!nSeg) {
    return { segA, segPoly, cellStart: new Int32Array(2), cellItems: new Int32Array(0), oversize: new Int32Array(0), minX: 0, minY: 0, cell: 1, nx: 1, ny: 1 };
  }

  // 2. choose cell size for ~segsPerCell segments per cell
  const w = Math.max(maxX - minX, 1e-6);
  const h = Math.max(maxY - minY, 1e-6);
  const targetCells = Math.max(1, nSeg / segsPerCell);
  let cell = Math.sqrt((w * h) / targetCells);
  cell = Math.max(cell, Math.max(w, h) / maxDim);
  const nx = Math.max(1, Math.ceil(w / cell));
  const ny = Math.max(1, Math.ceil(h / cell));

  const cellRange = (sIdx, out) => {
    const i = segA[sIdx] * 2;
    const x0 = coords[i],
      y0 = coords[i + 1],
      x1 = coords[i + 2],
      y1 = coords[i + 3];
    out[0] = Math.min(nx - 1, Math.max(0, Math.floor((Math.min(x0, x1) - minX) / cell)));
    out[1] = Math.min(ny - 1, Math.max(0, Math.floor((Math.min(y0, y1) - minY) / cell)));
    out[2] = Math.min(nx - 1, Math.max(0, Math.floor((Math.max(x0, x1) - minX) / cell)));
    out[3] = Math.min(ny - 1, Math.max(0, Math.floor((Math.max(y0, y1) - minY) / cell)));
  };

  // 3. two-pass CSR build: count, prefix-sum, fill
  const counts = new Int32Array(nx * ny + 1);
  const r = [0, 0, 0, 0];
  const big = [];
  const isBig = new Uint8Array(nSeg);
  for (let k = 0; k < nSeg; k++) {
    cellRange(k, r);
    const cells = (r[2] - r[0] + 1) * (r[3] - r[1] + 1);
    if (cells > maxCellsPerSeg) {
      isBig[k] = 1;
      big.push(k);
      continue;
    }
    for (let cy = r[1]; cy <= r[3]; cy++) for (let cx = r[0]; cx <= r[2]; cx++) counts[cy * nx + cx + 1]++;
  }
  for (let c = 1; c <= nx * ny; c++) counts[c] += counts[c - 1];
  const cellStart = counts;
  const cellItems = new Int32Array(cellStart[nx * ny]);
  const fill = cellStart.slice(0, nx * ny);
  for (let k = 0; k < nSeg; k++) {
    if (isBig[k]) continue;
    cellRange(k, r);
    for (let cy = r[1]; cy <= r[3]; cy++) for (let cx = r[0]; cx <= r[2]; cx++) cellItems[fill[cy * nx + cx]++] = k;
  }
  return { segA, segPoly, cellStart, cellItems, oversize: Int32Array.from(big), minX, minY, cell, nx, ny };
}

/**
 * Segment ids whose cells intersect the square (x±r, y±r). May contain
 * segments that are slightly outside — callers do the exact distance test.
 * `seen` is a reusable Uint32Array stamp buffer (avoids allocating a Set per query).
 */
export function querySegments(grid, x, y, r, out, seen, stamp) {
  out.length = 0;
  const { cell, minX, minY, nx, ny, cellStart, cellItems, oversize } = grid;
  const cx0 = Math.max(0, Math.floor((x - r - minX) / cell));
  const cx1 = Math.min(nx - 1, Math.floor((x + r - minX) / cell));
  const cy0 = Math.max(0, Math.floor((y - r - minY) / cell));
  const cy1 = Math.min(ny - 1, Math.floor((y + r - minY) / cell));
  for (let cy = cy0; cy <= cy1; cy++) {
    for (let cx = cx0; cx <= cx1; cx++) {
      const c = cy * nx + cx;
      for (let k = cellStart[c]; k < cellStart[c + 1]; k++) {
        const sId = cellItems[k];
        if (seen[sId] !== stamp) {
          seen[sId] = stamp;
          out.push(sId);
        }
      }
    }
  }
  for (let k = 0; k < oversize.length; k++) {
    const sId = oversize[k];
    if (seen[sId] !== stamp) {
      seen[sId] = stamp;
      out.push(sId);
    }
  }
  return out;
}

/** Default build-time filter: real linework only (stroked, or filled non-white). */
export function defaultInclude(geom, { includeFills = true, includeMasks = false } = {}) {
  return (p) => {
    const f = geom.polyFlags[p];
    if (f & POLY.MASK) return includeMasks;
    if (!(f & POLY.STROKE)) return includeFills;
    return true;
  };
}
