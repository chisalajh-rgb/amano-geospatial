// Amano Georeferencer — application wiring.
import { Viewer } from './viewer.js';
import { loadImageFile, cropToJpeg, download } from './imageio.js';
import { toGray, detectGrid, assignValues } from './grid.js';
import { fitRobust, chooseTransformType, gcpsFromGrid, MIN_POINTS, median } from './georef.js';
import { allCRS, findCRS, resolveCRS, toWGS84, inAreaOfUse, formatLonLat, crsLabel } from './crs.js';
import * as AI from './ai.js';
import { warpToNorthUp } from './warp.js';
import { writeGeoTIFF } from './tiff.js';
import { buildWorkImage, sampleColor, rgbToLab, extractUnits, wandSelect, latticeToPixel } from './digitize.js';
import { toGeoJSON, writeShapefile, polygonArea, pointsToCSV } from './vector.js';
import { makeZip } from './zip.js';
import { Basemap } from './basemap.js';

const VERSION = '0.1.0-beta';
const $ = (id) => document.getElementById(id);

const S = {
  src: null, gray: null, grid: null, frame: null, ai: null, legendBox: null,
  crs: null, gcps: [], nextId: 1, transformType: 'auto', model: null,
  units: [], work: null, features: [], nextFid: 1,
  tool: 'pan', draft: null, hover: null, log: [], aiLabels: null,
};

const viewer = new Viewer($('view'));
const basemap = new Basemap($('basemap'));
S.view = 'base'; // 'scan' = work on the scan, 'base' = OpenStreetMap with the scan laid over it

// ------------------------------------------------------------------ small UI helpers

function log(msg, level = '') {
  S.log.push({ t: new Date().toISOString(), msg, level });
  const li = document.createElement('li');
  if (level) li.className = level;
  const tm = document.createElement('time');
  tm.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  li.append(tm, document.createTextNode(msg));
  $('log').prepend(li);
}

let toastTimer = 0;
function toast(msg, level = '') {
  const t = $('toast');
  t.textContent = msg; t.className = 'toast ' + level; t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, level === 'bad' ? 9000 : 5000);
}

async function busy(text, fn) {
  $('busy-text').textContent = text; $('busy-bar').style.width = '0%'; $('busy').hidden = false;
  await new Promise((r) => setTimeout(r, 30)); // let the overlay paint
  try { return await fn(); }
  catch (e) { console.error(e); log(e.message || String(e), 'bad'); toast(e.message || String(e), 'bad'); return null; }
  finally { $('busy').hidden = true; }
}
const progress = (text, frac) => { if (text) $('busy-text').textContent = text; if (frac !== undefined) $('busy-bar').style.width = Math.round(frac * 100) + '%'; };
const fmt = (v, d = 2) => (isFinite(v) ? Number(v).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : '–');
const baseName = () => (S.src ? S.src.name.replace(/\.[^.]+$/, '') : 'map');
const mapUnit = () => (S.crs ? (S.crs.kind === 'geographic' ? '°' : S.crs.unit === 'metre' ? 'm' : S.crs.unit) : 'units');

function refreshEnabled() {
  const has = !!S.src, geo = !!S.model;
  for (const id of ['btn-auto', 'btn-detect', 'crs', 'transform', 'tool-gcp', 'btn-legend', 'tool-pick', 'r-tol', 'r-detail', 'attr']) $(id).disabled = !has;
  document.querySelectorAll('.tools .tool').forEach((b) => { b.disabled = !has; });
  $('btn-clear-gcps').disabled = !S.gcps.length;
  $('btn-clear-units').disabled = !S.units.length;
  $('btn-extract').disabled = !has || !S.units.length;
  $('btn-clear-feats').disabled = !S.features.length;
  for (const id of ['ex-all', 'ex-tif', 'ex-points', 'ex-audit']) $(id).disabled = !geo;
  $('ex-world').disabled = !geo || S.model.type === 'poly2';
  $('ex-shp').disabled = $('ex-geojson').disabled = !geo || !S.features.length;
  $('export-note').textContent = !has ? 'Load a map first.' : !geo ? 'Georeference the map first.'
    : `Ready. ${S.crs ? crsLabel(S.crs) : 'No coordinate system set: files will carry coordinates but no CRS.'}`;
  const s = AI.getSettings(), on = AI.aiReady();
  $('ai-chip').textContent = on ? 'Auto: connected' : 'Auto: not connected';
  $('ai-chip').classList.toggle('on', on);
}

function setTool(tool) {
  if (tool !== 'pan' && S.view === 'base' && S.src) setView('scan');
  if (S.draft && tool !== S.tool) S.draft = null;
  S.tool = tool;
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('on', b.dataset.tool === tool));
  $('view').classList.toggle('crosshair', tool !== 'pan');
  const hints = {
    pan: 'Click to add corners. Double-click or press Enter to finish, Esc to cancel.',
    wand: 'Click inside a coloured area to outline it.', polygon: 'Click each corner. Double-click or press Enter to finish, Esc to cancel.',
    line: 'Click along the line. Double-click or press Enter to finish, Esc to cancel.', point: 'Click to place a point.',
    erase: 'Click a feature to delete it.', gcp: 'Click a spot whose coordinates you know, then type them in the table.',
    pick: 'Click on the map inside a unit to sample its colour.',
  };
  $('draw-hint').textContent = hints[tool] || hints.pan;
  viewer.requestDraw();
}

// ------------------------------------------------------------------ basemap view

/** pixel -> [lon, lat], or null if the map cannot be placed on the basemap yet. */
function pixelToLonLat() {
  if (!S.model || !S.crs) return null;
  const tw = toWGS84(S.crs);
  if (!tw) return null;
  return (x, y) => { try { return tw(S.model.forward(x, y)); } catch { return null; } };
}

let basemapStamp = '';
async function syncBasemap(zoom = false) {
  if (!basemap.ok) return;
  const f = pixelToLonLat();
  if (!S.src || !f) { basemap.clear(); basemapStamp = ''; return; }
  const placed = await basemap.setScan(S.src, f);
  if (!placed) { basemap.clear(); basemapStamp = ''; return; }
  basemap.setFeatures(S.features.length ? JSON.parse(geojsonText()) : null, (code) => { const u = unitFor(code); return u ? css(u.rgb) : '#b4612f'; });
  const stamp = S.src.name + '|' + S.crs.code;
  if (zoom || stamp !== basemapStamp) basemap.fit();
  basemapStamp = stamp;
}

function setView(view) {
  if (view === 'base' && !basemap.ok) { toast('The basemap could not be loaded. Check your internet connection and reload.', 'bad'); return; }
  S.view = S.src ? view : 'base';
  const base = S.view === 'base';
  $('view').hidden = base;
  $('view-scan').classList.toggle('on', !base); $('view-base').classList.toggle('on', base);
  document.querySelectorAll('.scan-only').forEach((e) => { e.hidden = base; });
  document.querySelectorAll('.base-only').forEach((e) => { e.hidden = !base; });
  $('status').hidden = base || !S.src;
  if (base) {
    if (S.tool !== 'pan') setTool('pan');
    basemap.resize();
    if (S.src && !pixelToLonLat()) toast(!S.model ? 'Georeference the map and it will appear here on the basemap.' : 'Choose the map\'s coordinate system to place it on the basemap.');
    syncBasemap(true);
  } else { viewer.resize(); }
}

// ------------------------------------------------------------------ loading

async function loadFileCore(file) {
  {
    const src = await loadImageFile(file);
    Object.assign(S, { src, gray: toGray(src.rgba, src.width, src.height), grid: null, frame: null, ai: null, legendBox: null,
      crs: null, gcps: [], nextId: 1, model: null, units: [], work: null, features: [], nextFid: 1, draft: null, aiLabels: null });
    $('crs').value = ''; $('crs-note').textContent = 'Leave empty for a local mine grid.'; $('crs-note').className = 'hint';
    $('assist-form').hidden = true;
    basemap.clear(); basemapStamp = '';
    setView('scan');
    viewer.setImage(src.canvas, src.width, src.height);
    $('empty').hidden = true; $('toolbar').hidden = false; $('status').hidden = false; viewer.resize(); viewer.fit();
    const reduced = src.scale < 0.999 ? ` Reduced from ${src.originalWidth} × ${src.originalHeight} to fit in memory.` : '';
    $('file-info').textContent = `${src.name} · ${src.width} × ${src.height} px.${reduced}`;
    log(`Loaded ${src.name} (${src.width} × ${src.height} px).${reduced}`);
    setTool('pan'); renderGcps(); renderUnits(); renderFeatures(); refreshEnabled();
  }
}
async function loadFile(file) { await busy('Opening the map…', () => loadFileCore(file)); }

