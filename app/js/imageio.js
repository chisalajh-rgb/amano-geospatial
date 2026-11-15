// Amano Geospatial — loading scans and cutting pieces out of them (browser only).

export const MAX_PIXELS = 40e6; // larger scans are reduced on load so they fit in browser memory

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

function downscaleRGBA(rgba, w, h, f) {
  const ow = Math.floor(w / f), oh = Math.floor(h / f);
  const out = new Uint8ClampedArray(ow * oh * 4), inv = 1 / (f * f);
  for (let y = 0; y < oh; y++) for (let x = 0; x < ow; x++) {
    let r = 0, g = 0, b = 0;
    for (let dy = 0; dy < f; dy++) { let i = ((y * f + dy) * w + x * f) * 4; for (let dx = 0; dx < f; dx++, i += 4) { r += rgba[i]; g += rgba[i + 1]; b += rgba[i + 2]; } }
    const o = (y * ow + x) * 4; out[o] = r * inv; out[o + 1] = g * inv; out[o + 2] = b * inv; out[o + 3] = 255;
  }
  return { rgba: out, width: ow, height: oh };
}

/**
 * Load a scan. Returns {name, type, width, height, rgba, canvas, originalWidth, originalHeight, scale}
 * where scale = working size / original size (1 unless the scan was reduced).
 */
export async function loadImageFile(file) {
  const name = file.name || 'map';
  const ext = (name.split('.').pop() || '').toLowerCase();
  if (ext === 'pdf' || file.type === 'application/pdf') {
    throw new Error('PDF files are not supported yet. Export the map page as a PNG, JPEG or TIFF image and load that.');
  }
  let width, height, rgba, originalWidth, originalHeight;
  if (ext === 'tif' || ext === 'tiff' || file.type === 'image/tiff') {
    if (!globalThis.UTIF) throw new Error('The TIFF reader did not load. Reload the page and try again.');
    const buf = await file.arrayBuffer();
    let ifds;
    try { ifds = UTIF.decode(buf); } catch { throw new Error('This TIFF file could not be read.'); }
    const pages = ifds.filter((d) => d.t256 && d.t257);
    if (!pages.length) throw new Error('This TIFF file contains no image.');
    const ifd = pages.reduce((a, b) => (b.t256[0] * b.t257[0] > a.t256[0] * a.t257[0] ? b : a));
    UTIF.decodeImage(buf, ifd);
    if (!ifd.data || !ifd.data.length) throw new Error('This TIFF uses a compression the reader does not support. Save it with LZW or no compression and try again.');
    const raw = UTIF.toRGBA8(ifd);
    width = originalWidth = ifd.width; height = originalHeight = ifd.height;
    rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length);
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
    if (width * height > MAX_PIXELS) {
      const f = Math.ceil(Math.sqrt((width * height) / MAX_PIXELS));
      ({ rgba, width, height } = downscaleRGBA(rgba, width, height, f));
    }
  } else {
    let bmp;
    try { bmp = await createImageBitmap(file); } catch { throw new Error('This file could not be opened as an image. Use PNG, JPEG, WebP or TIFF.'); }
    originalWidth = bmp.width; originalHeight = bmp.height;
    let k = 1;
    if (bmp.width * bmp.height > MAX_PIXELS) k = Math.sqrt(MAX_PIXELS / (bmp.width * bmp.height));
    width = Math.max(1, Math.round(bmp.width * k)); height = Math.max(1, Math.round(bmp.height * k));
    const c = makeCanvas(width, height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(bmp, 0, 0, width, height);
    bmp.close?.();
    rgba = ctx.getImageData(0, 0, width, height).data;
  }
  const canvas = makeCanvas(width, height);
  canvas.getContext('2d').putImageData(new ImageData(rgba, width, height), 0, 0);
  return { name, type: ext, size: file.size, width, height, rgba, canvas, originalWidth, originalHeight, scale: width / originalWidth };
}

/** Cut a box out of the scan, optionally resized, as base64 JPEG (no data: prefix). */
export async function cropToJpeg(src, box, outW, outH, quality = 0.9) {
  const c = makeCanvas(outW, outH);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, outW, outH);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src.canvas, box.x0, box.y0, box.w, box.h, 0, 0, outW, outH);
  const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', quality));
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function download(name, data, mime = 'application/octet-stream') {
  const blob = data instanceof Blob ? data : new Blob([data], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
