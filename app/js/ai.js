// Amano Geospatial — AI layer.
// The AI reads what a person would read off the sheet: the stated grid and datum, the coordinate labels
// in the margins, and the legend. Geometry (where the lines actually are) is measured by grid.js, not guessed.
//
// Two ways to reach the model:
//   - "key":   the user's own Anthropic API key, kept in this browser only, sent straight to Anthropic
//   - "proxy": an Amano server endpoint (see /proxy) that holds the key, so visitors need none

export const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Standard (recommended)' },
  { id: 'claude-opus-5-5', label: 'Most careful (slower)' },
  { id: 'claude-haiku-5-5', label: 'Fastest' },
];

const STORE = 'amano.ai.v1';
const DEFAULTS = { mode: 'key', apiKey: '', model: MODELS[0].id, proxyUrl: '', accessCode: '' };

export function getSettings() {
  let saved = {};
  try { saved = JSON.parse(globalThis.localStorage?.getItem(STORE) || '{}'); } catch { /* storage unavailable */ }
  const cfg = globalThis.AMANO_CONFIG || {};
  const s = { ...DEFAULTS, ...saved };
  if (!saved.mode && cfg.proxyUrl) { s.mode = 'proxy'; s.proxyUrl = cfg.proxyUrl; }
  if (!MODELS.some((m) => m.id === s.model)) s.model = MODELS[0].id;
  return s;
}

export function saveSettings(s) {
  try { globalThis.localStorage?.setItem(STORE, JSON.stringify(s)); return true; } catch { return false; }
}

export function aiReady() {
  if (transport !== defaultTransport) return true;
  const s = getSettings();
  return s.mode === 'proxy' ? !!s.proxyUrl : !!s.apiKey;
}

// ------------------------------------------------------------------ transport

async function defaultTransport(body) {
  const s = getSettings();
  let url, headers = { 'content-type': 'application/json' };
  if (s.mode === 'proxy') {
    url = s.proxyUrl;
    if (s.accessCode) headers['x-amano-access'] = s.accessCode;
  } else {
    url = 'https://api.anthropic.com/v1/messages';
    headers['x-api-key'] = s.apiKey;
    headers['anthropic-version'] = '2023-06-01';
    headers['anthropic-dangerous-direct-browser-access'] = 'true';
  }
  let res;
  try {
    res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  } catch (e) {
    throw new Error('Could not reach the recognition service. Check your internet connection' + (s.mode === 'proxy' ? ' and the server address in Settings.' : '.'));
  }
  let data = null;
  try { data = await res.json(); } catch { /* not JSON */ }
  if (!res.ok) {
    const msg = data?.error?.message || `HTTP ${res.status}`;
    if (res.status === 401) throw new Error('The recognition service rejected the key. Check it in Settings. (' + msg + ')');
    if (res.status === 429) throw new Error('The recognition service is rate-limiting requests. Wait a minute and try again. (' + msg + ')');
    throw new Error('The automatic reading failed: ' + msg);
  }
  return data;
}

let transport = defaultTransport;
/** Replace the network call (used by tests). Pass null to restore. */
export function setTransport(fn) { transport = fn || defaultTransport; }

export const usage = { calls: 0, inputTokens: 0, outputTokens: 0 };

async function callClaude({ system, content, maxTokens = 6000 }) {
  const body = { model: getSettings().model, max_tokens: maxTokens, system, messages: [{ role: 'user', content }] };
  const data = await transport(body);
  usage.calls++;
  usage.inputTokens += data?.usage?.input_tokens || 0;
  usage.outputTokens += data?.usage?.output_tokens || 0;
  if (data?.stop_reason === 'refusal') throw new Error('The recognition service declined to read this image.');
  const text = (data?.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  if (!text.trim()) throw new Error('The recognition service returned an empty answer' + (data?.stop_reason === 'max_tokens' ? ' (it ran out of room).' : '.'));
  return extractJSON(text);
}

/** Pull the JSON object out of a model reply, tolerating code fences or stray prose around it. */
export function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [];
  if (fenced) candidates.push(fenced[1]);
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a !== -1 && b > a) candidates.push(text.slice(a, b + 1));
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* try next */ }
  }
  throw new Error('The reading came back in a form that could not be used. Try again.');
}

// ------------------------------------------------------------------ image sizing

