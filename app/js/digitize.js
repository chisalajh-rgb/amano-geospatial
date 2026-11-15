// Amano Geospatial — digitization: turn coloured map units into clean polygons.
//
// Pipeline: shrink the scan to a working image -> classify each pixel by nearest sample colour ->
// bridge thin linework and text -> drop specks -> trace region outlines on the pixel lattice ->
// simplify shared boundaries once, so neighbouring polygons stay perfectly matched.

// ------------------------------------------------------------------ colour

export function rgbToLab(r, g, b) {
  const lin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  const R = lin(r), G = lin(g), B = lin(b);
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const x = f((0.4124 * R + 0.3576 * G + 0.1805 * B) / 0.95047);
  const y = f(0.2126 * R + 0.7152 * G + 0.0722 * B);
  const z = f((0.0193 * R + 0.1192 * G + 0.9505 * B) / 1.08883);
  return [116 * y - 16, 500 * (x - y), 200 * (y - z)];
}

/**
 * Working image: the scan reduced by an integer factor (area average) and lightly smoothed,
 * stored as CIE Lab so colour distances match what the eye sees.
 */
export function buildWorkImage(src, maxDim = 1800) {
  const f = Math.max(1, Math.ceil(Math.max(src.width, src.height) / maxDim));
  const w = Math.floor(src.width / f), h = Math.floor(src.height / f);
  const rgb = new Float32Array(w * h * 3);
  const s = src.rgba, W = src.width, inv = 1 / (f * f);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < f; dy++) {
        let i = ((y * f + dy) * W + x * f) * 4;
        for (let dx = 0; dx < f; dx++, i += 4) { r += s[i]; g += s[i + 1]; b += s[i + 2]; }
      }
      const o = (y * w + x) * 3;
      rgb[o] = r * inv; rgb[o + 1] = g * inv; rgb[o + 2] = b * inv;
    }
  }
  // 3x3 box blur to calm scanner noise and JPEG blocks
  const lab = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if (xx < 0 || xx >= w) continue;
          const o = (yy * w + xx) * 3; r += rgb[o]; g += rgb[o + 1]; b += rgb[o + 2]; n++;
        }
      }
      const L = rgbToLab(r / n, g / n, b / n), o = (y * w + x) * 3;
      lab[o] = L[0]; lab[o + 1] = L[1]; lab[o + 2] = L[2];
    }
  }
  return { w, h, f, lab };
}

/** Median colour of a box on the full-resolution scan (used for legend swatches and picked samples). */
export function sampleColor(src, x0, y0, x1, y1) {
  x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
  x1 = Math.min(src.width, Math.ceil(x1)); y1 = Math.min(src.height, Math.ceil(y1));
  const rs = [], gs = [], bs = [];
  const step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 2000)));
  for (let y = y0; y < y1; y += step) for (let x = x0; x < x1; x += step) {
    const i = (y * src.width + x) * 4; rs.push(src.rgba[i]); gs.push(src.rgba[i + 1]); bs.push(src.rgba[i + 2]);
  }
  if (!rs.length) return null;
  const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1]; };
  return [med(rs), med(gs), med(bs)];
}

// ------------------------------------------------------------------ classification

/**
 * Label every working pixel inside `roi` with the nearest unit colour (1-based), or 0 if nothing is close.
 * units: [{lab:[L,a,b]}], tol: maximum Lab distance.
 */
/** Is working pixel (x,y) inside the frame? The frame may be slightly rotated: bv/bh are the slopes of its sides. */
export function insideRoi(roi, x, y, m = 0) {
  const sx = (roi.bv || 0) * (y - (roi.cy || 0)), sy = (roi.bh || 0) * (x - (roi.cx || 0));
  return x >= roi.x0 + sx + m && x < roi.x1 + sx - m && y >= roi.y0 + sy + m && y < roi.y1 + sy - m;
}

