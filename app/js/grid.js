// Amano Geospatial — grid-line detection on a scanned map.
// Finds the long, thin, evenly spaced dark lines of a coordinate grid, tolerating a few degrees
// of scan rotation, and returns each one as a fitted straight line in full-resolution pixels.
//
//   vertical line:   x = a + b * y
//   horizontal line: y = a + b * x

/** Luminance from RGBA. */
export function toGray(rgba, width, height) {
  const g = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < g.length; i++, j += 4) {
    g[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29) >> 8;
  }
  return g;
}

function transpose(gray, width, height) {
  const t = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const row = y * width;
    for (let x = 0; x < width; x++) t[x * height + y] = gray[row + x];
  }
  return t;
}

/** Shrink by an integer factor keeping the darkest pixel of each block, so thin lines survive. */
function minPool(gray, width, height, f) {
  if (f === 1) return { data: gray, w: width, h: height };
  const w = Math.floor(width / f), h = Math.floor(height / f);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let m = 255;
      for (let dy = 0; dy < f; dy++) {
        const row = (y * f + dy) * width + x * f;
        for (let dx = 0; dx < f; dx++) { const v = gray[row + dx]; if (v < m) m = v; }
      }
      out[y * w + x] = m;
    }
  }
  return { data: out, w, h };
}

/** Find near-vertical grid lines. roi is in full-resolution pixels. */
function detectVertical(gray, width, height, roi, opts) {
  const f = Math.max(1, Math.ceil(Math.max(width, height) / opts.detectSize));
  const small = minPool(gray, width, height, f);
  const { data, w, h } = small;
  const x0 = Math.max(4, Math.floor(roi.x0 / f)), x1 = Math.min(w - 4, Math.ceil(roi.x1 / f));
  const y0 = Math.max(0, Math.floor(roi.y0 / f)), y1 = Math.min(h, Math.ceil(roi.y1 / f));
  const span = y1 - y0;
  if (span < 40 || x1 - x0 < 40) return { lines: [], spacing: 0, slope: 0 };

  // 1. Thin dark ridges: a pixel clearly darker than the pixels a few columns either side.
  const d = 3, T = opts.contrast;
  const px = [], py = [];
  for (let y = y0; y < y1; y++) {
    const row = y * w;
    for (let x = x0; x < x1; x++) {
      const v = data[row + x];
      const l = data[row + x - d], r = data[row + x + d];
      if ((l < r ? l : r) - v >= T) { px.push(x); py.push(y); }
    }
  }
  const n = px.length;
  if (n < span) return { lines: [], spacing: 0, slope: 0 };

  // 2. Sheared projections: try small rotations and keep the one giving the sharpest column profile.
  const ym = (y0 + y1) / 2;
  const hist = new Float64Array(w + 2);
  const project = (s) => {
    hist.fill(0);
    for (let i = 0; i < n; i++) {
      const b = Math.round(px[i] - s * (py[i] - ym));
      if (b >= 0 && b < w) hist[b]++;
    }
    let score = 0;
    for (let b = 0; b < w; b++) score += hist[b] * hist[b];
    return score;
  };
  let best = 0, bestScore = -1;
  const scan = (from, to, step) => {
    for (let s = from; s <= to + 1e-9; s += step) {
      const sc = project(s);
      if (sc > bestScore) { bestScore = sc; best = s; }
    }
  };
  scan(-opts.maxSlope, opts.maxSlope, 0.002);
  scan(best - 0.002, best + 0.002, 0.00025);
  project(best);

  // 3. Peaks: columns where the ridge runs along most of the map height.
  const cover = new Float64Array(w);
  for (let b = 1; b < w - 1; b++) cover[b] = (hist[b - 1] + hist[b] + hist[b + 1]) / span;
  const findPeaks = (minCover) => {
    const peaks = [];
    for (let b = 2; b < w - 2; b++) {
      const c = cover[b];
      if (c < minCover) continue;
      let isMax = true;
      for (let k = -4; k <= 4; k++) if (k && cover[b + k] > c) { isMax = false; break; }
      if (!isMax) continue;
      if (peaks.length && b - peaks[peaks.length - 1].b <= 4) continue;
      // sub-bin position by centroid
      let sw = 0, sp = 0;
      for (let k = -2; k <= 2; k++) { sw += hist[b + k]; sp += hist[b + k] * (b + k); }
      peaks.push({ b, pos: sw ? sp / sw : b, cover: c });
    }
    return peaks;
  };
  let peaks = findPeaks(opts.minCover);
  if (peaks.length < 3) peaks = findPeaks(opts.minCover * 0.6);
  if (!peaks.length) return { lines: [], spacing: 0, slope: best };

  // 4. Keep the peaks that sit on one evenly spaced ladder (drops frame edges, legend boxes, text).
  const ladder = pickLadder(peaks.map((p) => p.pos), opts.minSpacing / f);
  const chosen = ladder.members.map((m) => ({ ...peaks[m.i], k: m.k }));

  // 5. Refine each line at full resolution and fit a straight line through it.
  const lines = [];
  const fy0 = Math.max(roi.y0, 0), fy1 = Math.min(roi.y1, height);
  for (const p of chosen) {
    const fit = refineLine(gray, width, height, (y) => (p.pos + 0.5 + best * (y / f - ym)) * f - 0.5, fy0, fy1, Math.max(6, 2 * f + 4));
    if (fit) lines.push({ ...fit, k: p.k, cover: p.cover });
  }
  lines.sort((p, q) => p.a + p.b * (fy0 + fy1) / 2 - (q.a + q.b * (fy0 + fy1) / 2));
  return { lines, spacing: ladder.spacing * f, slope: best };
}

