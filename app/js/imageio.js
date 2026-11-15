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


/** Read a TIFF with geotiff.js, shrinking while reading if it is larger than MAX_PIXELS. */
async function decodeWithGeoTIFF(buf) {
  const G = globalThis.GeoTIFF;
  if (!G) return null;
  const tiff = await G.fromArrayBuffer(buf);
  const n = await tiff.getImageCount();
  let image = null;
  for (let i = 0; i < n; i++) { const im = await tiff.getImage(i); if (!image || im.getWidth() * im.getHeight() > image.getWidth() * image.getHeight()) image = im; }
  const W = image.getWidth(), H = image.getHeight();
  const k = W * H > MAX_PIXELS ? Math.sqrt(MAX_PIXELS / (W * H)) : 1;
  const width = Math.max(1, Math.round(W * k)), height = Math.max(1, Math.round(H * k));
  const opts = { interleave: true };
  if (k < 1) { opts.width = width; opts.height = height; opts.resampleMethod = 'bilinear'; }
  // readRGB handles palettes, greys, YCbCr and CMYK; deep (16-bit) colour is read as plain bands and scaled below
  const bits = Number(image.getBitsPerSample()) || 8, spp = image.getSamplesPerPixel();
  const rgb = bits > 8 && spp >= 3 ? await image.readRasters({ ...opts, samples: [0, 1, 2] }) : await image.readRGB(opts);
  if (rgb.length < width * height * 3) throw new Error('unexpected sample count');
  // bring 16-bit and floating-point samples down to 8 bits
  let div = 1;
  if (!(rgb instanceof Uint8Array) && !(rgb instanceof Uint8ClampedArray)) {
    let max = 0; const step = Math.max(1, Math.floor(rgb.length / 200000));
    for (let i = 0; i < rgb.length; i += step) if (rgb[i] > max) max = rgb[i];
    div = max > 255 ? (max > 4095 ? 257 : max / 255) : max <= 1 ? 1 / 255 : 1;
  }
  const rgba = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; j < rgba.length; i += 3, j += 4) { rgba[j] = rgb[i] / div; rgba[j + 1] = rgb[i + 1] / div; rgba[j + 2] = rgb[i + 2] / div; rgba[j + 3] = 255; }
  return { width, height, rgba, originalWidth: W, originalHeight: H };
}

function decodeWithUTIF(buf) {
  const UTIF = globalThis.UTIF;
  if (!UTIF) throw new Error('The TIFF reader did not load. Reload the page and try again.');
  let ifds;
  try { ifds = UTIF.decode(buf); } catch { throw new Error('This TIFF file could not be read.'); }
  const pages = ifds.filter((d) => d.t256 && d.t257);
  if (!pages.length) throw new Error('This TIFF file contains no image.');
  const ifd = pages.reduce((a, b) => (b.t256[0] * b.t257[0] > a.t256[0] * a.t257[0] ? b : a));
  try { UTIF.decodeImage(buf, ifd); } catch { throw new Error('This TIFF uses a format the reader does not support. Save it as PNG or as an uncompressed TIFF and try again.'); }
  if (!ifd.data || !ifd.data.length) throw new Error('This TIFF uses a compression the reader does not support. Save it as PNG or as an uncompressed TIFF and try again.');
  const raw = UTIF.toRGBA8(ifd);
  let width = ifd.width, height = ifd.height;
  const originalWidth = width, originalHeight = height;
  let rgba = new Uint8ClampedArray(raw.buffer, raw.byteOffset, raw.length);
  for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  if (width * height > MAX_PIXELS) ({ rgba, width, height } = downscaleRGBA(rgba, width, height, Math.ceil(Math.sqrt((width * height) / MAX_PIXELS))));
  return { width, height, rgba, originalWidth, originalHeight };
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
    const buf = await file.arrayBuffer();
    let dec = null;
    // Two readers: geotiff.js copes with tiles, predictors, 16-bit and separate planes; UTIF covers fax-compressed scans.
    try { dec = await decodeWithGeoTIFF(buf); } catch (e) { console.warn('geotiff.js could not read this TIFF, trying UTIF:', e); }
    if (!dec) dec = decodeWithUTIF(buf);
    ({ width, height, rgba, originalWidth, originalHeight } = dec);
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