export function classify(work, units, tol, roi) {
  const { w, h, lab } = work;
  const labels = new Uint8Array(w * h);
  const skew = Math.ceil(Math.abs(roi.bv || 0) * h + Math.abs(roi.bh || 0) * w);
  const x0 = Math.max(0, Math.floor(roi.x0) - skew), y0 = Math.max(0, Math.floor(roi.y0) - skew), x1 = Math.min(w, Math.ceil(roi.x1) + skew), y1 = Math.min(h, Math.ceil(roi.y1) + skew);
  const n = units.length, tol2 = tol * tol;
  const UL = units.map((u) => u.lab);
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (!insideRoi(roi, x, y)) continue;
      const o = (y * w + x) * 3, L = lab[o], A = lab[o + 1], B = lab[o + 2];
      let best = 0, bd = tol2;
      for (let k = 0; k < n; k++) {
        const u = UL[k], dL = L - u[0], dA = A - u[1], dB = B - u[2];
        const d = dL * dL + dA * dA + dB * dB;
        if (d < bd) { bd = d; best = k + 1; }
      }
      labels[y * w + x] = best;
    }
  }
  return labels;
}

/**
 * Close gaps left by linework and lettering: labels spread into unlabelled pixels for `gap` steps,
 * then anything that is still next to open, unlabelled ground is pulled back by the same amount.
 * Gaps narrower than about 2*gap vanish; outer edges do not move.
 */
export function closeGaps(labels, w, h, gap) {
  let cur = labels;
  const original = labels.slice();
  for (let it = 0; it < gap; it++) {
    const next = cur.slice();
    let changed = 0;
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (cur[i]) continue;
        const v = (x > 0 && cur[i - 1]) || (x < w - 1 && cur[i + 1]) || (y > 0 && cur[i - w]) || (y < h - 1 && cur[i + w]);
        if (v) { next[i] = v; changed++; }
      }
    }
    cur = next;
    if (!changed) break;
  }
  // erode the "labelled" mask by the same amount
  let mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = cur[i] ? 1 : 0;
  for (let it = 0; it < gap; it++) {
    const next = mask.slice();
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x;
        if (!mask[i]) continue;
        // the image edge does not erode; only genuinely unlabelled neighbours do
        if ((x > 0 && !mask[i - 1]) || (x < w - 1 && !mask[i + 1]) || (y > 0 && !mask[i - w]) || (y < h - 1 && !mask[i + w])) next[i] = 0;
      }
    }
    mask = next;
  }
  for (let i = 0; i < cur.length; i++) if (!original[i] && !mask[i]) cur[i] = 0;
  return cur;
}

/**
 * Remove slivers: any strip of a label thinner than about 2*r+1 pixels is cleared (set to 0).
 * Where two colours blend along a contact, a ribbon of pixels can match a third unit; this drops it
 * so closeGaps() can hand those pixels back to the real neighbours.
 */
export function removeThin(labels, w, h, r) {
  if (r <= 0) return labels;
  let core = labels.slice();
  for (let it = 0; it < r; it++) {
    const next = core.slice();
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x, L = core[i];
        if (!L) continue;
        if (x === 0 || x === w - 1 || y === 0 || y === h - 1 ||
            core[i - 1] !== L || core[i + 1] !== L || core[i - w] !== L || core[i + w] !== L) next[i] = 0;
      }
    }
    core = next;
  }
  for (let it = 0; it < r; it++) {
    const next = core.slice();
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        const i = row + x, L = labels[i];
        if (!L || core[i]) continue;
        if ((x > 0 && core[i - 1] === L) || (x < w - 1 && core[i + 1] === L) || (y > 0 && core[i - w] === L) || (y < h - 1 && core[i + w] === L)) next[i] = L;
      }
    }
    core = next;
  }
  return core;
}

/** 4-connected components. Returns {comp:Int32Array (0-based ids), count, label[], area[]}. */
export function components(labels, w, h) {
  const comp = new Int32Array(w * h).fill(-1);
  const label = [], area = [];
  const stack = new Int32Array(w * h);
  let count = 0;
  for (let s = 0; s < labels.length; s++) {
    if (comp[s] !== -1) continue;
    const L = labels[s];
    let top = 0, a = 0;
    stack[top++] = s; comp[s] = count;
    while (top) {
      const i = stack[--top]; a++;
      const x = i % w;
      if (x > 0 && comp[i - 1] === -1 && labels[i - 1] === L) { comp[i - 1] = count; stack[top++] = i - 1; }
      if (x < w - 1 && comp[i + 1] === -1 && labels[i + 1] === L) { comp[i + 1] = count; stack[top++] = i + 1; }
      if (i >= w && comp[i - w] === -1 && labels[i - w] === L) { comp[i - w] = count; stack[top++] = i - w; }
      if (i + w < labels.length && comp[i + w] === -1 && labels[i + w] === L) { comp[i + w] = count; stack[top++] = i + w; }
    }
    label.push(L); area.push(a); count++;
  }
  return { comp, count, label, area };
}

