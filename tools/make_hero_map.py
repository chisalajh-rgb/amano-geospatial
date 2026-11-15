"""Build the 3D-look map illustration on the landing page ("Why Amano" section) and insert it into
index.html between the <!-- map3d --> markers. A scanned sheet floats above a georeferenced grid,
tied down by control points, with an extruded unit and drill pins.  Run: python3 tools/make_hero_map.py"""
import os, re
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
S, CX, CY, N = 1.12, 200, 176, 120          # scale, origin on screen, plane size in units
def iso(x, y, z=0):
    return (CX + (x - y) * 0.866 * S, CY + (x + y) * 0.5 * S - N * 0.5 * S - z)
def P(pts): return " ".join("%.1f,%.1f" % p for p in pts)
def line(a, b, **kw):
    att = " ".join('%s="%s"' % (k.replace("_", "-"), v) for k, v in kw.items())
    return '<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" %s/>' % (a[0], a[1], b[0], b[1], att)
Z = 84                                       # height of the floating sheet
out = []
# ground: slab with a soft shadow and a glowing grid
out.append('<ellipse cx="200" cy="214" rx="150" ry="26" fill="#24506b" opacity=".10"/>')
g = [iso(0, 0), iso(N, 0), iso(N, N), iso(0, N)]
out.append('<polygon points="%s" fill="#9cc7e4" opacity=".55"/>' % P([iso(0, N, -9), iso(N, N, -9), iso(N, N), iso(0, N)]))
out.append('<polygon points="%s" fill="#7fb4d8" opacity=".55"/>' % P([iso(N, 0, -9), iso(N, N, -9), iso(N, N), iso(N, 0)]))
out.append('<polygon points="%s" fill="url(#m3-ground)" stroke="#4a94c4" stroke-width="1.2"/>' % P(g))
for i in range(1, 6):
    t = i * N / 6
    out.append(line(iso(t, 0), iso(t, N), stroke="#4a94c4", stroke_width=".8", opacity=".55"))
    out.append(line(iso(0, t), iso(N, t), stroke="#4a94c4", stroke_width=".8", opacity=".55"))
# extruded map unit on the ground
poly = [(38, 30), (78, 24), (96, 58), (70, 86), (34, 70)]
H = 16
for i in range(len(poly)):
    a, b = poly[i], poly[(i + 1) % len(poly)]
    if (b[0] - a[0]) - (b[1] - a[1]) < 0 or True:
        shade = "#5d9fca" if (b[1] - a[1]) > 0 else "#7db6da"
        out.append('<polygon points="%s" fill="%s" opacity=".8"/>' % (P([iso(*a), iso(*b), iso(*b, H), iso(*a, H)]), shade))
out.append('<polygon points="%s" fill="url(#m3-unit)" stroke="#ffffff" stroke-width="1"/>' % P([iso(x, y, H) for x, y in poly]))
# drill pins
for (x, y) in [(52, 46), (74, 52), (58, 68)]:
    a, b = iso(x, y, H), iso(x, y, H + 24)
    out.append(line(a, b, stroke="#24506b", stroke_width="1.4"))
    out.append('<circle class="m3-pulse" cx="%.1f" cy="%.1f" r="4.2" fill="#24506b" stroke="#fff" stroke-width="1.2"/>' % b)
# ties from the floating sheet's control points down to the grid
for (x, y) in [(0, 0), (N, 0), (N, N), (0, N)]:
    a, b = iso(x, y), iso(x, y, Z)
    out.append(line(a, b, stroke="#4a94c4", stroke_width="1.3", stroke_dasharray="3 4", **{"class": "m3-flow"}))
    out.append('<circle cx="%.1f" cy="%.1f" r="3" fill="#fff" stroke="#4a94c4" stroke-width="1.4"/>' % a)
# the floating scanned sheet
sh = [iso(0, 0, Z), iso(N, 0, Z), iso(N, N, Z), iso(0, N, Z)]
out.append('<g class="m3-float">')
out.append('<polygon points="%s" fill="url(#m3-sheet)" stroke="#24506b" stroke-width="1.3"/>' % P(sh))
for i in range(1, 6):
    t = i * N / 6
    out.append(line(iso(t, 0, Z), iso(t, N, Z), stroke="#24506b", stroke_width=".5", opacity=".22"))
    out.append(line(iso(0, t, Z), iso(N, t, Z), stroke="#24506b", stroke_width=".5", opacity=".22"))
