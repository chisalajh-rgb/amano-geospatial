"""Load TIFFs stored in the common variants (tiles/strips, LZW/deflate/JPEG, predictor, 16-bit,
palette, grey, bilevel) into the app and compare the decoded pixels with a reference PNG.
Run tools: the test files are generated in /tmp/tifs (see git history of this test for the recipe)."""
import asyncio, glob, os, subprocess, sys, time
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
from playwright.async_api import async_playwright
PORT = 8792
import base64
REF = 'data:image/png;base64,' + base64.b64encode(open('/tmp/tifs/ref.png','rb').read()).decode()
CMP = """async (ref) => {
  const s = amano.state.src; if (!s) return null;
  const bmp = await createImageBitmap(await (await fetch(ref)).blob());
  const c = document.createElement('canvas'); c.width = 165; c.height = 130; const x = c.getContext('2d', {willReadFrequently:true});
  x.drawImage(bmp, 0, 0, 165, 130); const a = x.getImageData(0,0,165,130).data;
  x.drawImage(s.canvas, 0, 0, 165, 130); const b = x.getImageData(0,0,165,130).data;
  let d = 0, dg = 0; for (let i = 0; i < a.length; i += 4) { d += Math.abs(a[i]-b[i]) + Math.abs(a[i+1]-b[i+1]) + Math.abs(a[i+2]-b[i+2]);
    const ga = (a[i]*77+a[i+1]*150+a[i+2]*29)>>8, gb = (b[i]*77+b[i+1]*150+b[i+2]*29)>>8; dg += Math.abs(ga-gb); }
  return { w: s.width, h: s.height, diff: d / (a.length / 4 * 3), grayDiff: dg / (a.length / 4) };
}"""
async def main():
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT)], cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    ref = subprocess.Popen([sys.executable, "-m", "http.server", str(PORT + 1)], cwd="/tmp/tifs", stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1); ok = True
    try:
        async with async_playwright() as p:
            try: b = await p.chromium.launch()
            except Exception: b = await p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
            pg = await b.new_page(viewport={"width": 1300, "height": 850})
            errs = []; pg.on("pageerror", lambda e: errs.append(str(e)))
            await pg.goto(f"http://localhost:{PORT}/app/"); await pg.wait_for_function("window.amano")
            for f in sorted(glob.glob("/tmp/tifs/*.tif")):
                name = os.path.basename(f)
                await pg.evaluate("amano.state.src = null")
                await pg.set_input_files("#file", f)
                try:
                    await pg.wait_for_function("document.getElementById('busy').hidden && (amano.state.src || !document.getElementById('toast').hidden)", timeout=60000)
                    r = await pg.evaluate(CMP, REF)
                except Exception as e:
                    r = None; print('   ', str(e)[:150])
                toast = await pg.evaluate("document.getElementById('toast').hidden ? '' : document.getElementById('toast').textContent")
                colour = name not in ("gray.tif", "bilevel_g4.tif")
                limit = 60 if name == "bilevel_g4.tif" else 12
                good = r is not None and (r["diff"] if colour else r["grayDiff"]) < limit
                print(("ok  " if good else "BAD ") + name, r, toast[:90]); ok &= good
            print("page errors:", errs)
            await b.close()
    finally:
        srv.terminate(); ref.terminate()
    print("TIFF", "PASSED" if ok else "FAILED"); sys.exit(0 if ok else 1)
asyncio.run(main())
