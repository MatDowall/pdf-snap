// Run: npm test   (set PDFJS=/path/to/pdfjs-dist/legacy/build/pdf.mjs to test another PDF.js version)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractLinework, findCircles, POLY } from '../src/extract.js';
import { buildSegmentGrid, defaultInclude } from '../src/grid.js';
import { SnapEngine, constrainAngle } from '../src/snap.js';

const pdfjsPath = process.env.PDFJS || new URL('../node_modules/pdfjs-dist/legacy/build/pdf.mjs', import.meta.url).href;
const pdfjs = await import(pdfjsPath);
const data = new Uint8Array(readFileSync(new URL('./fixtures/snap-test.pdf', import.meta.url)));
const doc = await pdfjs.getDocument({ data, verbosity: 0 }).promise;
const page = await doc.getPage(1);
const ol = await page.getOperatorList({ annotationMode: 0 });
const geom = extractLinework(ol.fnArray, ol.argsArray, pdfjs.OPS);
const grid = buildSegmentGrid(geom, { include: defaultInclude(geom) });
const eng = new SnapEngine(geom, grid, findCircles(geom));
console.log(`# pdf.js ${pdfjs.version}: ${geom.polyStart.length} polylines, ${grid.segA.length} segments`);

const near = (h, x, y, eps = 1e-6) => h && Math.abs(h.x - x) < eps && Math.abs(h.y - y) < eps;
const snap = (x, y, o) => eng.snap(x, y, 10, { pxPerUnit: 1, ...o });

test('intersection of two separate lines', () => {
  const h = snap(102, 97);
  assert.equal(h.kind, 'intersection');
  assert.ok(near(h, 100, 100), JSON.stringify(h));
});

test('endpoint wins over nearby on-line point', () => {
  const h = snap(147, 102);
  assert.equal(h.kind, 'endpoint');
  assert.ok(near(h, 150, 100));
});

test('nested transforms (cm inside cm) are applied', () => {
  const h = snap(301, 102);
  assert.equal(h.kind, 'endpoint');
  assert.ok(near(h, 300, 100), JSON.stringify(h));
});

test('rectangle: corner endpoint and edge midpoint', () => {
  assert.ok(near(snap(449, 151), 450, 150));
  const m = snap(401, 52);
  assert.equal(m.kind, 'midpoint');
  assert.ok(near(m, 400, 50));
});

test('curve: endpoints only at true ends, not at flattening points', () => {
  // point on the arc near its top — should be "nearest", never "endpoint"
  const h = snap(550, 123, { kinds: ['endpoint'] });
  assert.equal(h, null, 'no endpoint should exist mid-curve: ' + JSON.stringify(h));
  assert.ok(near(snap(598, 52), 600, 50));
  assert.equal(snap(550, 123).kind, 'nearest');
});

test('clipping paths are not snappable', () => {
  // corner of the clip rect at (10,10) — must not snap
  assert.equal(snap(10, 10), null);
});

test('form XObject /Matrix applied', () => {
  const h = snap(898, 101);
  assert.equal(h.kind, 'endpoint');
  assert.ok(near(h, 900, 100), JSON.stringify(h));
});

test('dashed lines flagged', () => {
  const h = snap(950, 148);
  assert.ok(near(h, 950, 150));
  assert.ok(geom.polyFlags[h.poly] & POLY.DASH);
});

test('optional content layer recorded and filterable', () => {
  const h = snap(248, 301);
  assert.ok(near(h, 250, 300));
  const L = geom.polyLayer[h.poly];
  assert.ok(L >= 0 && geom.layers[L].length === 1, JSON.stringify(geom.layers));
  assert.equal(snap(248, 301, { layerVisible: () => false }), null);
});

test('filled polygon edges snappable; white masks excluded', () => {
  assert.ok(near(snap(399, 302), 400, 300)); // hatch triangle corner
  assert.equal(snap(452, 282), null); // white wipeout rect corner at 450,280
});

test('perpendicular from a previous point', () => {
  const h = snap(120, 100, { from: { x: 120, y: 30 }, kinds: ['perpendicular'] });
  assert.equal(h.kind, 'perpendicular');
  assert.ok(near(h, 120, 100));
});

test('extra points (own markups) win', () => {
  const h = snap(101, 99, { extraPoints: [103, 99] });
  assert.equal(h.kind, 'extra');
});

test('circle centre snap', () => {
  const h = snap(703, 296);
  assert.equal(h.kind, 'center');
  assert.ok(near(h, 700, 300, 1e-3), JSON.stringify(h));
});

test('ortho constraint', () => {
  const p = constrainAngle({ x: 0, y: 0 }, { x: 10, y: 1 }, 90);
  assert.ok(Math.abs(p.y) < 1e-12 && Math.abs(p.x - 10) < 1e-12);
});

test('dense area query is fast', () => {
  const t0 = performance.now();
  let hits = 0;
  for (let i = 0; i < 5000; i++) if (snap(50 + Math.random() * 1080, 420 + Math.random() * 390)) hits++;
  const per = (performance.now() - t0) / 5000;
  console.log(`# dense queries: ${per.toFixed(3)} ms each, ${hits} hits`);
  assert.ok(per < 1, `${per} ms per query`);
});
