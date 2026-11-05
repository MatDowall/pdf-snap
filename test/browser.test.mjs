// End-to-end in headless Chrome: worker extraction, snapping through the viewer, marker kinds.
// Expects ../pdf-viewport next to this folder. Run: npm run test:browser
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import puppeteer from 'puppeteer-core';

const parent = new URL('../..', import.meta.url).pathname;
const types = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.pdf': 'application/pdf' };
const server = http.createServer(async (req, res) => {
  try {
    let url = decodeURIComponent(req.url.split('?')[0]);
    const p = normalize(join(parent, url));
    if (!p.startsWith(parent)) throw 0;
    let body = await readFile(p);
    // serve the demo with local pdf.js instead of the CDN
    if (url.endsWith('/demo/index.html')) body = Buffer.from(String(body).replaceAll('https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/build/', '/pdf-viewport/node_modules/pdfjs-dist/build/'));
    res.writeHead(200, { 'content-type': types[extname(p)] || 'application/octet-stream' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}).listen(0);
const port = server.address().port;

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(`http://localhost:${port}/pdf-snap/demo/index.html`);
let failed = 0;
const check = (name, ok, info = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? '  — ' + info : ''}`); if (!ok) failed++; };

async function openPdf(path) {
  await page.evaluate(() => window.snapper && (window.snapper.engine = null));
  await (await page.$('#file')).uploadFile(path);
  await page.waitForFunction(() => window.snapper?.engine, { timeout: 30000 });
  return page.evaluate(() => window.snapper.engine.stats);
}
const stats = await openPdf(new URL('./fixtures/snap-test.pdf', import.meta.url).pathname);
check('extraction ran in the Web Worker', stats.where === 'worker', JSON.stringify(stats));

// zoom so 1 PDF unit = 4 px around the cross at (100,100)
const toScreen = (x, y) => page.evaluate((x, y) => {
  const p = vp.pdfToPage(x, y), s = vp.pageToScreen(p.x, p.y), r = vp.container.getBoundingClientRect();
  return { x: s.x + r.left, y: s.y + r.top };
}, x, y);
await page.evaluate(() => { const p = vp.pdfToPage(100, 100); vp.setView({ zoom: 4, panX: 400 - p.x * 4, panY: 400 - p.y * 4 }); });
await new Promise((r) => setTimeout(r, 400));

async function hover(x, y, dx = 0, dy = 0) {
  const s = await toScreen(x, y);
  await page.mouse.move(s.x + dx, s.y + dy);
  return page.evaluate(() => { const h = snapper._last; return h && { kind: h.kind, x: +h.pdf.x.toFixed(4), y: +h.pdf.y.toFixed(4) }; });
}
let h = await hover(100, 100, 6, -5);
check('hover 8px from crossing → intersection at (100,100)', h?.kind === 'intersection' && h.x === 100 && h.y === 100, JSON.stringify(h));
h = await hover(150, 100, -4, 3);
check('near line end → endpoint (150,100)', h?.kind === 'endpoint' && h.x === 150, JSON.stringify(h));
h = await hover(125, 100, 0, 6);
check('on a line → nearest', h?.kind === 'nearest' && h.y === 100, JSON.stringify(h));
const markerShape = await page.evaluate(() => snapper._marker.firstChild?.tagName);
check('marker drawn', !!markerShape, markerShape);
h = await hover(125, 130, 0, 0);
check('far from linework (beyond 12px) → no snap', h === null, JSON.stringify(h));

// measure: click intersection → endpoint, length should be exactly 50 pt = 17.639 mm paper → 1.764 m @1:100
let s1 = await toScreen(100, 100); await page.mouse.click(s1.x + 5, s1.y + 4);
let s2 = await toScreen(150, 100); await page.mouse.click(s2.x - 3, s2.y - 5);
await page.keyboard.press('Enter');
const readout = await page.$eval('#readout', (e) => e.textContent);
check('snapped measurement is exact (50 pt → 1.764 m at 1:100)', readout.includes('total 1.764 m'), readout);
await page.screenshot({ path: new URL('./demo-snap.png', import.meta.url).pathname });

// snapping cost per pointer move on the dense area
const perf = await page.evaluate(() => {
  const r = vp.container.getBoundingClientRect();
  vp.fitPage();
  const t0 = performance.now();
  for (let i = 0; i < 2000; i++) snapper.snapScreen(Math.random() * r.width, Math.random() * r.height);
  return (performance.now() - t0) / 2000;
});
check('snap per pointer-move < 0.5 ms (incl. marker DOM update)', perf < 0.5, `${perf.toFixed(3)} ms`);

// bigger real-ish sheet from pdf-viewport's fixture
const big = await openPdf(join(parent, 'pdf-viewport/test/fixtures/a1-test-sheet.pdf'));
check('A1 hairline sheet: exactly 237 + 167 grid lines + 400 diagonals = 804 segments', big.segments === 804, JSON.stringify(big));

check('no page errors', errors.length === 0, errors.join(' | '));
await browser.close(); server.close();
console.log(failed ? `\n${failed} FAILED` : '\nall browser checks passed');
process.exit(failed ? 1 : 0);
