// Generates test/fixtures/snap-test.pdf — every awkward case a real drawing throws at a snapper.
// Each case is drawn at a KNOWN position so tests can assert exact snap points.
// Run: node test/makeFixture.mjs
import { writeFileSync } from 'node:fs';
const W = 1190, H = 842; // A3 landscape (points)
const c = [];
// 1. plain lines forming a cross: intersection at (100,100); endpoints (50,100),(150,100),(100,50),(100,150)
c.push('0.5 w 50 100 m 150 100 l S 100 50 m 100 150 l S');
// 2. nested transforms: q 2 0 0 2 200 0 cm  → line 0,50 → 50,50 lands at (200,100)-(300,100)
c.push('q 2 0 0 2 200 0 cm q 1 0 0 1 0 0 cm 0 50 m 50 50 l S Q Q');
// 3. rectangle 350,50 w100 h100 (closed): corners endpoints, edge midpoints e.g. (400,50)
c.push('350 50 100 100 re S');
// 4. bezier curve from (500,50) to (600,50) bulging up: endpoints only at the two ends
c.push('500 50 m 520 150 580 150 600 50 c S');
// 5. clipping path that must NOT be snappable: clip rect 0,0,1190,842 then draw line 650,100-750,100
c.push('q 10 10 1170 822 re W n 650 100 m 750 100 l S Q');
// 6. form XObject with /Matrix [1 0 0 1 800 0] drawing 0,100 -> 100,100  → (800,100)-(900,100)
c.push('/Fm1 Do');
// 7. dashed line 950,50 -> 950,150
c.push('[6 3] 0 d 950 50 m 950 150 l S [] 0 d');
// 8. optional-content layer "Electrical": line 50,300 -> 250,300
c.push('/OC /oc1 BDC 50 300 m 250 300 l S EMC');
// 9. filled-only hatch triangle (fill, no stroke) at 300,300 400,300 350,380
c.push('0.5 g 300 300 m 400 300 l 350 380 l h f 0 g');
// 10. white-filled mask rectangle (common for wipeouts) 450,280 w80 h40
c.push('1 1 1 rg 450 280 80 40 re f 0 0 0 rg');
// 12. circle (4 beziers) centre (700,300) r 30 — e.g. a pile / column; also a 'q cm' scaled one
{ const k = 0.5523 * 30, x = 700, y = 300, r = 30;
  c.push(`${x + r} ${y} m ${x + r} ${y + k} ${x + k} ${y + r} ${x} ${y + r} c ${x - k} ${y + r} ${x - r} ${y + k} ${x - r} ${y} c ` +
         `${x - r} ${y - k} ${x - k} ${y - r} ${x} ${y - r} c ${x + k} ${y - r} ${x + r} ${y - k} ${x + r} ${y} c S`); }
// 11. dense grid for performance: 300 x 300 tiny segments in the lower half
let g = '0.1 w ';
for (let i = 0; i < 300; i++) for (let j = 0; j < 30; j++) {
  const x = 50 + i * 3.6, y = 420 + j * 13;
  g += `${x.toFixed(2)} ${y.toFixed(2)} m ${(x + 3).toFixed(2)} ${(y + 10).toFixed(2)} l `;
}
c.push(g + 'S');
const content = c.join('\n') + '\n';
const form = '0 100 m 100 100 l S\n';
const objs = [
  '<< /Type /Catalog /Pages 2 0 R /OCProperties << /OCGs [6 0 R] /D << /Order [6 0 R] /ON [6 0 R] >> >> >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << /XObject << /Fm1 5 0 R >> /Properties << /oc1 6 0 R >> >> >>`,
  `<< /Length ${content.length} >>\nstream\n${content}endstream`,
  `<< /Type /XObject /Subtype /Form /BBox [0 0 200 200] /Matrix [1 0 0 1 800 0] /Length ${form.length} >>\nstream\n${form}endstream`,
  '<< /Type /OCG /Name (Electrical) >>',
];
let out = '%PDF-1.5\n', offs = [];
objs.forEach((o, i) => { offs.push(out.length); out += `${i + 1} 0 obj\n${o}\nendobj\n`; });
const xref = out.length;
out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` + offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
writeFileSync(new URL('./fixtures/snap-test.pdf', import.meta.url), out, 'latin1');
console.log('wrote', out.length);
