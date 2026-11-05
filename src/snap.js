/**
 * snap.js — the snap query.
 *
 * Given a cursor position and a search radius (both in PDF units), return the
 * single best snap point, CAD-style.
 *
 * HOW THE WINNER IS PICKED (the part that makes snapping "feel" right)
 * --------------------------------------------------------------------
 * Every candidate gets a score in SCREEN PIXELS:
 *
 *     score = distanceFromCursor × pxPerUnit  −  bonus[kind]
 *
 * Lowest score wins. The bonus means "an endpoint 3 px further away still
 * beats a plain on-line point" — so you get the corner you were aiming for
 * instead of a point on the line just short of it — yet a much closer
 * candidate of a weaker kind still wins. Working in screen px makes the
 * behaviour identical at every zoom level.
 *
 * Kinds (strongest first, default bonuses in px):
 *   extra         your own points (existing markup vertices)       6
 *   endpoint      a real vertex of the linework (not curve flattening points) 4
 *   center        centre of a circle (piles, columns, set-out marks)          4
 *   intersection  where two different lines cross                             3
 *   midpoint      middle of a straight segment                                2
 *   perpendicular foot of the perpendicular from `from` (previous click)      1.5
 *   nearest       closest point on any line                                   0
 *
 * Intersections are O(n²) in nearby segments, so only the `maxIntersect`
 * segments nearest the cursor are tested pairwise (Nezo caps at 40).
 */

import { PT_VERTEX } from './extract.js';
import { querySegments } from './grid.js';

export const DEFAULT_BONUS = {
  extra: 6,
  endpoint: 4,
  center: 4,
  intersection: 3,
  midpoint: 2,
  perpendicular: 1.5,
  nearest: 0,
};

export class SnapEngine {
  /**
   * @param {object} geom     from extractLinework()
   * @param {object} grid     from buildSegmentGrid()
   * @param {Float64Array} [circles]  from findCircles()
   */
  constructor(geom, grid, circles = new Float64Array(0)) {
    this.geom = geom;
    this.grid = grid;
    this.circles = circles;
    this._seen = new Uint32Array(grid.segA.length);
    this._stamp = 0;
    this._cand = [];
  }

  get segmentCount() {
    return this.grid.segA.length;
  }

  /**
   * @param {number} x        cursor, PDF units
   * @param {number} y
   * @param {number} radius   search radius, PDF units (e.g. 10 px / zoom)
   * @param {object} [o]
   * @param {number} [o.pxPerUnit=1]  screen px per PDF unit (zoom) — scales scoring to screen px
   * @param {{x:number,y:number}} [o.from]  previous point → enables `perpendicular`
   * @param {Set<string>|string[]} [o.kinds] enabled kinds (default: all)
   * @param {Record<string,number>} [o.bonus] override bonuses
   * @param {(layerIndex:number)=>boolean} [o.layerVisible] filter by PDF layer (geom.layers[i] = OC ids)
   * @param {(polyIndex:number)=>boolean} [o.polyFilter] arbitrary per-polyline filter
   * @param {Float64Array|number[]} [o.extraPoints] your own snap points [x0,y0,x1,y1,…]
   * @param {number} [o.maxIntersect=48]
   * @returns {null | {x:number, y:number, kind:string, poly:number, seg:number, dist:number}}
   */
  snap(x, y, radius, o = {}) {
    const px = o.pxPerUnit ?? 1;
    const bonus = o.bonus ? { ...DEFAULT_BONUS, ...o.bonus } : DEFAULT_BONUS;
    const kinds = o.kinds ? new Set(o.kinds) : null;
    const on = (k) => !kinds || kinds.has(k);
    const { coords, ptFlags, polyLayer } = this.geom;
    const { segA, segPoly } = this.grid;
    const r2 = radius * radius;

    let best = null;
    let bestScore = Infinity;
    const consider = (cx, cy, kind, poly, seg) => {
      const dx = cx - x,
        dy = cy - y;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) return;
      const d = Math.sqrt(d2);
      const score = d * px - bonus[kind];
      if (score < bestScore) {
        bestScore = score;
        best = { x: cx, y: cy, kind, poly, seg, dist: d };
      }
    };

    // your own points first (cheap, usually few)
    if (o.extraPoints && on('extra')) {
      const e = o.extraPoints;
      for (let i = 0; i + 1 < e.length; i += 2) consider(e[i], e[i + 1], 'extra', -1, -1);
    }

    // circle centres
    if (on('center')) {
      const c = this.circles;
      for (let i = 0; i < c.length; i += 4) {
        if (Math.abs(c[i] - x) > radius || Math.abs(c[i + 1] - y) > radius) continue;
        const p = c[i + 3];
        if (o.layerVisible && polyLayer[p] >= 0 && !o.layerVisible(polyLayer[p])) continue;
        if (o.polyFilter && !o.polyFilter(p)) continue;
        consider(c[i], c[i + 1], 'center', p, -1);
      }
    }

    // nearby segments from the grid
    if (++this._stamp === 0xffffffff) {
      this._seen.fill(0);
      this._stamp = 1;
    }
    const cand = querySegments(this.grid, x, y, radius, this._cand, this._seen, this._stamp);

