// Amano Geospatial — vector export: GeoJSON and ESRI Shapefile.
// A feature is { id, type: 'polygon'|'line'|'point', coords, props } where coords are in MAP units:
//   polygon: [ring, ring, ...]   ring = [[x,y], ...] closed (first = last); ring 0 is the outline
//   line:    [[x,y], ...]
//   point:   [x,y]

export function ringArea(ring) {
  let a = 0;
  for (let i = 0, n = ring.length - 1; i < n; i++) a += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
  return a / 2; // > 0 = counter-clockwise (y up)
}

export function polygonArea(rings) {
  let a = 0;
  rings.forEach((r, i) => { a += (i === 0 ? 1 : -1) * Math.abs(ringArea(r)); });
  return a;
}

const round = (v, d) => { const k = 10 ** d; return Math.round(v * k) / k; };

/** GeoJSON FeatureCollection. `project` converts map units to the output CRS (e.g. to WGS 84), or is null. */
export function toGeoJSON(features, { project = null, decimals = 2, crsName = null } = {}) {
  const P = (pt) => { const q = project ? project(pt) : pt; return [round(q[0], decimals), round(q[1], decimals)]; };
  const fc = { type: 'FeatureCollection', features: [] };
  if (crsName) fc.crs = { type: 'name', properties: { name: crsName } };
  for (const f of features) {
    let geometry;
    if (f.type === 'point') geometry = { type: 'Point', coordinates: P(f.coords) };
    else if (f.type === 'line') geometry = { type: 'LineString', coordinates: f.coords.map(P) };
    else {
      geometry = { type: 'Polygon', coordinates: f.coords.map((ring, i) => {
        // GeoJSON wants the outline counter-clockwise and holes clockwise.
        const ccw = ringArea(ring) > 0;
        const r = (i === 0) === ccw ? ring : ring.slice().reverse();
        return r.map(P);
      }) };
    }
    fc.features.push({ type: 'Feature', id: f.id, properties: { ...f.props }, geometry });
  }
  return fc;
}

// ---------------------------------------------------------------- Shapefile

function dbf(records, fields) {
  const enc = new TextEncoder();
  const recLen = 1 + fields.reduce((s, f) => s + f.len, 0);
  const headLen = 32 + 32 * fields.length + 1;
  const out = new Uint8Array(headLen + recLen * records.length + 1);
  const dv = new DataView(out.buffer);
  const d = new Date();
  out[0] = 3; out[1] = d.getFullYear() - 1900; out[2] = d.getMonth() + 1; out[3] = d.getDate();
  dv.setUint32(4, records.length, true); dv.setUint16(8, headLen, true); dv.setUint16(10, recLen, true);
  fields.forEach((f, i) => {
    const at = 32 + i * 32;
    out.set(enc.encode(f.name).subarray(0, 10), at);
    out[at + 11] = f.type.charCodeAt(0); out[at + 16] = f.len; out[at + 17] = f.dec || 0;
  });
  out[headLen - 1] = 0x0d;
  let p = headLen;
  for (const rec of records) {
    out[p++] = 0x20;
    for (const f of fields) {
      const v = rec[f.name];
      let bytes;
      if (f.type === 'N') {
        const s = v === null || v === undefined || !isFinite(v) ? '' : Number(v).toFixed(f.dec || 0);
        bytes = enc.encode(s.slice(-f.len).padStart(f.len, ' '));
      } else {
        bytes = enc.encode(String(v ?? '')).subarray(0, f.len);
      }
      out.fill(0x20, p, p + f.len);
      out.set(bytes, f.type === 'N' ? p + f.len - bytes.length : p);
      p += f.len;
    }
  }
  out[p] = 0x1a;
  return out;
}

/**
 * Write one shapefile layer (all features must share a geometry type).
 * @returns {{shp:Uint8Array, shx:Uint8Array, dbf:Uint8Array, cpg:string}}
 */
export function writeShapefile(type, features, fields) {
  const shapeType = { point: 1, line: 3, polygon: 5 }[type];
  const recs = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; };
  for (const f of features) {
    let buf, dv;
    if (type === 'point') {
      buf = new Uint8Array(20); dv = new DataView(buf.buffer);
      dv.setInt32(0, 1, true); dv.setFloat64(4, f.coords[0], true); dv.setFloat64(12, f.coords[1], true);
      grow(f.coords[0], f.coords[1]);
    } else {
      let parts = type === 'line' ? [f.coords] : f.coords.map((ring, i) => {
        // Shapefile wants outlines clockwise and holes counter-clockwise.
        const ccw = ringArea(ring) > 0;
        return (i === 0) === ccw ? ring.slice().reverse() : ring;
      });
      const nPts = parts.reduce((s, p) => s + p.length, 0);
      buf = new Uint8Array(44 + 4 * parts.length + 16 * nPts); dv = new DataView(buf.buffer);
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (const p of parts) for (const [x, y] of p) { if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; grow(x, y); }
      dv.setInt32(0, shapeType, true);
      dv.setFloat64(4, bx0, true); dv.setFloat64(12, by0, true); dv.setFloat64(20, bx1, true); dv.setFloat64(28, by1, true);
      dv.setInt32(36, parts.length, true); dv.setInt32(40, nPts, true);
      let idx = 0, at = 44 + 4 * parts.length;
      parts.forEach((p, i) => {
        dv.setInt32(44 + 4 * i, idx, true); idx += p.length;
        for (const [x, y] of p) { dv.setFloat64(at, x, true); dv.setFloat64(at + 8, y, true); at += 16; }
      });
    }
    recs.push(buf);
  }
  if (!recs.length) { minX = minY = maxX = maxY = 0; }
  const shpLen = 100 + recs.reduce((s, r) => s + 8 + r.length, 0);
  const shp = new Uint8Array(shpLen), shx = new Uint8Array(100 + 8 * recs.length);
  const header = (arr, len) => {
    const dv = new DataView(arr.buffer);
    dv.setInt32(0, 9994, false); dv.setInt32(24, len / 2, false); dv.setInt32(28, 1000, true); dv.setInt32(32, shapeType, true);
    dv.setFloat64(36, minX, true); dv.setFloat64(44, minY, true); dv.setFloat64(52, maxX, true); dv.setFloat64(60, maxY, true);
  };
  header(shp, shp.length); header(shx, shx.length);
  const sdv = new DataView(shp.buffer), xdv = new DataView(shx.buffer);
  let p = 100;
  recs.forEach((r, i) => {
    xdv.setInt32(100 + 8 * i, p / 2, false); xdv.setInt32(104 + 8 * i, r.length / 2, false);
    sdv.setInt32(p, i + 1, false); sdv.setInt32(p + 4, r.length / 2, false);
    shp.set(r, p + 8); p += 8 + r.length;
  });
  return { shp, shx, dbf: dbf(features.map((f) => f.props || {}), fields), cpg: 'UTF-8' };
}

/** CSV of point features (name, X, Y and any other properties). */
export function pointsToCSV(features, xName = 'X', yName = 'Y') {
  const pts = features.filter((f) => f.type === 'point');
  const keys = [...new Set(pts.flatMap((f) => Object.keys(f.props || {})))];
  const esc = (v) => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = [[...keys, xName, yName].join(',')];
  for (const f of pts) rows.push([...keys.map((k) => esc(f.props[k])), f.coords[0], f.coords[1]].join(','));
  return rows.join('\n') + '\n';
}
