"""Render the landing page clip "from scanned archive to queryable database" (silent, loops).
Usage: python3 tools/make_clip.py frames 3.6 7.9 12.9   -> writes /tmp/clip-<t>.png stills to check
       python3 tools/make_clip.py render                 -> writes assets/archive-to-database.mp4 + poster
The map sheets are the app's synthetic sample map, re-tinted; nothing shown is a real published map."""
import math, os, random, subprocess, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter, ImageEnhance, ImageOps
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
W, H, SS, FPS, DUR = 1280, 720, 2, 30, 15.0
INK, BLUE, SKY, PALE = (36, 80, 107), (74, 148, 196), (140, 196, 232), (214, 235, 248)
def F(size, bold=True):
    return ImageFont.truetype("/usr/share/fonts/opentype/inter/Inter-%s.otf" % ("Bold" if bold else "Medium"), int(size * SS))
def clamp(v, a=0.0, b=1.0): return max(a, min(b, v))
def seg(t, a, b): return clamp((t - a) / (b - a))
def ease(x): return 1 - (1 - x) ** 3
def easeio(x): return x * x * (3 - 2 * x)
def lerp(a, b, x): return a + (b - a) * x

# ---- sprites
src = Image.open(os.path.join(ROOT, "app/sample/sample-map.jpg")).convert("RGB").crop((250, 215, 2760, 2110))
def sheet(tint, year, w=640, h=480):
    m = src.resize((w - 44, h - 44), Image.LANCZOS)
    m = ImageEnhance.Color(m).enhance(tint[1]); m = Image.blend(m, Image.new("RGB", m.size, tint[0]), tint[2])
    s = Image.new("RGBA", (w, h), (247, 243, 232, 255)); s.paste(m, (22, 22))
    d = ImageDraw.Draw(s); d.rectangle([0, 0, w - 1, h - 1], outline=(120, 120, 110, 255), width=3)
    d.rectangle([22, 22, w - 23, h - 23], outline=(40, 40, 40, 255), width=2)
    d.rectangle([w - 150, h - 60, w - 30, h - 28], fill=(247, 243, 232, 235)); d.text((w - 90, h - 44), year, font=ImageFont.truetype("/usr/share/fonts/opentype/inter/Inter-Bold.otf", 24), fill=(90, 60, 40), anchor="mm")
    return s
TINTS = [((196, 170, 120), 0.75, 0.22), ((180, 190, 170), 0.9, 0.12), ((210, 180, 150), 0.6, 0.30), ((170, 180, 200), 0.85, 0.15),
         ((200, 190, 150), 0.7, 0.25), ((190, 170, 160), 0.8, 0.18), ((205, 195, 165), 0.65, 0.28), ((235, 232, 220), 1.0, 0.04)]
YEARS = ["1958", "1964", "1971", "1979", "1983", "1988", "1992", "1967"]
SHEETS = [sheet(t, y) for t, y in zip(TINTS, YEARS)]
LOGO = Image.open(os.path.join(ROOT, "assets/icon-512.png")).convert("RGBA")
bg = Image.new("RGB", (W * SS, H * SS))
bd = ImageDraw.Draw(bg)
for y in range(H * SS):
    k = y / (H * SS); bd.line([(0, y), (W * SS, y)], fill=tuple(int(lerp(a, 255, k ** 0.8)) for a in (207, 232, 247)))
for x in range(0, W * SS, 64 * SS): bd.line([(x, 0), (x, H * SS)], fill=(196, 222, 240), width=1)
for y in range(0, H * SS, 64 * SS): bd.line([(0, y), (W * SS, y)], fill=(196, 222, 240), width=1)

def put(img, sprite, cx, cy, w, rot=0.0, alpha=1.0, shadow=True):
    """Paste sprite centred at (cx, cy) with on-screen width w (1280-space), rotation in degrees."""
    if alpha <= 0.01 or w < 2: return
    sc = w * SS / sprite.width
    sp = sprite.resize((max(2, int(sprite.width * sc)), max(2, int(sprite.height * sc))), Image.BILINEAR)
    if abs(rot) > 0.05: sp = sp.rotate(rot, expand=True, resample=Image.BICUBIC)
    if alpha < 1: sp.putalpha(sp.getchannel("A").point(lambda v: int(v * alpha)))
    x, y = int(cx * SS - sp.width / 2), int(cy * SS - sp.height / 2)
    def comp(layer, px, py):
        sx, sy = max(0, -px), max(0, -py)
        if sx >= layer.width or sy >= layer.height or px >= img.width or py >= img.height: return   # entirely off-screen
        img.alpha_composite(layer, (max(px, 0), max(py, 0)), (sx, sy))
    if shadow:
        sh = Image.new("RGBA", sp.size, (20, 45, 65, 0)); sh.putalpha(sp.getchannel("A").point(lambda v: int(v * 0.22)))
        comp(sh, x + 5 * SS, y + 7 * SS)
    comp(sp, x, y)

