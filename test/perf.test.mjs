// Synthetic big sheet: 250k random line segments + 20k circles-as-polylines-free → index + query timing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSegmentGrid } from '../src/grid.js';
import { SnapEngine } from '../src/snap.js';

test('250k segments: build index < 300 ms, query < 0.5 ms', () => {
  const N = 250000;
  const coords = new Float64Array(N * 4);
  const ptFlags = new Uint8Array(N * 2).fill(1);
  const polyStart = new Int32Array(N), polyLength = new Int32Array(N).fill(2);
  const polyFlags = new Uint8Array(N).fill(1), polyWidth = new Float32Array(N), polyLayer = new Int32Array(N).fill(-1);
  const polyBBox = new Float64Array(N * 4);
  let seed = 1;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < N; i++) {
    const x = rnd() * 2384, y = rnd() * 1684, a = rnd() * Math.PI, l = rnd() < 0.01 ? 800 : rnd() * 20;
    const x2 = x + Math.cos(a) * l, y2 = y + Math.sin(a) * l;
    coords.set([x, y, x2, y2], i * 4);
    polyStart[i] = i * 2;
    polyBBox.set([Math.min(x, x2), Math.min(y, y2), Math.max(x, x2), Math.max(y, y2)], i * 4);
  }
  const geom = { coords, ptFlags, polyStart, polyLength, polyFlags, polyWidth, polyLayer, polyBBox, layers: [] };
  let t0 = performance.now();
  const grid = buildSegmentGrid(geom);
  const build = performance.now() - t0;
  const eng = new SnapEngine(geom, grid);
  t0 = performance.now();
  for (let i = 0; i < 5000; i++) eng.snap(rnd() * 2384, rnd() * 1684, 4, { pxPerUnit: 2.5 });
  const q = (performance.now() - t0) / 5000;
  console.log(`# 250k segments: index ${build.toFixed(0)} ms, ${grid.nx}x${grid.ny} cells, ${grid.oversize.length} oversize, query ${q.toFixed(3)} ms`);
  assert.ok(build < 300);
  assert.ok(q < 0.5);
});
