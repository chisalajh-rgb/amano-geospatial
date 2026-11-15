// Warp + GeoTIFF + Shapefile + ZIP writers. Output is checked with GDAL by tests/check_export.py.
import fs from 'node:fs';
import { toGray, detectGrid, assignValues } from '../app/js/grid.js';
import { gcpsFromGrid, fitRobust } from '../app/js/georef.js';
import { warpToNorthUp } from '../app/js/warp.js';
import { writeGeoTIFF } from '../app/js/tiff.js';
import { writeShapefile, toGeoJSON } from '../app/js/vector.js';
import { makeZip } from '../app/js/zip.js';

const truth = JSON.parse(fs.readFileSync(new URL('./fixtures/sample-truth.json', import.meta.url)));
const rgba = new Uint8ClampedArray(fs.readFileSync('/tmp/sample-map.rgba'));
const { width: W, height: H } = truth;
const grid = detectGrid(toGray(rgba, W, H), W, H);
assignValues(grid.vertical, truth.eastingLabels.map((l) => ({ value: l.value, pos: l.x })), (l) => l.a + l.b * H / 2);
assignValues(grid.horizontal, truth.northingLabels.map((l) => ({ value: l.value, pos: l.y })), (l) => l.a + l.b * W / 2);
const gcps = gcpsFromGrid(grid.vertical, grid.horizontal).map((g, i) => ({ ...g, id: i + 1 }));
for (const type of ['affine', 'poly2']) {
  const model = fitRobust(gcps, type);
  let t0 = performance.now();
  const warped = await warpToNorthUp({ width: W, height: H, rgba }, model);
  const t1 = performance.now();
  const tif = await writeGeoTIFF({ ...warped, epsg: 20935, kind: 'projected', citation: 'Arc 1950 / UTM zone 35S' });
  console.log(`${type}: warp ${(t1 - t0).toFixed(0)} ms -> ${warped.width}x${warped.height}; tiff ${(performance.now() - t1).toFixed(0)} ms, ${(tif.length / 1e6).toFixed(1)} MB`);
  fs.writeFileSync(`/tmp/amano-${type}.tif`, tif);
}
// vectors: one polygon with a hole, a line and points
const poly = { id: 1, type: 'polygon', props: { unit: 'Gr', name: 'Granite intrusion', area_m2: 0 },
  coords: [[[361000, 8643000], [363000, 8643000], [363000, 8645000], [361000, 8645000], [361000, 8643000]],
           [[361500, 8643500], [361500, 8644000], [362000, 8644000], [362000, 8643500], [361500, 8643500]]] };
poly.props.area_m2 = 4e6 - 0.25e6;
const fields = [{ name: 'unit', type: 'C', len: 16 }, { name: 'name', type: 'C', len: 60 }, { name: 'area_m2', type: 'N', len: 18, dec: 1 }];
const shpPoly = writeShapefile('polygon', [poly], fields);
const pts = truth.collars.map((c, i) => ({ id: i + 1, type: 'point', coords: [c.e, c.n], props: { name: c.name } }));
const shpPts = writeShapefile('point', pts, [{ name: 'name', type: 'C', len: 40 }]);
const line = { id: 1, type: 'line', coords: [[365200, 8640000], [366700, 8646000]], props: { name: 'Fault é' } };
const shpLine = writeShapefile('line', [line], [{ name: 'name', type: 'C', len: 40 }]);
const files = [];
for (const [n, s] of [['polygons', shpPoly], ['points', shpPts], ['lines', shpLine]]) {
  files.push({ name: `${n}.shp`, data: s.shp }, { name: `${n}.shx`, data: s.shx }, { name: `${n}.dbf`, data: s.dbf }, { name: `${n}.cpg`, data: s.cpg });
}
files.push({ name: 'features.geojson', data: JSON.stringify(toGeoJSON([poly, line, ...pts])) });
fs.writeFileSync('/tmp/amano-vectors.zip', makeZip(files));
console.log('wrote zip with', files.length, 'files');
