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

// A zoom view region in (τ, v) coordinates. May extend outside [0, 1) on
// τ (continuous representation when straddling the seam).
export interface ZoomRegion {
  tauMin: number; tauMax: number;
  vMin: number;   vMax: number;
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

  // ----- zoom-mode state -----
  // When zoomRegion is set, the canvas renders the data as a Cartesian-
  // stretched view of that (τ, v) rectangle instead of as a polar disc.
  private zoomRegion: ZoomRegion | null = null;
  private zoomToolActive = false;
  private dragStart: { x: number; y: number } | null = null;
  private dragEnd: { x: number; y: number } | null = null;
  onZoomBoxDrawn: ((region: ZoomRegion) => void) | null = null;

  // Padding in zoom mode (for axis labels).
  private readonly PAD_L = 50;
  private readonly PAD_R = 12;
  private readonly PAD_T = 30;
  private readonly PAD_B = 28;

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

  setZoomRegion(r: ZoomRegion | null): void {
    this.zoomRegion = r;
    this.draw();
  }
  getZoomRegion(): ZoomRegion | null { return this.zoomRegion; }
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
    const region = this.computeZoomRegion(start, end);
    if (region && this.onZoomBoxDrawn) this.onZoomBoxDrawn(region);
    this.draw();
  }
  private onMouseLeave(): void {
    if (this.dragStart) {
      this.dragStart = null;
      this.dragEnd = null;
      this.draw();
    }
  }

  // ----- screen ↔ (τ, v) conversion (depends on current view mode) -----

  private polarGeom(): { cx: number; cy: number; R: number } {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return {
      cx: w / 2,
      cy: h / 2,
      R: Math.max(0, Math.min(w, h) / 2 - 28),
    };
  }
  private zoomPlotRect(): { x: number; y: number; w: number; h: number } {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    return {
      x: this.PAD_L,
      y: this.PAD_T,
      w: Math.max(0, cw - this.PAD_L - this.PAD_R),
      h: Math.max(0, ch - this.PAD_T - this.PAD_B),
    };
  }
  private screenToTauV(x: number, y: number): { tau: number; v: number } | null {
    if (this.zoomRegion) {
      const p = this.zoomPlotRect();
      if (x < p.x || x > p.x + p.w || y < p.y || y > p.y + p.h) return null;
      const r = this.zoomRegion;
      const tau = r.tauMin + ((x - p.x) / p.w) * (r.tauMax - r.tauMin);
      const v = r.vMax - ((y - p.y) / p.h) * (r.vMax - r.vMin);
      return { tau, v };
    }
    const { cx, cy, R } = this.polarGeom();
    if (R <= 0) return null;
    const dx = x - cx, dy = y - cy;
    const rad = Math.hypot(dx, dy);
    if (rad > R) return null;
    const ang = Math.atan2(dy, dx) + Math.PI / 2;
    let tau = ang / (2 * Math.PI);
    tau = tau - Math.floor(tau);
    const v = (rad / R) * this.vMax;
    return { tau, v };
  }

  // Bounding box of (τ, v) values from the 4 corners of the screen rectangle.
  // Handles τ wraparound by finding the largest cyclic gap and bounding the
  // complement.
  private computeZoomRegion(
    s: { x: number; y: number }, e: { x: number; y: number },
  ): ZoomRegion | null {
    const x1 = Math.min(s.x, e.x), x2 = Math.max(s.x, e.x);
    const y1 = Math.min(s.y, e.y), y2 = Math.max(s.y, e.y);
    if (x2 - x1 < 4 || y2 - y1 < 4) return null; // ignore tiny drags
    const corners: Array<[number, number]> = [
      [x1, y1], [x2, y1], [x1, y2], [x2, y2],
    ];
    const taus: number[] = [];
    const vs: number[] = [];
    for (const [x, y] of corners) {
      const tv = this.screenToTauV(x, y);
      if (tv) { taus.push(tv.tau); vs.push(tv.v); }
    }
    if (taus.length === 0 || vs.length === 0) return null;
    const vMin = Math.min(...vs);
    const vMax = Math.max(...vs);
    if (vMax <= vMin) return null;
    // In polar mode τ is cyclic; pick the bounding arc by gap-complement.
    // In zoom mode τ is already linear (continuous), so use plain min/max.
    let tauMin: number, tauMax: number;
    if (this.zoomRegion) {
      tauMin = Math.min(...taus);
      tauMax = Math.max(...taus);
    } else {
      const b = cyclicTauBounds(taus);
      tauMin = b.min;
      tauMax = b.max;
    }
    if (tauMax <= tauMin) return null;
    return { tauMin, tauMax, vMin, vMax };
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

    // Pixel sampling: for each pixel inside the disc, find which (i,j) cell
    // it belongs to. Cells live at scan-time v values in [0, scanVMax].
    // The display polar disc spans v ∈ [0, displayVMax]. A pixel at radius r
    // represents v = (r/R) * displayVMax — if that exceeds scanVMax, no scan
    // cell covers it (leave transparent).
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
        // angle = atan2(dy, dx) + π/2 matches τ=0 at top, clockwise.
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
    if (this.zoomRegion) this.drawZoom();
    else this.drawPolar();
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

    const cx = w / 2, cy = h / 2;
    const R = Math.max(0, Math.min(w, h) / 2 - 28);
    if (R <= 0) return;

    if (this.showGrid) {
      if (!this.offValid) this.rasterise();
      ctx.drawImage(this.off, 0, 0, w, h);
    }

    // Image-dot overlay: for each non-escape grid cell, plot at (τ*, |v*|)
    // coloured by τ₀ (the input phase). Same cyclic colourmap as the grid,
    // applied to the input rather than the output.
    if (this.showImage && this.tauStars && this.vStars && this.n > 0) {
      const n = this.n;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const ts = this.tauStars[j * n + i];
          if (isNaN(ts)) continue;
          const vs = this.vStars[j * n + i];
          if (isNaN(vs)) continue;
          const rad = (vs / this.vMax) * R;
          if (rad < 0 || rad > R) continue;
          const ang = angleForTau(ts);
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

    // Polar grid: rings + month spokes.
    ctx.strokeStyle = '#1e2638';
    ctx.lineWidth = 1;
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.fillStyle = '#556';
    const rings = 4;
    for (let i = 1; i <= rings; i++) {
      const r = (R * i) / rings;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.stroke();
      const val = (this.vMax * i) / rings;
      ctx.fillText(val.toFixed(2), cx + 3, cy - r - 2);
    }
    ctx.strokeStyle = '#1a2030';
    for (let m = 0; m < 12; m++) {
      const a = angleForTau(m / 12);
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
      const a = angleForTau((m + 0.5) / 12);
      ctx.fillText(months[m], cx + (R + 14) * Math.cos(a), cy + (R + 14) * Math.sin(a));
    }

    // Sector (blue translucent annular wedge).
    if (this.sector) {
      const s = this.sector;
      const rIn = Math.max(0, Math.min(R, (s.vS / this.vMax) * R));
      const rOut = Math.max(0, Math.min(R, (s.vE / this.vMax) * R));
      const aS = angleForTau(s.tauS);
      const aE = angleForTau(s.tauE);
      // Canvas arcs go counter-clockwise when anticlockwise=true; our angle
      // increases clockwise with τ. Use clockwise=true (default false flipped
      // because y axis is flipped). The math: angleForTau is monotonic in τ,
      // so going from aS to aE (with aE > aS in math coords) traces tau
      // increasing.
      ctx.fillStyle = 'rgba(80, 140, 255, 0.35)';
      ctx.strokeStyle = 'rgba(140, 180, 255, 0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      // sweep angle range
      const fromA = aS;
      const toA = aE > aS ? aE : aE + 2 * Math.PI;
      ctx.arc(cx, cy, rOut, fromA, toA, false);
      ctx.arc(cx, cy, rIn, toA, fromA, true);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // P markers: Moser's transverse intersection points ∂D₀ ∩ ∂D₁ on
    // the symmetry line. Drawn last so they sit on top of everything.
    if (this.pPoints.length > 0) {
      for (const p of this.pPoints) {
        const rad = (p.v / this.vMax) * R;
        if (rad < 0 || rad > R + 8) continue;
        const ang = angleForTau(p.tau);
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
        // Halo the label so it's readable over any background.
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 3;
        const label = p.label ?? 'P';
        ctx.strokeText(label, x + 8, y);
        ctx.fillText(label, x + 8, y);
        ctx.lineWidth = 1;
      }
    }

    // Title in the top centre showing what the plot is.
    {
      const lines: string[] = [];
      if (this.showGrid && this.tauStars) lines.push('grid: (τ₀, v₀)  colour = τ*');
      if (this.showImage && this.tauStars) lines.push('image: (τ*, |v*|)  colour = τ₀');
      ctx.fillStyle = '#8a8fa5';
      ctx.font = '11px -apple-system, system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      for (let i = 0; i < lines.length; i++) {
        ctx.fillText(lines[i], 10, 8 + i * 14);
      }
    }

    // Cyclic colour-bar legend (top right) when grid is visible.
    if (this.showGrid && this.tauStars) this.drawColorBar(ctx, w, h);

    // Polygon: closed boundary of φ(R), filled with evenodd rule so folds
    // (which wind the curve twice) become visible as holes rather than
    // being covered up by uniform fill.
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
        const rad = (p.v / this.vMax) * R;
        if (rad < 0 || rad > R) { started = false; continue; }
        const a = angleForTau(p.tau);
        const x = cx + rad * Math.cos(a);
        const y = cy + rad * Math.sin(a);
        if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        started = true;
      }
      ctx.closePath();
      ctx.fill('evenodd');
      ctx.stroke();
    }
  }

  // Cartesian-stretched view of the data, bounded by this.zoomRegion.
  // Same data sources as drawPolar, projected through linear (τ, v) → (x, y).
  private drawZoom(): void {
    const ctx = this.ctx;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#06060e';
    ctx.fillRect(0, 0, cw, ch);
    const p = this.zoomPlotRect();
    const r = this.zoomRegion!;
    if (p.w <= 0 || p.h <= 0 || r.tauMax <= r.tauMin || r.vMax <= r.vMin) return;

    // Plot background
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(p.x, p.y, p.w, p.h);

    const toX = (tau: number) =>
      p.x + ((tau - r.tauMin) / (r.tauMax - r.tauMin)) * p.w;
    const toY = (v: number) =>
      p.y + p.h - ((v - r.vMin) / (r.vMax - r.vMin)) * p.h;

    // --- Grid heatmap as Cartesian cells, iterate τ-shifts for wrap support
    if (this.showGrid && this.tauStars && this.n > 0) {
      const n = this.n;
      const cellTau = 1 / n;
      const cellV = this.scanVMax / n;
      const j0 = Math.max(0, Math.floor(r.vMin / cellV));
      const j1 = Math.min(n, Math.ceil(r.vMax / cellV) + 1);
      const kLow = Math.floor(r.tauMin);
      const kHigh = Math.floor(r.tauMax);
      for (let k = kLow; k <= kHigh; k++) {
        const localMin = r.tauMin - k;
        const localMax = r.tauMax - k;
        const i0 = Math.max(0, Math.floor(localMin / cellTau));
        const i1 = Math.min(n, Math.ceil(localMax / cellTau) + 1);
        for (let j = j0; j < j1; j++) {
          for (let i = i0; i < i1; i++) {
            const ts = this.tauStars[j * n + i];
            if (isNaN(ts)) continue;
            const x0 = toX(i * cellTau + k);
            const x1 = toX((i + 1) * cellTau + k);
            const y0 = toY((j + 1) * cellV);
            const y1 = toY(j * cellV);
            const xMin = Math.max(p.x, Math.min(x0, x1));
            const xMax = Math.min(p.x + p.w, Math.max(x0, x1));
            const yMin = Math.max(p.y, Math.min(y0, y1));
            const yMax = Math.min(p.y + p.h, Math.max(y0, y1));
            if (xMax <= xMin || yMax <= yMin) continue;
            const [rr, gg, bb] = cyclicColor(ts);
            ctx.fillStyle = `rgb(${rr},${gg},${bb})`;
            ctx.fillRect(xMin, yMin, xMax - xMin, yMax - yMin);
          }
        }
      }
    }

    // --- Image dots (coloured by τ₀)
    if (this.showImage && this.tauStars && this.vStars && this.n > 0) {
      const n = this.n;
      const kLow = Math.floor(r.tauMin);
      const kHigh = Math.floor(r.tauMax);
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const ts = this.tauStars[j * n + i];
          if (isNaN(ts)) continue;
          const vs = this.vStars[j * n + i];
          if (isNaN(vs)) continue;
          if (vs < r.vMin || vs > r.vMax) continue;
          const tau0 = (i + 0.5) / n;
          const [r0, g0, b0] = cyclicColor(tau0);
          ctx.fillStyle = `rgba(${r0},${g0},${b0},0.7)`;
          for (let k = kLow; k <= kHigh; k++) {
            const tauU = ts + k;
            if (tauU < r.tauMin || tauU > r.tauMax) continue;
            ctx.beginPath();
            ctx.arc(toX(tauU), toY(vs), 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      ctx.restore();
    }

    // --- Sector rectangle
    if (this.sector) {
      const s = this.sector;
      ctx.fillStyle = 'rgba(80, 140, 255, 0.30)';
      ctx.strokeStyle = 'rgba(140, 180, 255, 0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.rect(toX(s.tauS), toY(s.vE), toX(s.tauE) - toX(s.tauS), toY(s.vS) - toY(s.vE));
      ctx.fill();
      ctx.stroke();
    }

    // --- Polygon outline (stroke only, with continuous τ unwrap)
    if (this.polygon && this.polygon.length > 2) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255, 130, 130, 0.95)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      const center = 0.5 * (r.tauMin + r.tauMax);
      let started = false;
      let prevTauU = 0;
      for (const pt of this.polygon) {
        if (pt.escaped || !isFinite(pt.tau) || !isFinite(pt.v)) {
          started = false; continue;
        }
        let tauU: number;
        if (started) {
          let d = pt.tau - prevTauU;
          d -= Math.round(d);
          tauU = prevTauU + d;
        } else {
          tauU = pt.tau - Math.round(pt.tau - center);
        }
        const x = toX(tauU), y = toY(pt.v);
        if (started) ctx.lineTo(x, y); else ctx.moveTo(x, y);
        prevTauU = tauU;
        started = true;
      }
      ctx.stroke();
      ctx.restore();
    }

    // --- P markers
    {
      const kLow = Math.floor(r.tauMin);
      const kHigh = Math.floor(r.tauMax);
      for (const pt of this.pPoints) {
        if (pt.v < r.vMin || pt.v > r.vMax) continue;
        for (let k = kLow; k <= kHigh; k++) {
          const tauU = pt.tau + k;
          if (tauU < r.tauMin || tauU > r.tauMax) continue;
          const x = toX(tauU), y = toY(pt.v);
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
          const label = pt.label ?? 'P';
          ctx.strokeText(label, x + 8, y);
          ctx.fillText(label, x + 8, y);
        }
      }
    }

    // --- Border + axis ticks
    ctx.strokeStyle = '#3a3a48';
    ctx.lineWidth = 1;
    ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    ctx.fillStyle = '#8a8fa5';
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    for (const t of niceTicks(r.tauMin, r.tauMax, 6)) {
      const x = toX(t);
      if (x < p.x || x > p.x + p.w) continue;
      ctx.strokeStyle = '#8a8fa5';
      ctx.beginPath(); ctx.moveTo(x, p.y + p.h); ctx.lineTo(x, p.y + p.h + 3); ctx.stroke();
      ctx.fillText(t.toFixed(3), x, p.y + p.h + 5);
    }
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    for (const v of niceTicks(r.vMin, r.vMax, 6)) {
      const y = toY(v);
      if (y < p.y || y > p.y + p.h) continue;
      ctx.strokeStyle = '#8a8fa5';
      ctx.beginPath(); ctx.moveTo(p.x - 3, y); ctx.lineTo(p.x, y); ctx.stroke();
      ctx.fillText(v.toFixed(3), p.x - 5, y);
    }
    // Title
    ctx.fillStyle = '#8a8fa5';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText(
      `zoom: τ ∈ [${r.tauMin.toFixed(3)}, ${r.tauMax.toFixed(3)}],  v ∈ [${r.vMin.toFixed(3)}, ${r.vMax.toFixed(3)}]`,
      this.PAD_L, 8,
    );
    // Colour bar
    if (this.showGrid && this.tauStars) this.drawColorBar(ctx, cw, ch);
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
