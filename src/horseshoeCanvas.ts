// Polar canvas for the Horseshoe page.
//  - Shows a τ₀-by-v₀ grid heatmap of τ* (first-return phase), with
//    escape cells rendered transparent.
//  - Overlays a translucent blue "sector" (the chosen rectangle in
//    domain (τ, v) space).
//  - Overlays a translucent red "image polygon" (the closed curve in
//    codomain (τ*, |v*|) space traced by integrating around the sector
//    boundary).
//
// Heatmap pixels are rasterised to an offscreen canvas as grid rows
// arrive; the main draw composits offscreen + overlays each redraw.

export interface SectorRect {
  tauS: number; tauE: number; // τ₀ bounds (may wrap mod 1)
  vS: number; vE: number;     // v₀ bounds (vS < vE)
}

export interface PolygonPoint {
  tau: number;        // τ* (cyclic mod 1)
  v: number;          // |v*|
  escaped: boolean;
}

// Viewport rectangle in NATURAL canvas pixel coordinates (the rectangle of
// the un-zoomed render that should fill the visible canvas). All drawing
// happens in natural coords; we apply a scale+translate transform so the
// selected rectangle stretches to fill the visible canvas.
export interface ViewRect {
  x: number; y: number;
  w: number; h: number;
}

export class HorseshoeCanvas {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;

  // Offscreen heatmap.
  private off: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private offValid = false;

  private n = 0;
  // vMax is the display-time radial scale. scanVMax is the vMax at which
  // the stored grid was scanned — fixed at beginGrid, never changes if the
  // user later adjusts the display vMax slider. The two are kept separate
  // so the heatmap data stays anchored to its real v values.
  private vMax = 1;
  private scanVMax = 1;
  // tauStars[j*n+i] = τ* at (i,j) cell; vStars[j*n+i] = |v*|. NaN = escape.
  private tauStars: Float32Array | null = null;
  private vStars: Float32Array | null = null;

  private sector: SectorRect | null = null;
  private polygon: PolygonPoint[] | null = null;
  // Matched pair of spirals (image of τ=tauS and τ=tauE edges of R),
  // sampled at the same K v values so adjacent entries form a quad.
  private spiralLeft: PolygonPoint[] | null = null;
  private spiralRight: PolygonPoint[] | null = null;
  // P points: where ∂D₀ ∩ ∂D₁ on a symmetry line (Moser's P).
  private pPoints: { tau: number; v: number; label?: string }[] = [];
  private showGrid = true;
  private showImage = false;