async function loadSample() {
  const res = await fetch('sample/sample-map.jpg');
  if (!res.ok) { toast('The sample map could not be loaded.', 'bad'); return; }
  await loadFile(new File([await res.blob()], 'sample-map.jpg', { type: 'image/jpeg' }));
  log('This is a synthetic sample sheet: the geology is invented.');
}

// ------------------------------------------------------------------ grid + georeferencing

const lineAtMid = (l, vertical) => l.a + l.b * (vertical ? S.src.height : S.src.width) / 2;

function frameFromGrid(g) {
  if (!g || g.vertical.length < 2 || g.horizontal.length < 2) return null;
  const xs = g.vertical.map((l) => lineAtMid(l, true)), ys = g.horizontal.map((l) => lineAtMid(l, false));
  const x0 = Math.min(Math.min(...xs), median(g.horizontal.map((l) => l.from)));
  const x1 = Math.max(Math.max(...xs), median(g.horizontal.map((l) => l.to)));
  const y0 = Math.min(Math.min(...ys), median(g.vertical.map((l) => l.from)));
  const y1 = Math.max(Math.max(...ys), median(g.vertical.map((l) => l.to)));
  return { x0: Math.max(0, x0), y0: Math.max(0, y0), x1: Math.min(S.src.width, x1), y1: Math.min(S.src.height, y1) };
}

function runDetect() {
  S.grid = detectGrid(S.gray, S.src.width, S.src.height);
  const g = S.grid, f = frameFromGrid(g);
  if (f) S.frame = f;
  const nv = g.vertical.length, nh = g.horizontal.length;
  if (nv >= 2 && nh >= 2) log(`Found ${nv} vertical and ${nh} horizontal grid lines. The scan is rotated ${fmt(Math.abs(g.skewDeg), 2)}°.`, 'good');
  else log(`Found ${nv} vertical and ${nh} horizontal grid lines, which is too few to use. This sheet may only have tick marks or crosses.`, 'warn');
  viewer.requestDraw();
  return nv >= 2 && nh >= 2;
}

function setGcps(list) {
  S.gcps = list.map((g) => ({ ...g, id: S.nextId++ }));
  refit();
}

function refit() {
  const usable = S.gcps.filter((g) => g.enabled !== false && isFinite(g.mx) && isFinite(g.my));
  let type = S.transformType;
  if (type === 'auto') type = chooseTransformType(usable);
  if (usable.length < MIN_POINTS[type]) type = usable.length >= 3 ? 'affine' : 'similarity';
  S.model = usable.length >= MIN_POINTS[type] ? fitRobust(S.gcps, type) : null;
  if (!S.model) for (const g of S.gcps) g.rejected = false;
  renderGcps(); renderFit(); refreshEnabled(); viewer.requestDraw();
  if (S.view === 'base') syncBasemap();
}

function crsCheck() {
  // Returns a warning string if the fitted position is implausible for the chosen CRS.
  if (!S.model || !S.crs) return '';
  const tw = toWGS84(S.crs);
  if (!tw) return '';
  let ll;
  try { ll = tw(S.model.forward(S.src.width / 2, S.src.height / 2)); } catch { return ''; }
  if (!ll || !isFinite(ll[0]) || !isFinite(ll[1]) || Math.abs(ll[1]) > 90) return `These coordinates are not valid in ${S.crs.name}. The coordinate system is probably wrong.`;
  if (inAreaOfUse(S.crs, ll) === false) return `The map centre works out at ${formatLonLat(ll)}, outside the region where ${S.crs.name} is used. Check the coordinate system.`;
  return '';
}

function renderFit() {
  const el = $('fit');
  const m = S.model;
  if (!m) {
    const n = S.gcps.filter((g) => isFinite(g.mx) && isFinite(g.my)).length;
    el.hidden = !S.gcps.length;
    el.innerHTML = S.gcps.length ? `<div class="msg">${n} control point${n === 1 ? '' : 's'} with coordinates. At least 2 are needed.</div>` : '';
    return;
  }
  const q = m.rmsPx <= 1.5 ? ['good', 'Good fit'] : m.rmsPx <= 4 ? ['warn', 'Check the points'] : ['bad', 'Poor fit'];
  const rejected = S.gcps.filter((g) => g.rejected).length;
  const names = { similarity: 'Shift, scale, rotate', affine: 'Affine', poly2: 'Polynomial 2' };
  const warn = crsCheck();
  const u = mapUnit();
  el.hidden = false;
  el.innerHTML = `
    <div class="big"><b>${fmt(m.rmsPx, 2)} px</b><span class="k">typical error (RMS), ${fmt(m.rms, S.crs?.kind === 'geographic' ? 6 : 2)} ${u}</span><span class="badge ${q[0]}">${q[1]}</span></div>
    <div><div class="k">Points used</div><div class="v">${m.n}${rejected ? ` <span class="k">(${rejected} set aside)</span>` : ''}</div></div>
    <div><div class="k">Transform</div><div class="v">${names[m.type]}</div></div>
    <div><div class="k">Pixel size</div><div class="v">${fmt(m.resolution, S.crs?.kind === 'geographic' ? 7 : 3)} ${u}</div></div>
    <div><div class="k">Scan rotation</div><div class="v">${fmt(m.rotationDeg, 2)}°</div></div>
    ${warn ? `<div class="msg hint bad">${warn}</div>` : ''}
    ${m.n < 4 ? '<div class="msg hint warn">With fewer than 4 points the error cannot be checked properly. Add more if you can.</div>' : ''}`;
}

function renderGcps() {
  const body = $('gcp-body');
  $('gcp-wrap').hidden = !S.gcps.length;
  body.textContent = '';
  const geo = S.crs?.kind === 'geographic';
  for (const g of S.gcps) {
    const tr = document.createElement('tr');
    if (g.rejected) tr.className = 'rej'; else if (g.enabled === false) tr.className = 'off';
    const res = S.model?.residuals.get(g.id);
    const mk = (key) => {
      const i = document.createElement('input');
      i.type = 'number'; i.step = 'any'; i.value = isFinite(g[key]) ? (geo ? g[key] : +g[key].toFixed(3)) : '';
      i.placeholder = key === 'mx' ? 'X' : 'Y';
      i.addEventListener('change', () => { g[key] = i.value === '' ? NaN : Number(i.value); if (g.source !== 'manual') g.source = 'edited'; refit(); });
      return i;
    };
    const id = document.createElement('td'); id.className = 'id'; id.textContent = g.id; id.title = 'Show on map';
    id.addEventListener('click', () => { viewer.centerOn(g.px, g.py, 1.5); S.hover = g.id; viewer.requestDraw(); });
    const tx = document.createElement('td'); tx.append(mk('mx'));
    const ty = document.createElement('td'); ty.append(mk('my'));
    const te = document.createElement('td'); te.textContent = res ? fmt(res.errPx, 2) : '–'; if (g.rejected) te.title = 'Set aside automatically: it does not agree with the other points';
    const tu = document.createElement('td'); const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = g.enabled !== false;
    cb.addEventListener('change', () => { g.enabled = cb.checked; refit(); }); tu.append(cb);
    const td = document.createElement('td'); const del = document.createElement('button'); del.className = 'del'; del.type = 'button'; del.textContent = '×'; del.title = 'Delete point';
    del.addEventListener('click', () => { S.gcps = S.gcps.filter((q) => q !== g); refit(); }); td.append(del);
    tr.append(id, tx, ty, te, tu, td);
    tr.dataset.id = g.id;
    body.append(tr);
  }
}

async function setCRS(code, why = '') {
  const note = $('crs-note');
  if (!code) { S.crs = null; note.textContent = 'No coordinate system: treated as a local grid.'; note.className = 'hint'; refit(); return true; }
  let crs = findCRS(code);
  if (!crs) { note.textContent = `Looking up EPSG:${code}…`; crs = await resolveCRS(code); }
  if (!crs) { note.textContent = `EPSG:${code} could not be found. Check the number or your connection.`; note.className = 'hint bad'; return false; }
  S.crs = crs;
  $('crs').value = `${crs.code} — ${crs.name}`;
  note.textContent = why || `Units: ${crs.unit}.`; note.className = 'hint';
  refit();
  return true;
}