/** Choose the arithmetic progression (offset + k * spacing) that explains the most peaks. */
export function pickLadder(pos, minSpacing) {
  const n = pos.length;
  if (n <= 2) {
    return { spacing: n === 2 ? pos[1] - pos[0] : 0, members: pos.map((_, i) => ({ i, k: i })) };
  }
  let bestScore = -Infinity, bestRes = null;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      for (let m = 1; m <= 6; m++) {
        const sp = (pos[j] - pos[i]) / m;
        if (sp < minSpacing) break;
        const tol = Math.max(2, 0.03 * sp);
        const members = [];
        const used = new Set();
        for (let q = 0; q < n; q++) {
          const kf = (pos[q] - pos[i]) / sp, k = Math.round(kf);
          if (Math.abs(kf - k) * sp <= tol && !used.has(k)) { members.push({ i: q, k }); used.add(k); }
        }
        if (members.length < 2) continue;
        let kmin = Infinity, kmax = -Infinity;
        for (const mm of members) { if (mm.k < kmin) kmin = mm.k; if (mm.k > kmax) kmax = mm.k; }
        const missing = kmax - kmin + 1 - members.length;
        const score = members.length - 0.75 * missing;
        if (score > bestScore + 1e-9) { bestScore = score; bestRes = { spacing: sp, members, kmin }; }
      }
    }
  }
  if (!bestRes) return { spacing: 0, members: [] };
  // Least-squares refine of the spacing, then renumber from zero.
  const ks = bestRes.members.map((m) => m.k), ps = bestRes.members.map((m) => pos[m.i]);
  const mk = ks.reduce((s, v) => s + v, 0) / ks.length, mp = ps.reduce((s, v) => s + v, 0) / ps.length;
  let num = 0, den = 0;
  for (let i = 0; i < ks.length; i++) { num += (ks[i] - mk) * (ps[i] - mp); den += (ks[i] - mk) ** 2; }
  const spacing = den ? num / den : bestRes.spacing;
  return { spacing, members: bestRes.members.map((m) => ({ i: m.i, k: m.k - bestRes.kmin })) };
}

