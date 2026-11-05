# pdf-snap

CAD-style snapping to the **vector linework inside a PDF**, for on-screen takeoff. Built on PDF.js and designed to pair with [`pdf-viewport`](https://github.com/MatDowall/pdf-viewport).

- Snaps to **endpoint □, intersection ✕, midpoint △, circle centre ○, perpendicular ⊾, nearest ⧗**, plus your own markup points ◇
- **Exact**: snap points are the PDF's real coordinates, not pixel guesses. A 50 pt line measures exactly 50 pt.
- **Fast**: extraction and indexing run in a Web Worker (about 75 ms for 9k paths). A snap query takes **~0.02 ms**, and **~0.2 ms** on a 250k-segment sheet.
- Handles what breaks naive extractors: nested transforms, form XObjects (blocks/xrefs), clipping paths, curves, dashes, fills, white wipeouts, and **PDF layers** (optional content).
- Works with `pdfjs-dist` **4.x and 5.x/6.x**, whose operator formats differ. Both are tested.

The approach is the same one Nezo uses, found by reading its shipped code, with a few improvements (see *What's different from Nezo*).

---

## Quick start (with pdf-viewport)

```js
import * as pdfjsLib from 'pdfjs-dist';
import { PdfViewport } from 'pdf-viewport';
import { PdfSnapper } from 'pdf-snap';

const vp = new PdfViewport(el, { panButtons: [1] });            // left click = tools
const snapper = new PdfSnapper(vp, { OPS: pdfjsLib.OPS, radiusPx: 12 });

await vp.setPage(page);
await snapper.setPage(page);           // extracts linework (worker), cached per page

el.addEventListener('pointermove', (e) => {
  const hit = snapper.snapClient(e.clientX, e.clientY, { from: lastPagePoint });
  // hit → { kind, page: {x,y}, pdf: {x,y}, poly }   (or null; marker is drawn for you)
});
```

**Store measurements as `hit.pdf`** (PDF units). They survive rotation, zoom and re-opening. Draw with `vp.pdfToPage()`.

**Demo:** clone [pdf-viewport](https://github.com/MatDowall/pdf-viewport) and this repo side by side in one folder. Run `npx.cmd serve .` in that **parent** folder and open `/pdf-snap/demo/`. It has a polyline measure tool with drawing scale, snap toggles, a PDF layer list, ortho on Shift, and F3 to toggle snapping.

### Without pdf-viewport

The core has no DOM dependency:

```js
import { loadSnapEngine } from 'pdf-snap';
const engine = await loadSnapEngine(page, pdfjsLib.OPS);
const hit = engine.snap(x, y, radiusInPdfUnits, { pxPerUnit: zoom, from: prevPoint });
```

Or the individual steps (e.g. in your own worker, or in Node):

```js
import { extractLinework, buildSegmentGrid, defaultInclude, findCircles, SnapEngine } from 'pdf-snap';
const ol    = await page.getOperatorList({ annotationMode: pdfjsLib.AnnotationMode.DISABLE });
const geom  = extractLinework(ol.fnArray, ol.argsArray, pdfjsLib.OPS);
const grid  = buildSegmentGrid(geom, { include: defaultInclude(geom) });
const engine = new SnapEngine(geom, grid, findCircles(geom));
```

---

## How it works

```
 page.getOperatorList()          PDF.js parses the page in ITS worker → list of drawing commands
        │  prefilter (~30 op types; text/images dropped)
        ▼
 snapWorker.js ─ extractLinework  interpret commands like a renderer → polylines in PDF space
               ─ buildSegmentGrid uniform grid over segments (flat Int32Arrays)
               ─ findCircles      closed curves that sit on a radius → centre points
        │  typed arrays TRANSFERRED back (zero copy)
        ▼
 SnapEngine.snap(x, y, r)         grid lookup → candidates → score in screen px → best point
```

### 1. Extract from the operator list, not the pixels

`page.getOperatorList()` gives the exact commands the renderer runs, already parsed. `extract.js` steps through them while tracking graphics state, and records geometry instead of drawing:

| PDF construct | Why it matters | Handling |
|---|---|---|
| `q` / `Q` / `cm` | Blocks, title blocks and viewports are drawn under transforms | CTM stack; every point is transformed into page space |
| Form XObjects (`Do`) | CAD xrefs and blocks are usually forms with their own `/Matrix` | `paintFormXObjectBegin` pushes state and applies the matrix |
| Clipping (`W n`) | Every viewport or clip rectangle would otherwise become a snap target | Only paths **painted** by stroke/fill are kept. `endPath` is discarded. |
| Curves | Flattened into segments for distance tests | Only the curve's real ends are vertices. Flattening points never give endpoint/midpoint snaps. |
| Line width, dashes | Useful for filtering (e.g. ignore dashed hidden lines) | `polyWidth` (× CTM scale), `POLY.DASH` flag |
| White fills | Wipeouts and masks aren't real linework | `POLY.MASK`, excluded by default |
| Optional content | Turn off snapping to e.g. the Electrical layer | `BDC /OC … EMC` stack → `polyLayer` → `geom.layers` |
| Annotations | Markups and stamps sit in annotation space | Skipped (`annotationMode: DISABLE`) |

**PDF.js version difference.** In 4.x, `constructPath` collects subpaths and a **separate** paint op follows. In 5.x+, the paint op is **inside** `constructPath` (`[paintOp, [Float32Array], minMax]`) and the path data uses DrawOPS codes. The extractor detects which format it's given. Nezo is on 4.7; the test suite runs on both 4.7.76 and 6.5.438.

### 2. Pack into typed arrays

```
coords     Float64Array  x0,y0,x1,y1,…      all points, PDF units
ptFlags    Uint8Array    PT_VERTEX per point (0 = curve-flattening point)
polyStart / polyLength   Int32Array          polyline → point range
polyFlags  Uint8Array    STROKE FILL CLOSED CURVE DASH MASK
polyWidth  Float32Array  stroke width in PDF units
polyLayer  Int32Array    index into geom.layers (array of OC ids), -1 = none
polyBBox   Float64Array  x0,y0,x1,y1 per polyline
```

A sheet with hundreds of thousands of paths fits in a few MB, and the arrays transfer between the worker and the page without copying.

### 3. Uniform grid index

Linework is spread fairly evenly over a sheet, so a uniform grid beats a tree: finding a cell is direct arithmetic, and there's no tree to walk. Cell size targets about 4 segments per cell. The grid is stored as two flat arrays (`cellStart`, `cellItems`). **Long segments** (borders, grid lines, long walls) would fill hundreds of cells, so they go in a small `oversize` list that every query checks. 250k segments index in about 75 ms.

### 4. Scoring: why it feels right

Each candidate gets a score in **screen pixels**:

```
score = distance × zoom − bonus[kind]       (lowest wins)
bonus: extra 6 · endpoint 4 · centre 4 · intersection 3 · midpoint 2 · perpendicular 1.5 · nearest 0
```

So a corner 3 px further away still beats the line just short of it, but a much closer weaker candidate still wins. Working in screen px makes the behaviour the same at every zoom. The radius is `radiusPx / zoom` for the same reason. Intersections are tested pairwise between only the ~48 segments nearest the cursor, and segments of one polyline that share a vertex are skipped.

Tune with `snap(..., { bonus: { midpoint: 0.5 } })`. Restrict kinds with `kinds: ['endpoint','intersection']`.

### What's different from Nezo

- **PDF.js 5+/6 format support.** Nezo's walker only reads the 4.x format.
- **Real perpendicular snap** (foot of the perpendicular from your previous point). Nezo's "perpendicular" is actually the nearest point.
- **Circle centre snap**, for piles, columns and set-out points.
- Intersections are tested among the **nearest** 48 segments. Nezo skips intersections entirely once more than 40 segments are nearby, which loses them in dense areas.
- Shapes that end at their start without `h` count as closed. CAD exports do this constantly.
- A time-sliced main-thread fallback if module workers aren't available (CSP, old bundler).

---

## API

**`new PdfSnapper(viewer, { OPS, radiusPx=10, kinds, color, showMarker=true, engine })`**
- `await setPage(page)` → stats `{ polylines, segments, circles, layers, operatorListMs, extractMs, where }`
- `snapClient(clientX, clientY, { from?, kinds? })` / `snapScreen(sx, sy, …)` → `{ kind, page, pdf, poly } | null`. `from` is in page units.
- `enabled`, `hiddenOc: Set<ocId>` (layer filter), `extraPoints: number[]` (your points, PDF units), `clearMarker()`, `destroy()`

**`loadSnapEngine(page, OPS, opt)`**: cached per page. `opt`: `useWorker` (true), `curveTolerance` (0.5), `minPathSize` (0.05), `includeFills` (true), `includeMasks` (false), `maxPoints` (4e6), `segsPerCell` (4).

**`SnapEngine`**
- `snap(x, y, radius, { pxPerUnit, from, kinds, bonus, layerVisible, polyFilter, extraPoints, maxIntersect })`
- `pickPolyline(x, y, radius)` → polyline index (for hover-highlight or "click a wall to measure it")
- `polylinePoints(p)` → `Float64Array` of that polyline's points

**`constrainAngle(from, p, stepDeg=90)`**: ortho (90) or ortho + diagonals (45).

### Layer names

`geom.layers[i]` is an array of OC ids. To get display names:

```js
const cfg = await doc.getOptionalContentConfig();
cfg.getGroup(id)?.name   // e.g. "Electrical"
```

To hide a layer visually as well, call `cfg.setVisibility(id, false)` then `vp.invalidate({ optionalContentConfigPromise: Promise.resolve(cfg) })`.

---

## Gotchas on real drawings

- **Scanned or raster sheets have no linework.** `stats.segments === 0`; tell the user snapping is unavailable.
- **SHX / exploded text** from AutoCAD is drawn as tiny strokes and becomes snap noise. Filter with `polyFilter: (p) => bboxSize(p) > 2` or by line width (text is often the thinnest pen).
- **Hatching** drawn as strokes produces many nearby lines. Turn its layer off, or filter `polyWidth` / `POLY.DASH`.
- **Duplicate lines** (CAD often draws twice) are harmless: same point, same score.
- **Huge sheets:** `maxPoints` (4M) caps memory, and `stats.truncated` tells you when it was hit.
- **Rotation:** everything is in PDF space, so rotated views just work through `pageToPdf` / `pdfToPage`.

## Tests

```
npm test               # Node: extraction + snapping on test/fixtures/snap-test.pdf, 250k-segment perf
PDFJS=…/pdfjs-dist@4/legacy/build/pdf.mjs npm run test:pdfjs4   # same suite on pdf.js 4.x
npm run test:browser   # headless Chrome: worker, snapping through PdfViewport, measure tool, marker
node test/makeFixture.mjs   # regenerate the fixture (each tricky case at a known coordinate)
```

Results: 16/16 (pdf.js 6.5), 15/15 (4.7), 10/10 browser checks. Query cost is 0.02 ms on the fixture and 0.18 ms on 250k random segments, and index build is 76 ms for 250k.

## Files

```
src/extract.js      operator-list walker → packed geometry; circle finder
src/grid.js         uniform-grid segment index
src/snap.js         SnapEngine (scoring, kinds), constrainAngle
src/loader.js       getOperatorList → prefilter → worker (or time-sliced fallback), per-page cache
src/snapWorker.js   the worker
src/PdfSnapper.js   viewer glue + CAD markers
demo/index.html     measure tool demo (needs ../pdf-viewport)
```
