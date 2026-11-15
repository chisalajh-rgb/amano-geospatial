// Amano Geospatial — control-point fitting.
// A "GCP" (ground control point) pairs a pixel position on the scan with a map coordinate:
//   { id, px, py, mx, my, enabled, rejected, source }
// Models map pixel -> map (forward) and map -> pixel (inverse).

const TERMS = {
  affine: (u, v) => [1, u, v],
  poly2: (u, v) => [1, u, v, u * u, u * v, v * v],
};

export const MIN_POINTS = { similarity: 2, affine: 3, poly2: 6 };

/** Solve the least-squares problem A x = b (A: rows of numbers). Returns x or null if singular. */
export function solveLeastSquares(A, b) {
  const n = A[0].length;
  const M = Array.from({ length: n }, () => new Float64Array(n + 1));
  for (let r = 0; r < A.length; r++) {
    const row = A[r];
    for (let i = 0; i < n; i++) {
      const ri = row[i];
      if (ri === 0) continue;
      for (let j = i; j < n; j++) M[i][j] += ri * row[j];
      M[i][n] += ri * b[r];
    }
  }
  for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) M[i][j] = M[j][i];
  // Gaussian elimination with partial pivoting
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    if (Math.abs(M[p][c]) < 1e-12) return null;
    if (p !== c) { const t = M[p]; M[p] = M[c]; M[c] = t; }
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c];
      if (f === 0) continue;
      for (let j = c; j <= n; j++) M[r][j] -= f * M[c][j];
    }
  }
  const x = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n];
    for (let j = i + 1; j < n; j++) s -= M[i][j] * x[j];
    x[i] = s / M[i][i];
  }
  return Array.from(x);
}

function stats(vals) {
  let min = Infinity, max = -Infinity, sum = 0;
  for (const v of vals) { if (v < min) min = v; if (v > max) max = v; sum += v; }
  return { mean: sum / vals.length, half: Math.max((max - min) / 2, 1e-9) };
}

/** Fit a polynomial mapping (x,y) -> (X,Y) in normalised coordinates. */
function fitPoly(src, dst, type) {
  const sx = stats(src.map((p) => p[0])), sy = stats(src.map((p) => p[1]));
  const ox = stats(dst.map((p) => p[0])).mean, oy = stats(dst.map((p) => p[1])).mean;
  const norm = { cx: sx.mean, cy: sy.mean, sx: sx.half, sy: sy.half, ox, oy };
  let coefX, coefY, terms = type;
  if (type === 'similarity') {
    // X = a u + b v + c ; Y = b u - a v + d   (rotation + uniform scale + y-axis flip)
    const s = Math.max(sx.half, sy.half);
    norm.sx = norm.sy = s;
    const A = [], b = [];
    for (let i = 0; i < src.length; i++) {
      const u = (src[i][0] - norm.cx) / s, v = (src[i][1] - norm.cy) / s;
      A.push([u, v, 1, 0]); b.push(dst[i][0] - ox);
      A.push([-v, u, 0, 1]); b.push(dst[i][1] - oy);
    }
    const p = solveLeastSquares(A, b);
    if (!p) return null;
    coefX = [p[2], p[0], p[1]];
    coefY = [p[3], p[1], -p[0]];
    terms = 'affine';
  } else {
    const f = TERMS[type];
    const A = src.map((p) => f((p[0] - norm.cx) / norm.sx, (p[1] - norm.cy) / norm.sy));
    coefX = solveLeastSquares(A, dst.map((p) => p[0] - ox));
    coefY = solveLeastSquares(A, dst.map((p) => p[1] - oy));
    if (!coefX || !coefY) return null;
  }
  return { terms, ...norm, coefX, coefY };
}

export function applyPoly(m, x, y) {
  const u = (x - m.cx) / m.sx, v = (y - m.cy) / m.sy;
  let X = m.ox + m.coefX[0] + m.coefX[1] * u + m.coefX[2] * v;
  let Y = m.oy + m.coefY[0] + m.coefY[1] * u + m.coefY[2] * v;
  if (m.terms === 'poly2') {
    X += m.coefX[3] * u * u + m.coefX[4] * u * v + m.coefX[5] * v * v;
    Y += m.coefY[3] * u * u + m.coefY[4] * u * v + m.coefY[5] * v * v;
  }
  return [X, Y];
}

/** Plain affine coefficients {a,b,c,d,e,f}: X = a x + b y + c ; Y = d x + e y + f. */
export function polyToAffine(m) {
  const a = m.coefX[1] / m.sx, b = m.coefX[2] / m.sy;
  const d = m.coefY[1] / m.sx, e = m.coefY[2] / m.sy;
  return {
    a, b, c: m.ox + m.coefX[0] - a * m.cx - b * m.cy,
    d, e, f: m.oy + m.coefY[0] - d * m.cx - e * m.cy,
  };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = Array.from(arr).sort((p, q) => p - q);
  const k = s.length >> 1;
  return s.length % 2 ? s[k] : (s[k - 1] + s[k]) / 2;
}

/**
 * Fit a transform to the usable control points.
 * Returns null if there are too few points; otherwise
 * { type, n, forward(x,y), inverse(X,Y), fwd, inv, affine, resolution, rotationDeg, rms, rmsPx, residuals: Map(id -> {dx,dy,err,errPx}) }
 */
