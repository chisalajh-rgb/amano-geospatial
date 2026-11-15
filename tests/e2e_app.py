"""End-to-end browser test of the app on the sample map.

The AI service is replaced by a stand-in that answers from the sample map's known truth, with
deliberately imprecise label positions and one wrong label, so the test exercises the real
pipeline (grid detection, label matching, fitting, digitizing, exports) without an API key.
It does NOT test how well the real model reads a real scan.

Run from the repository root:  python3 tests/e2e_app.py
"""
import asyncio, io, json, os, subprocess, sys, time, zipfile
import numpy as np, rasterio, shapefile
from playwright.async_api import async_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
truth = json.load(open(os.path.join(ROOT, "tests/fixtures/sample-truth.json")))
OUT = "/tmp/amano-e2e"; os.makedirs(OUT, exist_ok=True)
PORT = 8791

MOCK = """
(truth) => {
  const S = window.amano.state, AI = window.amano.AI;
  let seed = 11; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const reply = (obj) => ({ content: [{ type: 'thinking', thinking: '...' }, { type: 'text', text: 'Here is the result:\\n```json\\n' + JSON.stringify(obj) + '\\n```' }], stop_reason: 'end_turn', usage: { input_tokens: 9000, output_tokens: 700 } });
  window.__calls = [];
  AI.setTransport(async (body) => {
    const parts = body.messages[0].content;
    const text = parts.filter((p) => p.type === 'text').map((p) => p.text).join('\\n');
    const images = parts.filter((p) => p.type === 'image');
    window.__calls.push({ model: body.model, images: images.length, bytes: images.reduce((s, i) => s + i.source.data.length, 0), kind: text.includes('scan of a map sheet') ? 'sheet' : text.includes('strips above') ? 'margins' : 'legend' });
    const W = S.src.width, H = S.src.height;
    if (text.includes('scan of a map sheet')) {
      const m = text.match(/(\\d+) x (\\d+) pixels/); const k = Number(m[1]) / W;
      const b = (a) => ({ x0: a[0] * k, y0: a[1] * k, x1: a[2] * k, y1: a[3] * k });
      return reply({ title: 'SAMPLE GEOLOGICAL SHEET 35S-A', scale_denominator: 25000, neatline: b(truth.frame),
        grid: { drawn_as: 'lines', label_kind: 'projected', units: 'metres', interval: 1000 },
        crs: { stated_text: 'Grid: Universal Transverse Mercator, Zone 35 South. Datum: Arc 1950.', candidates: [
          { epsg: 20935, name: 'Arc 1950 / UTM zone 35S', confidence: 0.93, why: 'The sheet states UTM zone 35 South on the Arc 1950 datum.' },
          { epsg: 32735, name: 'WGS 84 / UTM zone 35S', confidence: 0.05, why: 'Same zone on WGS 84.' }] },
        margins_with_coordinates: ['top', 'bottom', 'left', 'right'], legend: b(truth.legendRegion), notes: '' });
    }
    if (text.includes('strips above')) {
      const strips = AI.planStrips(S.frame, W, H, ['top', 'bottom', 'left', 'right']);
      const out = strips.map((s) => {
        const labels = [];
        if (s.edge === 'top' || s.edge === 'bottom') for (const l of truth.eastingLabels) { const p = (l.x - s.x0) * s.scale; if (p > 0 && p < s.w * s.scale) labels.push({ text: String(l.value), value: l.value, kind: 'easting', pos: p + (rnd() - 0.5) * 50 }); }
        else for (const l of truth.northingLabels) { const p = (l.y - s.y0) * s.scale; if (p > 0 && p < s.h * s.scale) labels.push({ text: String(l.value), value: String(l.value).replace(/(\\d)(?=(\\d{3})+$)/g, '$1 '), kind: 'northing', pos: p + (rnd() - 0.5) * 50 }); }
        return { id: s.id, labels };
      });
      out[0].labels.push({ text: '35S-A', value: 35, kind: 'easting', pos: 400 });   // a misread
      return reply({ strips: out });
    }
    // legend
    const m = text.match(/(\\d+) x (\\d+) pixels/); const cw = Number(m[1]);
    const pad = 0.02 * Math.max(W, H), lb = S.legendBox;
    const bx0 = Math.max(0, Math.round(lb.x0 - pad)), by0 = Math.max(0, Math.round(lb.y0 - pad));
    const bw = Math.min(W, Math.round(lb.x1 + pad)) - bx0, k = cw / bw;
    const entries = truth.legend.map((l) => ({ code: l.code, name: l.name, kind: 'area', swatch: { x0: (l.box[0] - bx0 + 8) * k, y0: (l.box[1] - by0 + 8) * k, x1: (l.box[2] - bx0 - 8) * k, y1: (l.box[3] - by0 - 8) * k } }));
    entries.push({ code: '', name: 'Drill collar', kind: 'point', swatch: null });
    return reply({ entries });
  });
}
"""

