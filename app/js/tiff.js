// Amano Geospatial — GeoTIFF writer (RGBA, deflate-compressed, north-up).
// Writes a baseline TIFF with the GeoTIFF tags GIS software needs: pixel size, tie point and CRS code.

async function deflate(bytes) {
  const cs = new CompressionStream('deflate');
  const writer = cs.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buf = await new Response(cs.readable).arrayBuffer();
  return new Uint8Array(buf);
}

/**
 * @param {object} o
 * @param {number} o.width
 * @param {number} o.height
 * @param {Uint8Array|Uint8ClampedArray} o.rgba   width*height*4, alpha 0 = no data
 * @param {number} o.originX   map X of the outer edge of the top-left pixel
 * @param {number} o.originY   map Y of the outer edge of the top-left pixel
 * @param {number} o.pixelSize map units per pixel (square pixels)
 * @param {number|null} o.epsg EPSG code, or null to leave the CRS undefined
 * @param {'projected'|'geographic'} [o.kind]
 * @param {string} [o.citation]
 * @param {(fraction:number)=>void} [o.onProgress]
 * @returns {Promise<Uint8Array>}
 */
export async function writeGeoTIFF(o) {
  const { width, height, rgba } = o;
  const spp = 4, rowBytes = width * spp;
  const rowsPerStrip = Math.max(1, Math.min(height, Math.floor((1 << 20) / rowBytes) || 1));
  const nStrips = Math.ceil(height / rowsPerStrip);
  const strips = [];
  for (let s = 0; s < nStrips; s++) {
    const r0 = s * rowsPerStrip, r1 = Math.min(height, r0 + rowsPerStrip);
    const chunk = new Uint8Array(rgba.buffer, rgba.byteOffset + r0 * rowBytes, (r1 - r0) * rowBytes).slice();
    // Predictor 2: horizontal differencing per sample makes map scans compress far better.
    for (let r = 0; r < r1 - r0; r++) {
      const base = r * rowBytes;
      for (let i = rowBytes - 1; i >= spp; i--) chunk[base + i] = (chunk[base + i] - chunk[base + i - spp]) & 255;
    }
    strips.push(await deflate(chunk));
    if (o.onProgress) o.onProgress((s + 1) / nStrips);
  }

  // --- GeoTIFF keys
  const citation = (o.citation || 'Amano Geospatial') + '|';
  const keys = [];
  const geographic = o.kind === 'geographic';
  if (o.epsg) {
    keys.push([1024, 0, 1, geographic ? 2 : 1]);        // GTModelTypeGeoKey
    keys.push([1025, 0, 1, 1]);                         // GTRasterTypeGeoKey = PixelIsArea
    keys.push([1026, 34737, citation.length, 0]);       // GTCitationGeoKey
    if (geographic) keys.push([2048, 0, 1, o.epsg]);    // GeographicTypeGeoKey
    else keys.push([3072, 0, 1, o.epsg]);               // ProjectedCSTypeGeoKey
  }
  const geoKeyDir = [1, 1, 0, keys.length, ...keys.flat()];

  // --- tags (must be written in ascending order)
  const SHORT = 3, LONG = 4, DOUBLE = 12, ASCII = 2;
  const software = 'Amano Geospatial\0';
  const tags = [
    [256, LONG, [width]],
    [257, LONG, [height]],
    [258, SHORT, [8, 8, 8, 8]],
    [259, SHORT, [8]],                 // Adobe deflate
    [262, SHORT, [2]],                 // RGB
    [273, LONG, null],                 // StripOffsets (filled below)
    [277, SHORT, [spp]],
    [278, LONG, [rowsPerStrip]],
    [279, LONG, strips.map((s) => s.length)],
    [284, SHORT, [1]],
    [305, ASCII, software],
    [317, SHORT, [2]],
    [338, SHORT, [2]],                 // ExtraSamples: unassociated alpha
    [33550, DOUBLE, [o.pixelSize, o.pixelSize, 0]],
    [33922, DOUBLE, [0, 0, 0, o.originX, o.originY, 0]],
  ];
  if (o.epsg) {
    tags.push([34735, SHORT, geoKeyDir]);
    tags.push([34737, ASCII, citation + '\0']);
  }
  const size = { [SHORT]: 2, [LONG]: 4, [DOUBLE]: 8, [ASCII]: 1 };
  const count = (t) => (t[1] === ASCII ? t[2].length : t[0] === 273 ? nStrips : t[2].length);

  // --- layout: header | strips | out-of-line tag data | IFD
  let offset = 8;
  const stripOffsets = strips.map((s) => { const at = offset; offset += s.length + (s.length & 1); return at; });
  tags.find((t) => t[0] === 273)[2] = stripOffsets;
  const dataAt = new Map();
  for (const t of tags) {
    const bytes = count(t) * size[t[1]];
    if (bytes > 4) { dataAt.set(t[0], offset); offset += bytes + (bytes & 1); }
  }
  const ifdAt = offset;
  const total = ifdAt + 2 + tags.length * 12 + 4;
  if (total > 0xfffffff0) throw new Error('The output would be larger than a TIFF file allows (4 GB).');

  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  out[0] = 0x49; out[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, ifdAt, true);
  strips.forEach((s, i) => out.set(s, stripOffsets[i]));
  const put = (t, at) => {
    const v = t[2];
    if (t[1] === ASCII) { for (let i = 0; i < v.length; i++) out[at + i] = v.charCodeAt(i) & 255; return; }
    for (let i = 0; i < v.length; i++) {
      if (t[1] === SHORT) dv.setUint16(at + i * 2, v[i], true);
      else if (t[1] === LONG) dv.setUint32(at + i * 4, v[i], true);
      else dv.setFloat64(at + i * 8, v[i], true);
    }
  };
  dv.setUint16(ifdAt, tags.length, true);
  tags.forEach((t, i) => {
    const e = ifdAt + 2 + i * 12;
    dv.setUint16(e, t[0], true); dv.setUint16(e + 2, t[1], true); dv.setUint32(e + 4, count(t), true);
    if (dataAt.has(t[0])) { dv.setUint32(e + 8, dataAt.get(t[0]), true); put(t, dataAt.get(t[0])); }
    else put(t, e + 8);
  });
  dv.setUint32(ifdAt + 2 + tags.length * 12, 0, true);
  return out;
}