function gcpsFromLabels(xs, ys) {
  const uniq = (arr) => { const m = new Map(); for (const l of arr) { const e = m.get(l.value) || { s: 0, n: 0 }; e.s += l.pos; e.n++; m.set(l.value, e); } return [...m].map(([value, e]) => ({ value, pos: e.s / e.n })); };
  const X = uniq(xs), Y = uniq(ys), out = [];
  for (const x of X) for (const y of Y) out.push({ px: x.pos, py: y.pos, mx: x.value, my: y.value, enabled: true, rejected: false, source: 'ai-approx' });
  return out.slice(0, 150);
}

/** The automatic pipeline for the loaded map. Throws with a readable message if it cannot finish. */
async function autoGeorefCore({ quiet = false } = {}) {

  {
    const { width: W, height: H } = S.src;
    S.aiCrsConfidence = null;
    const haveLines = S.grid ? S.grid.vertical.length >= 2 && S.grid.horizontal.length >= 2 : runDetect();

    progress('Reading the sheet…', 0.15);
    const [ow, oh] = AI.fitForVision(W, H);
    const overview = { b64: await cropToJpeg(S.src, { x0: 0, y0: 0, w: W, h: H }, ow, oh, 0.88), width: ow, height: oh };
    const a = await AI.analyzeSheet(overview);
    const k = W / ow;
    const sc = (b) => (b ? { x0: b.x0 * k, y0: b.y0 * k, x1: b.x1 * k, y1: b.y1 * k } : null);
    S.ai = { ...a, neatline: sc(a.neatline), legend: sc(a.legend), model: AI.getSettings().model };
    S.legendBox = S.ai.legend;
    log(`Read the sheet${a.title ? `: “${a.title}”` : ''}${a.scaleDenominator ? `, scale 1:${a.scaleDenominator.toLocaleString('en-US')}` : ''}. Grid drawn as ${a.grid.drawnAs}; labels are ${a.grid.labelKind}.`);
    if (a.crs.statedText) log(`Stated on the sheet: “${a.crs.statedText}”`);
    if (a.notes) log(`Note from the reading: ${a.notes}`, 'warn');

    const frame = (haveLines && S.frame) || S.ai.neatline;
    if (!frame) throw new Error('The map frame could not be found. Add control points by hand instead.');
    S.frame = frame;

    progress('Reading the coordinate labels…', 0.45);
    const edges = a.margins.length ? a.margins : ['top', 'bottom', 'left', 'right'];
    const strips = AI.planStrips(frame, W, H, edges);
    for (const s of strips) {
      s.width = Math.max(1, Math.round(s.w * s.scale)); s.height = Math.max(1, Math.round(s.h * s.scale));
      s.b64 = await cropToJpeg(S.src, { x0: s.x0, y0: s.y0, w: s.w, h: s.h }, s.width, s.height, 0.92);
    }
    if (!strips.length) throw new Error('There is no margin around the map frame to read labels from.');
    const labels = await AI.readMargins(strips, a.grid);
    const axes = AI.labelsToAxes(labels, strips);
    S.aiLabels = axes;
    const projected = axes.easting.length >= 2 && axes.northing.length >= 2 && a.grid.labelKind !== 'geographic';
    const xs = projected ? axes.easting : axes.longitude, ys = projected ? axes.northing : axes.latitude;
    log(`Read ${xs.length} ${projected ? 'easting' : 'longitude'} and ${ys.length} ${projected ? 'northing' : 'latitude'} labels from the margins.`);
    if (xs.length < 2 || ys.length < 2) throw new Error('Too few coordinate labels could be read from the margins. Use grid assist or add control points by hand.');

    progress('Fitting the map…', 0.8);
    let gcps = [];
    if (haveLines) {
      const ra = assignValues(S.grid.vertical, xs, (l) => lineAtMid(l, true));
      const rb = assignValues(S.grid.horizontal, ys, (l) => lineAtMid(l, false));
      if (ra.assigned >= 2 && rb.assigned >= 2) {
        gcps = gcpsFromGrid(S.grid.vertical, S.grid.horizontal, 'grid+ai');
        log(`Matched labels to ${ra.assigned} vertical and ${rb.assigned} horizontal lines (interval ${fmt(ra.interval, 0)} × ${fmt(rb.interval, 0)}). ${gcps.length} control points placed on grid intersections.`, 'good');
      } else log('The labels could not be matched to the detected grid lines.', 'warn');
    }
    if (!gcps.length) {
      gcps = gcpsFromLabels(xs, ys);
      log(`Placed ${gcps.length} approximate control points from the label positions. These are rough: zoom in and check them.`, 'warn');
    }

    // coordinate system: first candidate that resolves and matches the kind of labels
    let chosen = null;
    for (const c of a.crs.candidates) {
      const crs = await resolveCRS(c.epsg);
      if (crs && (crs.kind === 'projected') === projected) { chosen = { crs, c }; break; }
    }
    if (chosen) {
      S.crs = chosen.crs;
      $('crs').value = `${chosen.crs.code} — ${chosen.crs.name}`;
      const pct = Math.round(chosen.c.confidence * 100);
      S.aiCrsConfidence = chosen.c.confidence;
      $('crs-note').textContent = `Read from the sheet (${pct}% confident): ${chosen.c.why}`;
      $('crs-note').className = 'hint' + (chosen.c.confidence < 0.6 ? ' warn' : '');
      log(`Coordinate system set to ${crsLabel(chosen.crs)} (${pct}% confident). ${chosen.c.why}`, chosen.c.confidence < 0.6 ? 'warn' : '');
    } else {
      S.crs = null; $('crs').value = '';
      $('crs-note').textContent = 'The coordinate system could not be read from the sheet. Choose it here.'; $('crs-note').className = 'hint warn';
      log('The coordinate system could not be determined from the sheet. Choose it in the Georeference panel.', 'warn');
    }
    setGcps(gcps);
    const m = S.model;
    if (m) {
      log(`Fitted: typical error ${fmt(m.rmsPx, 2)} px (${fmt(m.rms, S.crs?.kind === 'geographic' ? 6 : 2)} ${mapUnit()}), pixel size ${fmt(m.resolution, 3)} ${mapUnit()}.`, m.rmsPx <= 1.5 ? 'good' : 'warn');
      const w = crsCheck(); if (w) log(w, 'bad');
      if (!quiet) toast(m.rmsPx <= 1.5 ? 'Georeferenced. Check the points, then export.' : 'Georeferenced, but the fit is loose. Check the control points.', m.rmsPx <= 1.5 ? 'good' : '');
    }
    log(`Automatic reading: ${AI.usage.calls} requests so far this session.`);
  }
}
async function autoGeoref() {
  if (!AI.aiReady()) { openSettings(); toast('Set up the connection first: this step uses the automatic reading.'); return; }
  await busy('Looking for grid lines…', () => autoGeorefCore());
}

function applyAssist() {
  const e0 = Number($('as-e0').value), de = Number($('as-de').value), n0 = Number($('as-n0').value), dn = Number($('as-dn').value);
  if (![e0, de, n0, dn].every(isFinite) || !de || !dn || $('as-e0').value === '' || $('as-n0').value === '') { toast('Fill in all four values.', 'bad'); return; }
  const g = S.grid;
  const kv = g.vertical[0].k, kh = g.horizontal[0].k;
  g.vertical.forEach((l) => { l.value = e0 + (l.k - kv) * Math.abs(de); });
  g.horizontal.forEach((l) => { l.value = n0 - (l.k - kh) * Math.abs(dn); });
  setGcps(gcpsFromGrid(g.vertical, g.horizontal, 'grid-assist'));
  log(`Grid assist: ${S.gcps.length} control points from the detected lines (first line ${e0}, ${n0}; spacing ${Math.abs(de)} × ${Math.abs(dn)}).`);
}

// ------------------------------------------------------------------ digitizing

