"""Generate the synthetic sample map used by the app's "Load sample map" button and by the tests.

The geology is invented. The sheet imitates a scanned 1:25 000 map with a 1 km grid in
Arc 1950 / UTM zone 35S (EPSG:20935), slightly rotated and noisy like a real scan.

Run:  python3 tools/make_sample_map.py
Writes app/sample/sample-map.jpg and tests/fixtures/sample-truth.json (+ raw pixels for tests).
"""
import json, math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H = 3300, 2600
FX0, FY0, FX1, FY1 = 300, 260, 2700, 2060          # map frame in pixels (before rotation)
E0, E1, N0, N1 = 360000, 368000, 8640000, 8646000  # map frame in metres
PPM = (FX1 - FX0) / (E1 - E0)                        # pixels per metre (0.3)
ROT_DEG = 0.7
PAPER = (244, 239, 227)

UNITS = [
    ("Qa", "Alluvium", (247, 236, 160)),
    ("Ks", "Upper shale", (176, 205, 150)),
    ("Kd", "Dolomite", (146, 190, 222)),
    ("Rq", "Quartzite", (240, 190, 140)),
    ("Rc", "Basal conglomerate", (214, 160, 190)),
    ("Gr", "Granite intrusion", (236, 130, 120)),
]

def font(size, bold=False):
    for p in ["/usr/share/fonts/opentype/inter/Inter-%s.otf" % ("Bold" if bold else "Regular"),
              "/usr/share/fonts/truetype/dejavu/DejaVuSans%s.ttf" % ("-Bold" if bold else "")]:
        if os.path.exists(p):
            return ImageFont.truetype(p, size)
    return ImageFont.load_default()

def px(e, n):
    return FX0 + (e - E0) * PPM, FY1 - (n - N0) * PPM

def classify(e, n):
    """Invented geology: folded bands, a river of alluvium, one granite body, one fault offset."""
    fault = e > 365200 + (n - N0) * 0.25
    nn = np.where(fault, n - 650, n)
    f = (nn - N0) + 700 * np.sin((e - E0) / 1500.0) + 0.18 * (e - E0)
    cls = np.digitize(f, [1500, 2900, 4300, 5600]) + 1           # 1..5 -> Ks, Kd, Rq, Rc, (wrap)
    cls = np.where(cls > 4, 1, cls)
    river = np.abs((n - N0) - (1800 + 900 * np.sin((e - E0) / 2100.0 + 1.0))) < 170
    cls = np.where(river, 0, cls)
    granite = ((e - 362300) / 900.0) ** 2 + ((n - 8644300) / 650.0) ** 2 < 1
    cls = np.where(granite, 5, cls)
    return cls