  // ----- viewport-zoom state -----
  // Viewport zoom is a pure pixel-space magnification: when viewRect is
  // set, only the natural canvas pixels in that rectangle are visible,
  // stretched (no aspect lock) to fill the canvas via a 2D transform.
  // All drawing code stays in natural canvas coords; the transform is
  // applied once at the start of the draw.
  private viewRect: ViewRect | null = null;
  private zoomToolActive = false;
  private dragStart: { x: number; y: number } | null = null;
  private dragEnd: { x: number; y: number } | null = null;
  onZoomBoxDrawn: ((rect: ViewRect) => void) | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.off = document.createElement('canvas');
    this.offCtx = this.off.getContext('2d')!;
    this.resize();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    this.setupMouseHandlers();
  }

  // ----- zoom-mode API -----

  setViewRect(r: ViewRect | null): void {
    this.viewRect = r;
    this.draw();
  }
  getViewRect(): ViewRect | null { return this.viewRect; }
  setZoomToolActive(on: boolean): void {
    this.zoomToolActive = on;
    this.canvas.style.cursor = on ? 'crosshair' : '';
    if (!on) { this.dragStart = null; this.dragEnd = null; this.draw(); }
  }

  private setupMouseHandlers(): void {
    this.canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
    this.canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
    this.canvas.addEventListener('mouseup',   (e) => this.onMouseUp(e));
    this.canvas.addEventListener('mouseleave', () => this.onMouseLeave());
  }
  private mousePos(e: MouseEvent): { x: number; y: number } {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }
  private onMouseDown(e: MouseEvent): void {
    if (!this.zoomToolActive) return;
    this.dragStart = this.mousePos(e);
    this.dragEnd = this.dragStart;
    this.draw();
  }
  private onMouseMove(e: MouseEvent): void {
    if (!this.zoomToolActive || !this.dragStart) return;
    this.dragEnd = this.mousePos(e);
    this.draw();
  }
  private onMouseUp(e: MouseEvent): void {
    if (!this.zoomToolActive || !this.dragStart) return;
    const end = this.mousePos(e);
    const start = this.dragStart;
    this.dragStart = null;
    this.dragEnd = null;
    const rect = this.computeViewRect(start, end);
    if (rect && this.onZoomBoxDrawn) this.onZoomBoxDrawn(rect);
    this.draw();
  }
  private onMouseLeave(): void {
    if (this.dragStart) {
      this.dragStart = null;
      this.dragEnd = null;
      this.draw();
    }
  }

  // ----- screen ↔ natural canvas conversion (for viewport zoom) -----

  // Map a screen pixel (relative to canvas top-left) to natural canvas
  // pixel — i.e. into the coordinate system used by all draw code.
  private screenToNatural(sx: number, sy: number): { x: number; y: number } {
    if (!this.viewRect) return { x: sx, y: sy };
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const r = this.viewRect;
    return {
      x: r.x + (sx / Math.max(1, w)) * r.w,
      y: r.y + (sy / Math.max(1, h)) * r.h,
    };
  }

  // Pixel rectangle in NATURAL coords that corresponds to a screen drag.
  private computeViewRect(
    s: { x: number; y: number }, e: { x: number; y: number },
  ): ViewRect | null {
    if (Math.abs(e.x - s.x) < 4 || Math.abs(e.y - s.y) < 4) return null;
    const a = this.screenToNatural(s.x, s.y);
    const b = this.screenToNatural(e.x, e.y);
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    const w = Math.abs(b.x - a.x);
    const h = Math.abs(b.y - a.y);
    if (w < 1 || h < 1) return null;
    return { x, y, w, h };
  }

  // ----- grid -----

  beginGrid(n: number, vMax: number): void {
    this.n = n;
    this.vMax = vMax;
    this.scanVMax = vMax;
    this.tauStars = new Float32Array(n * n);
    this.vStars = new Float32Array(n * n);
    this.tauStars.fill(Number.NaN);
    this.vStars.fill(Number.NaN);
    this.offValid = false;
    this.draw();
  }

  setGridRow(j: number, tauStars: Float32Array, vStars: Float32Array): void {
    if (!this.tauStars || !this.vStars || j < 0 || j >= this.n) return;
    const off = j * this.n;
    for (let i = 0; i < this.n; i++) {
      this.tauStars[off + i] = tauStars[i];
      this.vStars[off + i] = vStars[i];
    }
    this.offValid = false;
    this.draw();
  }

  clearGrid(): void {
    this.tauStars = null;
    this.vStars = null;
    this.offValid = false;
    this.draw();
  }

  // ----- overlays -----

  setSector(s: SectorRect | null): void { this.sector = s; this.draw(); }
  setPolygon(pts: PolygonPoint[] | null): void { this.polygon = pts; this.draw(); }
  setSpiralPair(left: PolygonPoint[] | null, right: PolygonPoint[] | null): void {
    this.spiralLeft = left;
    this.spiralRight = right;
    this.draw();
  }
  setPPoints(pts: { tau: number; v: number; label?: string }[]): void {
    this.pPoints = pts;
    this.draw();
  }
  setVMax(v: number): void {
    if (!isFinite(v) || v <= 0) return;
    this.vMax = v;
    this.draw();
  }
  setShowGrid(on: boolean): void { this.showGrid = on; this.draw(); }
  getShowGrid(): boolean { return this.showGrid; }
  hasGrid(): boolean { return this.tauStars !== null; }
  setShowImage(on: boolean): void { this.showImage = on; this.draw(); }
  getShowImage(): boolean { return this.showImage; }

  // Geometry for screen-space gap measurement in the refinement loop.
  getDiscGeometry(): { cx: number; cy: number; R: number; vMax: number } {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return {
      cx: w / 2,
      cy: h / 2,
      R: Math.max(0, Math.min(w, h) / 2 - 28),
      vMax: this.vMax,
    };
  }

  // ----- size -----

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    // Main canvas: dpr-scaled buffer, CSS-pixel drawing coords.
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Offscreen heatmap: CSS-pixel sized + identity transform. ImageData
    // operations bypass canvas transforms, so keeping this 1:1 with CSS
    // pixels avoids the "stamp in upper-left quadrant" trap on retina.
    this.off.width = Math.floor(w);
    this.off.height = Math.floor(h);
    this.offCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.offValid = false;
    this.draw();
  }

  // ----- rasterise the heatmap -----

  private drawColorBar(ctx: CanvasRenderingContext2D, w: number, _h: number): void {
    const barW = 150;
    const barH = 10;
    const x = w - barW - 16;
    const y = 30;
    // Header label
    ctx.fillStyle = '#8a8fa5';
    ctx.font = '11px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('cyclic τ  (0 = mutual apogee)', x, y - 6);
    // Gradient strip
    for (let px = 0; px < barW; px++) {
      const t = px / (barW - 1);
      const [r, g, b] = cyclicColor(t);
      ctx.fillStyle = `rgb(${r},${g},${b})`;
      ctx.fillRect(x + px, y, 1, barH);
    }
    // Border
    ctx.strokeStyle = '#3a3a48';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, barW - 1, barH - 1);
    // Tick marks + labels
    ctx.fillStyle = '#8a8fa5';
    ctx.strokeStyle = '#8a8fa5';
    ctx.font = '9px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const ticks = [0, 0.25, 0.5, 0.75, 1.0];
    for (const t of ticks) {
      const tx = x + t * (barW - 1);
      ctx.beginPath();
      ctx.moveTo(tx, y + barH);
      ctx.lineTo(tx, y + barH + 3);
      ctx.stroke();
      ctx.fillText(t.toFixed(2), tx, y + barH + 4);
    }
  }

  private rasterise(): void {
    const ctx = this.offCtx;
    const wi = this.off.width;
    const hi = this.off.height;
    ctx.clearRect(0, 0, wi, hi);

    if (!this.tauStars || this.n === 0) { this.offValid = true; return; }

    const cx = wi / 2, cy = hi / 2;
    const R = Math.max(0, Math.min(wi, hi) / 2 - 28);
    if (R <= 0) { this.offValid = true; return; }

    const n = this.n;
    const displayVMax = this.vMax;
    const scanVMax = this.scanVMax;
    // Per-pixel sampling at NATURAL canvas coords. Viewport zoom is
    // applied later by the canvas transform; we don't have to know
    // about it here.
    const imageData = ctx.createImageData(wi, hi);
    const data = imageData.data;
    for (let py = 0; py < hi; py++) {
      const dy = py - cy;
      for (let px = 0; px < wi; px++) {
        const dx = px - cx;
        const rad = Math.hypot(dx, dy);
        if (rad > R) continue;
        const vDisplay = (rad / R) * displayVMax;
        if (vDisplay > scanVMax) continue;
        const ang = Math.atan2(dy, dx) + Math.PI / 2;
        let tau = ang / (2 * Math.PI);
        tau = tau - Math.floor(tau);
        const i = Math.min(n - 1, Math.max(0, Math.floor(tau * n)));
        const j = Math.min(n - 1, Math.max(0, Math.floor((vDisplay / scanVMax) * n)));
        const ts = this.tauStars[j * n + i];
        if (isNaN(ts)) continue;
        const [r, g, b] = cyclicColor(ts);
        const idx = (py * wi + px) * 4;
        data[idx] = r;
        data[idx + 1] = g;
        data[idx + 2] = b;
        data[idx + 3] = 230;
      }
    }
    ctx.putImageData(imageData, 0, 0);
    this.offValid = true;
  }

  // ----- composite draw -----

  private draw(): void {
    this.drawPolar();
    this.drawDragBox();
  }

  private drawDragBox(): void {
    if (!this.dragStart || !this.dragEnd) return;
    const ctx = this.ctx;
    const x1 = Math.min(this.dragStart.x, this.dragEnd.x);
    const y1 = Math.min(this.dragStart.y, this.dragEnd.y);
    const x2 = Math.max(this.dragStart.x, this.dragEnd.x);
    const y2 = Math.max(this.dragStart.y, this.dragEnd.y);
    ctx.strokeStyle = 'rgba(140, 180, 255, 0.95)';
    ctx.fillStyle = 'rgba(140, 180, 255, 0.15)';
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 3]);
    ctx.fillRect(x1, y1, x2 - x1, y2 - y1);
    ctx.strokeRect(x1 + 0.5, y1 + 0.5, x2 - x1 - 1, y2 - y1 - 1);
    ctx.setLineDash([]);
  }

  private drawPolar(): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#06060e';
    ctx.fillRect(0, 0, w, h);

    // Apply viewport-zoom transform: the natural canvas pixels in viewRect
    // get stretched to fill the visible canvas (no aspect lock).
    ctx.save();
    if (this.viewRect) {
      const r = this.viewRect;
      ctx.scale(w / r.w, h / r.h);
      ctx.translate(-r.x, -r.y);
    }

    const cx = w / 2, cy = h / 2;
    const R = Math.max(0, Math.min(w, h) / 2 - 28);
    if (R <= 0) { ctx.restore(); return; }

    // No projection helpers — everything renders in natural canvas coords.
    // The transform takes care of stretching the visible rectangle.
    const angleOf = (tau: number): number => tau * 2 * Math.PI - Math.PI / 2;
    const radiusOf = (v: number): number => (v / this.vMax) * R;
    const unwrap = (tau: number): number => tau - Math.floor(tau);
    const vIn = (v: number): boolean => v <= this.vMax;

    if (this.showGrid) {
      if (!this.offValid) this.rasterise();
      ctx.drawImage(this.off, 0, 0, w, h);
    }

    // Image dots: cell (i, j) plotted at (τ*, |v*|) coloured by τ₀.
    if (this.showImage && this.tauStars && this.vStars && this.n > 0) {
      const n = this.n;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const ts = this.tauStars[j * n + i];
          if (isNaN(ts)) continue;
          const vs = this.vStars[j * n + i];
          if (isNaN(vs)) continue;
          const tu = unwrap(ts);
          if (tu === null || !vIn(vs)) continue;
          const rad = radiusOf(vs);
          if (rad < 0 || rad > R) continue;
          const ang = angleOf(tu);
          const x = cx + rad * Math.cos(ang);
          const y = cy + rad * Math.sin(ang);
          const tau0 = (i + 0.5) / n;
          const [r0, g0, b0] = cyclicColor(tau0);
          ctx.fillStyle = `rgba(${r0},${g0},${b0},0.55)`;
          ctx.beginPath();
          ctx.arc(x, y, 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Rings + spokes. In zoom mode use niceTicks on the zoomed ranges
    // and number labels on spokes; in polar mode use the months scheme.
    ctx.strokeStyle = '#1e2638';
    ctx.lineWidth = 1;
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = '#556';
    const ringValues = [this.vMax / 4, this.vMax / 2, (3 * this.vMax) / 4, this.vMax];
    for (const val of ringValues) {
      const r = radiusOf(val);
      if (r <= 0 || r > R) continue;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(val.toFixed(2), cx + 3, cy - r - 2);
    }
    ctx.strokeStyle = '#1a2030';
    for (let m = 0; m < 12; m++) {
      const a = angleOf(m / 12);
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a));
      ctx.stroke();
    }
    ctx.fillStyle = '#8a8fa5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const months = ['J','F','M','A','M','J','J','A','S','O','N','D'];
    for (let m = 0; m < 12; m++) {
      const a = angleOf((m + 0.5) / 12);
      ctx.fillText(months[m], cx + (R + 14) * Math.cos(a), cy + (R + 14) * Math.sin(a));
    }

    // Sector overlay (annular wedge in natural polar coords).
    if (this.sector) {
      const s = this.sector;
      const rIn = Math.max(0, Math.min(R, radiusOf(s.vS)));
      const rOut = Math.max(0, Math.min(R, radiusOf(s.vE)));
      const aS = angleOf(s.tauS);
      const aE = angleOf(s.tauE);
      ctx.fillStyle = 'rgba(80, 140, 255, 0.35)';
      ctx.strokeStyle = 'rgba(140, 180, 255, 0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const fromA = aS;
      const toA = aE > aS ? aE : aE + 2 * Math.PI;
      ctx.arc(cx, cy, rOut, fromA, toA, false);
      ctx.arc(cx, cy, rIn, toA, fromA, true);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // Polygon
    if (this.polygon && this.polygon.length > 2) {
      ctx.fillStyle = 'rgba(255, 90, 90, 0.22)';
      ctx.strokeStyle = 'rgba(255, 130, 130, 0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      for (const p of this.polygon) {
        if (p.escaped || !isFinite(p.tau) || !isFinite(p.v)) {
          started = false; continue;
        }
        if (!vIn(p.v)) { started = false; continue; }
        const rad = radiusOf(p.v);
        if (rad < 0 || rad > R) { started = false; continue; }
        const a = angleOf(unwrap(p.tau));
        const x = cx + rad * Math.cos(a);
        const y = cy + rad * Math.sin(a);
        if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        started = true;
      }
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.stroke();
    }

    // P markers
    if (this.pPoints.length > 0) {
      for (const p of this.pPoints) {
        if (!vIn(p.v)) continue;
        const rad = radiusOf(p.v);
        if (rad < 0 || rad > R + 8) continue;
        const ang = angleOf(unwrap(p.tau));
        const x = cx + rad * Math.cos(ang);
        const y = cy + rad * Math.sin(ang);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 12px -apple-system, system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        const label = p.label ?? 'P';
        ctx.strokeText(label, x + 8, y);
        ctx.fillText(label, x + 8, y);
        ctx.lineWidth = 1;
      }
    }

    // End of transformed drawing. Title + colour bar are screen-anchored.
    ctx.restore();

    {
      const lines: string[] = [];
      if (this.showGrid && this.tauStars) lines.push('grid: (τ₀, v₀)  colour = τ*');
      if (this.showImage && this.tauStars) lines.push('image: (τ*, |v*|)  colour = τ₀');
      if (this.viewRect) {
        const r = this.viewRect;
        lines.push(`zoom: ${(w / r.w).toFixed(2)}× × ${(h / r.h).toFixed(2)}×`);
      }
      ctx.fillStyle = '#8a8fa5';
      ctx.font = '11px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], 10, 8 + i * 14);
      }
    }

    if (this.showGrid && this.tauStars) this.drawColorBar(ctx, w, h);
  }

}