/** Follow one line down the image at full resolution; return x = a + b*y by robust least squares. */
function refineLine(gray, width, height, predict, y0, y1, halfWin) {
  const samples = 48, r = 6;
  const ys = [], xs = [];
  const prof = new Float64Array(2 * halfWin + 1);
  for (let s = 0; s < samples; s++) {
    const y = Math.round(y0 + (s + 0.5) * (y1 - y0) / samples);
    if (y - r < 0 || y + r >= height) continue;
    const xc = Math.round(predict(y));
    if (xc - halfWin < 0 || xc + halfWin >= width) continue;
    prof.fill(0);
    for (let dy = -r; dy <= r; dy++) {
      const row = (y + dy) * width + xc - halfWin;
      for (let i = 0; i < prof.length; i++) prof[i] += gray[row + i];
    }
    let minI = 0, sorted = Array.from(prof).sort((p, q) => p - q);
    const bg = sorted[Math.floor(sorted.length * 0.75)] / (2 * r + 1);
    for (let i = 0; i < prof.length; i++) { prof[i] = bg - prof[i] / (2 * r + 1); if (prof[i] > prof[minI]) minI = i; }
    const peak = prof[minI];
    if (peak < 14) continue; // no clear line here (gap, or crossing something dark)
    let lo = minI, hi = minI;
    while (lo > 0 && prof[lo - 1] > 0.4 * peak) lo--;
    while (hi < prof.length - 1 && prof[hi + 1] > 0.4 * peak) hi++;
    if (hi - lo > halfWin) continue; // too wide to be a line
    let sw = 0, sp = 0;
    for (let i = lo; i <= hi; i++) { sw += prof[i]; sp += prof[i] * i; }
    ys.push(y); xs.push(xc - halfWin + sp / sw);
  }
  if (ys.length < samples * 0.35) return null;
  let keep = ys.map((_, i) => i), a = 0, b = 0, rms = 0;
  for (let it = 0; it < 6; it++) {
    const m = keep.length;
    let sy = 0, sx = 0;
    for (const i of keep) { sy += ys[i]; sx += xs[i]; }
    const my = sy / m, mx = sx / m;
    let num = 0, den = 0;
    for (const i of keep) { num += (ys[i] - my) * (xs[i] - mx); den += (ys[i] - my) ** 2; }
    b = den ? num / den : 0; a = mx - b * my;
    let ss = 0;
    const res = keep.map((i) => { const e = xs[i] - (a + b * ys[i]); ss += e * e; return Math.abs(e); });
    rms = Math.sqrt(ss / m);
    const thr = Math.max(1.0, 2.5 * rms);
    const next = keep.filter((_, q) => res[q] <= thr);
    if (next.length === keep.length || next.length < samples * 0.3) break;
    keep = next;
  }
  return { a, b, support: keep.length / samples, rms, from: ys[keep[0]], to: ys[keep[keep.length - 1]] };
}

/**
 * Detect the coordinate grid.
 * @returns {{vertical: Array, horizontal: Array, spacingV: number, spacingH: number, skewDeg: number}}
 *   vertical[i]   = {a, b, k, support}  with x = a + b*y, ordered left to right, k = ladder index
 *   horizontal[i] = {a, b, k, support}  with y = a + b*x, ordered top to bottom
 */
export function detectGrid(gray, width, height, roi = null, options = {}) {
  const opts = { detectSize: 2400, contrast: 24, maxSlope: 0.06, minCover: 0.45, minSpacing: 40, ...options };
  const R = roi || { x0: 0, y0: 0, x1: width, y1: height };
  const v = detectVertical(gray, width, height, R, opts);
  const t = transpose(gray, width, height);
  const hRes = detectVertical(t, height, width, { x0: R.y0, y0: R.x0, x1: R.y1, y1: R.x1 }, opts);
  return {
    vertical: v.lines,
    horizontal: hRes.lines,
    spacingV: v.spacing,
    spacingH: hRes.spacing,
    skewDeg: Math.atan(v.slope) * 180 / Math.PI,
  };
}