/** Merge specks (and small unlabelled holes) into whichever neighbour they share the longest border with. */
export function removeSmall(labels, w, h, minArea, roi) {
  for (let pass = 0; pass < 3; pass++) {
    const cc = components(labels, w, h);
    const small = [];
    for (let c = 0; c < cc.count; c++) if (cc.area[c] < minArea) small.push(c);
    if (!small.length) break;
    const isSmall = new Uint8Array(cc.count); for (const c of small) isSmall[c] = 1;
    const votes = new Map(); // comp -> Map(label -> border length)
    const touchesEdge = new Uint8Array(cc.count);
    const vote = (c, L) => { let m = votes.get(c); if (!m) votes.set(c, (m = new Map())); m.set(L, (m.get(L) || 0) + 1); };
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, c = cc.comp[i];
        if (!isSmall[c]) continue;
        if (!insideRoi(roi, x, y, 1)) touchesEdge[c] = 1;
        if (x > 0 && cc.comp[i - 1] !== c) vote(c, labels[i - 1]);
        if (x < w - 1 && cc.comp[i + 1] !== c) vote(c, labels[i + 1]);
        if (y > 0 && cc.comp[i - w] !== c) vote(c, labels[i - w]);
        if (y < h - 1 && cc.comp[i + w] !== c) vote(c, labels[i + w]);
      }
    }
    const target = new Int16Array(cc.count).fill(-1);
    let any = false;
    for (const c of small) {
      const m = votes.get(c); if (!m) continue;
      if (cc.label[c] === 0 && touchesEdge[c]) continue; // open ground at the frame stays open
      let bestL = -1, bestN = 0;
      for (const [L, n] of m) if (n > bestN) { bestN = n; bestL = L; }
      if (bestL >= 0 && bestL !== cc.label[c]) { target[c] = bestL; any = true; }
    }
    if (!any) break;
    for (let i = 0; i < labels.length; i++) { const t = target[cc.comp[i]]; if (t >= 0) labels[i] = t; }
  }
  return labels;
}

// ------------------------------------------------------------------ vectorisation

function simplifyOpen(pts, tol) {
  // Douglas-Peucker on an open polyline of [x,y]; endpoints are kept.
  const n = pts.length;
  if (n <= 2) return pts.slice();
  const keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const tol2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a][0], ay = pts[a][1], bx = pts[b][0], by = pts[b][1];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy;
    let worst = -1, wd = tol2;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i][0] - ax, py = pts[i][1] - ay;
      let d;
      if (len2 === 0) d = px * px + py * py;
      else { const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2)); const ex = px - t * dx, ey = py - t * dy; d = ex * ex + ey * ey; }
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst !== -1) { keep[worst] = 1; stack.push([a, worst], [worst, b]); }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i]);
  return out;
}

/** Take the stair-steps out of a lattice path before simplifying: average each inner vertex with its neighbours. */
function relax(pts, closed) {
  const n = pts.length;
  if (n < 4) return pts;
  const out = pts.map((p) => [p[0], p[1]]);
  const lo = closed ? 0 : 1, hi = closed ? n : n - 1;
  for (let i = lo; i < hi; i++) {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    out[i] = [(a[0] + 2 * b[0] + c[0]) / 4, (a[1] + 2 * b[1] + c[1]) / 4];
  }
  return out;
}

/**
 * Trace polygons from a label image.
 * @returns {Array<{label:number, rings:number[][][], areaPx:number}>} rings in working-pixel lattice
 *   coordinates (0..w, 0..h); ring 0 is the outline, the rest are holes; every ring is closed.
 */
