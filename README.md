# Amano Geospatial — website

Source for **https://amanogeospatial.com**, the one-page site for Amano Geospatial
(AI-powered georeferencing and map digitization).

It is a plain static site: no build step, no dependencies. Whatever is on the
`main` branch is what gets published.

## What's in here

| Path | What it is |
| --- | --- |
| `index.html` | The landing page |
| `css/style.css` | All styles |
| `404.html` | "Page not found" page |
| `assets/` | Logo (SVG + PNG), favicon set, social-preview image |
| `design/og-image.svg` | Editable source for the social-preview image |
| `robots.txt`, `sitemap.xml` | Search-engine files |
| `site.webmanifest` | App name and icons for phones |
| `docs/DEPLOY.md` | Step-by-step: hosting, domain, DNS, email |
| `.nojekyll` | Tells GitHub Pages to serve the files as they are |

## The app (`app/`)

The Amano Georeferencer (beta) runs entirely in the browser at `/app/`:

- **Georeference:** finds the grid lines on a scan, reads the margin labels and stated datum with AI
  (or you type the first line's value and the spacing), fits the map and reports the error.
- **Digitize:** reads the legend with AI or takes colours you pick, and traces the units as polygons;
  magic wand, polygon, line and point tools for the rest.
- **Batch:** choose many scans; each is georeferenced with AI in turn and saved as a GeoTIFF with its
  control points and audit log, plus a summary CSV that flags the maps a person should check.
- **Basemap:** an OpenStreetMap view shows the georeferenced scan and features over real ground, to check
  the map landed in the right place. Tiles come from openstreetmap.org, which is free for light use only;
  heavy traffic needs a paid tile provider.
- **Export:** GeoTIFF, Shapefile, GeoJSON, QGIS control points, world file and an audit log.

AI steps need either the user's own Anthropic API key (entered in the app's Settings, kept in their
browser) or the optional server in `proxy/`. Never commit an API key.

| Path | What it is |
| --- | --- |
| `app/js/` | The engine: `grid.js` (line detection), `georef.js` (fitting), `ai.js`, `digitize.js`, `tiff.js`, `vector.js` … |
| `app/vendor/` | Third-party libraries (proj4js, Leaflet, geotiff.js, UTIF.js, pako) with their licences |
| `app/sample/` | A synthetic sample map (invented geology) |
| `proxy/` | Optional AI server (Cloudflare Worker) |
| `tools/` | Scripts that generate the sample map and the coordinate-system list |
| `tests/` | Engine tests (`node tests/test_*.mjs`) and a browser test (`python3 tests/e2e_app.py`) |

**Tested so far:** on the sample map only, with the AI replaced by a stand-in. The AI prompts have
not yet been run against the live model or on real scans.

## Preview on your own computer

```bash
python3 -m http.server 8000
```

Then open http://localhost:8000.

## Common edits

**Change the contact email.** The site currently uses `chisala.jh@gmail.com`
as a temporary contact address. Once the mailbox on the domain exists (for
example `hello@amanogeospatial.com`), replace every occurrence in `index.html` —
it appears in the three buttons, the footer and the structured-data block near
the top.

**Change the copy.** Edit the text directly in `index.html`.

**Regenerate the images** after changing a logo or the preview image
(needs `rsvg-convert`, from librsvg):

```bash
rsvg-convert -w 1200 -h 630 design/og-image.svg -o assets/og-image.png
rsvg-convert -w 192 -h 192 assets/logo-icon.svg -o assets/icon-192.png
rsvg-convert -w 512 -h 512 assets/logo-icon.svg -o assets/icon-512.png
```

## Launch checklist

- [x] Landing page, logo, favicon, social preview, SEO tags
- [x] Georeferencer app (beta) at `/app/`
- [ ] AI steps tested on real maps with a live API key
- [x] Temporary contact email in place (`chisala.jh@gmail.com`)
- [ ] Copy approved
- [ ] Contact email switched to an address on the domain
- [ ] Domain `amanogeospatial.com` registered
- [ ] Repository pushed to GitHub
- [ ] Site deployed (GitHub Pages or Cloudflare Pages) — see `docs/DEPLOY.md`
- [ ] Domain connected and the padlock (HTTPS) shows
- [ ] Mailbox created; a test email arrives
- [ ] Checked on phone and laptop
- [ ] Link preview looks right on WhatsApp / LinkedIn

---

© 2026 Amano Geospatial. All rights reserved. The Amano name and logo are not
licensed for reuse.
