// Amano Geospatial — resample a scan into a north-up raster in map coordinates.

/**
 * @param {{width:number,height:number,rgba:Uint8ClampedArray|Uint8Array}} src
 * @param {object} model   result of fitTransform (uses model.forward, model.inv, model.resolution)
 * @param {object} [opts]  {maxPixels, onProgress}
 * @returns {Promise<{width,height,rgba,originX,originY,pixelSize}>}
 */
export async function warpToNorthUp(src, model, opts = {}) {
  const { width: W, height: H } = src;
  const maxPixels = opts.maxPixels || 60e6;
  // Output footprint: the scan's outline carried into map space (edges sampled for curved transforms).
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const steps = 16;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    for (const [x, y] of [[t * W, 0], [t * W, H], [0, t * H], [W, t * H]]) {
      const [X, Y] = model.forward(x - 0.5, y - 0.5);
      if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
    }
  }
  let px = model.resolution;
  let ow = Math.ceil((maxX - minX) / px), oh = Math.ceil((maxY - minY) / px);
  if (ow * oh > maxPixels) {
    const k = Math.sqrt((ow * oh) / maxPixels);
    px *= k; ow = Math.ceil((maxX - minX) / px); oh = Math.ceil((maxY - minY) / px);
  }
  if (!(ow > 0 && oh > 0) || !isFinite(ow * oh)) throw new Error('The transform does not give a usable output size.');
  const out = new Uint8ClampedArray(ow * oh * 4);
  const s = src.rgba, m = model.inv, poly = m.terms === 'poly2';
  const cX = m.coefX, cY = m.coefY;
  const chunk = Math.max(16, Math.floor(2e6 / ow));
  for (let r0 = 0; r0 < oh; r0 += chunk) {
    const r1 = Math.min(oh, r0 + chunk);
    for (let r = r0; r < r1; r++) {
      const Y = maxY - (r + 0.5) * px;
      const v = (Y - m.cy) / m.sy;
      let o = r * ow * 4;
      for (let c = 0; c < ow; c++, o += 4) {
        const X = minX + (c + 0.5) * px;
        const u = (X - m.cx) / m.sx;
        let x = m.ox + cX[0] + cX[1] * u + cX[2] * v;
        let y = m.oy + cY[0] + cY[1] * u + cY[2] * v;
        if (poly) {
          x += cX[3] * u * u + cX[4] * u * v + cX[5] * v * v;
          y += cY[3] * u * u + cY[4] * u * v + cY[5] * v * v;
        }
        if (x < -0.5 || y < -0.5 || x > W - 0.5 || y > H - 0.5) continue; // stays transparent
        let x0 = Math.floor(x), y0 = Math.floor(y);
        let fx = x - x0, fy = y - y0;
        if (x0 < 0) { x0 = 0; fx = 0; } else if (x0 >= W - 1) { x0 = W - 2; fx = 1; }
        if (y0 < 0) { y0 = 0; fy = 0; } else if (y0 >= H - 1) { y0 = H - 2; fy = 1; }
        const i00 = (y0 * W + x0) * 4, i10 = i00 + 4, i01 = i00 + W * 4, i11 = i01 + 4;
        const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
        out[o] = s[i00] * w00 + s[i10] * w10 + s[i01] * w01 + s[i11] * w11;
        out[o + 1] = s[i00 + 1] * w00 + s[i10 + 1] * w10 + s[i01 + 1] * w01 + s[i11 + 1] * w11;
        out[o + 2] = s[i00 + 2] * w00 + s[i10 + 2] * w10 + s[i01 + 2] * w01 + s[i11 + 2] * w11;
        out[o + 3] = 255;
      }
    }
    if (opts.onProgress) { opts.onProgress(r1 / oh); await new Promise((res) => setTimeout(res, 0)); }
  }
  return { width: ow, height: oh, rgba: out, originX: minX, originY: maxY, pixelSize: px };
}