def text(d, xy, s, size, fill, anchor="la", bold=True, alpha=1.0):
    if alpha <= 0.01: return
    d.text((xy[0] * SS, xy[1] * SS), s, font=F(size, bold), fill=fill + (int(255 * alpha),), anchor=anchor)
def rr(d, box, r, **kw): d.rounded_rectangle([v * SS for v in box], radius=r * SS, **{k: (int(round(v * SS)) if k == "width" else v) for k, v in kw.items()})

random.seed(4)
PILE = [(400 + random.uniform(-70, 70), 330 + random.uniform(-45, 45), random.uniform(-19, 19)) for _ in range(8)]
PILE[7] = (410, 322, -7.0)
CELLS = [(340 + 200 * c, 228 + 156 * r) for r in range(2) for c in range(4)]
BIG = (800, 318, 560)             # the sheet being georeferenced: centre x, y, width

def caption(d, t, a, b, title, sub):
    al = min(seg(t, a, a + 0.5), 1 - seg(t, b - 0.4, b))
    text(d, (640, 618), title, 38, INK, "mm", True, al); text(d, (640, 664), sub, 21, (61, 83, 97), "mm", False, al)

def frame(t):
    img = bg.copy().convert("RGBA")
    d = ImageDraw.Draw(img, "RGBA")
    # ---------------- scene 1 + 2: the pile
    if t < 10.4:
        slide = easeio(seg(t, 4.5, 5.6)); out = seg(t, 9.5, 10.2)
        for i in range(7):
            a = ease(seg(t, 0.25 + 0.36 * i, 0.9 + 0.36 * i))
            if a <= 0: continue
            px, py, pr = PILE[i]
            x = lerp(px, 200 + (px - 400) * 0.6, slide); y = lerp(-220, py, a); w = lerp(330, 230, slide)
            put(img, SHEETS[i], x, y, w, pr * a + (1 - a) * 40, a * lerp(1, 0.55, slide) * (1 - out))
        # the top sheet
        a = ease(seg(t, 0.25 + 0.36 * 7, 0.9 + 0.36 * 7))
        if a > 0:
            px, py, pr = PILE[7]
            x, y, w, r = lerp(px, BIG[0], slide), lerp(lerp(-220, py, a), BIG[1], slide), lerp(330, BIG[2], slide), pr * a * (1 - slide) + (1 - a) * 40
            if t >= 9.5:   # shrink into the first mosaic cell
                k = easeio(seg(t, 9.5, 10.4)); x, y, w = lerp(BIG[0], CELLS[5][0], k), lerp(BIG[1], CELLS[5][1], k), lerp(BIG[2], 184, k)
            put(img, SHEETS[7], x, y, w, r, a)
        # padlock on the pile
        la = ease(seg(t, 3.2, 3.6)) * (1 - seg(t, 4.5, 5.0))
        if la > 0:
            cx, cy, s = 520, 215, 34 * (0.6 + 0.4 * la)
            d.arc([(cx - s * .55) * SS, (cy - s * 1.25) * SS, (cx + s * .55) * SS, (cy - s * .1) * SS], 180, 360, fill=INK + (int(255 * la),), width=int(7 * SS))
            rr(d, [cx - s * .85, cy - s * .65, cx + s * .85, cy + s * .75], 7, fill=INK + (int(255 * la),))
            d.ellipse([(cx - 6) * SS, (cy - 8) * SS, (cx + 6) * SS, (cy + 4) * SS], fill=(255, 255, 255, int(255 * la)))
        # ---------------- scene 2 overlays on the big sheet
        if 5.6 <= t < 9.5:
            x0, x1 = BIG[0] - BIG[2] / 2, BIG[0] + BIG[2] / 2; hh = BIG[2] * 0.75; y0, y1 = BIG[1] - hh / 2, BIG[1] + hh / 2
            fx0, fy0, fx1, fy1 = x0 + 20, y0 + 20, x1 - 20, y1 - 20
            sweep = seg(t, 5.7, 7.3); sy = lerp(fy0, fy1, easeio(sweep))
            for i in range(9):      # coordinate grid revealed behind the scan line
                gx = lerp(fx0, fx1, i / 8); d.line([gx * SS, fy0 * SS, gx * SS, sy * SS], fill=BLUE + (230,), width=int(1.6 * SS))
            for i in range(7):
                gy = lerp(fy0, fy1, i / 6)
                if gy <= sy: d.line([fx0 * SS, gy * SS, fx1 * SS, gy * SS], fill=BLUE + (230,), width=int(1.6 * SS))
            if 0 < sweep < 1:
                d.rectangle([fx0 * SS, (sy - 26) * SS, fx1 * SS, sy * SS], fill=SKY + (70,)); d.line([x0 * SS, sy * SS, x1 * SS, sy * SS], fill=(255, 255, 255, 255), width=int(4 * SS))
                d.line([x0 * SS, (sy + 2) * SS, x1 * SS, (sy + 2) * SS], fill=BLUE + (255,), width=int(2 * SS))
            labels = [((fx0, fy0), "360 000 E", "8 646 000 N", "rb"), ((fx1, fy0), "368 000 E", "8 646 000 N", "lb"), ((fx1, fy1), "368 000 E", "8 640 000 N", "lt"), ((fx0, fy1), "360 000 E", "8 640 000 N", "rt")]
            for i, ((cx, cy), e, n, anc) in enumerate(labels):
                pa = ease(seg(t, 7.3 + 0.15 * i, 7.6 + 0.15 * i))
                if pa <= 0: continue
                r = 11 * (1.6 - 0.6 * pa); pulse = 0.5 + 0.5 * math.sin(t * 5 + i)
                d.ellipse([(cx - r - 7) * SS, (cy - r - 7) * SS, (cx + r + 7) * SS, (cy + r + 7) * SS], fill=BLUE + (int(60 * pa * pulse),))
                d.ellipse([(cx - r) * SS, (cy - r) * SS, (cx + r) * SS, (cy + r) * SS], fill=BLUE + (int(255 * pa),), outline=(255, 255, 255, int(255 * pa)), width=int(3 * SS))
                ox = -18 if "r" in anc else 18; oy = -14 if "b" in anc else 14
                bw = 118; bx = cx + ox - (bw if "r" in anc else 0); by = cy + oy - (40 if "b" in anc else 0)
                rr(d, [bx, by, bx + bw, by + 40], 8, fill=(255, 255, 255, int(240 * pa)), outline=BLUE + (int(255 * pa),), width=1.5)
                text(d, (bx + bw / 2, by + 13), e, 13, INK, "mm", True, pa); text(d, (bx + bw / 2, by + 28), n, 13, INK, "mm", True, pa)
            ca = ease(seg(t, 8.0, 8.4))
            if ca > 0:
                rr(d, [BIG[0] - 150, y1 + 16, BIG[0] + 150, y1 + 52], 18, fill=INK + (int(255 * ca),))
                text(d, (BIG[0], y1 + 34), "Arc 1950 / UTM 35S   ·   fit 0.3 px", 16, (255, 255, 255), "mm", True, ca)
    # ---------------- scene 3: the mosaic and the search
    if t >= 9.5:
        pa = ease(seg(t, 9.6, 10.3)); fade = 1 - seg(t, 13.6, 14.1)
        rr(d, [226, 140, 1054, 472], 16, fill=(255, 255, 255, int(200 * pa * fade)), outline=BLUE + (int(255 * pa * fade),), width=2)
        order = [5, 0, 6, 1, 4, 2, 7, 3]
        for n, ci in enumerate(order):
            if ci == 5: continue
            a = ease(seg(t, 10.3 + 0.13 * n, 10.75 + 0.13 * n))
            cx, cy = CELLS[ci]; put(img, SHEETS[ci if ci != 7 else 6], cx, cy - 26 * (1 - a), 184, 0, a * fade)
        if t >= 10.4: put(img, SHEETS[7], CELLS[5][0], CELLS[5][1], 184, 0, fade)
        else:   # the georeferenced sheet shrinking into its place, drawn above the panel
            k = easeio(seg(t, 9.5, 10.4)); put(img, SHEETS[7], lerp(BIG[0], CELLS[5][0], k), lerp(BIG[1], CELLS[5][1], k), lerp(BIG[2], 184, k), 0, 1)
        d = ImageDraw.Draw(img, "RGBA")
        sa = ease(seg(t, 11.3, 11.7)) * fade
        if sa > 0:
            rr(d, [400, 62, 880, 114], 26, fill=(255, 255, 255, int(255 * sa)), outline=BLUE + (int(255 * sa),), width=2)
            d.ellipse([424 * SS, 78 * SS, 442 * SS, 96 * SS], outline=INK + (int(255 * sa),), width=int(3 * SS)); d.line([440 * SS, 94 * SS, 448 * SS, 102 * SS], fill=INK + (int(255 * sa),), width=int(3 * SS))
            q = "dolomite, 1:25 000, Arc 1950"; n = int(len(q) * seg(t, 11.7, 12.7))
            text(d, (462, 88), q[:n] + ("|" if n < len(q) and int(t * 4) % 2 == 0 else ""), 20, INK, "lm", False, sa)
        ha = ease(seg(t, 12.8, 13.2)) * fade
        if ha > 0:
            for ci in (0, 5, 6, 3):
                cx, cy = CELLS[ci]; g = 0.6 + 0.4 * math.sin(t * 6 + ci)
                rr(d, [cx - 96, cy - 73, cx + 96, cy + 73], 6, outline=BLUE + (int(255 * ha),), width=4)
                rr(d, [cx - 101, cy - 78, cx + 101, cy + 78], 9, outline=SKY + (int(150 * ha * g),), width=4)
            for ci in (1, 2, 4, 7):
                cx, cy = CELLS[ci]; rr(d, [cx - 92, cy - 69, cx + 92, cy + 69], 0, fill=(255, 255, 255, int(105 * ha)))
            rr(d, [906, 70, 1052, 106], 18, fill=INK + (int(255 * ha),)); text(d, (979, 88), "4 sheets found", 16, (255, 255, 255), "mm", True, ha)
        # end card
        ea = easeio(seg(t, 13.7, 14.3))
        if ea > 0:
            d.rectangle([0, 0, W * SS, H * SS], fill=(240, 248, 253, int(235 * ea)))
            put(img, LOGO, 640, 285, 170 * (0.9 + 0.1 * ea), 0, ea, shadow=False); d = ImageDraw.Draw(img, "RGBA")
            text(d, (640, 410), "Amano Geospatial", 46, INK, "mm", True, ea); text(d, (640, 458), "Your map archive, as a living database", 22, (61, 83, 97), "mm", False, ea)
    d = ImageDraw.Draw(img, "RGBA")
    caption(d, t, 0.6, 4.5, "Decades of scanned maps", "locked in local grids and legacy projections")
    caption(d, t, 5.0, 9.5, "Amano ties each sheet to real coordinates", "grid, datum and control points, read from the map itself")
    caption(d, t, 10.0, 13.7, "A living, queryable database", "search the whole archive by unit, scale or coordinate system")
    return img.convert("RGB").resize((W, H), Image.LANCZOS)