export function fitTransform(gcps, type = 'affine') {
  const pts = gcps.filter((g) => g.enabled !== false && !g.rejected && isFinite(g.mx) && isFinite(g.my));
  if (pts.length < MIN_POINTS[type]) return null;
  const src = pts.map((g) => [g.px, g.py]), dst = pts.map((g) => [g.mx, g.my]);
  const fwd = fitPoly(src, dst, type);
  if (!fwd) return null;
  // A plain affine is always fitted too: it gives the pixel size, rotation and world file.
  const affFit = type === 'poly2' ? fitPoly(src, dst, 'affine') : fwd;
  if (!affFit) return null;
  const affine = polyToAffine(affFit);
  const det = affine.a * affine.e - affine.b * affine.d;
  if (!isFinite(det) || Math.abs(det) < 1e-30) return null;
  const resolution = Math.sqrt(Math.abs(det));
  let inv, inverse;
  if (type === 'poly2') {
    inv = fitPoly(dst, src, 'poly2');
    if (!inv) return null;
    inverse = (X, Y) => applyPoly(inv, X, Y);
  } else {
    const ia = affine.e / det, ib = -affine.b / det, id = -affine.d / det, ie = affine.a / det;
    inverse = (X, Y) => [ia * (X - affine.c) + ib * (Y - affine.f), id * (X - affine.c) + ie * (Y - affine.f)];
    inv = { terms: 'affine', cx: 0, cy: 0, sx: 1, sy: 1, ox: 0, oy: 0,
      coefX: [-(ia * affine.c + ib * affine.f), ia, ib], coefY: [-(id * affine.c + ie * affine.f), id, ie] };
  }
  const forward = (x, y) => applyPoly(fwd, x, y);
  const residuals = new Map();
  let ss = 0;
  for (const g of gcps) {
    if (!isFinite(g.mx) || !isFinite(g.my)) continue;
    const [X, Y] = forward(g.px, g.py);
    const dx = X - g.mx, dy = Y - g.my, err = Math.hypot(dx, dy);
    residuals.set(g.id, { dx, dy, err, errPx: err / resolution });
    if (g.enabled !== false && !g.rejected) ss += err * err;
  }
  const rms = Math.sqrt(ss / pts.length);
  // Rotation of the scan relative to grid north (positive = map's north is rotated clockwise on the scan).
  const rotationDeg = Math.atan2(affine.d, affine.a) * 180 / Math.PI;
  return { type, n: pts.length, forward, inverse, fwd, inv, affine, resolution, rotationDeg, rms, rmsPx: rms / resolution, residuals };
}

/**
 * Fit with automatic outlier rejection. Points whose error is far outside the pack are flagged
 * `rejected` (kept in the list so a person can review them) and the fit is repeated.
 */
export function fitRobust(gcps, type = 'affine', { maxRejectFraction = 0.3, minTolPx = 1.5 } = {}) {
  for (const g of gcps) g.rejected = false;
  const usable = (g) => g.enabled !== false && isFinite(g.mx) && isFinite(g.my);
  let model = fitTransform(gcps, type);
  if (!model) return null;
  const maxReject = Math.floor(gcps.filter(usable).length * maxRejectFraction);
  let rejected = 0;
  while (rejected < maxReject && model.n > MIN_POINTS[type] + 2) {
    const active = gcps.filter((g) => usable(g) && !g.rejected);
    const errs = active.map((g) => model.residuals.get(g.id).errPx);
    const sigma = 1.4826 * median(errs);
    let worst = 0;
    for (let i = 1; i < errs.length; i++) if (errs[i] > errs[worst]) worst = i;
    if (errs[worst] <= Math.max(4 * sigma, minTolPx)) break;
    active[worst].rejected = true;
    rejected++;
    const next = fitTransform(gcps, type);
    if (!next) { active[worst].rejected = false; break; }
    model = next;
  }
  return model;
}

/** Pick the simplest transform that explains the points. */
export function chooseTransformType(gcps) {
  const n = gcps.filter((g) => g.enabled !== false).length;
  if (n < 3) return 'similarity';
  if (n < 12) return 'affine';
  const aff = fitRobust(gcps.map((g) => ({ ...g })), 'affine');
  const pol = fitRobust(gcps.map((g) => ({ ...g })), 'poly2');
  if (aff && pol && aff.rmsPx > 1.5 && pol.rmsPx < 0.6 * aff.rmsPx) return 'poly2';
  return 'affine';
}

/** Intersections of fitted grid lines become control points.
 *  vertical lines: x = a + b*y, value = easting/longitude ; horizontal lines: y = a + b*x, value = northing/latitude */
export function gcpsFromGrid(vertical, horizontal, source = 'grid') {
  const out = [];
  for (const v of vertical) {
    if (!isFinite(v.value)) continue;
    for (const h of horizontal) {
      if (!isFinite(h.value)) continue;
      const den = 1 - v.b * h.b;
      if (Math.abs(den) < 1e-9) continue;
      const x = (v.a + v.b * h.a) / den;
      const y = h.a + h.b * x;
      out.push({ px: x, py: y, mx: v.value, my: h.value, enabled: true, rejected: false, source });
    }
  }
  return out;
}

export { median };