def main():
    rng = np.random.default_rng(7)
    img = Image.new("RGB", (W, H), PAPER)
    # geology raster inside the frame
    xs = np.arange(FX0, FX1) + 0.5
    ys = np.arange(FY0, FY1) + 0.5
    ee = E0 + (xs - FX0) / PPM
    nn = N0 + (FY1 - ys) / PPM
    EE, NN = np.meshgrid(ee, nn)
    cls = classify(EE, NN).astype(np.uint8)
    pal = np.array([u[2] for u in UNITS], dtype=np.uint8)
    rgb = pal[cls]
    # unit boundaries as thin black contacts
    edge = np.zeros(cls.shape, bool)
    edge[:, 1:] |= cls[:, 1:] != cls[:, :-1]
    edge[1:, :] |= cls[1:, :] != cls[:-1, :]
    edge = np.array(Image.fromarray((edge * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(3))) > 0
    rgb[edge] = (40, 40, 40)
    img.paste(Image.fromarray(rgb, "RGB"), (FX0, FY0))
    d = ImageDraw.Draw(img)

    # grid every 1 km, with labels on all four margins
    f_lab, f_small = font(30), font(24)
    for e in range(E0, E1 + 1, 1000):
        x, _ = px(e, N0)
        if E0 < e < E1:
            d.line([(x, FY0), (x, FY1)], fill=(30, 40, 70), width=2)
        for yy, anchor in ((FY0 - 16, "mb"), (FY1 + 16, "mt")):
            d.text((x, yy), "%d" % e, font=f_lab, fill=(20, 20, 20), anchor=anchor)
    for n in range(N0, N1 + 1, 1000):
        _, y = px(E0, n)
        if N0 < n < N1:
            d.line([(FX0, y), (FX1, y)], fill=(30, 40, 70), width=2)
        d.text((FX0 - 16, y), "%d" % n, font=f_lab, fill=(20, 20, 20), anchor="rm")
        d.text((FX1 + 16, y), "%d" % n, font=f_lab, fill=(20, 20, 20), anchor="lm")
    d.rectangle([FX0 - 2, FY0 - 2, FX1 + 2, FY1 + 2], outline=(0, 0, 0), width=5)   # centred on the frame coordinates

    # unit codes on the map, drill collars
    for e, n in [(361000, 8641400), (363400, 8641300), (366400, 8643400), (361400, 8645650),
                 (362300, 8644300), (364300, 8642050), (367100, 8642300), (364700, 8644000), (366500, 8640500)]:
        x, y = px(e, n)
        code = UNITS[int(classify(np.array([e], float), np.array([n], float))[0])][0]
        d.text((x, y), code, font=font(34, True), fill=(20, 20, 20), anchor="mm")
    collars = [("SD-001", 361650, 8643550), ("SD-002", 363250, 8643750), ("SD-003", 364650, 8644650),
               ("SD-004", 366350, 8641650), ("SD-005", 367250, 8644350)]
    for name, e, n in collars:
        x, y = px(e, n)
        d.ellipse([x - 9, y - 9, x + 9, y + 9], fill=(255, 255, 255), outline=(0, 0, 0), width=3)
        d.line([(x - 14, y), (x + 14, y)], fill=(0, 0, 0), width=2)
        d.line([(x, y - 14), (x, y + 14)], fill=(0, 0, 0), width=2)
        d.text((x + 18, y - 26), name, font=font(22), fill=(0, 0, 0))

    # title block
    d.text((FX0, 70), "SAMPLE GEOLOGICAL SHEET 35S-A", font=font(64, True), fill=(20, 20, 20))
    d.text((FX0, 150), "Synthetic test map. The geology shown is invented and is for software testing only.", font=font(30), fill=(70, 70, 70))
    d.text((FX0, FY1 + 90), "Scale 1:25 000", font=font(40, True), fill=(20, 20, 20))
    d.text((FX0, FY1 + 150), "Grid: Universal Transverse Mercator, Zone 35 South. Datum: Arc 1950. Spheroid: Clarke 1880 (modified).", font=font(30), fill=(40, 40, 40))
    d.text((FX0, FY1 + 195), "Grid lines are at 1000 metre intervals. Coordinates are in metres.", font=font(30), fill=(40, 40, 40))
    # scale bar: 2 km
    bx, by = FX0 + 1500, FY1 + 105
    for i in range(4):
        d.rectangle([bx + i * 150, by, bx + (i + 1) * 150, by + 18], fill=(0, 0, 0) if i % 2 == 0 else (255, 255, 255), outline=(0, 0, 0), width=2)
    for i, t in enumerate(["0", "500", "1000", "1500", "2000 m"]):
        d.text((bx + i * 150, by + 26), t, font=font(22), fill=(0, 0, 0), anchor="mt")

    # legend
    lx, ly = FX1 + 190, FY0 + 40
    d.text((lx, ly - 10), "LEGEND", font=font(40, True), fill=(20, 20, 20), anchor="lb")
    legend = []
    for i, (code, name, col) in enumerate(UNITS):
        y = ly + 40 + i * 110
        d.rectangle([lx, y, lx + 120, y + 64], fill=col, outline=(0, 0, 0), width=3)
        d.text((lx + 140, y + 4), code, font=font(30, True), fill=(20, 20, 20))
        d.text((lx + 140, y + 38), name, font=font(24), fill=(40, 40, 40))
        legend.append({"code": code, "name": name, "color": list(col), "box": [lx, y, lx + 120, y + 64]})
    y = ly + 40 + len(UNITS) * 110 + 20
    d.ellipse([lx + 50, y + 12, lx + 68, y + 30], fill=(255, 255, 255), outline=(0, 0, 0), width=3)
    d.text((lx + 140, y + 6), "Drill collar", font=font(24), fill=(40, 40, 40))

    # imitate a scan: rotate about the sheet centre, blur a touch, add noise
    th = math.radians(ROT_DEG)
    cx, cy = W / 2, H / 2
    cos, sin = math.cos(th), math.sin(th)
    def fwd(x, y):   # unrotated pixel -> scanned pixel
        return cx + cos * (x - cx) - sin * (y - cy), cy + sin * (x - cx) + cos * (y - cy)
    # PIL wants the inverse (output -> input)
    inv = (cos, sin, cx - cos * cx - sin * cy, -sin, cos, cy + sin * cx - cos * cy)
    img = img.transform((W, H), Image.AFFINE, inv, resample=Image.BICUBIC, fillcolor=PAPER)
    arr = np.asarray(img).astype(np.float32)
    arr += rng.normal(0, 3.0, arr.shape)
    arr *= (0.97 + 0.03 * np.linspace(1, 0.6, W)[None, :, None])   # uneven lighting
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))

    os.makedirs(os.path.join(ROOT, "app/sample"), exist_ok=True)
    os.makedirs(os.path.join(ROOT, "tests/fixtures"), exist_ok=True)
    img.save(os.path.join(ROOT, "app/sample/sample-map.jpg"), quality=86, optimize=True)

    # ground truth
    gcps = []
    for e in range(E0, E1 + 1, 1000):
        for n in range(N0, N1 + 1, 1000):
            x, y = px(e, n)
            sx, sy = fwd(x, y)
            gcps.append({"px": sx, "py": sy, "e": e, "n": n})
    def scan_box(b):
        pts = [fwd(b[0], b[1]), fwd(b[2], b[1]), fwd(b[2], b[3]), fwd(b[0], b[3])]
        return [min(p[0] for p in pts), min(p[1] for p in pts), max(p[0] for p in pts), max(p[1] for p in pts)]
    truth = {
        "width": W, "height": H, "epsg": 20935, "rotationDeg": ROT_DEG, "metresPerPixel": 1 / PPM,
        "frame": scan_box([FX0, FY0, FX1, FY1]),
        "frameCorners": [list(fwd(FX0, FY0)), list(fwd(FX1, FY0)), list(fwd(FX1, FY1)), list(fwd(FX0, FY1))],
        "extent": [E0, N0, E1, N1],
        "gcps": gcps,
        "legend": [{**l, "box": scan_box(l["box"])} for l in legend],
        "legendRegion": scan_box([lx - 30, ly - 70, W - 40, ly + 40 + len(UNITS) * 110 + 80]),
        "collars": [{"name": nme, "e": e, "n": n} for nme, e, n in collars],
        "eastingLabels": [{"value": e, "x": fwd(*px(e, N1))[0], "yTop": fwd(*px(e, N1))[1]} for e in range(E0, E1 + 1, 1000)],
        "northingLabels": [{"value": n, "y": fwd(*px(E0, n))[1], "xLeft": fwd(*px(E0, n))[0]} for n in range(N0, N1 + 1, 1000)],
    }
    # class areas (m2) for checking digitization
    area = {}
    for i, (code, name, col) in enumerate(UNITS):
        area[code] = float((cls == i).sum()) / (PPM * PPM)
    truth["unitAreasM2"] = area
    with open(os.path.join(ROOT, "tests/fixtures/sample-truth.json"), "w") as f:
        json.dump(truth, f, indent=1)
    # raw pixels of the saved JPEG for the Node tests (not committed)
    back = Image.open(os.path.join(ROOT, "app/sample/sample-map.jpg")).convert("RGBA")
    with open("/tmp/sample-map.rgba", "wb") as f:
        f.write(back.tobytes())
    np.save("/tmp/sample-classes.npy", cls)
    print("wrote sample map", back.size, os.path.getsize(os.path.join(ROOT, "app/sample/sample-map.jpg")) // 1024, "KB")

if __name__ == "__main__":
    main()
