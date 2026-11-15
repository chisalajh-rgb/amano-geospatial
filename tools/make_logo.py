"""Build the Amano logo: a turning globe with a satellite orbit and a small network of linked points.
Writes the animated mark (for the web) and a still version (favicon, PNG icons, print).
Run: python3 tools/make_logo.py   (needs rsvg-convert and Pillow for the PNG/ICO files)"""
import io, math, os, subprocess
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PINE, MOSS, CLAY, OCHRE = "#24506b", "#4a94c4", "#3d86b8", "#9fd0ee"

def mark(animated):
    tilt = -24
    def orbit(front):
        sat = '<circle r="6.5" fill="url(#sat)"/><circle r="2.4" fill="#fff" opacity=".85"/>'
        if animated: dot = f'<g class="orb">{sat}</g>'
        else: dot = f'<g transform="translate({57 * math.cos(math.radians(38)):.1f} {20 * math.sin(math.radians(38)):.1f})">{sat}</g>'
        clip = ' clip-path="url(#front)"' if front else ''
        op = '1' if front else '.45'
        return (f'<g transform="rotate({tilt} 64 64)"{clip}><g transform="translate(64 64)">'
                f'<ellipse rx="57" ry="20" fill="none" stroke="url(#ring)" stroke-width="3.2" opacity="{op}"/>{dot}</g></g>')
    if animated:
        mer = ''.join(f'<ellipse class="mer m{i}" cx="64" cy="64" rx="40" ry="40"/>' for i in (1, 2, 3))
    else:
        mer = ''.join(f'<ellipse cx="64" cy="64" rx="{rx}" ry="40"/>' for rx in (35, 21, 7))
    style = '''
  <style>
    .mer{fill:none;transform-box:fill-box;transform-origin:center;animation:spin 7s linear infinite}
    .m2{animation-delay:-2.33s}.m3{animation-delay:-4.66s}
    .orb{offset-path:path('M57 0 A57 20 0 1 1 -57 0 A57 20 0 1 1 57 0');offset-rotate:0deg;animation:orbit 5.5s linear infinite}
    .node{animation:pulse 2.8s ease-in-out infinite}.n2{animation-delay:-.9s}.n3{animation-delay:-1.8s}
    .link{stroke-dasharray:3 4;animation:flow 1.6s linear infinite}
    @keyframes spin{from{transform:scaleX(1)}to{transform:scaleX(-1)}}
    @keyframes orbit{from{offset-distance:0%}to{offset-distance:100%}}
    @keyframes pulse{0%,100%{opacity:.55}50%{opacity:1}}
    @keyframes flow{to{stroke-dashoffset:-14}}
    @media (prefers-reduced-motion:reduce){.mer,.orb,.node,.link{animation:none}.m2{transform:scaleX(.5)}.m3{transform:scaleX(.15)}.orb{offset-distance:11%}}
  </style>''' if animated else ''
    return f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" width="128" height="128" role="img" aria-label="Amano Geospatial">
  <defs>
    <radialGradient id="sphere" cx="36%" cy="30%" r="78%"><stop offset="0" stop-color="#bfe3f7"/><stop offset=".5" stop-color="{MOSS}"/><stop offset="1" stop-color="#1d4460"/></radialGradient>
    <radialGradient id="sat" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="{CLAY}"/></radialGradient>
    <linearGradient id="ring" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="{OCHRE}"/><stop offset="1" stop-color="{CLAY}"/></linearGradient>
    <clipPath id="globe"><circle cx="64" cy="64" r="40"/></clipPath>
    <clipPath id="front"><rect x="-10" y="64" width="148" height="80"/></clipPath>
  </defs>{style}
  {orbit(False)}
  <circle cx="64" cy="64" r="40" fill="url(#sphere)"/>
  <g clip-path="url(#globe)" fill="none" stroke="#ffffff" stroke-width="1.5" vector-effect="non-scaling-stroke" opacity=".5">
    <ellipse cx="64" cy="64" rx="40" ry="9"/><ellipse cx="64" cy="44" rx="34.6" ry="7"/><ellipse cx="64" cy="84" rx="34.6" ry="7"/>
    <g vector-effect="non-scaling-stroke">{mer}</g>
  </g>
  <g stroke="#e3f3fc" stroke-width="1.6" fill="none" stroke-linecap="round"><path class="link" d="M47 52 L66 44 L80 62 L58 74 Z"/></g>
  <g fill="#ffffff"><circle class="node" cx="47" cy="52" r="3.2"/><circle class="node n2" cx="66" cy="44" r="3.2"/><circle class="node n3" cx="80" cy="62" r="3.2"/><circle class="node n2" cx="58" cy="74" r="3.2"/></g>
  <ellipse cx="50" cy="45" rx="17" ry="11" fill="#fff" opacity=".13" transform="rotate(-30 50 45)"/>
  <circle cx="64" cy="64" r="40" fill="none" stroke="{PINE}" stroke-width="1.5" opacity=".55"/>
  {orbit(True)}
</svg>
'''

def write(path, text):
    with open(os.path.join(ROOT, path), "w") as f: f.write(text)

still, moving = mark(False), mark(True)
write("assets/logo-animated.svg", moving); write("app/logo.svg", moving)
write("assets/logo-icon.svg", still); write("assets/favicon.svg", still)
inner = still.split("\n", 1)[1].rsplit("</svg>", 1)[0]
write("assets/logo-horizontal.svg", f'''<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 430 128" width="430" height="128" role="img" aria-label="Amano Geospatial">
{inner}  <text x="150" y="74" font-family="Inter, 'Segoe UI', Arial, sans-serif" font-size="62" font-weight="700" fill="{PINE}" letter-spacing="-1">Amano</text>
  <text x="153" y="106" font-family="Inter, 'Segoe UI', Arial, sans-serif" font-size="21" font-weight="600" fill="{CLAY}" letter-spacing="8.8">GEOSPATIAL</text>
</svg>
''')
def png(svg, w, h, out):
    subprocess.run(["rsvg-convert", "-w", str(w), "-h", str(h), os.path.join(ROOT, svg), "-o", os.path.join(ROOT, out)], check=True)
png("assets/logo-icon.svg", 192, 192, "assets/icon-192.png"); png("assets/logo-icon.svg", 512, 512, "assets/icon-512.png")
png("assets/logo-horizontal.svg", 1290, 384, "assets/logo-horizontal.png")
from PIL import Image
big = Image.open(os.path.join(ROOT, "assets/icon-512.png")).convert("RGBA")
big.resize((256, 256), Image.LANCZOS).save(os.path.join(ROOT, "assets/favicon.ico"), sizes=[(16, 16), (32, 32), (48, 48)])
bg = Image.new("RGBA", (180, 180), (255, 255, 255, 255)); bg.alpha_composite(big.resize((160, 160), Image.LANCZOS), (10, 10))
bg.convert("RGB").save(os.path.join(ROOT, "assets/apple-touch-icon.png"))
print("logo written")