async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1.0)
    ok = True
    try:
        async with async_playwright() as p:
            try:
                b = await p.chromium.launch()
            except Exception:
                b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
            ctx = await b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
            pg = await ctx.new_page()
            errors = []
            pg.on("console", lambda m: errors.append(m.text) if m.type == "error" and "Failed to load resource" not in m.text else None)
            pg.on("pageerror", lambda e: errors.append(str(e)))
            failed = []
            pg.on("response", lambda r: failed.append((r.status, r.url)) if r.status >= 400 and "openstreetmap.org" not in r.url else None)
            pg.on("console", lambda m: None)
            await pg.goto(f"http://localhost:{PORT}/app/")
            await pg.wait_for_function("window.amano && window.amano.version")
            await pg.screenshot(path=f"{OUT}/01-empty.png")

            # --- load the sample
            await pg.click("#btn-sample")
            await pg.wait_for_function("window.amano.state.src && document.getElementById('busy').hidden")
            await pg.screenshot(path=f"{OUT}/02-loaded.png")

            # --- without AI: the button must send the user to Settings, not fail
            await pg.click("#btn-auto")
            await pg.wait_for_selector("dialog#settings[open]")
            await pg.screenshot(path=f"{OUT}/03-settings.png")
            await pg.click("dialog#settings button[value=cancel]")

            # --- grid assist path (no AI at all)
            await pg.click("#assist summary")
            await pg.click("#btn-detect")
            await pg.wait_for_function("!document.getElementById('assist-form').hidden && document.getElementById('busy').hidden")
            await pg.fill("#as-e0", "360000"); await pg.fill("#as-de", "1000"); await pg.fill("#as-n0", "8646000"); await pg.fill("#as-dn", "1000")
            await pg.click("#btn-assist")
            r = await pg.evaluate("({n: amano.state.gcps.length, rms: amano.state.model.rmsPx, res: amano.state.model.resolution})")
            print("grid assist:", r)
            ok &= r["n"] == 63 and r["rms"] < 1.0
            await pg.click("#btn-clear-gcps")

            # --- AI path with the stand-in service
            await pg.evaluate(MOCK, truth)
            await pg.click("#btn-auto")
            await pg.wait_for_function("document.getElementById('busy').hidden && amano.state.model", timeout=120000)
            r = await pg.evaluate("""({n: amano.state.gcps.length, used: amano.state.model.n, rejected: amano.state.gcps.filter(g=>g.rejected).length,
                rmsPx: amano.state.model.rmsPx, rms: amano.state.model.rms, type: amano.state.model.type, crs: amano.state.crs && amano.state.crs.code,
                calls: window.__calls, crsNote: document.getElementById('crs-note').textContent, fit: document.getElementById('fit').innerText})""")
            print("auto georef:", {k: v for k, v in r.items() if k not in ("calls", "fit")})
            print("   AI requests:", r["calls"])
            print("   fit panel:", " | ".join(r["fit"].split("\n")))
            ok &= r["n"] == 63 and r["rmsPx"] < 1.0 and r["crs"] == 20935
            # accuracy against the generator's truth
            errs = await pg.evaluate("(t) => t.gcps.map(g => { const [X, Y] = amano.state.model.forward(g.px, g.py); return Math.hypot(X - g.e, Y - g.n); })", truth)
            print("   vs truth: rms %.2f m, max %.2f m" % (float(np.sqrt(np.mean(np.square(errs)))), max(errs)))
            ok &= max(errs) < 4
            await pg.screenshot(path=f"{OUT}/04-georeferenced.png")

            # --- digitize
            await pg.click("#btn-legend")
            await pg.wait_for_function("document.getElementById('busy').hidden && amano.state.units.length > 0", timeout=60000)
            await pg.click("#btn-extract")
            await pg.wait_for_function("document.getElementById('busy').hidden && amano.state.features.length > 0", timeout=120000)
            r = await pg.evaluate("({units: amano.state.units.map(u => u.code + ':' + u.rgb.join('/')), feats: amano.state.features.length})")
            print("digitize:", r)
            ok &= r["feats"] == 11
            # manual tools: a point and a line drawn on the canvas
            box = await pg.locator("#view").bounding_box()
            await pg.fill("#attr", "SD-006")
            await pg.click(".tools [data-tool=point]")
            await pg.mouse.click(box["x"] + box["width"] * 0.5, box["y"] + box["height"] * 0.5)
            await pg.fill("#attr", "Fault")
            await pg.click(".tools [data-tool=line]")
            for fx, fy in ((0.55, 0.3), (0.6, 0.5), (0.62, 0.7)):
                await pg.mouse.click(box["x"] + box["width"] * fx, box["y"] + box["height"] * fy)
                await pg.wait_for_timeout(350)
            await pg.keyboard.press("Enter")
            r = await pg.evaluate("amano.state.features.map(f => f.type).reduce((m, t) => (m[t] = (m[t] || 0) + 1, m), {})")
            print("after drawing:", r)
            ok &= r.get("point") == 1 and r.get("line") == 1
            await pg.click("#tb-fit")
            await pg.screenshot(path=f"{OUT}/05-digitized.png")
            await pg.evaluate("amano.viewer.centerOn(900, 900, 1.6)")
            await pg.wait_for_timeout(300)
            await pg.screenshot(path=f"{OUT}/06-zoom.png")

            # --- basemap view: the scan must sit at its true position on the web map
            await pg.click("#view-base")
            await pg.wait_for_function("amano.basemap.img && amano.basemap.corners")
            await pg.wait_for_timeout(1200)
            r = await pg.evaluate("""(() => { const b = amano.basemap, c = b.map.getCenter(); const r = b.img.getBoundingClientRect(), s = document.getElementById('basemap').getBoundingClientRect();
                return { lat: c.lat, lon: c.lng, zoom: b.map.getZoom(), layers: b.features.getLayers()[0].getLayers().length, imgW: r.width, imgH: r.height, inside: r.left >= s.left - 2 && r.right <= s.right + 2,
                         tiles: document.querySelectorAll('#basemap img.leaflet-tile').length, viewHidden: document.getElementById('view').hidden }; })()""")
            print("basemap:", r)
            ok &= abs(r["lat"] + 12.277) < 0.02 and abs(r["lon"] - 25.755) < 0.02 and r["layers"] == 13 and r["imgW"] > 300 and r["inside"] and r["viewHidden"]
            await pg.screenshot(path=f"{OUT}/08-basemap.png")
            await pg.click("#view-scan")
            ok &= not await pg.evaluate("document.getElementById('view').hidden")

            # --- export everything
            async with pg.expect_download(timeout=180000) as dl:
                await pg.click("#ex-all")
            d = await dl.value
            await d.save_as(f"{OUT}/export.zip")
            await pg.wait_for_function("document.getElementById('busy').hidden")
            print("console errors:", errors, "| failed requests:", failed)
            ok &= not errors and not failed
            # --- phone-width layout
            await pg.set_viewport_size({"width": 390, "height": 844})
            await pg.wait_for_timeout(400)
            await pg.screenshot(path=f"{OUT}/07-phone.png")
            ov = await pg.evaluate("document.documentElement.scrollWidth - document.documentElement.clientWidth")
            print("phone horizontal overflow:", ov); ok &= ov <= 0
            await b.close()
    finally:
        srv.terminate()

    # ---- check the exported files with GDAL and pyshp
    z = zipfile.ZipFile(f"{OUT}/export.zip")
    names = z.namelist(); print("zip:", names)
    assert z.testzip() is None
    tif = [n for n in names if n.endswith(".tif")][0]
    with rasterio.open(io.BytesIO(z.read(tif))) as ds:
        print("GeoTIFF:", ds.width, "x", ds.height, ds.crs, "pixel", round(ds.res[0], 4), "bounds", [round(v, 1) for v in ds.bounds])
        ok &= ds.crs.to_epsg() == 20935 and abs(ds.res[0] - truth["metresPerPixel"]) < 0.01
        a = ds.read()
        # the granite body's centre should be granite-coloured at its true coordinates
        r_, c_ = ds.index(362300, 8644300); px = a[:3, r_ + 40, c_ + 60]
        print("   colour at granite centre:", px.tolist()); ok &= abs(int(px[0]) - 232) < 25 and abs(int(px[1]) - 128) < 25
    area = {}
    shp = [n for n in names if n.endswith("_polygons.shp")][0][:-4]
    rd = shapefile.Reader(shp=io.BytesIO(z.read(shp + ".shp")), shx=io.BytesIO(z.read(shp + ".shx")), dbf=io.BytesIO(z.read(shp + ".dbf")), encoding="utf-8")
    for rec in rd.records():
        area[rec["code"]] = area.get(rec["code"], 0) + rec["area"]
    worst = 0
    for code, want in truth["unitAreasM2"].items():
        got = area.get(code, 0); pct = 100 * (got - want) / want; worst = max(worst, abs(pct))
        print("   %s: %.3f km2 (truth %.3f) %+.2f%%" % (code, got / 1e6, want / 1e6, pct))
    ok &= worst < 3
    prj = z.read(shp + ".prj").decode(); print("   prj:", prj[:60]); ok &= "Arc_1950_UTM_Zone_35S" in prj
    gj = json.loads(z.read([n for n in names if n.endswith(".geojson")][0]))
    c0 = [f for f in gj["features"] if f["geometry"]["type"] == "Point"][0]["geometry"]["coordinates"]
    print("   GeoJSON features:", len(gj["features"]), "point lon/lat", c0); ok &= 25.6 < c0[0] < 25.9 and -12.4 < c0[1] < -12.2
    audit = json.loads(z.read([n for n in names if n.endswith("_audit.json")][0]))
    print("   audit:", audit["crs"]["epsg"], audit["transform"]["type"], "points", len(audit["controlPoints"]), "recognition", sorted(audit["recognition"].keys())[:3], "log entries", len(audit["activity"]))
    pts = z.read([n for n in names if n.endswith(".points")][0]).decode().splitlines(); print("   .points rows:", len(pts) - 1, "|", pts[1])
    wld = [n for n in names if n.endswith(".jgw")]; print("   world file:", z.read(wld[0]).decode().split())
    print("E2E", "PASSED" if ok else "FAILED")
    sys.exit(0 if ok else 1)

if __name__ == "__main__":
    asyncio.run(main())