export function tracePolygons(labels, w, h, { tolerance = 1.2, minArea = 0 } = {}) {
  const cc = components(labels, w, h);
  const comp = cc.comp;
  const VW = w + 1;
  // comp id of the cell with top-left lattice corner (x,y); -1 outside the image
  const cell = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : comp[y * w + x]);
  // Unlabelled ground (label 0) and "outside" count as one background (-1) so its edges are not traced.
  const cid = (x, y) => { const c = cell(x, y); return c === -1 || cc.label[c] === 0 ? -1 : c; };

  // The cell on the right-hand side of a directed edge leaving vertex (x,y). Directions: 0=E 1=S 2=W 3=N.
  const rightCell = (x, y, d) => (d === 0 ? cid(x, y) : d === 1 ? cid(x - 1, y) : d === 2 ? cid(x - 1, y - 1) : cid(x, y - 1));
  const leftCell = (x, y, d) => (d === 0 ? cid(x, y - 1) : d === 1 ? cid(x, y) : d === 2 ? cid(x - 1, y) : cid(x - 1, y - 1));
  const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
  const visited = new Uint8Array(VW * (h + 1));

  const isJunction = (x, y) => {
    const a = cid(x - 1, y - 1), b = cid(x, y - 1), c = cid(x - 1, y), d = cid(x, y);
    const s = new Set([a, b, c, d]);
    if (s.size >= 3) return true;
    return s.size === 2 && a === d && b === c && a !== b;
  };

  const arcCache = new Map();
  const simplifyArc = (verts, closed) => {
    // verts: lattice vertex ids along the arc (open: endpoints are junctions; closed: a loop without junctions)
    let pts = verts.map((v) => [v % VW, Math.floor(v / VW)]);
    if (closed) {
      pts = relax(pts, true);
      // split the loop at its two most distant points so Douglas-Peucker has fixed ends
      let far = 0, fd = -1;
      for (let i = 1; i < pts.length; i++) { const d = (pts[i][0] - pts[0][0]) ** 2 + (pts[i][1] - pts[0][1]) ** 2; if (d > fd) { fd = d; far = i; } }
      const a = simplifyOpen(pts.slice(0, far + 1), tolerance);
      const b = simplifyOpen([...pts.slice(far), pts[0]], tolerance);
      return [...a, ...b.slice(1)]; // closed: first === last
    }
    return simplifyOpen(relax(pts, false), tolerance);
  };
  const arcFor = (verts) => {
    // canonical orientation so both neighbours get identical geometry
    const n = verts.length;
    const a = verts[0], a2 = verts[1], b = verts[n - 1], b2 = verts[n - 2];
    const fwd = a < b || (a === b && a2 <= b2);
    const key = fwd ? a + ':' + a2 : b + ':' + b2;
    let pts = arcCache.get(key);
    if (!pts) { pts = simplifyArc(fwd ? verts : verts.slice().reverse(), false); arcCache.set(key, pts); }
    return fwd ? pts : pts.slice().reverse();
  };
  const loopFor = (verts) => {
    // verts: cyclic list without repetition of the first vertex
    const n = verts.length;
    let m = 0;
    for (let i = 1; i < n; i++) if (verts[i] < verts[m]) m = i;
    const next = verts[(m + 1) % n], prev = verts[(m - 1 + n) % n];
    const fwd = next <= prev;
    const key = 'L' + verts[m] + ':' + (fwd ? next : prev);
    let pts = arcCache.get(key);
    if (!pts) {
      const canon = [];
      for (let i = 0; i < n; i++) canon.push(verts[(fwd ? m + i : m - i + n) % n]);
      pts = simplifyArc(canon, true);
      arcCache.set(key, pts);
    }
    return fwd ? pts : pts.slice().reverse();
  };

  const byComp = new Map();
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      const v = y * VW + x;
      for (let d = 0; d < 4; d++) {
        if (visited[v] & (1 << d)) continue;
        const c = rightCell(x, y, d);
        if (c === -1 || leftCell(x, y, d) === c) continue; // not a boundary edge of a labelled region
        // follow the ring with region c on the right
        const ring = [];
        let cx = x, cy = y, cd = d;
        for (;;) {
          const cv = cy * VW + cx;
          visited[cv] |= 1 << cd;
          ring.push(cv);
          cx += DX[cd]; cy += DY[cd];
          let nd = -1;
          for (const turn of [1, 0, 3]) { // right, straight, left
            const t = (cd + turn) & 3;
            if (rightCell(cx, cy, t) === c && leftCell(cx, cy, t) !== c) { nd = t; break; }
          }
          if (nd === -1) break; // should not happen on a closed boundary
          cd = nd;
          if (cx === x && cy === y && cd === d) break;
        }
        if (ring.length < 4) continue;
        // split at junctions, simplify each arc once
        const jIdx = [];
        for (let i = 0; i < ring.length; i++) { const rv = ring[i]; if (isJunction(rv % VW, Math.floor(rv / VW))) jIdx.push(i); }
        let pts;
        if (!jIdx.length) pts = loopFor(ring);
        else {
          pts = [];
          for (let j = 0; j < jIdx.length; j++) {
            const from = jIdx[j], to = jIdx[(j + 1) % jIdx.length];
            const verts = [];
            for (let i = from; ; i = (i + 1) % ring.length) { verts.push(ring[i]); if (i === to && verts.length > 1) break; if (verts.length > ring.length + 1) break; }
            const arc = arcFor(verts);
            for (let i = pts.length ? 1 : 0; i < arc.length; i++) pts.push(arc[i]);
          }
        }
        if (pts.length && (pts[0][0] !== pts[pts.length - 1][0] || pts[0][1] !== pts[pts.length - 1][1])) pts.push(pts[0]);
        if (pts.length < 4) continue;
        let area = 0;
        for (let i = 0; i < pts.length - 1; i++) area += pts[i][0] * pts[i + 1][1] - pts[i + 1][0] * pts[i][1];
        area /= 2; // > 0: outline (clockwise on screen), < 0: hole
        let e = byComp.get(c);
        if (!e) byComp.set(c, (e = { outer: null, outerArea: 0, holes: [] }));
        if (area > 0 && area > e.outerArea) { if (e.outer) e.holes.push(e.outer); e.outer = pts; e.outerArea = area; }
        else e.holes.push(pts);
      }
    }
  }
  const out = [];
  for (const [c, e] of byComp) {
    if (!e.outer || cc.area[c] < minArea) continue;
    out.push({ label: cc.label[c], rings: [e.outer, ...e.holes], areaPx: cc.area[c] });
  }
  out.sort((p, q) => q.areaPx - p.areaPx);
  return out;
}

