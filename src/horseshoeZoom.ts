// Cartesian zoom view of a (τ, v) rectangle on the horseshoe page.
// Shares the same data (grid heatmap, image dots, sector, polygon, P markers)
// as the main HorseshoeCanvas but renders them as a flat (τ on x, v on y)
// rectangle, so a narrow polar sector becomes a usable rectangle.

import type { SectorRect, PolygonPoint } from './horseshoeCanvas';

export interface ZoomRange {
  tauMin: number; tauMax: number;
  vMin: number; vMax: number;
}

export class HorseshoeZoom {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private n = 0;
  private scanVMax = 1;
  private tauStars: Float32Array | null = null;
  private vStars: Float32Array | null = null;
  private sector: SectorRect | null = null;
  private polygon: PolygonPoint[] | null = null;
  private spiralLeft: PolygonPoint[] | null = null;
  private spiralRight: PolygonPoint[] | null = null;
  private pPoints: { tau: number; v: number; label?: string }[] = [];
  private showGrid = true;
  private showImage = false;
  private colorRange: { lo: number; hi: number } | null = null;
  private range: ZoomRange = { tauMin: 0, tauMax: 1, vMin: 0, vMax: 1 };

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.resize();
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  beginGrid(n: number, vMax: number): void {
    this.n = n;
    this.scanVMax = vMax;
    this.tauStars = new Float32Array(n * n);
    this.vStars = new Float32Array(n * n);
    this.tauStars.fill(Number.NaN);
    this.vStars.fill(Number.NaN);
    this.draw();
  }
  setGridRow(j: number, tauStars: Float32Array, vStars: Float32Array): void {
    if (!this.tauStars || !this.vStars || j < 0 || j >= this.n) return;
    const off = j * this.n;
    for (let i = 0; i < this.n; i++) {
      this.tauStars[off + i] = tauStars[i];
      this.vStars[off + i] = vStars[i];
    }
    this.draw();
  }
  clearGrid(): void { this.tauStars = null; this.vStars = null; this.draw(); }
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
  setShowGrid(on: boolean): void { this.showGrid = on; this.draw(); }
  setShowImage(on: boolean): void { this.showImage = on; this.draw(); }
  setColorRange(lo: number, hi: number): void {
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return;
    this.colorRange = { lo, hi };
    this.draw();
  }
  setRange(r: ZoomRange): void { this.range = r; this.draw(); }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    this.canvas.width = Math.floor(w * dpr);
    this.canvas.height = Math.floor(h * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  // Plot margins reserve space for axis labels.
  private readonly PAD_L = 42;
  private readonly PAD_B = 28;
  private readonly PAD_T = 28;
  private readonly PAD_R = 12;

  private plotRect(): { x: number; y: number; w: number; h: number } {
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    return {
      x: this.PAD_L,
      y: this.PAD_T,
      w: Math.max(0, cw - this.PAD_L - this.PAD_R),
      h: Math.max(0, ch - this.PAD_T - this.PAD_B),
    };
  }

  // (τ, v) → screen px (origin at top-left of plot rect, y goes down).
  private toX(tau: number): number {
    const p = this.plotRect();
    const r = this.range;
    return p.x + ((tau - r.tauMin) / (r.tauMax - r.tauMin)) * p.w;
  }
  private toY(v: number): number {
    const p = this.plotRect();
    const r = this.range;
    return p.y + p.h - ((v - r.vMin) / (r.vMax - r.vMin)) * p.h;
  }

  private draw(): void {
    const ctx = this.ctx;
    const cw = this.canvas.clientWidth;
    const ch = this.canvas.clientHeight;
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = '#06060e';
    ctx.fillRect(0, 0, cw, ch);

    const p = this.plotRect();
    if (p.w <= 0 || p.h <= 0) return;

    // Plot background
    ctx.fillStyle = '#0a0a12';
    ctx.fillRect(p.x, p.y, p.w, p.h);

    // Grid heatmap: draw each visible cell as a filled rect in (τ, v).
    if (this.showGrid && this.tauStars && this.n > 0) {
      const n = this.n;
      const cellTau = 1 / n;
      const cellV = this.scanVMax / n;
      const r = this.range;
      const i0 = Math.max(0, Math.floor(r.tauMin / cellTau));
      const i1 = Math.min(n, Math.ceil(r.tauMax / cellTau) + 1);
      const j0 = Math.max(0, Math.floor(r.vMin / cellV));
      const j1 = Math.min(n, Math.ceil(r.vMax / cellV) + 1);
      for (let j = j0; j < j1; j++) {
        for (let i = i0; i < i1; i++) {
          const ts = this.tauStars[j * n + i];
          if (isNaN(ts)) continue;
          const x0 = this.toX(i * cellTau);
          const x1 = this.toX((i + 1) * cellTau);
          const y0 = this.toY((j + 1) * cellV);
          const y1 = this.toY(j * cellV);
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

    // Image dots, coloured by τ₀ (same convention as main canvas).
    if (this.showImage && this.tauStars && this.vStars && this.n > 0) {
      const n = this.n;
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
          if (ts < this.range.tauMin || ts > this.range.tauMax) continue;
          if (vs < this.range.vMin || vs > this.range.vMax) continue;
          const tau0 = (i + 0.5) / n;
          const [r0, g0, b0] = cyclicColor(tau0);
          ctx.fillStyle = `rgba(${r0},${g0},${b0},0.7)`;
          ctx.beginPath();
          ctx.arc(this.toX(ts), this.toY(vs), 1.6, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      ctx.restore();
    }

    // Sector (blue rectangle).
    if (this.sector) {
      const s = this.sector;
      const x0 = this.toX(s.tauS);
      const x1 = this.toX(s.tauE);
      const y0 = this.toY(s.vE);
      const y1 = this.toY(s.vS);
      ctx.fillStyle = 'rgba(80, 140, 255, 0.30)';
      ctx.strokeStyle = 'rgba(140, 180, 255, 0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.fill();
      ctx.stroke();
    }

    // Polygon outline only — no fill in the zoom view. The polygon's
    // boundary is one continuous loop in (τ*, v*), but a narrow Cartesian
    // τ window cuts it into many sub-paths (one per "wind" of the curve
    // through the visible strip). Canvas's evenodd fill would implicitly
    // close each sub-path with a chord back to its start, producing many
    // spurious triangular regions. Stroking only avoids this entirely and
    // shows exactly the polygon outline.
    if (this.polygon && this.polygon.length > 2) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      ctx.strokeStyle = 'rgba(255, 130, 130, 0.95)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      let started = false;
      let prevTau = 0;
      for (const pt of this.polygon) {
        if (pt.escaped || !isFinite(pt.tau) || !isFinite(pt.v)) {
          started = false; continue;
        }
        const x = this.toX(pt.tau);
        const y = this.toY(pt.v);
        if (started) {
          // Break on apparent τ wrap (polar canvas would render the short
          // cyclic chord; linear Cartesian would render a long horizontal).
          if (Math.abs(pt.tau - prevTau) > 0.5) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        } else {
          ctx.moveTo(x, y);
        }
        prevTau = pt.tau;
        started = true;
      }
      ctx.stroke();
      ctx.restore();
    }

    // P markers
    for (const pt of this.pPoints) {
      if (pt.tau < this.range.tauMin || pt.tau > this.range.tauMax) continue;
      if (pt.v < this.range.vMin || pt.v > this.range.vMax) continue;
      const x = this.toX(pt.tau);
      const y = this.toY(pt.v);
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

    // Border + axis labels
    ctx.strokeStyle = '#3a3a48';
    ctx.lineWidth = 1;
    ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    ctx.fillStyle = '#8a8fa5';
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    // x ticks (τ)
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    const xTicks = niceTicks(this.range.tauMin, this.range.tauMax, 5);
    for (const t of xTicks) {
      const x = this.toX(t);
      if (x < p.x || x > p.x + p.w) continue;
      ctx.beginPath();
      ctx.moveTo(x, p.y + p.h);
      ctx.lineTo(x, p.y + p.h + 3);
      ctx.strokeStyle = '#8a8fa5';
      ctx.stroke();
      ctx.fillText(t.toFixed(3), x, p.y + p.h + 5);
    }
    // y ticks (v)
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    const yTicks = niceTicks(this.range.vMin, this.range.vMax, 5);
    for (const v of yTicks) {
      const y = this.toY(v);
      if (y < p.y || y > p.y + p.h) continue;
      ctx.beginPath();
      ctx.moveTo(p.x - 3, y);
      ctx.lineTo(p.x, y);
      ctx.stroke();
      ctx.fillText(v.toFixed(3), p.x - 5, y);
    }
    // Axis titles
    ctx.fillStyle = '#8a8fa5';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('τ', p.x + p.w / 2, p.y + p.h + 22);
    ctx.save();
    ctx.translate(12, p.y + p.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText('v', 0, 0);
    ctx.restore();

    // Title
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('zoom: (τ, v) Cartesian around sector', this.PAD_L, 6);
  }
}

function cyclicColor(t: number): [number, number, number] {
  const u = t - Math.floor(t);
  const a = 2 * Math.PI * u;
  const r = 0.5 + 0.5 * Math.cos(a);
  const g = 0.5 + 0.5 * Math.cos(a + 2.094);
  const b = 0.5 + 0.5 * Math.cos(a + 4.189);
  return [Math.round(255 * r), Math.round(255 * g), Math.round(255 * b)];
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