/**
 * Give each detected line its coordinate value from a list of labels read off the map margin.
 * labels: [{value, pos}] where pos is the approximate pixel position (x for vertical lines, y for horizontal).
 * Returns {assigned: number, interval: number} and sets line.value on each line it could label.
 */
export function assignValues(lines, labels, linePos) {
  for (const l of lines) l.value = undefined;
  const lab = labels.filter((l) => isFinite(l.value) && isFinite(l.pos));
  if (lines.length < 1 || lab.length < 2) return { assigned: 0, interval: 0 };
  const pos = lines.map(linePos);
  // Robust straight-line relation value = A + B * pos from the labels (RANSAC over pairs).
  let best = null;
  const spacingPx = pos.length > 1 ? Math.abs(pos[pos.length - 1] - pos[0]) / (pos.length - 1) : 0;
  for (let i = 0; i < lab.length; i++) {
    for (let j = i + 1; j < lab.length; j++) {
      const dp = lab[j].pos - lab[i].pos;
      if (Math.abs(dp) < 1) continue;
      const B = (lab[j].value - lab[i].value) / dp;
      if (!B) continue;
      const A = lab[i].value - B * lab[i].pos;
      const tolV = Math.abs(B) * (spacingPx ? spacingPx * 0.3 : 20);
      let inl = 0;
      for (const l of lab) if (Math.abs(l.value - (A + B * l.pos)) <= tolV) inl++;
      if (!best || inl > best.inl) best = { A, B, inl, tolV };
    }
  }
  if (!best || best.inl < 2) return { assigned: 0, interval: 0 };
  const inliers = lab.filter((l) => Math.abs(l.value - (best.A + best.B * l.pos)) <= best.tolV);
  // The printed interval: smallest common step between distinct label values.
  const vals = [...new Set(inliers.map((l) => l.value))].sort((p, q) => p - q);
  let interval = 0;
  for (let i = 1; i < vals.length; i++) {
    const dv = vals[i] - vals[i - 1];
    if (dv > 0 && (!interval || dv < interval)) interval = dv;
  }
  // Lines may be drawn more often than they are labelled; use the line spacing to find the true step.
  if (spacingPx && interval) {
    const perLine = Math.abs(best.B) * spacingPx;
    const ratio = interval / perLine;
    if (ratio > 1.5) interval = interval / Math.round(ratio);
  }
  if (!interval) return { assigned: 0, interval: 0 };
  // Snap every line to the nearest multiple of the interval, anchored on a real label value.
  // Each inlier label votes for the line nearest to it; the offset between labels and lines is then removed.
  let shift = 0, votes = 0;
  for (const l of inliers) {
    let bi = 0;
    for (let i = 1; i < pos.length; i++) if (Math.abs(pos[i] - l.pos) < Math.abs(pos[bi] - l.pos)) bi = i;
    if (spacingPx && Math.abs(pos[bi] - l.pos) > 0.45 * spacingPx) continue;
    shift += l.value - (best.A + best.B * pos[bi]); votes++;
  }
  const A = best.A + (votes ? shift / votes : 0);
  const anchor = vals[0];
  let assigned = 0;
  lines.forEach((line, i) => {
    const raw = A + best.B * pos[i];
    const snapped = anchor + Math.round((raw - anchor) / interval) * interval;
    if (Math.abs(snapped - raw) <= 0.3 * interval) { line.value = snapped; assigned++; }
  });
  // Two lines must never share a value.
  const seen = new Map();
  for (const line of lines) {
    if (line.value === undefined) continue;
    if (seen.has(line.value)) { line.value = undefined; seen.get(line.value).value = undefined; assigned -= 2; } else seen.set(line.value, line);
  }
  return { assigned: Math.max(0, assigned), interval };
}