/** Largest size (same aspect ratio) the model sees without resizing, so its pixel coordinates are ours. */
export function fitForVision(width, height, maxEdge = 2576, maxTokens = 4784) {
  const fits = (w, h) => Math.ceil(w / 28) * 28 <= maxEdge && Math.ceil(h / 28) * 28 <= maxEdge && Math.ceil(w / 28) * Math.ceil(h / 28) <= maxTokens;
  if (fits(width, height)) return [width, height];
  if (height > width) { const [h, w] = fitForVision(height, width, maxEdge, maxTokens); return [w, h]; }
  const ar = width / height;
  let lo = 1, hi = width;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (fits(mid, Math.max(Math.round(mid / ar), 1))) lo = mid; else hi = mid;
  }
  return [lo, Math.max(Math.round(lo / ar), 1)];
}

const img = (b64) => ({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: b64 } });
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && isFinite(Number(v.replace(/[\s,]/g, ''))) ? Number(v.replace(/[\s,]/g, '')) : null);
const box = (b, sx = 1, sy = 1) => {
  if (!b || typeof b !== 'object') return null;
  const x0 = num(b.x0), y0 = num(b.y0), x1 = num(b.x1), y1 = num(b.y1);
  if ([x0, y0, x1, y1].some((v) => v === null) || x1 <= x0 || y1 <= y0) return null;
  return { x0: x0 * sx, y0: y0 * sy, x1: x1 * sx, y1: y1 * sy };
};

const SYSTEM = 'You are a cartographic analyst inside a map georeferencing tool. You report only what can be read or seen on the scanned sheet. ' +
  'You answer with a single JSON object and nothing else: no explanation, no code fences.';

// ------------------------------------------------------------------ 1. whole-sheet analysis

/**
 * @param {{b64:string,width:number,height:number}} overview  the sheet, already resized with fitForVision
 * @returns normalised result with boxes in overview pixels
 */
export async function analyzeSheet(overview) {
  const prompt = `This image is a scan of a map sheet, ${overview.width} x ${overview.height} pixels. Every position you report must be in pixels of this image: x from the left edge, y from the top edge.

Return this JSON object:
{
  "title": string or null,
  "scale_denominator": number or null,
  "neatline": {"x0":0,"y0":0,"x1":0,"y1":0} or null,
  "grid": {
    "drawn_as": "lines" | "ticks" | "crosses" | "none",
    "label_kind": "projected" | "geographic" | "both" | "none",
    "units": "metres" | "feet" | "yards" | "degrees" | null,
    "interval": number or null
  },
  "crs": {
    "stated_text": string or null,
    "candidates": [ {"epsg": 0, "name": "", "confidence": 0.0, "why": ""} ]
  },
  "margins_with_coordinates": ["top","bottom","left","right"],
  "legend": {"x0":0,"y0":0,"x1":0,"y1":0} or null,
  "notes": string
}

Field meanings:
- neatline: the rectangle bounding the mapped area (the inner frame line), not the paper edge.
- grid.drawn_as: how the coordinate grid appears across the map body. "lines" = full lines crossing the map; "ticks" = only short marks at the frame; "crosses" = small crosses at intersections.
- grid.label_kind: "projected" = eastings/northings in metres, feet or yards; "geographic" = latitude/longitude; "both" if both are labelled.
- grid.interval: spacing between neighbouring labelled grid lines, in the labelled units.
- crs.stated_text: copy, word for word, any text on the sheet naming the projection, grid, zone, datum or spheroid. null if the sheet does not say.
- crs.candidates: up to three EPSG codes for the coordinate system of the LABELLED coordinates, most likely first. Use the stated text first. If the datum is not stated, use the region shown (title, place names, country) and the size of the coordinate values to propose the systems normally used there, give a lower confidence, and say in "why" that the datum is an assumption. Examples: 20935 = Arc 1950 / UTM zone 35S, 32735 = WGS 84 / UTM zone 35S, 4326 = WGS 84 latitude/longitude.
- margins_with_coordinates: which sides of the frame carry coordinate labels.
- legend: a box around the legend (explanation of colours and symbols), or null if there is none.
- notes: anything a person georeferencing this sheet should know (for example a local mine grid, a rotated grid, two overlapping grids, or labels that are hard to read). Empty string if nothing.`;
  const r = await callClaude({ system: SYSTEM, content: [img(overview.b64), { type: 'text', text: prompt }], maxTokens: 4000 });
  const grid = r.grid || {};
  const cands = Array.isArray(r.crs?.candidates) ? r.crs.candidates : [];
  return {
    title: typeof r.title === 'string' ? r.title : null,
    scaleDenominator: num(r.scale_denominator),
    neatline: box(r.neatline),
    grid: {
      drawnAs: ['lines', 'ticks', 'crosses', 'none'].includes(grid.drawn_as) ? grid.drawn_as : 'none',
      labelKind: ['projected', 'geographic', 'both', 'none'].includes(grid.label_kind) ? grid.label_kind : 'none',
      units: typeof grid.units === 'string' ? grid.units : null,
      interval: num(grid.interval),
    },
    crs: {
      statedText: typeof r.crs?.stated_text === 'string' ? r.crs.stated_text : null,
      candidates: cands.map((c) => ({ epsg: num(c.epsg), name: String(c.name || ''), confidence: Math.max(0, Math.min(1, num(c.confidence) ?? 0)), why: String(c.why || '') }))
        .filter((c) => c.epsg && Number.isInteger(c.epsg) && c.epsg > 1000 && c.epsg < 1000000).slice(0, 3),
    },
    margins: Array.isArray(r.margins_with_coordinates) ? r.margins_with_coordinates.filter((m) => ['top', 'bottom', 'left', 'right'].includes(m)) : [],
    legend: box(r.legend),
    notes: typeof r.notes === 'string' ? r.notes : '',
  };
}