// Cyclic τ bounding-arc: find the largest gap and return the complement.
function cyclicTauBounds(taus: number[]): { min: number; max: number } {
  if (taus.length === 1) return { min: taus[0], max: taus[0] };
  const sorted = [...taus].sort((a, b) => a - b);
  let maxGap = 0;
  let maxGapStart = 0;
  for (let i = 0; i < sorted.length; i++) {
    const next = (i + 1) % sorted.length;
    let gap = sorted[next] - sorted[i];
    if (i === sorted.length - 1) gap += 1;
    if (gap > maxGap) { maxGap = gap; maxGapStart = i; }
  }
  const startIdx = (maxGapStart + 1) % sorted.length;
  const tauMin = sorted[startIdx];
  let tauMax = sorted[maxGapStart];
  if (tauMax < tauMin) tauMax += 1;
  return { min: tauMin, max: tauMax };
}

function niceTicks(lo: number, hi: number, n: number): number[] {
  if (!(hi > lo) || !isFinite(lo) || !isFinite(hi)) return [];
  const span = hi - lo;
  const rough = span / n;
  const exp = Math.floor(Math.log10(rough));
  const base = Math.pow(10, exp);
  const candidates = [1, 2, 5, 10].map((m) => m * base);
  let step = candidates[0];
  for (const c of candidates) if (Math.abs(c - rough) < Math.abs(step - rough)) step = c;
  const first = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = first; v <= hi + 1e-12; v += step) out.push(Number(v.toFixed(10)));
  return out;
}

function angleForTau(tau: number): number {
  return tau * 2 * Math.PI - Math.PI / 2;
}

// Cyclic colour map for τ ∈ [0, 1) → RGB. Twilight-like (purple → blue →
// green → yellow → orange → red → purple).
function cyclicColor(t: number): [number, number, number] {
  let u = t - Math.floor(t);
  // Cosine-based cyclic colormap (looks similar to matplotlib twilight).
  const a = 2 * Math.PI * u;
  const r = 0.5 + 0.5 * Math.cos(a + 0.0);
  const g = 0.5 + 0.5 * Math.cos(a + 2.094); // 120°
  const b = 0.5 + 0.5 * Math.cos(a + 4.189); // 240°
  return [Math.round(255 * r), Math.round(255 * g), Math.round(255 * b)];
}
