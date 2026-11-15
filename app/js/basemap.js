// Amano Georeferencer — OpenStreetMap basemap (Leaflet).
// Shows real-world ground behind the app, and lays the georeferenced scan and digitized
// features over it so a person can see at a glance whether the map landed in the right place.

const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors';

export class Basemap {
  constructor(el) {
    const L = globalThis.L;
    this.ok = !!L;
    if (!this.ok) return;
    this.map = L.map(el, { zoomControl: false, attributionControl: true, worldCopyJump: true }).setView([-12.6, 27.6], 6);
    this.map.attributionControl.setPrefix(false); // no library credit; the map-data credit below is a licence condition
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.control.scale({ imperial: false, position: 'bottomright' }).addTo(this.map);
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(this.map);
    this.img = null; this.corners = null; this.opacity = 0.75;
    this.features = L.layerGroup().addTo(this.map);
    this.outline = null;
    this.map.on('zoomend viewreset', () => this._place());
  }

  resize() { if (this.ok) this.map.invalidateSize(); }

  /** Remove the scan and features (a new map was loaded, or the fit was cleared). */
  clear() {
    if (!this.ok) return;
    if (this.img) { this.img.remove(); if (this.img.src.startsWith('blob:')) URL.revokeObjectURL(this.img.src); this.img = null; }
    if (this.outline) { this.outline.remove(); this.outline = null; }
    this.corners = null; this.srcCanvas = null;
    this.features.clearLayers();
  }

  /**
   * Lay the scan over the basemap.
   * @param {{canvas:HTMLCanvasElement,width:number,height:number}} src
   * @param {(px:number,py:number)=>[number,number]} toLonLat  pixel -> [lon, lat]
   * @returns {boolean} false if the position is not usable
   */
  async setScan(src, toLonLat) {
    if (!this.ok) return false;
    const L = globalThis.L, W = src.width, H = src.height;
    const pts = [[-0.5, -0.5], [W - 0.5, -0.5], [-0.5, H - 0.5], [W - 0.5, H - 0.5]].map(([x, y]) => toLonLat(x, y));
    if (pts.some((p) => !p || !isFinite(p[0]) || !isFinite(p[1]) || Math.abs(p[1]) > 85 || Math.abs(p[0]) > 180)) return false;
    this.corners = pts.map((p) => L.latLng(p[1], p[0]));
    if (this.srcCanvas !== src.canvas) {
      // a reduced copy of the scan is enough for an overlay and keeps panning smooth
      const k = Math.min(1, 2600 / Math.max(W, H));
      const c = document.createElement('canvas');
      c.width = Math.round(W * k); c.height = Math.round(H * k);
      c.getContext('2d').drawImage(src.canvas, 0, 0, c.width, c.height);
      const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.85));
      if (this.img) { this.img.remove(); URL.revokeObjectURL(this.img.src); }
      const img = document.createElement('img');
      img.src = URL.createObjectURL(blob); img.alt = '';
      img.className = 'scan-overlay leaflet-zoom-hide';
      img.style.width = c.width + 'px'; img.style.height = c.height + 'px';
      this.iw = c.width; this.ih = c.height;
      this.map.getPanes().overlayPane.appendChild(img);
      this.img = img; this.srcCanvas = src.canvas;
    }
    this.img.style.opacity = this.opacity;
    if (this.outline) this.outline.remove();
    const [tl, tr, bl, br] = this.corners;
    this.outline = L.polygon([tl, tr, br, bl], { color: '#24382f', weight: 1.5, fill: false, dashArray: '5 4', interactive: false }).addTo(this.map);
    this._place();
    return true;
  }

  _place() {
    if (!this.img || !this.corners) return;
    const [tl, tr, bl] = this.corners.map((c) => this.map.latLngToLayerPoint(c));
    const a = (tr.x - tl.x) / this.iw, b = (tr.y - tl.y) / this.iw, c = (bl.x - tl.x) / this.ih, d = (bl.y - tl.y) / this.ih;
    this.img.style.transform = `matrix(${a},${b},${c},${d},${tl.x},${tl.y})`;
  }

  setOpacity(v) { this.opacity = v; if (this.img) this.img.style.opacity = v; }

  /** Zoom to the scan. */
  fit() { if (this.ok && this.corners) this.map.fitBounds(globalThis.L.latLngBounds(this.corners), { padding: [30, 30] }); }

  /** Draw digitized features. geojson must be in WGS 84; colorFor(code) returns a CSS colour. */
  setFeatures(geojson, colorFor) {
    if (!this.ok) return;
    const L = globalThis.L;
    this.features.clearLayers();
    if (!geojson) return;
    L.geoJSON(geojson, {
      style: (f) => (f.geometry.type === 'LineString'
        ? { color: '#a8402f', weight: 3 }
        : { color: '#24382f', weight: 1.5, fillColor: colorFor(f.properties.code), fillOpacity: 0.45 }),
      pointToLayer: (f, latlng) => L.circleMarker(latlng, { radius: 6, color: '#fff', weight: 2, fillColor: '#a8402f', fillOpacity: 1 }),
      onEachFeature: (f, layer) => {
        const p = f.properties, label = [p.code, p.name].filter(Boolean).join(' · ');
        if (label) layer.bindTooltip(label, { sticky: true });
      },
    }).addTo(this.features);
  }
}
