// Amano Geospatial — pan/zoom map viewer on a canvas.
// Image coordinates use "integer = pixel centre"; the top-left corner of the scan is (-0.5, -0.5).

export class Viewer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.image = null; this.iw = 0; this.ih = 0;
    this.scale = 1; this.tx = 0; this.ty = 0;
    this.onDraw = null; this.onClick = null; this.onMove = null; this.onDblClick = null;
    this._drag = null; this._raf = 0;
    this._bind();
    new ResizeObserver(() => this.resize()).observe(canvas);
    this.resize();
  }

  setImage(image, w, h) { this.image = image; this.iw = w; this.ih = h; this.fit(); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
    this.dpr = dpr; this.cw = r.width; this.ch = r.height;
    this.requestDraw();
  }

  fit(box = null) {
    if (!this.iw) return;
    const b = box || { x0: 0, y0: 0, x1: this.iw, y1: this.ih };
    const pad = box ? 60 : 24;
    const s = Math.min((this.cw - 2 * pad) / (b.x1 - b.x0), (this.ch - 2 * pad) / (b.y1 - b.y0));
    this.scale = Math.max(0.01, Math.min(s, 20));
    this.tx = (this.cw - (b.x0 + b.x1) * this.scale) / 2;
    this.ty = (this.ch - (b.y0 + b.y1) * this.scale) / 2;
    this.requestDraw();
  }

  centerOn(x, y, minScale = 0) {
    if (minScale && this.scale < minScale) this.scale = minScale;
    this.tx = this.cw / 2 - (x + 0.5) * this.scale; this.ty = this.ch / 2 - (y + 0.5) * this.scale;
    this.requestDraw();
  }

  zoomBy(k, sx = this.cw / 2, sy = this.ch / 2) {
    const ns = Math.max(0.01, Math.min(40, this.scale * k));
    const f = ns / this.scale;
    this.tx = sx - (sx - this.tx) * f; this.ty = sy - (sy - this.ty) * f; this.scale = ns;
    this.requestDraw();
  }

  toScreen(x, y) { return [(x + 0.5) * this.scale + this.tx, (y + 0.5) * this.scale + this.ty]; }
  toImage(sx, sy) { return [(sx - this.tx) / this.scale - 0.5, (sy - this.ty) / this.scale - 0.5]; }

  requestDraw() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => { this._raf = 0; this.draw(); });
  }

  draw() {
    const { ctx, dpr } = this;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.cw, this.ch);
    if (this.image) {
      ctx.imageSmoothingEnabled = this.scale < 3;
      ctx.imageSmoothingQuality = 'medium';
      ctx.drawImage(this.image, this.tx, this.ty, this.iw * this.scale, this.ih * this.scale);
    }
    if (this.onDraw) this.onDraw(ctx, this);
  }

  _pos(e) { const r = this.canvas.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  _bind() {
    const c = this.canvas;
    c.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [sx, sy] = this._pos(e);
      this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), sx, sy);
    }, { passive: false });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 && e.button !== 1) return;
      c.setPointerCapture(e.pointerId);
      const [sx, sy] = this._pos(e);
      this._drag = { sx, sy, tx: this.tx, ty: this.ty, moved: false, button: e.button };
    });
    c.addEventListener('pointermove', (e) => {
      const [sx, sy] = this._pos(e);
      if (this._drag) {
        const dx = sx - this._drag.sx, dy = sy - this._drag.sy;
        if (!this._drag.moved && Math.hypot(dx, dy) > 4) this._drag.moved = true;
        if (this._drag.moved) { this.tx = this._drag.tx + dx; this.ty = this._drag.ty + dy; c.classList.add('grabbing'); this.requestDraw(); }
      }
      if (this.onMove && this.iw) { const [x, y] = this.toImage(sx, sy); this.onMove(x, y, e); }
    });
    const end = (e) => {
      const d = this._drag; this._drag = null; c.classList.remove('grabbing');
      if (!d || d.moved || d.button !== 0 || e.type === 'pointercancel') return;
      if (this.onClick && this.iw) { const [x, y] = this.toImage(d.sx, d.sy); this.onClick(x, y, e); }
    };
    c.addEventListener('pointerup', end);
    c.addEventListener('pointercancel', end);
    c.addEventListener('dblclick', (e) => {
      if (this.onDblClick && this.iw) { const [sx, sy] = this._pos(e); const [x, y] = this.toImage(sx, sy); this.onDblClick(x, y, e); }
    });
  }
}