out.append('<polygon points="%s" fill="#8cc4e8" opacity=".45" stroke="#24506b" stroke-width=".9"/>' % P([iso(x, y, Z) for x, y in poly]))
c1 = [iso(8 + 0.9 * t, 100 - 0.25 * t + 10 * __import__("math").sin(t / 14), Z) for t in range(0, 120, 6)]
out.append('<polyline points="%s" fill="none" stroke="#24506b" stroke-width=".8" opacity=".45"/>' % P(c1))
for (x, y) in [(52, 46), (74, 52), (58, 68)]:
    out.append('<circle cx="%.1f" cy="%.1f" r="2" fill="#24506b"/>' % iso(x, y, Z))
# scanning beam sweeping the sheet
a, b = iso(0, 0, Z), iso(N, 0, Z)
dx, dy = iso(0, N, Z)[0] - a[0], iso(0, N, Z)[1] - a[1]
out.append('<g class="m3-scan" style="--dx:%.1fpx;--dy:%.1fpx">%s%s</g>' % (dx, dy,
    line(a, b, stroke="#ffffff", stroke_width="5", opacity=".55", stroke_linecap="round"),
    line(a, b, stroke="#4a94c4", stroke_width="1.6", stroke_linecap="round")))
for p in sh:
    out.append('<circle class="m3-pulse" cx="%.1f" cy="%.1f" r="4" fill="#4a94c4" stroke="#fff" stroke-width="1.4"/>' % p)
out.append('</g>')
# small coordinate read-outs
out.append('<g font-family="Inter, Segoe UI, Arial, sans-serif" font-size="8.5" font-weight="600" fill="#24506b" opacity=".8">'
           '<text x="%.1f" y="%.1f" text-anchor="end">8 646 000 N</text><text x="%.1f" y="%.1f">364 000 E</text></g>' % (iso(0, N)[0] - 6, iso(0, N)[1] + 4, iso(N, 0)[0] + 7, iso(N, 0)[1] + 4))
svg = '''<svg viewBox="0 0 400 260" width="100%%" role="img" aria-label="A scanned map floating above a coordinate grid, tied to it by control points">
            <defs>
              <linearGradient id="m3-bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#d6ebf8"/><stop offset="1" stop-color="#ffffff"/></linearGradient>
              <linearGradient id="m3-ground" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#eef7fd"/><stop offset="1" stop-color="#c3def0"/></linearGradient>
              <linearGradient id="m3-unit" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#bfe0f4"/><stop offset="1" stop-color="#8cc4e8"/></linearGradient>
              <linearGradient id="m3-sheet" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffffff" stop-opacity=".92"/><stop offset="1" stop-color="#e3f1fa" stop-opacity=".7"/></linearGradient>
            </defs>
            <style>
              .m3-float{animation:m3-float 6s ease-in-out infinite}
              .m3-scan{animation:m3-scan 4.5s ease-in-out infinite}
              .m3-pulse{animation:m3-pulse 2.4s ease-in-out infinite}
              .m3-flow{animation:m3-flow 1.4s linear infinite}
              @keyframes m3-float{0%%,100%%{transform:translateY(0)}50%%{transform:translateY(-5px)}}
              @keyframes m3-scan{0%%,100%%{transform:translate(0,0)}50%%{transform:translate(var(--dx),var(--dy))}}
              @keyframes m3-pulse{0%%,100%%{opacity:1}50%%{opacity:.45}}
              @keyframes m3-flow{to{stroke-dashoffset:-14}}
              @media (prefers-reduced-motion:reduce){.m3-float,.m3-scan,.m3-pulse,.m3-flow{animation:none}}
            </style>
            <rect width="400" height="260" rx="10" fill="url(#m3-bg)"/>
            %s
          </svg>''' % "\n            ".join(out)
p = os.path.join(ROOT, "index.html"); s = open(p).read()
if "<!-- map3d -->" not in s:
    a = s.index('<svg viewBox="0 0 400 260"'); b = s.index("</svg>", a) + 6
    s = s[:a] + "<!-- map3d -->" + s[a:b] + "<!-- /map3d -->" + s[b:]
s = re.sub(r"<!-- map3d -->.*?<!-- /map3d -->", lambda m: "<!-- map3d -->" + svg + "<!-- /map3d -->", s, flags=re.S)
open(p, "w").write(s)
print("illustration written")