    // exact filter + distance (needed for intersection ranking)
    const near = [];
    for (const s of cand) {
      const p = segPoly[s];
      if (o.layerVisible && polyLayer[p] >= 0 && !o.layerVisible(polyLayer[p])) continue;
      if (o.polyFilter && !o.polyFilter(p)) continue;
      const i = segA[s] * 2;
      const ax = coords[i],
        ay = coords[i + 1],
        bx = coords[i + 2],
        by = coords[i + 3];
      // cheap bbox reject
      if (Math.min(ax, bx) - radius > x || Math.max(ax, bx) + radius < x) continue;
      if (Math.min(ay, by) - radius > y || Math.max(ay, by) + radius < y) continue;
      const f = closest(ax, ay, bx, by, x, y);
      const d2 = (f.x - x) ** 2 + (f.y - y) ** 2;
      if (d2 > r2) continue;
      near.push({ s, p, ax, ay, bx, by, d2, fx: f.x, fy: f.y });

      const pa = segA[s];
      const va = ptFlags[pa] & PT_VERTEX;
      const vb = ptFlags[pa + 1] & PT_VERTEX;
      if (on('endpoint')) {
        if (va) consider(ax, ay, 'endpoint', p, s);
        if (vb) consider(bx, by, 'endpoint', p, s);
      }
      // midpoints only make sense on straight segments (both ends real vertices)
      if (on('midpoint') && va && vb) consider((ax + bx) / 2, (ay + by) / 2, 'midpoint', p, s);
      if (on('perpendicular') && o.from) {
        const t = projT(ax, ay, bx, by, o.from.x, o.from.y);
        if (t > 1e-6 && t < 1 - 1e-6) consider(ax + t * (bx - ax), ay + t * (by - ay), 'perpendicular', p, s);
      }
      if (on('nearest')) consider(f.x, f.y, 'nearest', p, s);
    }

    // intersections between the closest few segments of DIFFERENT polylines
    if (on('intersection') && near.length > 1) {
      const max = o.maxIntersect ?? 48;
      if (near.length > max) near.sort((a, b) => a.d2 - b.d2).length = max;
      for (let i = 0; i < near.length; i++) {
        const A = near[i];
        for (let j = i + 1; j < near.length; j++) {
          const B = near[j];
          // adjacent segments of one polyline always "intersect" at their shared vertex — skip
          if (A.p === B.p && Math.abs(segA[A.s] - segA[B.s]) <= 1) continue;
          const q = intersect(A.ax, A.ay, A.bx, A.by, B.ax, B.ay, B.bx, B.by);
          if (q) consider(q.x, q.y, 'intersection', A.p, A.s);
        }
      }
    }
    return best;
  }

  /**
   * Hit-test: the polyline nearest the cursor within radius (for "pick a line",
   * auto-trace, or highlighting what you're about to snap to).
   */
  pickPolyline(x, y, radius, o = {}) {
    const r = this.snap(x, y, radius, { ...o, kinds: ['nearest'] });
    return r ? r.poly : -1;
  }

  /** Points of polyline p as [x0,y0,x1,y1,…] (PDF units). */
  polylinePoints(p) {
    const { coords, polyStart, polyLength } = this.geom;
    return coords.subarray(polyStart[p] * 2, (polyStart[p] + polyLength[p]) * 2);
  }
}

// ---------------------------------------------------------------- geometry

function projT(ax, ay, bx, by, px, py) {
  const dx = bx - ax,
    dy = by - ay;
  const L = dx * dx + dy * dy;
  return L === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / L;
}

function closest(ax, ay, bx, by, px, py) {
  let t = projT(ax, ay, bx, by, px, py);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return { x: ax + t * (bx - ax), y: ay + t * (by - ay) };
}

/** Proper segment–segment intersection (excluding parallel/collinear). */
function intersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const rX = bx - ax,
    rY = by - ay,
    sX = dx - cx,
    sY = dy - cy;
  const den = rX * sY - rY * sX;
  if (Math.abs(den) < 1e-12 * (Math.abs(rX * sY) + Math.abs(rY * sX) + 1e-300)) return null;
  const t = ((cx - ax) * sY - (cy - ay) * sX) / den;
  const u = ((cx - ax) * rY - (cy - ay) * rX) / den;
  const e = 1e-9;
  if (t < -e || t > 1 + e || u < -e || u > 1 + e) return null;
  return { x: ax + t * rX, y: ay + t * rY };
}

/**
 * Constrain p to angles from `from` in steps of `stepDeg` (90 = ortho, 45 = ortho + diagonals).
 * Do this BEFORE snapping if you want "ortho then snap along that ray", or after to lock direction.
 */
export function constrainAngle(from, p, stepDeg = 90) {
  const dx = p.x - from.x,
    dy = p.y - from.y;
  const len = Math.hypot(dx, dy);
  if (!len) return { ...p };
  const step = (stepDeg * Math.PI) / 180;
  const a = Math.round(Math.atan2(dy, dx) / step) * step;
  // project onto the ray (keeps the distance along the chosen direction)
  const ux = Math.cos(a),
    uy = Math.sin(a);
  const t = dx * ux + dy * uy;
  return { x: from.x + ux * t, y: from.y + uy * t };
}
