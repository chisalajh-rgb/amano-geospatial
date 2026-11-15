"""Textures for the landing page's 3D scene: a shaded-relief terrain and a scanned geological sheet.
The terrain is computer-generated (not a real place); the sheet is the app's synthetic sample map.
Run: python3 tools/make_scene_textures.py"""
import os, numpy as np
from PIL import Image, ImageFilter, ImageDraw
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
rng = np.random.default_rng(21)
W, H = 960, 720
# fractal terrain from filtered noise
fx, fy = np.meshgrid(np.fft.fftfreq(W), np.fft.fftfreq(H))
f = np.sqrt(fx ** 2 + fy ** 2); f[0, 0] = 1
spec = (rng.normal(size=(H, W)) + 1j * rng.normal(size=(H, W))) / f ** 2.15
z = np.real(np.fft.ifft2(spec)); z = (z - z.min()) / (z.max() - z.min())
yy, xx = np.mgrid[0:H, 0:W]
valley = np.abs((yy / H) - (0.52 + 0.16 * np.sin(xx / W * 5.2 + 0.8)))          # a river valley
z = z * 0.75 + np.clip(valley * 1.5, 0, 0.5) * 0.5
z = (z - z.min()) / (z.max() - z.min())
gy, gx = np.gradient(z * 260)
az, alt = np.radians(315), np.radians(45)
slope = np.pi / 2 - np.arctan(np.hypot(gx, gy)); aspect = np.arctan2(-gx, gy)
shade = np.sin(alt) * np.sin(slope) + np.cos(alt) * np.cos(slope) * np.cos(az - aspect)
shade = np.clip(shade, 0, 1)
stops = [(0.00, (176, 196, 160)), (0.25, (203, 211, 170)), (0.50, (226, 216, 180)), (0.75, (214, 190, 160)), (1.00, (240, 236, 228))]
rgb = np.zeros((H, W, 3))
for (a, ca), (b, cb) in zip(stops, stops[1:]):
    m = (z >= a) & (z <= b); t = ((z - a) / (b - a))[m][:, None]
    rgb[m] = np.array(ca) * (1 - t) + np.array(cb) * t
rgb *= (0.45 + 0.75 * shade)[..., None]
river = valley < 0.0045
rgb[river] = (120, 170, 205)
img = Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).filter(ImageFilter.GaussianBlur(0.6))
d = ImageDraw.Draw(img, "RGBA")
for i in range(1, 8): d.line([(i * W / 8, 0), (i * W / 8, H)], fill=(36, 80, 107, 110), width=2)
for i in range(1, 6): d.line([(0, i * H / 6), (W, i * H / 6)], fill=(36, 80, 107, 110), width=2)
d.rectangle([0, 0, W - 1, H - 1], outline=(36, 80, 107, 255), width=4)
img.save(os.path.join(ROOT, "assets/scene-terrain.jpg"), quality=82, optimize=True)
# the scanned sheet: the sample map's frame with a little paper margin
src = Image.open(os.path.join(ROOT, "app/sample/sample-map.jpg")).convert("RGB")
crop = src.crop((120, 190, 2880, 2260)).resize((960, 720), Image.LANCZOS)
crop.save(os.path.join(ROOT, "assets/scene-sheet.jpg"), quality=80, optimize=True)
print({n: os.path.getsize(os.path.join(ROOT, "assets", n)) // 1024 for n in ("scene-terrain.jpg", "scene-sheet.jpg")}, "KB")
