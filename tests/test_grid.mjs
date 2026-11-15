// Grid detection + georeferencing accuracy on the synthetic sample map.
import fs from 'node:fs';
import { toGray, detectGrid, assignValues } from '../app/js/grid.js';
import { gcpsFromGrid, fitRobust, fitTransform } from '../app/js/georef.js';

const truth = JSON.parse(fs.readFileSync(new URL('./fixtures/sample-truth.json', import.meta.url)));
const rgba = new Uint8Array(fs.readFileSync('/tmp/sample-map.rgba'));
const { width: W, height: H } = truth;
const gray = toGray(rgba, W, H);
let t0 = performance.now();
const grid = detectGrid(gray, W, H);
console.log(`detect: ${(performance.now() - t0).toFixed(0)} ms; vertical ${grid.vertical.length}, horizontal ${grid.horizontal.length}, skew ${grid.skewDeg.toFixed(3)}°, spacing ${grid.spacingV.toFixed(1)}/${grid.spacingH.toFixed(1)}`);

// Simulated margin labels: true values with deliberately sloppy positions (±40 px), one wrong label.
const rnd = (() => { let s = 42; return () => (s = (s * 16807) % 2147483647) / 2147483647; })();
const eLab = truth.eastingLabels.map((l) => ({ value: l.value, pos: l.x + (rnd() - 0.5) * 80 }));
const nLab = truth.northingLabels.map((l) => ({ value: l.value, pos: l.y + (rnd() - 0.5) * 80 }));
eLab.push({ value: 999999, pos: 1500 });
const ym = H / 2, xm = W / 2;
const ra = assignValues(grid.vertical, eLab, (l) => l.a + l.b * ym);
const rb = assignValues(grid.horizontal, nLab, (l) => l.a + l.b * xm);
console.log('assigned', ra, rb);
console.log('eastings', grid.vertical.map((l) => l.value).join(','));
console.log('northings', grid.horizontal.map((l) => l.value).join(','));
const gcps = gcpsFromGrid(grid.vertical, grid.horizontal).map((g, i) => ({ ...g, id: i + 1 }));
const model = fitRobust(gcps, 'affine');
console.log(`gcps ${gcps.length}, used ${model.n}, rms ${model.rms.toFixed(3)} m (${model.rmsPx.toFixed(3)} px), res ${model.resolution.toFixed(4)} m/px, rot ${model.rotationDeg.toFixed(3)}°`);
// Compare with ground truth at every true grid intersection.
let maxErr = 0, sum = 0;
// (The sample's drawn lines are themselves only placed to about half a pixel, ~1.7 m.)
for (const g of truth.gcps) {
  const [X, Y] = model.forward(g.px, g.py);
  const e = Math.hypot(X - g.e, Y - g.n); sum += e * e; if (e > maxErr) maxErr = e;
}
const rmsTruth = Math.sqrt(sum / truth.gcps.length);
console.log(`vs truth: rms ${rmsTruth.toFixed(3)} m, max ${maxErr.toFixed(3)} m`);
for (const type of ['similarity', 'poly2']) {
  const m = fitTransform(gcps, type);
  const [X, Y] = m.forward(truth.gcps[10].px, truth.gcps[10].py);
  const [bx, by] = m.inverse(X, Y);
  console.log(type, 'rms', m.rms.toFixed(3), 'roundtrip px err', Math.hypot(bx - truth.gcps[10].px, by - truth.gcps[10].py).toExponential(2));
}
if (!(grid.vertical.length >= 7 && grid.horizontal.length >= 5)) throw new Error('too few lines');
if (!(rmsTruth < 2.5)) throw new Error('accuracy too low: ' + rmsTruth);
console.log('OK');