/**
 * Full automatic extraction.
 * units: [{lab}] ; roi: working-pixel box ; returns polygons from tracePolygons (label = unit index + 1).
 */
export function extractUnits(work, units, roi, { tol = 16, gap = 5, minArea = 80, tolerance = 1.2, minWidth = 2 } = {}) {
  let labels = classify(work, units, tol, roi);
  labels = removeThin(labels, work.w, work.h, minWidth);
  labels = closeGaps(labels, work.w, work.h, gap);
  labels = removeSmall(labels, work.w, work.h, minArea, roi);
  return { labels, polygons: tracePolygons(labels, work.w, work.h, { tolerance, minArea }) };
}

/** Magic wand: the connected area whose colour matches the clicked spot. Returns one polygon or null. */
export function wandSelect(work, x, y, roi, { tol = 14, gap = 5, tolerance = 1.2, minHole = 150, grow = 1 } = {}) {
  const { w, h, lab } = work;
  x = Math.max(1, Math.min(w - 2, Math.round(x))); y = Math.max(1, Math.min(h - 2, Math.round(y)));
  let L = 0, A = 0, B = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const o = ((y + dy) * w + x + dx) * 3; L += lab[o]; A += lab[o + 1]; B += lab[o + 2]; }
  const seed = { lab: [L / 9, A / 9, B / 9] };
  let labels = classify(work, [seed], tol, roi);
  labels = closeGaps(labels, w, h, gap);
  // keep only the component under the click
  const cc = components(labels, w, h);
  const c = cc.comp[y * w + x];
  if (cc.label[c] !== 1) return null;
  for (let i = 0; i < labels.length; i++) labels[i] = cc.comp[i] === c ? 1 : 0;
  labels = removeSmall(labels, w, h, minHole, { x0: -1, y0: -1, x1: w + 1, y1: h + 1 }); // fill small holes
  // step out to roughly the middle of the surrounding linework
  for (let it = 0; it < grow; it++) {
    const next = labels.slice();
    for (let yy = 0; yy < h; yy++) for (let xx = 0; xx < w; xx++) {
      const i = yy * w + xx;
      if (labels[i]) continue;
      if ((xx > 0 && labels[i - 1]) || (xx < w - 1 && labels[i + 1]) || (yy > 0 && labels[i - w]) || (yy < h - 1 && labels[i + w])) next[i] = 1;
    }
    labels = next;
  }
  const polys = tracePolygons(labels, w, h, { tolerance });
  return polys.length ? { ...polys[0], seed: seed.lab } : null;
}

/** Working-lattice coordinates -> full-resolution pixel coordinates (integer = pixel centre). */
export function latticeToPixel(work, pt) {
  return [pt[0] * work.f - 0.5, pt[1] * work.f - 0.5];
}