function ensureWork() { if (!S.work) S.work = buildWorkImage(S.src, 1800); return S.work; }
function workRoi() {
  const w = ensureWork(), f = w.f, fr = S.frame || { x0: 0, y0: 0, x1: S.src.width, y1: S.src.height };
  const roi = { x0: fr.x0 / f, y0: fr.y0 / f, x1: fr.x1 / f, y1: fr.y1 / f, cx: w.w / 2, cy: w.h / 2 };
  // follow the scan's rotation so the corners of the frame are not clipped
  const g = S.grid;
  if (g && g.vertical.length >= 2 && g.horizontal.length >= 2) { roi.bv = median(g.vertical.map((l) => l.b)); roi.bh = median(g.horizontal.map((l) => l.b)); }
  return roi;
}
const unitFor = (code) => S.units.find((u) => u.code && u.code === code);
const css = (rgb, a = 1) => `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;

function addUnit(code, name, rgb) {
  S.units.push({ code, name, rgb, lab: rgbToLab(rgb[0], rgb[1], rgb[2]) });
}

function renderUnits() {
  const el = $('units'); el.textContent = '';
  S.units.forEach((u, i) => {
    const row = document.createElement('div'); row.className = 'unit';
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = css(u.rgb);
    const code = document.createElement('input'); code.value = u.code; code.placeholder = 'Code'; code.title = 'Unit code';
    code.addEventListener('change', () => { const old = u.code; u.code = code.value.trim(); for (const f of S.features) if (f.props.code === old && f.props.source === 'auto') f.props.code = u.code; renderFeatures(); viewer.requestDraw(); });
    const name = document.createElement('input'); name.value = u.name; name.placeholder = 'Name';
    name.addEventListener('change', () => { u.name = name.value.trim(); for (const f of S.features) if (f.props.code === u.code && f.props.source === 'auto') f.props.name = u.name; });
    const del = document.createElement('button'); del.type = 'button'; del.textContent = '×'; del.title = 'Remove unit';
    del.addEventListener('click', () => { S.units.splice(i, 1); renderUnits(); refreshEnabled(); });
    row.append(sw, code, name, del); el.append(row);
  });
}

function renderFeatures() {
  if (S.view === 'base' && S.src) syncBasemap();
  const el = $('feat-summary'); el.textContent = '';
  const n = { polygon: 0, line: 0, point: 0 };
  const per = new Map();
  for (const f of S.features) { n[f.type]++; if (f.type === 'polygon') per.set(f.props.code || '(no code)', (per.get(f.props.code || '(no code)') || 0) + 1); }
  if (!S.features.length) { el.textContent = 'No features yet.'; return; }
  const head = document.createElement('div');
  head.textContent = `${n.polygon} polygon${n.polygon === 1 ? '' : 's'}, ${n.line} line${n.line === 1 ? '' : 's'}, ${n.point} point${n.point === 1 ? '' : 's'}`;
  head.style.fontWeight = '600'; el.append(head);
  for (const [code, c] of per) {
    const d = document.createElement('div'); d.className = 'u';
    const i = document.createElement('i'); const u = unitFor(code); i.style.background = u ? css(u.rgb) : '#b4612f';
    d.append(i, document.createTextNode(`${code}${u?.name ? ' · ' + u.name : ''}: ${c}`)); el.append(d);
  }
}

async function readLegendAI() {
  if (!AI.aiReady()) { openSettings(); toast('Set up the connection first: this step uses the automatic reading.'); return; }
  await busy('Reading the legend…', async () => {
    const { width: W, height: H } = S.src;
    if (!S.legendBox) {
      const [ow, oh] = AI.fitForVision(W, H);
      const a = await AI.analyzeSheet({ b64: await cropToJpeg(S.src, { x0: 0, y0: 0, w: W, h: H }, ow, oh, 0.88), width: ow, height: oh });
      const k = W / ow;
      if (a.legend) S.legendBox = { x0: a.legend.x0 * k, y0: a.legend.y0 * k, x1: a.legend.x1 * k, y1: a.legend.y1 * k };
      if (!S.ai) S.ai = { ...a, model: AI.getSettings().model };
    }
    if (!S.legendBox) throw new Error('No legend was found on this sheet. Use “Pick a unit colour” and click each unit on the map instead.');
    const pad = 0.02 * Math.max(W, H);
    const b = { x0: Math.max(0, Math.round(S.legendBox.x0 - pad)), y0: Math.max(0, Math.round(S.legendBox.y0 - pad)) };
    b.w = Math.min(W, Math.round(S.legendBox.x1 + pad)) - b.x0; b.h = Math.min(H, Math.round(S.legendBox.y1 + pad)) - b.y0;
    const [cw, ch] = AI.fitForVision(b.w, b.h);
    const entries = await AI.readLegend({ b64: await cropToJpeg(S.src, b, cw, ch, 0.92), width: cw, height: ch });
    const k = b.w / cw;
    let added = 0;
    S.units = [];
    for (const e of entries) {
      if (e.kind !== 'area' || !e.swatch) continue;
      const sw = { x0: b.x0 + e.swatch.x0 * k, y0: b.y0 + e.swatch.y0 * k, x1: b.x0 + e.swatch.x1 * k, y1: b.y0 + e.swatch.y1 * k };
      const mx = (sw.x1 - sw.x0) * 0.2, my = (sw.y1 - sw.y0) * 0.2;
      const rgb = sampleColor(S.src, sw.x0 + mx, sw.y0 + my, sw.x1 - mx, sw.y1 - my);
      if (!rgb) continue;
      addUnit(e.code || `U${S.units.length + 1}`, e.name, rgb); S.units[S.units.length - 1].swatch = sw; added++;
    }
    const others = entries.filter((e) => e.kind !== 'area').map((e) => e.name || e.code);
    log(`Read ${entries.length} legend entries; ${added} colour units added.${others.length ? ` Line and point symbols (${others.join(', ')}) are not extracted automatically yet: draw them by hand.` : ''}`, added ? 'good' : 'warn');
    if (!added) throw new Error('The legend was read but no colour boxes could be sampled. Use “Pick a unit colour” instead.');
    renderUnits(); refreshEnabled(); viewer.requestDraw();
  });
}

const DETAIL = [null, [2.6, 'Coarse'], [1.8, 'Simple'], [1.2, 'Normal'], [0.8, 'Fine'], [0.5, 'Finest']];

async function extract() {
  await busy('Extracting polygons…', async () => {
    const work = ensureWork();
    const tol = Number($('r-tol').value), tolerance = DETAIL[Number($('r-detail').value)][0];
    const { polygons } = extractUnits(work, S.units, workRoi(), { tol, tolerance });
    S.features = S.features.filter((f) => f.props.source !== 'auto');
    for (const p of polygons) {
      const u = S.units[p.label - 1];
      S.features.push({ id: S.nextFid++, type: 'polygon', coords: p.rings.map((r) => r.map((pt) => latticeToPixel(work, pt))), props: { code: u.code, name: u.name, source: 'auto' } });
    }
    log(`Extracted ${polygons.length} polygons for ${S.units.length} units (colour match ${tol}, detail ${DETAIL[Number($('r-detail').value)][1].toLowerCase()}).`, polygons.length ? 'good' : 'warn');
    if (!polygons.length) toast('No areas matched those colours. Raise “Colour match” or pick the colours again.');
    $('show-feats').checked = true;
    renderFeatures(); refreshEnabled(); viewer.requestDraw();
  });
}

function attrProps(source) {
  const v = $('attr').value.trim();
  const u = unitFor(v);
  return { code: v, name: u ? u.name : '', source };
}

function pointInRing(x, y, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function featureAt(x, y) {
  const tolPx = 8 / viewer.scale;
  let best = null, bestArea = Infinity;
  for (const f of S.features) {
    if (f.type === 'point') { if (Math.hypot(f.coords[0] - x, f.coords[1] - y) < tolPx * 1.5) return f; }
    else if (f.type === 'line') {
      for (let i = 0; i < f.coords.length - 1; i++) {
        const [ax, ay] = f.coords[i], [bx, by] = f.coords[i + 1];
        const dx = bx - ax, dy = by - ay, t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        if (Math.hypot(ax + t * dx - x, ay + t * dy - y) < tolPx) return f;
      }
    } else if (pointInRing(x, y, f.coords[0]) && !f.coords.slice(1).some((h) => pointInRing(x, y, h))) {
      const a = Math.abs(polygonArea(f.coords));
      if (a < bestArea) { bestArea = a; best = f; }
    }
  }
  return best;
}

function finishDraft() {
  const d = S.draft; S.draft = null;
  if (!d) return;
  const pts = d.pts.filter((p, i) => i === 0 || Math.hypot(p[0] - d.pts[i - 1][0], p[1] - d.pts[i - 1][1]) > 0.5);
  if (d.type === 'polygon' && pts.length >= 3) S.features.push({ id: S.nextFid++, type: 'polygon', coords: [[...pts, pts[0]]], props: attrProps('drawn') });
  else if (d.type === 'line' && pts.length >= 2) S.features.push({ id: S.nextFid++, type: 'line', coords: pts, props: attrProps('drawn') });
  renderFeatures(); refreshEnabled(); viewer.requestDraw();
}

viewer.onClick = (x, y) => {
  if (!S.src) return;
  const inside = x >= -0.5 && y >= -0.5 && x <= S.src.width - 0.5 && y <= S.src.height - 0.5;
  if (S.tool === 'gcp' && inside) {
    const g = { id: S.nextId++, px: x, py: y, mx: NaN, my: NaN, enabled: true, rejected: false, source: 'manual' };
    S.gcps.push(g); refit();
    const row = $('gcp-body').querySelector(`tr[data-id="${g.id}"] input`);
    if (row) { row.scrollIntoView({ block: 'nearest' }); row.focus(); }
  } else if (S.tool === 'pick' && inside) {
    const rgb = sampleColor(S.src, x - 4, y - 4, x + 5, y + 5);
    if (rgb) { addUnit(`U${S.units.length + 1}`, '', rgb); renderUnits(); refreshEnabled(); log(`Sampled a unit colour at pixel ${Math.round(x)}, ${Math.round(y)}.`); }
  } else if (S.tool === 'wand' && inside) {
    const work = ensureWork();
    const p = wandSelect(work, (x + 0.5) / work.f, (y + 0.5) / work.f, { x0: 0, y0: 0, x1: work.w, y1: work.h }, { tol: Number($('r-tol').value), tolerance: DETAIL[Number($('r-detail').value)][0] });
    if (!p) { toast('Nothing to outline there.'); return; }
    S.features.push({ id: S.nextFid++, type: 'polygon', coords: p.rings.map((r) => r.map((pt) => latticeToPixel(work, pt))), props: attrProps('wand') });
    renderFeatures(); refreshEnabled();
  } else if ((S.tool === 'polygon' || S.tool === 'line') && inside) {
    if (!S.draft) S.draft = { type: S.tool, pts: [] };
    S.draft.pts.push([x, y]);
  } else if (S.tool === 'point' && inside) {
    S.features.push({ id: S.nextFid++, type: 'point', coords: [x, y], props: attrProps('drawn') });
    renderFeatures(); refreshEnabled();
  } else if (S.tool === 'erase') {
    const f = featureAt(x, y);
    if (f) { S.features = S.features.filter((q) => q !== f); renderFeatures(); refreshEnabled(); }
  }
  viewer.requestDraw();
};
viewer.onDblClick = () => { if (S.draft) finishDraft(); };
viewer.onMove = (x, y) => {
  S.cursor = [x, y];
  let t = `Pixel ${Math.round(x)}, ${Math.round(y)}`;
  if (S.model) {
    const [X, Y] = S.model.forward(x, y);
    const geo = S.crs?.kind === 'geographic';
    t += `   ·   ${geo ? `${fmt(X, 6)}, ${fmt(Y, 6)}` : `X ${fmt(X, 1)}  Y ${fmt(Y, 1)}`}`;
    if (!geo && S.crs) { const tw = toWGS84(S.crs); if (tw) { try { const ll = tw([X, Y]); if (isFinite(ll[0]) && Math.abs(ll[1]) <= 90) t += `   ·   ${formatLonLat(ll)}`; } catch { /* ignore */ } } }
  }
  $('status').textContent = t;
  if (S.draft) viewer.requestDraw();
};

// ------------------------------------------------------------------ drawing overlays

viewer.onDraw = (ctx, v) => {
  if (!S.src) return;
  const P = (x, y) => v.toScreen(x, y);
  const { width: W, height: H } = S.src;
  // features
  if ($('show-feats').checked) {
    for (const f of S.features) {
      const u = unitFor(f.props.code);
      const rgb = u ? u.rgb : [180, 97, 47];
      if (f.type === 'polygon') {
        ctx.beginPath();
        for (const ring of f.coords) { ring.forEach((p, i) => { const [sx, sy] = P(p[0], p[1]); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); }); ctx.closePath(); }
        ctx.fillStyle = css(rgb, 0.38); ctx.fill('evenodd');
        ctx.lineWidth = 1.6; ctx.strokeStyle = 'rgba(36,56,47,.95)'; ctx.stroke();
      } else if (f.type === 'line') {
        ctx.beginPath(); f.coords.forEach((p, i) => { const [sx, sy] = P(p[0], p[1]); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
        ctx.lineWidth = 3; ctx.strokeStyle = '#a8402f'; ctx.stroke();
      } else {
        const [sx, sy] = P(f.coords[0], f.coords[1]);
        ctx.beginPath(); ctx.arc(sx, sy, 5.5, 0, 7); ctx.fillStyle = '#a8402f'; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.stroke();
        if (f.props.code) { ctx.font = '600 12px Segoe UI, Inter, sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.strokeText(f.props.code, sx + 9, sy + 4); ctx.fillStyle = '#1d241f'; ctx.fillText(f.props.code, sx + 9, sy + 4); }
      }
    }
    for (const u of S.units) if (u.swatch) { const [x0, y0] = P(u.swatch.x0, u.swatch.y0), [x1, y1] = P(u.swatch.x1, u.swatch.y1); ctx.setLineDash([4, 3]); ctx.lineWidth = 1.5; ctx.strokeStyle = '#24382f'; ctx.strokeRect(x0, y0, x1 - x0, y1 - y0); ctx.setLineDash([]); }
  }
  // grid lines
  if ($('show-grid').checked && S.grid) {
    const fr = S.frame || { x0: 0, y0: 0, x1: W, y1: H };
    ctx.lineWidth = 1.5; ctx.font = '600 11px Segoe UI, Inter, sans-serif';
    const lab = (txt, sx, sy) => { const w = ctx.measureText(txt).width + 8; ctx.fillStyle = 'rgba(36,56,47,.9)'; ctx.fillRect(sx - w / 2, sy - 8, w, 16); ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(txt, sx, sy); ctx.textAlign = 'start'; ctx.textBaseline = 'alphabetic'; };
    for (const l of S.grid.vertical) {
      const a = P(l.a + l.b * fr.y0, fr.y0), b = P(l.a + l.b * fr.y1, fr.y1);
      ctx.strokeStyle = l.value !== undefined ? 'rgba(180,97,47,.95)' : 'rgba(63,107,85,.8)';
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      if (l.value !== undefined && v.scale * S.grid.spacingV > 46) lab(String(l.value), a[0], a[1] - 11);
    }
    for (const l of S.grid.horizontal) {
      const a = P(fr.x0, l.a + l.b * fr.x0), b = P(fr.x1, l.a + l.b * fr.x1);
      ctx.strokeStyle = l.value !== undefined ? 'rgba(180,97,47,.95)' : 'rgba(63,107,85,.8)';
      ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      if (l.value !== undefined && v.scale * S.grid.spacingH > 24) lab(String(l.value), a[0] - 34, a[1]);
    }
  }
  // control points
  if ($('show-gcps').checked) {
    for (const g of S.gcps) {
      const [sx, sy] = P(g.px, g.py);
      if (sx < -20 || sy < -20 || sx > v.cw + 20 || sy > v.ch + 20) continue;
      const col = g.enabled === false ? '#8c8f86' : g.rejected ? '#a8402f' : !isFinite(g.mx) || !isFinite(g.my) ? '#a8741a' : '#3d7a4f';
      ctx.lineWidth = 2; ctx.strokeStyle = '#fff'; ctx.fillStyle = col;
      ctx.beginPath(); ctx.arc(sx, sy, g.id === S.hover ? 8 : 5.5, 0, 7); ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(sx - 10, sy); ctx.lineTo(sx + 10, sy); ctx.moveTo(sx, sy - 10); ctx.lineTo(sx, sy + 10); ctx.lineWidth = 1; ctx.strokeStyle = col; ctx.stroke();
      if (v.scale > 0.35 || S.gcps.length < 20) { ctx.font = '600 11px Segoe UI, Inter, sans-serif'; ctx.lineWidth = 3; ctx.strokeStyle = '#fff'; ctx.strokeText(g.id, sx + 8, sy - 8); ctx.fillStyle = '#1d241f'; ctx.fillText(g.id, sx + 8, sy - 8); }
    }
  }
  // drawing in progress
  if (S.draft && S.draft.pts.length) {
    ctx.beginPath();
    S.draft.pts.forEach((p, i) => { const [sx, sy] = P(p[0], p[1]); if (i) ctx.lineTo(sx, sy); else ctx.moveTo(sx, sy); });
    if (S.cursor) { const [sx, sy] = P(S.cursor[0], S.cursor[1]); ctx.lineTo(sx, sy); }
    ctx.lineWidth = 2; ctx.strokeStyle = '#b4612f'; ctx.setLineDash([6, 4]); ctx.stroke(); ctx.setLineDash([]);
    for (const p of S.draft.pts) { const [sx, sy] = P(p[0], p[1]); ctx.fillStyle = '#fff'; ctx.strokeStyle = '#b4612f'; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fill(); ctx.stroke(); }
  }
};

// ------------------------------------------------------------------ exports

function mapFeatures() {
  const fwd = (p) => S.model.forward(p[0], p[1]);
  return S.features.map((f) => {
    const props = { code: f.props.code || '', name: f.props.name || '', source: f.props.source || '' };
    let coords;
    if (f.type === 'point') coords = fwd(f.coords);
    else if (f.type === 'line') { coords = f.coords.map(fwd); let len = 0; for (let i = 1; i < coords.length; i++) len += Math.hypot(coords[i][0] - coords[i - 1][0], coords[i][1] - coords[i - 1][1]); props.length = len; }
    else { coords = f.coords.map((r) => r.map(fwd)); props.area = polygonArea(coords); }
    return { id: f.id, type: f.type, coords, props };
  });
}

function shapefileEntries() {
  const feats = mapFeatures(), files = [];
  const base = [{ name: 'code', type: 'C', len: 24 }, { name: 'name', type: 'C', len: 80 }, { name: 'source', type: 'C', len: 12 }];
  const layers = [['polygon', 'polygons', [...base, { name: 'area', type: 'N', len: 19, dec: 3 }]], ['line', 'lines', [...base, { name: 'length', type: 'N', len: 19, dec: 3 }]], ['point', 'points', base]];
  for (const [type, name, fields] of layers) {
    const sel = feats.filter((f) => f.type === type);
    if (!sel.length) continue;
    const s = writeShapefile(type, sel, fields), n = `${baseName()}_${name}`;
    files.push({ name: `${n}.shp`, data: s.shp }, { name: `${n}.shx`, data: s.shx }, { name: `${n}.dbf`, data: s.dbf }, { name: `${n}.cpg`, data: s.cpg });
    if (S.crs?.wkt) files.push({ name: `${n}.prj`, data: S.crs.wkt });
  }
  return files;
}

function geojsonText() {
  const feats = mapFeatures();
  const tw = S.crs ? toWGS84(S.crs) : null;
  if (tw) return JSON.stringify(toGeoJSON(feats, { project: tw, decimals: 7 }));
  return JSON.stringify(toGeoJSON(feats, { decimals: S.crs?.kind === 'geographic' ? 7 : 3, crsName: S.crs ? `EPSG:${S.crs.code}` : 'local grid (no CRS)' }));
}

function pointsFileText() {
  // QGIS georeferencer format; source coordinates are measured from the image corner with y negative downwards
  const rows = ['mapX,mapY,sourceX,sourceY,enable,dX,dY,residual'];
  const k = 1 / S.src.scale;
  for (const g of S.gcps) {
    if (!isFinite(g.mx) || !isFinite(g.my)) continue;
    const r = S.model.residuals.get(g.id);
    rows.push([g.mx, g.my, ((g.px + 0.5) * k).toFixed(3), (-(g.py + 0.5) * k).toFixed(3), g.enabled !== false && !g.rejected ? 1 : 0, r ? (r.dx / S.model.resolution).toFixed(3) : 0, r ? (r.dy / S.model.resolution).toFixed(3) : 0, r ? r.errPx.toFixed(3) : 0].join(','));
  }
  return rows.join('\n') + '\n';
}

function worldFile() {
  // Six-line world file for the ORIGINAL image (centre of the top-left pixel).
  const m = S.model.affine, s = S.src.scale;
  // working pixel = (original pixel + 0.5) * s - 0.5
  const a = m.a * s, b = m.b * s, d = m.d * s, e = m.e * s;
  const c = m.c + (m.a + m.b) * (0.5 * s - 0.5), f = m.f + (m.d + m.e) * (0.5 * s - 0.5);
  const ext = { jpg: 'jgw', jpeg: 'jgw', png: 'pgw', tif: 'tfw', tiff: 'tfw', webp: 'wld', bmp: 'bpw', gif: 'gfw' }[S.src.type] || 'wld';
  return { ext, text: [a, d, b, e, c, f].map((v) => v.toPrecision(15)).join('\n') + '\n' };
}

function auditObject() {
  const m = S.model;
  return {
    tool: 'Amano Georeferencer', version: VERSION, created: new Date().toISOString(),
    source: { file: S.src.name, bytes: S.src.size, width: S.src.originalWidth, height: S.src.originalHeight, workingWidth: S.src.width, workingHeight: S.src.height },
    crs: S.crs ? { epsg: S.crs.code, name: S.crs.name, proj4: S.crs.proj4 } : null,
    transform: m ? { type: m.type, pointsUsed: m.n, rmsMapUnits: m.rms, rmsPixels: m.rmsPx, pixelSize: m.resolution, rotationDeg: m.rotationDeg, affine: m.affine } : null,
    controlPoints: S.gcps.map((g) => { const r = m?.residuals.get(g.id); return { id: g.id, pixelX: g.px, pixelY: g.py, mapX: g.mx, mapY: g.my, used: g.enabled !== false && !g.rejected, setAside: !!g.rejected, source: g.source, errorPixels: r ? r.errPx : null }; }),
    recognition: S.ai ? { title: S.ai.title, scaleDenominator: S.ai.scaleDenominator, statedText: S.ai.crs?.statedText, crsCandidates: S.ai.crs?.candidates, grid: S.ai.grid, notes: S.ai.notes, requests: AI.usage.calls } : null,
    units: S.units.map((u) => ({ code: u.code, name: u.name, rgb: u.rgb })),
    features: { polygons: S.features.filter((f) => f.type === 'polygon').length, lines: S.features.filter((f) => f.type === 'line').length, points: S.features.filter((f) => f.type === 'point').length },
    activity: S.log,
  };
}

async function buildGeoTIFF() {
  progress('Straightening the map…', 0);
  const warped = await warpToNorthUp(S.src, S.model, { onProgress: (f) => progress(null, f * 0.5) });
  progress('Writing the GeoTIFF…');
  return writeGeoTIFF({ ...warped, epsg: S.crs?.code || null, kind: S.crs?.kind, citation: S.crs?.name || 'Local grid', onProgress: (f) => progress(null, 0.5 + f * 0.5) });
}

const exporters = {
  'ex-tif': () => busy('Building the GeoTIFF…', async () => { const t = await buildGeoTIFF(); download(`${baseName()}_georef.tif`, t, 'image/tiff'); log(`Exported GeoTIFF (${fmt(t.length / 1e6, 1)} MB).`, 'good'); }),
  'ex-shp': () => busy('Writing shapefiles…', async () => { download(`${baseName()}_shapefiles.zip`, makeZip(shapefileEntries()), 'application/zip'); log('Exported shapefiles.', 'good'); }),
  'ex-geojson': () => { download(`${baseName()}_features.geojson`, geojsonText(), 'application/geo+json'); log(`Exported GeoJSON${S.crs && toWGS84(S.crs) ? ' in WGS 84' : ' in map coordinates'}.`, 'good'); },
  'ex-points': () => { download(`${baseName()}.points`, pointsFileText(), 'text/plain'); log('Exported control points (QGIS .points format).', 'good'); },
  'ex-world': () => { const w = worldFile(); const files = [{ name: `${baseName()}.${w.ext}`, data: w.text }]; if (S.crs?.wkt) files.push({ name: `${baseName()}.prj`, data: S.crs.wkt }); download(`${baseName()}_worldfile.zip`, makeZip(files), 'application/zip'); log('Exported world file. Keep it next to the original image, with the same name.', 'good'); },
  'ex-audit': () => { download(`${baseName()}_audit.json`, JSON.stringify(auditObject(), null, 2), 'application/json'); log('Exported audit log.', 'good'); },
  'ex-all': () => busy('Building the export…', async () => {
    const files = [{ name: `${baseName()}_georef.tif`, data: await buildGeoTIFF() }, { name: `${baseName()}.points`, data: pointsFileText() }];
    if (S.model.type !== 'poly2') { const w = worldFile(); files.push({ name: `original-image-sidecar/${baseName()}.${w.ext}`, data: w.text }); if (S.crs?.wkt) files.push({ name: `original-image-sidecar/${baseName()}.prj`, data: S.crs.wkt }); }
    if (S.features.length) { files.push(...shapefileEntries().map((f) => ({ ...f, name: 'vectors/' + f.name }))); files.push({ name: `vectors/${baseName()}_features.geojson`, data: geojsonText() });
      const pts = mapFeatures().filter((f) => f.type === 'point'); if (pts.length) files.push({ name: `vectors/${baseName()}_points.csv`, data: pointsToCSV(pts) }); }
    files.push({ name: `${baseName()}_audit.json`, data: JSON.stringify(auditObject(), null, 2) });
    progress('Packing the files…', 1);
    download(`${baseName()}_amano.zip`, makeZip(files), 'application/zip');
    log(`Exported everything (${files.length} files).`, 'good');
  }),
};


// ------------------------------------------------------------------ batch mode

const B = { files: [], rows: [], running: false, stop: false, dir: null };
const csvCell = (v) => { const t = String(v ?? ''); return /[",\n]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };

function batchRender() {
  const body = $('batch-body'); body.textContent = '';
  B.rows.forEach((r, i) => {
    const tr = document.createElement('tr'); tr.className = r.status;
    const cells = [i + 1, r.file, { queued: 'Waiting', working: r.stage || 'Working…', ok: 'Good', check: 'Check', failed: 'Failed', stopped: 'Not run' }[r.status],
      r.crs || '', r.points ?? '', r.rmsPx != null ? fmt(r.rmsPx, 2) : '', r.note || ''];
    cells.forEach((c, k) => { const td = document.createElement('td'); td.textContent = c; if (k === 2) td.className = 'st'; if (k === 6) td.title = c; tr.append(td); });
    body.append(tr);
  });
  const done = B.rows.filter((r) => ['ok', 'check', 'failed'].includes(r.status)).length;
  const n = (st) => B.rows.filter((r) => r.status === st).length;
  $('batch-progress').textContent = !B.rows.length ? 'No maps chosen yet.'
    : B.running ? `Working: ${done} of ${B.rows.length} done.`
    : done ? `Finished: ${n('ok')} good, ${n('check')} to check, ${n('failed')} failed${n('stopped') ? `, ${n('stopped')} not run` : ''}.`
    : `${B.rows.length} map${B.rows.length === 1 ? '' : 's'} ready.`;
  $('batch-bar').style.width = B.rows.length ? Math.round((100 * done) / B.rows.length) + '%' : '0%';
  $('batch-start').disabled = B.running || !B.rows.some((r) => r.status === 'queued');
  $('batch-stop').hidden = !B.running;
  $('batch-files').disabled = $('batch-folder').disabled = $('batch-crs').disabled = B.running;
  $('batch-summary').disabled = B.running || !done;
}

function batchSummaryCSV() {
  const cols = ['file', 'status', 'note', 'crs_epsg', 'crs_name', 'crs_confidence', 'points_used', 'points_set_aside', 'rms_px', 'rms_map_units', 'pixel_size', 'rotation_deg', 'title', 'scale', 'output'];
  return [cols.join(','), ...B.rows.map((r) => cols.map((c) => csvCell(r.csv?.[c] ?? (c === 'file' ? r.file : c === 'status' ? r.status : c === 'note' ? r.note : ''))).join(','))].join('\n') + '\n';
}

async function batchSave(name, data, mime) {
  if (B.dir) {
    const fh = await B.dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(data instanceof Uint8Array || typeof data === 'string' ? data : new Uint8Array(data));
    await w.close();
  } else download(name, data, mime);
}

/** Judge one finished map: 'ok' only when nothing looks doubtful. */
function batchVerdict() {
  const m = S.model, notes = [];
  if (!m) return { status: 'failed', note: 'Too few control points to fit the map.' };
  if (S.gcps.some((g) => g.source === 'ai-approx')) notes.push('grid lines not found: points are approximate');
  if (m.rmsPx > 4) notes.push(`poor fit (${fmt(m.rmsPx, 1)} px)`); else if (m.rmsPx > 1.5) notes.push(`loose fit (${fmt(m.rmsPx, 1)} px)`);
  if (m.n < 6) notes.push(`only ${m.n} control points`);
  if (!S.crs) notes.push('coordinate system not determined');
  else if (!B.fixedCrs && (S.aiCrsConfidence ?? 0) < 0.6) notes.push(`coordinate system is a guess (${Math.round((S.aiCrsConfidence ?? 0) * 100)}%)`);
  const w = crsCheck(); if (w) notes.push('position does not suit the coordinate system');
  return { status: notes.length ? 'check' : 'ok', note: notes.join('; ') };
}

async function batchRun() {
  if (B.running) return;
  if (!AI.aiReady()) { $('batch').close(); openSettings(); toast('Batch mode needs the automatic reading. Set up the connection first.'); return; }
  const crsText = $('batch-crs').value.trim(), cm = crsText.match(/^(?:epsg:)?\s*(\d{4,6})/i);
  B.fixedCrs = null;
  if (crsText) {
    B.fixedCrs = cm ? await resolveCRS(Number(cm[1])) : null;
    if (!B.fixedCrs) { toast('That coordinate system was not recognised. Pick one from the list or leave the box empty.', 'bad'); return; }
  }
  B.dir = null;
  if ($('batch-folder').checked && window.showDirectoryPicker) {
    try { B.dir = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; } // cancelled
  }
  B.running = true; B.stop = false;
  log(`Batch started: ${B.rows.filter((r) => r.status === 'queued').length} maps${B.fixedCrs ? `, all in ${crsLabel(B.fixedCrs)}` : ''}.`);
  for (let i = 0; i < B.rows.length; i++) {
    const row = B.rows[i];
    if (row.status !== 'queued') continue;
    if (B.stop) { row.status = 'stopped'; continue; }
    const stage = (t) => { row.status = 'working'; row.stage = t; batchRender(); };
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        stage('Opening…');
        await new Promise((r) => setTimeout(r, 30));
        await loadFileCore(B.files[i]);
        stage('Reading the sheet…');
        await autoGeorefCore({ quiet: true });
        if (B.fixedCrs) { S.crs = B.fixedCrs; $('crs').value = `${S.crs.code} — ${S.crs.name}`; refit(); }
        const v = batchVerdict();
        const m = S.model;
        let output = '';
        if (m) {
          stage('Writing GeoTIFF…');
          const base = baseName();
          const tif = await buildGeoTIFF();
          if (B.dir) {
            await batchSave(`${base}_georef.tif`, tif, 'image/tiff');
            await batchSave(`${base}.points`, pointsFileText(), 'text/plain');
            await batchSave(`${base}_audit.json`, JSON.stringify(auditObject(), null, 2), 'application/json');
            output = `${base}_georef.tif`;
          } else {
            await batchSave(`${base}_amano.zip`, makeZip([{ name: `${base}_georef.tif`, data: tif }, { name: `${base}.points`, data: pointsFileText() }, { name: `${base}_audit.json`, data: JSON.stringify(auditObject(), null, 2) }]), 'application/zip');
            output = `${base}_amano.zip`;
          }
        }
        Object.assign(row, { status: v.status, note: v.note, crs: S.crs ? `EPSG:${S.crs.code}` : '', points: m ? m.n : 0, rmsPx: m ? m.rmsPx : null });
        row.csv = { file: row.file, status: v.status, note: v.note, crs_epsg: S.crs?.code ?? '', crs_name: S.crs?.name ?? '', crs_confidence: B.fixedCrs ? 'set by user' : S.aiCrsConfidence ?? '',
          points_used: m ? m.n : 0, points_set_aside: S.gcps.filter((g) => g.rejected).length, rms_px: m ? m.rmsPx.toFixed(3) : '', rms_map_units: m ? m.rms : '', pixel_size: m ? m.resolution : '',
          rotation_deg: m ? m.rotationDeg.toFixed(3) : '', title: S.ai?.title ?? '', scale: S.ai?.scaleDenominator ?? '', output };
        break;
      } catch (e) {
        const msg = e?.message || String(e);
        if (attempt === 0 && /rate-limit|overloaded|529|Could not reach/i.test(msg) && !B.stop) { stage('Waiting to retry…'); await new Promise((r) => setTimeout(r, B.retryMs ?? 30000)); continue; }
        Object.assign(row, { status: 'failed', note: msg }); log(`Batch: ${row.file} failed. ${msg}`, 'bad');
        break;
      }
    }
    batchRender();
  }
  B.running = false;
  const done = B.rows.filter((r) => ['ok', 'check', 'failed'].includes(r.status));
  if (done.length) { try { await batchSave('amano_batch_summary.csv', batchSummaryCSV(), 'text/csv'); } catch { /* the button still offers it */ } }
  const n = (st) => B.rows.filter((r) => r.status === st).length;
  log(`Batch finished: ${n('ok')} good, ${n('check')} to check, ${n('failed')} failed.`, n('failed') ? 'warn' : 'good');
  batchRender();
}

function openBatch() {
  $('batch-folder-row').hidden = !window.showDirectoryPicker;
  batchRender();
  $('batch').showModal();
}

$('btn-batch').addEventListener('click', openBatch);
$('batch-files').addEventListener('change', (e) => {
  B.files = [...e.target.files].filter((f) => /\.(png|jpe?g|webp|tiff?|bmp|gif)$/i.test(f.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
  B.rows = B.files.map((f) => ({ file: f.name, status: 'queued' }));
  batchRender();
});
$('batch-start').addEventListener('click', batchRun);
$('batch-stop').addEventListener('click', () => { B.stop = true; $('batch-progress').textContent = 'Stopping after the current map…'; });
$('batch-summary').addEventListener('click', () => download('amano_batch_summary.csv', batchSummaryCSV(), 'text/csv'));
$('batch-close').addEventListener('click', () => { if (!B.running) $('batch').close(); else toast('Stop the batch first.'); });
$('batch').addEventListener('cancel', (e) => { if (B.running) e.preventDefault(); });

// ------------------------------------------------------------------ settings

function openSettings() {
  const s = AI.getSettings();
  document.querySelectorAll('input[name=mode]').forEach((r) => { r.checked = r.value === s.mode; });
  $('set-key').value = s.apiKey; $('set-proxy').value = s.proxyUrl; $('set-code').value = s.accessCode;
  const sel = $('set-model'); sel.textContent = '';
  for (const m of AI.MODELS) { const o = document.createElement('option'); o.value = m.id; o.textContent = m.label; o.selected = m.id === s.model; sel.append(o); }
  $('settings').showModal();
}

$('settings').addEventListener('close', () => {
  if ($('settings').returnValue !== 'save') return;
  const mode = document.querySelector('input[name=mode]:checked')?.value || 'key';
  const ok = AI.saveSettings({ mode, apiKey: $('set-key').value.trim(), proxyUrl: $('set-proxy').value.trim(), accessCode: $('set-code').value.trim(), model: $('set-model').value });
  if (!ok) toast('Settings could not be saved in this browser. They will be lost when you close the page.', 'bad');
  refreshEnabled();
});
$('set-forget').addEventListener('click', () => { $('set-key').value = ''; });

// ------------------------------------------------------------------ events

$('file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) loadFile(f); e.target.value = ''; });
$('btn-sample').addEventListener('click', loadSample);
for (const el of [$('stage'), $('drop')]) {
  el.addEventListener('dragover', (e) => { e.preventDefault(); el.classList.add('over'); });
  el.addEventListener('dragleave', () => el.classList.remove('over'));
  el.addEventListener('drop', (e) => { e.preventDefault(); el.classList.remove('over'); const f = e.dataTransfer.files[0]; if (f) loadFile(f); });
}
$('btn-auto').addEventListener('click', autoGeoref);
$('btn-detect').addEventListener('click', () => busy('Looking for grid lines…', async () => {
  const ok = runDetect();
  $('assist-form').hidden = !ok;
  if (!ok) toast('No usable grid lines were found. Add control points by hand.');
}));
$('btn-assist').addEventListener('click', applyAssist);
$('crs').addEventListener('change', () => {
  const v = $('crs').value.trim();
  if (!v) { setCRS(null); return; }
  const m = v.match(/^(?:epsg:)?\s*(\d{4,6})/i);
  if (m) setCRS(Number(m[1])); else { $('crs-note').textContent = 'Pick an entry from the list, or type an EPSG number.'; $('crs-note').className = 'hint warn'; }
});
$('transform').addEventListener('change', () => { S.transformType = $('transform').value; refit(); });
$('btn-clear-gcps').addEventListener('click', () => { S.gcps = []; if (S.grid) for (const l of [...S.grid.vertical, ...S.grid.horizontal]) l.value = undefined; refit(); });
$('btn-legend').addEventListener('click', readLegendAI);
$('btn-clear-units').addEventListener('click', () => { S.units = []; renderUnits(); refreshEnabled(); viewer.requestDraw(); });
$('btn-extract').addEventListener('click', extract);
$('btn-clear-feats').addEventListener('click', () => { S.features = []; renderFeatures(); refreshEnabled(); viewer.requestDraw(); });
$('r-tol').addEventListener('input', () => { $('o-tol').textContent = $('r-tol').value; });
$('r-detail').addEventListener('input', () => { $('o-detail').textContent = DETAIL[Number($('r-detail').value)][1]; });
document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(S.tool === b.dataset.tool && b.dataset.tool !== 'pan' ? 'pan' : b.dataset.tool)));
$('tb-fit').addEventListener('click', () => (S.view === 'base' ? basemap.fit() : viewer.fit()));
$('view-scan').addEventListener('click', () => setView('scan'));
$('view-base').addEventListener('click', () => setView('base'));
$('base-opacity').addEventListener('input', () => basemap.setOpacity(Number($('base-opacity').value) / 100));
$('tb-in').addEventListener('click', () => viewer.zoomBy(1.4));
$('tb-out').addEventListener('click', () => viewer.zoomBy(1 / 1.4));
for (const id of ['show-grid', 'show-gcps', 'show-feats']) $(id).addEventListener('change', () => viewer.requestDraw());
for (const [id, fn] of Object.entries(exporters)) $(id).addEventListener('click', fn);
$('btn-settings').addEventListener('click', openSettings);
$('ai-chip').addEventListener('click', openSettings);
window.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea')) return;
  if (e.key === 'Escape') { if (S.draft) { S.draft = null; viewer.requestDraw(); } else setTool('pan'); }
  if (e.key === 'Enter' && S.draft) finishDraft();
});

// coordinate-system list
{
  const dl = $('crs-list');
  $('batch-crs').setAttribute('list', 'crs-list');
  const first = [20935, 20934, 20936, 32735, 32734, 32736, 3988, 3989, 3991, 3987, 4209, 4326];
  const list = allCRS().slice().sort((a, b) => (first.indexOf(a.code) === -1 ? 99 : first.indexOf(a.code)) - (first.indexOf(b.code) === -1 ? 99 : first.indexOf(b.code)) || a.name.localeCompare(b.name));
  for (const c of list) { const o = document.createElement('option'); o.value = `${c.code} — ${c.name}`; dl.append(o); }
}

renderFeatures(); refreshEnabled();
log('Ready. Load a scanned map to begin.');

// Handle for tests and for debugging in the browser console.
window.amano = { state: S, viewer, batch: B, batchRun, basemap, setView, AI, loadFile, autoGeoref, readLegendAI, extract, refit, setCRS, runDetect, exporters, version: VERSION };