ENC = ["-c:v", "libx264", "-crf", "22", "-preset", "medium", "-pix_fmt", "yuv420p", "-r", str(FPS)]
def render(only=None):
    cuts, parts = [0, 4.5, 9.5, DUR], []
    for i in range(3):
        if only and (i + 1) not in only: parts.append("/tmp/clip-part%d.mp4" % i); continue
        tmp, fin = "/tmp/clip-part%d.tmp.mp4" % i, "/tmp/clip-part%d.mp4" % i
        p = subprocess.Popen(["ffmpeg", "-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H), "-framerate", str(FPS), "-i", "-"] + ENC + [tmp], stdin=subprocess.PIPE)
        for f in range(int(round(cuts[i] * FPS)), int(round(cuts[i + 1] * FPS))): p.stdin.write(frame(f / FPS).tobytes())
        p.stdin.close()
        if p.wait() != 0: raise SystemExit("ffmpeg failed")
        os.replace(tmp, fin); parts.append(fin); print("scene", i + 1, "done", flush=True)
    open("/tmp/clip-list.txt", "w").write("".join("file '%s'\n" % p for p in parts))
    out = os.path.join(ROOT, "assets/archive-to-database.mp4")
    subprocess.run(["ffmpeg", "-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", "/tmp/clip-list.txt", "-c", "copy", "-movflags", "+faststart", "/tmp/clip-out.tmp.mp4"], check=True)
    os.replace("/tmp/clip-out.tmp.mp4", out)
    frame(8.9).save(os.path.join(ROOT, "assets/archive-to-database-poster.jpg"), quality=84, optimize=True)
    print("wrote", out, os.path.getsize(out) // 1024, "KB")

if __name__ == "__main__":
    if sys.argv[1] == "frames":
        for t in sys.argv[2:]: frame(float(t)).save("/tmp/clip-%s.png" % t)
    else: render([int(v) for v in sys.argv[2:]])   # e.g. `render 3` re-renders only scene 3