// ------------------------------------------------------------------ 2. margin labels

/**
 * @param {Array<{id:string, edge:'top'|'bottom'|'left'|'right', b64:string, width:number, height:number}>} strips
 * @param {{labelKind:string, units:string|null, interval:number|null}} hint
 * @returns {Promise<Array<{strip:string, text:string, value:number, kind:string, pos:number}>>}
 */
export async function readMargins(strips, hint = {}) {
  const content = [];
  for (const s of strips) {
    const axis = s.edge === 'top' || s.edge === 'bottom' ? 'x (pixels from the left edge of this strip)' : 'y (pixels from the top edge of this strip)';
    content.push({ type: 'text', text: `Strip ${s.id}: cut from the ${s.edge.toUpperCase()} margin of the map, ${s.width} x ${s.height} pixels. Report "pos" as ${axis}.` });
    content.push(img(s.b64));
  }
  const hintText = [
    hint.labelKind && hint.labelKind !== 'none' ? `The sheet's coordinate labels are ${hint.labelKind === 'both' ? 'both projected (eastings/northings) and geographic (latitude/longitude)' : hint.labelKind}.` : '',
    hint.units ? `Units: ${hint.units}.` : '',
    hint.interval ? `Neighbouring labelled lines are about ${hint.interval} apart.` : '',
  ].filter(Boolean).join(' ');
  content.push({ type: 'text', text: `The strips above were cut from the margins of one scanned map, along the map frame, so that the coordinate labels can be read. ${hintText}

List every coordinate label printed in each strip. Return this JSON object:
{"strips":[{"id":"T1","labels":[{"text":"","value":0,"kind":"easting","pos":0}]}]}

For each label:
- "text": the label exactly as printed.
- "value": the full coordinate as a plain number in the map's units. Expand abbreviated labels using their neighbours: on a metric grid where one label reads 8 630 000 and the next reads 31, the second is 8631000. Small raised leading digits belong to the number. For latitude and longitude give decimal degrees (degrees + minutes/60 + seconds/3600), negative for South and for West.
- "kind": "easting", "northing", "longitude" or "latitude".
- "pos": where the grid line or tick mark that the label belongs to meets the map frame, in pixels within THAT strip, along the axis named for the strip. If no line or tick is visible, use the centre of the label.

Rules: do not invent labels. Leave out any label you cannot read with confidence. Strips from the top and bottom margins normally carry eastings or longitudes; strips from the left and right margins normally carry northings or latitudes. Ignore sheet numbers, scale-bar numbers and other text that is not a coordinate.` });
  const r = await callClaude({ system: SYSTEM, content, maxTokens: 8000 });
  const out = [];
  for (const s of Array.isArray(r.strips) ? r.strips : []) {
    for (const l of Array.isArray(s.labels) ? s.labels : []) {
      const value = num(l.value), pos = num(l.pos);
      if (value === null || pos === null) continue;
      const kind = ['easting', 'northing', 'longitude', 'latitude'].includes(l.kind) ? l.kind : null;
      if (!kind) continue;
      out.push({ strip: String(s.id), text: String(l.text ?? ''), value, kind, pos });
    }
  }
  return out;
}

// ------------------------------------------------------------------ 3. legend

/**
 * @param {{b64:string,width:number,height:number}} crop  the legend area
 * @returns {Promise<Array<{code:string,name:string,kind:string,swatch:{x0,y0,x1,y1}|null}>>} swatches in crop pixels
 */
