// Legend-driven polygon extraction on the sample map, checked against the generator's true unit areas.
import fs from 'node:fs';
import { toGray, detectGrid, assignValues } from '../app/js/grid.js';
import { gcpsFromGrid, fitRobust } from '../app/js/georef.js';
import { buildWorkImage, sampleColor, rgbToLab, extractUnits, wandSelect, latticeToPixel } from '../app/js/digitize.js';
import { polygonArea, writeShapefile } from '../app/js/vector.js';

const truth = JSON.parse(fs.readFileSync(new URL('./fixtures/sample-truth.json', import.meta.url)));
const rgba = new Uint8ClampedArray(fs.readFileSync('/tmp/sample-map.rgba'));
const { width: W, height: H } = truth;
const src = { width: W, height: H, rgba };
const grid = detectGrid(toGray(rgba, W, H), W, H);
assignValues(grid.vertical, truth.eastingLabels.map((l) => ({ value: l.value, pos: l.x })), (l) => l.a + l.b * H / 2);
assignValues(grid.horizontal, truth.northingLabels.map((l) => ({ value: l.value, pos: l.y })), (l) => l.a + l.b * W / 2);
const model = fitRobust(gcpsFromGrid(grid.vertical, grid.horizontal).map((g, i) => ({ ...g, id: i + 1 })), 'affine');

let t0 = performance.now();
const work = buildWorkImage(src, 1800);
const units = truth.legend.map((l) => {
  const [x0, y0, x1, y1] = l.box, mx = (x1 - x0) * 0.3, my = (y1 - y0) * 0.3;
  const rgb = sampleColor(src, x0 + mx, y0 + my, x1 - mx, y1 - my);
  return { code: l.code, name: l.name, rgb, lab: rgbToLab(...rgb) };
});
console.log('sampled', units.map((u) => u.code + ':' + u.rgb.join('/')).join('  '));
const f = work.f, fr = truth.frame;
const roi = { x0: Math.ceil(fr[0] / f), y0: Math.ceil(fr[1] / f), x1: Math.floor(fr[2] / f), y1: Math.floor(fr[3] / f) };
const { polygons } = extractUnits(work, units, roi);
console.log(`work ${work.w}x${work.h} (f=${f}); ${polygons.length} polygons in ${(performance.now() - t0).toFixed(0)} ms`);
const toMap = (pt) => model.forward(...latticeToPixel(work, pt));
const feats = polygons.map((p, i) => {
  const coords = p.rings.map((r) => r.map(toMap));
  return { id: i + 1, type: 'polygon', coords, props: { unit: units[p.label - 1].code, name: units[p.label - 1].name, area_m2: polygonArea(coords) } };
});
const byUnit = {};
let total = 0, nVerts = 0;
for (const ft of feats) { byUnit[ft.props.unit] = (byUnit[ft.props.unit] || 0) + ft.props.area_m2; total += ft.props.area_m2; nVerts += ft.coords.reduce((s, r) => s + r.length, 0); }
let worst = 0;
for (const u of units) {
  const got = byUnit[u.code] || 0, want = truth.unitAreasM2[u.code];
  const pct = 100 * (got - want) / want; worst = Math.max(worst, Math.abs(pct));
  console.log(`  ${u.code}: ${(got / 1e6).toFixed(3)} km2 (truth ${(want / 1e6).toFixed(3)}), ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%  polygons: ${feats.filter((q) => q.props.unit === u.code).length}`);
}
const frameArea = (truth.extent[2] - truth.extent[0]) * (truth.extent[3] - truth.extent[1]);
console.log(`total ${(total / 1e6).toFixed(3)} km2 of frame ${(frameArea / 1e6).toFixed(3)} km2 (${(100 * total / frameArea).toFixed(2)}%), vertices ${nVerts}`);
const shp = writeShapefile('polygon', feats, [{ name: 'unit', type: 'C', len: 16 }, { name: 'name', type: 'C', len: 60 }, { name: 'area_m2', type: 'N', len: 18, dec: 1 }]);
fs.writeFileSync('/tmp/units.shp', shp.shp); fs.writeFileSync('/tmp/units.shx', shp.shx); fs.writeFileSync('/tmp/units.dbf', shp.dbf);
fs.writeFileSync('/tmp/units.json', JSON.stringify(feats));
// magic wand on the granite body
const gx = truth.gcps.find((g) => g.e === 362000 && g.n === 8644000);
const wand = wandSelect(work, (gx.px + 60) / f, (gx.py - 60) / f, roi);
const wc = wand.rings.map((r) => r.map(toMap));
console.log(`wand granite: ${(polygonArea(wc) / 1e6).toFixed(3)} km2 (truth ${(truth.unitAreasM2.Gr / 1e6).toFixed(3)}), rings ${wand.rings.length}`);
if (worst > 3) throw new Error('unit area error too large: ' + worst.toFixed(2) + '%');
if (Math.abs(total / frameArea - 1) > 0.02) throw new Error('coverage off');
if (Math.abs(polygonArea(wc) / truth.unitAreasM2.Gr - 1) > 0.05) throw new Error('wand area off');
console.log('OK');
