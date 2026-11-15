// Coordinate systems: database lookups and datum-aware conversion to WGS 84.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
globalThis.proj4 = require('../app/vendor/proj4.js');
const { findCRS, searchCRS, toWGS84, inAreaOfUse, allCRS } = await import('../app/js/crs.js');
console.log('systems', allCRS().length, '| search "arc 35s":', searchCRS('arc 35s').map((c) => c.code).join(','), '| "katanga":', searchCRS('katanga').length);
const arc = findCRS(20935), wgs = findCRS(32735);
const a = toWGS84(arc)([364000, 8643000]), b = toWGS84(wgs)([364000, 8643000]);
console.log('Arc1950 35S -> WGS84', a.map((v) => v.toFixed(6)), '| WGS84 35S ->', b.map((v) => v.toFixed(6)));
const dLon = (a[0] - b[0]) * 111320 * Math.cos(a[1] * Math.PI / 180), dLat = (a[1] - b[1]) * 110540;
console.log('datum shift m', dLon.toFixed(1), dLat.toFixed(1), 'in area', inAreaOfUse(arc, a), 'far away', inAreaOfUse(arc, [10, 50]));
let bad = 0;
for (const c of allCRS()) { if (!toWGS84(c)) { bad++; console.log('cannot use', c.code, c.name); } }
if (bad) throw new Error(bad + ' systems failed in proj4');
console.log('OK');
