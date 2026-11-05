/**
 * PdfSnapper — glue between a SnapEngine and a viewer (pdf-viewport's PdfViewport,
 * or anything with the same five members). Handles coordinate conversion,
 * zoom-correct radius, and draws the CAD-style snap marker.
 *
 *   const snapper = new PdfSnapper(viewport, { OPS: pdfjsLib.OPS });
 *   await snapper.setPage(page);                      // after viewport.setPage(page)
 *   viewerEl.onpointermove = (e) => {
 *     const hit = snapper.snapClient(e.clientX, e.clientY, { from: lastPoint });
 *     // hit.page = {x,y} page units, hit.pdf = {x,y} PDF units, hit.kind
 *   };
 *
 * Viewer interface used:
 *   view {zoom}, screenToPage(sx,sy), pageToPdf(x,y), pdfToPage(x,y),
 *   overlayGroup (SVG <g> in page units), container (element), addEventListener('viewchange')
 */
import { loadSnapEngine } from './loader.js';

const SVG = 'http://www.w3.org/2000/svg';

export class PdfSnapper {
  /**
   * @param {object} viewer   PdfViewport (or compatible)
   * @param {object} o
   * @param {Record<string,number>} o.OPS          pdfjsLib.OPS (required)
   * @param {number} [o.radiusPx=10]               aperture in screen px
   * @param {string[]} [o.kinds]                   enabled snap kinds (default all)
   * @param {string} [o.color='#ff8a00']
   * @param {boolean} [o.showMarker=true]
   * @param {object} [o.engine]                    options passed to loadSnapEngine
   */
  constructor(viewer, o) {
    if (!o?.OPS) throw new Error('PdfSnapper needs { OPS: pdfjsLib.OPS }');
    this.viewer = viewer;
    this.opts = { radiusPx: 10, color: '#ff8a00', showMarker: true, ...o };
    this.engine = null;
    this.enabled = true;
    /** hidden PDF layers, by OC id (see engine.geom.layers) */
    this.hiddenOc = new Set();
    /** your own snap points in PDF units (e.g. vertices of existing measurements) */
    this.extraPoints = [];
    this._last = null;
    this._marker = document.createElementNS(SVG, 'g');
    this._marker.setAttribute('pointer-events', 'none');
    viewer.overlayGroup.appendChild(this._marker);
    this._onView = () => this._drawMarker();
    viewer.addEventListener('viewchange', this._onView);
  }

  /** Load (or fetch from cache) the linework for `page`. Snapping returns null until ready. */
  async setPage(page) {
    this.engine = null;
    this.clearMarker();
    this._page = page;
    const engine = await loadSnapEngine(page, this.opts.OPS, this.opts.engine);
    if (this._page === page) this.engine = engine;
    return engine.stats;
  }

  /** Snap from clientX/Y (pointer event coords). */
  snapClient(clientX, clientY, o = {}) {
    const r = this.viewer.container.getBoundingClientRect();
    return this.snapScreen(clientX - r.left, clientY - r.top, o);
  }

  /**
   * Snap from container-relative screen px.
   * @param {object} [o]
   * @param {{x:number,y:number}} [o.from]  previous point in PAGE units (enables perpendicular)
   * @returns {null | {kind:string, page:{x,y}, pdf:{x,y}, poly:number}}
   */
  snapScreen(sx, sy, o = {}) {
    const v = this.viewer;
    if (!this.enabled || !this.engine) return this._set(null);
    const p = v.screenToPage(sx, sy);
    const q = v.pageToPdf(p.x, p.y);
    const zoom = v.view.zoom; // page units are isometric to PDF units → same radius
    const from = o.from ? v.pageToPdf(o.from.x, o.from.y) : undefined;
    const layers = this.engine.geom.layers;
    const hit = this.engine.snap(q.x, q.y, this.opts.radiusPx / zoom, {
      pxPerUnit: zoom,
      from,
      kinds: o.kinds ?? this.opts.kinds,
      extraPoints: this.extraPoints,
      layerVisible: this.hiddenOc.size ? (i) => !layers[i].some((id) => this.hiddenOc.has(id)) : undefined,
    });
    if (!hit) return this._set(null);
    const pg = v.pdfToPage(hit.x, hit.y);
    return this._set({ kind: hit.kind, page: pg, pdf: { x: hit.x, y: hit.y }, poly: hit.poly });
  }

  clearMarker() {
    this._set(null);
  }

  destroy() {
    this.viewer.removeEventListener('viewchange', this._onView);
    this._marker.remove();
  }

  _set(hit) {
    this._last = hit;
    this._drawMarker();
    return hit;
  }

  /** Marker glyphs follow AutoCAD conventions so they're instantly readable. Constant screen size. */
  _drawMarker() {
    const g = this._marker;
    g.replaceChildren();
    const h = this._last;
    if (!h || !this.opts.showMarker) return;
    const s = 7 / this.viewer.view.zoom; // half-size: 7 screen px
    const { x, y } = h.page;
    const el = (tag, attrs) => {
      const e = document.createElementNS(SVG, tag);
      for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
      e.setAttribute('fill', 'none');
      e.setAttribute('stroke', this.opts.color);
      e.setAttribute('stroke-width', '2');
      e.setAttribute('vector-effect', 'non-scaling-stroke');
      g.appendChild(e);
      return e;
    };
    switch (h.kind) {
      case 'endpoint': // □
        el('rect', { x: x - s, y: y - s, width: 2 * s, height: 2 * s });
        break;
      case 'midpoint': // △
        el('polygon', { points: `${x},${y - s} ${x + s},${y + s} ${x - s},${y + s}` });
        break;
      case 'intersection': // ✕
        el('path', { d: `M${x - s},${y - s}L${x + s},${y + s}M${x - s},${y + s}L${x + s},${y - s}` });
        break;
      case 'center': // ○ with dot
        el('circle', { cx: x, cy: y, r: s });
        el('circle', { cx: x, cy: y, r: s / 4 });
        break;
      case 'perpendicular': // ⊾
        el('path', { d: `M${x - s},${y - s}V${y + s}H${x + s}M${x - s},${y}H${x}V${y + s}` });
        break;
      case 'extra': // ◇
        el('polygon', { points: `${x},${y - s} ${x + s},${y} ${x},${y + s} ${x - s},${y}` });
        break;
      default: // nearest: ⧗ hourglass
        el('path', { d: `M${x - s},${y - s}H${x + s}L${x - s},${y + s}H${x + s}Z` });
    }
  }
}
