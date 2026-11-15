"""Batch mode in the browser: four files (a good JPEG, the same sheet as a tiled TIFF, a blank
page and a corrupt file) with the stand-in AI service from e2e_app.py."""
import asyncio, csv, glob, io, json, os, subprocess, sys, time, zipfile
import rasterio
from playwright.async_api import async_playwright
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from e2e_app import MOCK, truth, ROOT
PORT = 8794; OUT = "/tmp/amano-batch"; os.makedirs(OUT, exist_ok=True)
async def main():
    for f in glob.glob(OUT + "/*"): os.remove(f)
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL); time.sleep(1)
    ok = True
    try:
        async with async_playwright() as p:
            try: b = await p.chromium.launch()
            except Exception: b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
            ctx = await b.new_context(viewport={"width": 1440, "height": 900}, accept_downloads=True)
            pg = await ctx.new_page()
            errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            saved = []
            async def on_dl(d):
                path = f"{OUT}/{d.suggested_filename}"; await d.save_as(path); saved.append(d.suggested_filename)
            pg.on("download", lambda d: asyncio.ensure_future(on_dl(d)))
            await pg.goto(f"http://localhost:{PORT}/app/"); await pg.wait_for_function("window.amano")
            await pg.click("#btn-batch")
            await pg.wait_for_selector("dialog#batch[open]")
            # without AI the Start button must lead to Settings
            await pg.set_input_files("#batch-files", sorted(glob.glob("/tmp/batch-in/*")))
            await pg.click("#batch-start"); await pg.wait_for_selector("dialog#settings[open]"); await pg.click("dialog#settings button[value=cancel]")
            await pg.evaluate(MOCK, truth)
            await pg.click("#btn-batch")
            if await pg.locator("#batch-folder-row").is_visible(): await pg.uncheck("#batch-folder")
            await pg.fill("#batch-crs", "")
            await pg.screenshot(path=f"{OUT}/batch-ready.png")
            await pg.click("#batch-start")
            await pg.wait_for_function("!amano.batch.running && amano.batch.rows.every(r => r.status !== 'queued' && r.status !== 'working')", timeout=400000)
            await pg.wait_for_timeout(2500)
            rows = await pg.evaluate("amano.batch.rows.map(r => ({file: r.file, status: r.status, note: r.note, rms: r.rmsPx, crs: r.crs, points: r.points}))")
            for r in rows: print("  ", r)
            print("progress:", await pg.inner_text("#batch-progress"))
            await pg.screenshot(path=f"{OUT}/batch-done.png")
            st = {r["file"]: r["status"] for r in rows}
            ok &= st["sheet_01.jpg"] == "ok" and st["sheet_02.tif"] == "ok" and st["sheet_03_blank.png"] in ("check", "failed") and st["sheet_04_broken.png"] == "failed"
            print("page errors:", errs, "| downloads:", sorted(saved)); ok &= not errs
            await b.close()
    finally:
        srv.terminate()
    for n in ("sheet_01_amano.zip", "sheet_02_amano.zip"):
        z = zipfile.ZipFile(f"{OUT}/{n}"); names = z.namelist()
        with rasterio.open(io.BytesIO(z.read([x for x in names if x.endswith(".tif")][0]))) as ds:
            print(n, names, ds.crs, round(ds.res[0], 3)); ok &= ds.crs.to_epsg() == 20935 and abs(ds.res[0] - truth["metresPerPixel"]) < 0.01
    rows = list(csv.DictReader(open(f"{OUT}/amano_batch_summary.csv")))
    print("summary rows:", len(rows), "|", {k: rows[0][k] for k in ("file", "status", "crs_epsg", "points_used", "rms_px", "output")}); ok &= len(rows) == 4
    print("BATCH", "PASSED" if ok else "FAILED"); sys.exit(0 if ok else 1)
asyncio.run(main())