export async function readLegend(crop) {
  const prompt = `This image is the legend of a geological or thematic map, ${crop.width} x ${crop.height} pixels. Positions must be in pixels of this image: x from the left edge, y from the top edge.

List every legend entry. Return this JSON object:
{"entries":[{"code":"","name":"","kind":"area","swatch":{"x0":0,"y0":0,"x1":0,"y1":0}}]}

For each entry:
- "code": the short unit code or symbol printed for it (for example "Kd"), or "" if none.
- "name": the description printed next to it.
- "kind": "area" for a colour or pattern box that fills regions of the map, "line" for a line symbol (fault, contact, road), "point" for a point symbol (drill hole, sample, mine).
- "swatch": for "area" entries, a box that lies INSIDE the coloured sample box, clear of its outline and of any text; null for line and point entries.

Do not invent entries. Keep the order in which they are printed.`;
  const r = await callClaude({ system: SYSTEM, content: [img(crop.b64), { type: 'text', text: prompt }], maxTokens: 6000 });
  return (Array.isArray(r.entries) ? r.entries : []).map((e) => ({
    code: String(e.code ?? '').trim(),
    name: String(e.name ?? '').trim(),
    kind: ['area', 'line', 'point'].includes(e.kind) ? e.kind : 'area',
    swatch: box(e.swatch),
  })).filter((e) => e.code || e.name);
}

// ------------------------------------------------------------------ strip planning

/**
 * Plan the margin strips to cut from the scan.
 * @param {{x0,y0,x1,y1}} frame  map frame in full-resolution pixels
 * @returns {Array<{id, edge, x0, y0, w, h, scale}>}  boxes in full-resolution pixels; scale = sent size / real size
 */
export function planStrips(frame, width, height, edges = ['top', 'bottom', 'left', 'right'], maxTilesPerEdge = 3) {
  const fw = frame.x1 - frame.x0, fh = frame.y1 - frame.y0;
  const inset = Math.round(Math.max(12, 0.012 * Math.min(fw, fh)));
  const padAlong = Math.round(0.03 * Math.max(fw, fh));
  const out = [];
  let n = 0;
  const add = (edge, x0, y0, x1, y1, along) => {
    x0 = Math.max(0, Math.round(x0)); y0 = Math.max(0, Math.round(y0));
    x1 = Math.min(width, Math.round(x1)); y1 = Math.min(height, Math.round(y1));
    if (x1 - x0 < 24 || y1 - y0 < 24) return;
    const len = along === 'x' ? x1 - x0 : y1 - y0;
    const tiles = Math.min(maxTilesPerEdge, Math.max(1, Math.ceil(len / 2400)));
    const scale = Math.min(1, (tiles * 2400) / len);
    const step = len / tiles, overlap = tiles > 1 ? Math.round(0.04 * step) : 0;
    for (let t = 0; t < tiles; t++) {
      const a = Math.max(0, Math.round(t * step - overlap)), b = Math.min(len, Math.round((t + 1) * step + overlap));
      out.push(along === 'x'
        ? { id: 'T' + ++n, edge, x0: x0 + a, y0, w: b - a, h: y1 - y0, scale }
        : { id: 'T' + ++n, edge, x0, y0: y0 + a, w: x1 - x0, h: b - a, scale });
    }
  };
  const mTop = Math.min(frame.y0, Math.max(70, 0.07 * height)), mBot = Math.min(height - frame.y1, Math.max(70, 0.07 * height));
  const mLeft = Math.min(frame.x0, Math.max(110, 0.09 * width)), mRight = Math.min(width - frame.x1, Math.max(110, 0.09 * width));
  if (edges.includes('top')) add('top', frame.x0 - padAlong, frame.y0 - mTop, frame.x1 + padAlong, frame.y0 + inset, 'x');
  if (edges.includes('bottom')) add('bottom', frame.x0 - padAlong, frame.y1 - inset, frame.x1 + padAlong, frame.y1 + mBot, 'x');
  if (edges.includes('left')) add('left', frame.x0 - mLeft, frame.y0 - padAlong, frame.x0 + inset, frame.y1 + padAlong, 'y');
  if (edges.includes('right')) add('right', frame.x1 - inset, frame.y0 - padAlong, frame.x1 + mRight, frame.y1 + padAlong, 'y');
  return out;
}

/** Convert labels read from strips into full-resolution positions, split by axis. */
export function labelsToAxes(labels, strips) {
  const byId = new Map(strips.map((s) => [s.id, s]));
  const res = { easting: [], northing: [], longitude: [], latitude: [] };
  for (const l of labels) {
    const s = byId.get(l.strip);
    if (!s) continue;
    const horizontalStrip = s.edge === 'top' || s.edge === 'bottom';
    const xKind = l.kind === 'easting' || l.kind === 'longitude';
    if (horizontalStrip !== xKind) continue; // an easting read off a side margin cannot be placed
    const pos = horizontalStrip ? s.x0 + l.pos / s.scale : s.y0 + l.pos / s.scale;
    res[l.kind].push({ value: l.value, pos, text: l.text, edge: s.edge });
  }
  return res;
}
