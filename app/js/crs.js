// Amano Geospatial — coordinate reference systems.
import { CRS_DB } from './crs-db.js';

const byCode = new Map(CRS_DB.filter((c) => !c.axisFlip).map((c) => [c.code, c]));
const proj = () => globalThis.proj4;

export function allCRS() { return [...byCode.values()]; }
export function findCRS(code) { return byCode.get(Number(code)) || null; }

/** Text search over code and name ("35S", "arc 1950", "20935", "katanga"). */
export function searchCRS(query, limit = 40) {
  const q = String(query || '').toLowerCase().trim();
  const list = allCRS();
  if (!q) return list.filter((c) => [20935, 32735, 20934, 20936, 32734, 32736, 3988, 3989, 4326, 4209].includes(c.code));
  const tokens = q.split(/[\s/,]+/).filter(Boolean);
  const scored = [];
  for (const c of list) {
    const hay = (c.code + ' ' + c.name).toLowerCase();
    if (!tokens.every((t) => hay.includes(t))) continue;
    let score = 0;
    if (String(c.code) === q) score += 100;
    if (String(c.code).startsWith(q)) score += 10;
    if (c.name.toLowerCase().startsWith(q)) score += 5;
    scored.push([score, c]);
  }
  scored.sort((a, b) => b[0] - a[0] || a[1].code - b[1].code);
  return scored.slice(0, limit).map((s) => s[1]);
}

/** Look a code up locally, then on epsg.io. Returns null if it cannot be found. */
export async function resolveCRS(code) {
  code = Number(code);
  const local = findCRS(code);
  if (local) return local;
  try {
    const [p, w] = await Promise.all([
      fetch(`https://epsg.io/${code}.proj4`).then((r) => (r.ok ? r.text() : '')),
      fetch(`https://epsg.io/${code}.esriwkt`).then((r) => (r.ok ? r.text() : '')),
    ]);
    const proj4str = p.trim();
    if (!proj4str.startsWith('+proj')) return null;
    const name = (w.match(/^\w+\["([^"]+)"/) || [])[1]?.replace(/_/g, ' ') || `EPSG:${code}`;
    const geographic = /\+proj=longlat/.test(proj4str);
    const unit = geographic ? 'degree' : /\+units=us-ft/.test(proj4str) ? 'US survey foot' : /\+units=ft/.test(proj4str) ? 'foot' : 'metre';
    const crs = { code, name, kind: geographic ? 'geographic' : 'projected', unit, proj4: proj4str, wkt: w.trim() || null, bounds: null, online: true };
    byCode.set(code, crs);
    return crs;
  } catch {
    return null;
  }
}

/** Function converting [x, y] in the CRS to [lon, lat] WGS 84, or null if the CRS has no usable definition. */
export function toWGS84(crs) {
  if (!crs || !crs.proj4 || !proj()) return null;
  try {
    const t = proj()(crs.proj4, 'WGS84');
    t.forward([crs.kind === 'geographic' ? 28 : 500000, crs.kind === 'geographic' ? -12 : 8600000]); // fail early on bad definitions
    return (pt) => t.forward([pt[0], pt[1]]);
  } catch {
    return null;
  }
}

export function fromWGS84(crs) {
  if (!crs || !crs.proj4 || !proj()) return null;
  try { const t = proj()(crs.proj4, 'WGS84'); return (pt) => t.inverse([pt[0], pt[1]]); } catch { return null; }
}

/** Is a WGS 84 position inside the CRS's official area of use (with a small margin)? null if unknown. */
export function inAreaOfUse(crs, lonlat, margin = 1.0) {
  if (!crs?.bounds || !lonlat || !isFinite(lonlat[0]) || !isFinite(lonlat[1])) return null;
  const [w, s, e, n] = crs.bounds;
  return lonlat[0] >= w - margin && lonlat[0] <= e + margin && lonlat[1] >= s - margin && lonlat[1] <= n + margin;
}

export function formatLonLat(lonlat) {
  const f = (v, pos, neg) => `${Math.abs(v).toFixed(5)}°${v >= 0 ? pos : neg}`;
  return `${f(lonlat[1], 'N', 'S')} ${f(lonlat[0], 'E', 'W')}`;
}

export function crsLabel(crs) {
  return crs ? `${crs.name} (EPSG:${crs.code})` : 'No coordinate system (local grid)';
}
