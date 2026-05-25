// Cartesian zoom view of a (τ, v) rectangle on the horseshoe page.
// Shares the same data (grid heatmap, image dots, sector, polygon, P markers)
// as the main HorseshoeCanvas but renders them as a flat (τ on x, v on y)
// rectangle, so a narrow polar sector becomes a usable rectangle.

import type { SectorRect, PolygonPoint } from './horseshoeCanvas';
import { getPalette, onThemeChange } from './theme';

export interface ZoomRange {
  tauMin: number; tauMax: number;
  vMin: number; vMax: number;
}

export class HorseshoeZoom {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  private n = 0;
  private scanTauMin = 0;
  private scanTauMax = 1;
  private scanVMin = 0;
  private scanVMax = 1;
  private tauStars: Float32Array | null = null;
  private vStars: Float32Array | null = null;
  private sector: SectorRect | null = null;
  private polygon: PolygonPoint[] | null = null;
  private spiralLeft: PolygonPoint[] | null = null;
  private spiralRight: PolygonPoint[] | null = null;
  private pPoints: { tau: number; v: number; label?: string }[] = [];
  private boundaryD0: { tau: number; v: number }[] | null = null;
  private showBoundaries = true;
  private vkPolygon: PolygonPoint[] | null = null;
  private showVk = false;
  private shapes: ReadonlyArray<import('./shapes').Shape> = [];
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
    onThemeChange(() => this.draw());
  }

  beginGrid(
    n: number,
    tauMin: number, tauMax: number,
    vMin: number,   vMax: number,
  ): void {
    this.n = n;
    this.scanTauMin = tauMin;
    this.scanTauMax = tauMax;
    this.scanVMin = vMin;
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
  setBoundaryD0(pts: { tau: number; v: number }[] | null): void {
    this.boundaryD0 = pts;
    this.draw();
  }
  setShowBoundaries(on: boolean): void { this.showBoundaries = on; this.draw(); }
  setShowVk(on: boolean): void { this.showVk = on; this.draw(); }
  setVkPolygon(pts: PolygonPoint[] | null): void { this.vkPolygon = pts; this.draw(); }
  setShapes(shapes: ReadonlyArray<import('./shapes').Shape>): void {
    this.shapes = shapes; this.draw();
  }
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
    const T = getPalette();
    ctx.clearRect(0, 0, cw, ch);
    ctx.fillStyle = T.bgCanvasOuter;
    ctx.fillRect(0, 0, cw, ch);

    const p = this.plotRect();
    if (p.w <= 0 || p.h <= 0) return;

    // Plot background
    ctx.fillStyle = T.bgCanvas;
    ctx.fillRect(p.x, p.y, p.w, p.h);

    // Grid heatmap: draw each visible cell as a filled rect in (τ, v).
    // The zoom range can extend outside [0, 1) when the sector straddles
    // the τ=0 seam (e.g. tauMin=-0.1), so iterate over integer τ-shifts
    // that overlap the visible window and render each cell once per shift.
    if (this.showGrid && this.tauStars && this.n > 0) {
      const n = this.n;
      const stMin = this.scanTauMin, stMax = this.scanTauMax;
      const svMin = this.scanVMin,   svMax = this.scanVMax;
      const cellTau = (stMax - stMin) / n;
      const cellV   = (svMax - svMin) / n;
      const r = this.range;
      const j0 = Math.max(0, Math.floor((r.vMin - svMin) / cellV));
      const j1 = Math.min(n, Math.ceil((r.vMax - svMin) / cellV) + 1);
      // Cell i covers τ ∈ [stMin + i*cellTau + k, stMin + (i+1)*cellTau + k] for shift k.
      const kLow = Math.floor(r.tauMin - stMax);
      const kHigh = Math.floor(r.tauMax - stMin);
      for (let k = kLow; k <= kHigh; k++) {
        for (let j = j0; j < j1; j++) {
          for (let i = 0; i < n; i++) {
            const ts = this.tauStars[j * n + i];
            if (isNaN(ts)) continue;
            const cellLow = stMin + i * cellTau + k;
            const cellHigh = stMin + (i + 1) * cellTau + k;
            if (cellHigh < r.tauMin || cellLow > r.tauMax) continue;
            const x0 = this.toX(cellLow);
            const x1 = this.toX(cellHigh);
            const y0 = this.toY(svMin + (j + 1) * cellV);
            const y1 = this.toY(svMin + j * cellV);
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

    // Image dots, coloured by τ₀ (same convention as main canvas). Iterate
    // over integer τ-shifts that overlap the visible window so dots near
    // τ=0.95 also appear at τ=-0.05 when the window is centred near 0.
    if (this.showImage && this.tauStars && this.vStars && this.n > 0) {
      const n = this.n;
      const r = this.range;
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
          const tau0 = this.scanTauMin + ((i + 0.5) / n) * (this.scanTauMax - this.scanTauMin);
          const [r0, g0, b0] = cyclicColor(tau0);
          ctx.fillStyle = `rgba(${r0},${g0},${b0},0.7)`;
          for (let k = kLow; k <= kHigh; k++) {
            const tauU = ts + k;
            if (tauU < r.tauMin || tauU > r.tauMax) continue;
            ctx.beginPath();
            ctx.arc(this.toX(tauU), this.toY(vs), 1.6, 0, Math.PI * 2);
            ctx.fill();
          }
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
      ctx.fillStyle = T.sectorFill;
      ctx.strokeStyle = T.sectorStroke;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.fill();
      ctx.stroke();
    }

    // Stroke a (τ, v) polyline in the zoom panel.
    // Two stages:
    //
    //   1) Unwrap each node's τ into a continuous tauU value relative to
    //      the previous one — a step from τ=0.97 → τ=0.03 becomes
    //      0.97 → 1.03, so the path stays continuous across the τ=0 seam.
    //      The unwrap accumulates across windings, so a polygon that
    //      winds N times has tauU spanning ~N units.
    //
    //   2) Render the polyline at every integer τ-shift k such that
    //      shifting all tauU by k puts at least one node inside the
    //      visible τ window. This makes EACH winding visible in the
    //      narrow window (otherwise only the unique tauU values that
    //      happen to land in the window — typically one winding's worth
    //      — would appear).
    //
    // tauMap lets the same routine draw V_k = ρ(U_k) (t → -t) and
    // ∂D₁ = ρ(∂D₀). closeLoop walks one extra wrap segment so closed
    // curves render their wrap chord too.
    const drawPolyline = (
      pts: ReadonlyArray<{ tau: number; v: number; escaped?: boolean }>,
      color: string, lineWidth: number,
      tauMap: (t: number) => number, closeLoop: boolean,
    ): void => {
      if (pts.length < 2) return;
      const n = pts.length;
      const center = 0.5 * (this.range.tauMin + this.range.tauMax);
      // Stage 1: continuous tauU per node (NaN for breaks).
      const tauUs: number[] = new Array(n);
      let started = false;
      let prevTauU = 0;
      let minTauU = Infinity, maxTauU = -Infinity;
      for (let i = 0; i < n; i++) {
        const pt = pts[i];
        if (pt.escaped || !isFinite(pt.tau) || !isFinite(pt.v)) {
          tauUs[i] = NaN; started = false; continue;
        }
        const tauRaw = tauMap(pt.tau);
        let tauU: number;
        if (started) {
          let delta = tauRaw - prevTauU;
          delta -= Math.round(delta);
          tauU = prevTauU + delta;
        } else {
          tauU = tauRaw - Math.round(tauRaw - center);
        }
        tauUs[i] = tauU;
        if (tauU < minTauU) minTauU = tauU;
        if (tauU > maxTauU) maxTauU = tauU;
        prevTauU = tauU;
        started = true;
      }
      if (!isFinite(minTauU)) return;
      // Stage 2: render at every integer τ-shift overlapping the window.
      const kLow = Math.ceil(this.range.tauMin - maxTauU);
      const kHigh = Math.floor(this.range.tauMax - minTauU);
      ctx.save();
      ctx.beginPath();
      ctx.rect(p.x, p.y, p.w, p.h);
      ctx.clip();
      ctx.strokeStyle = color;
      ctx.lineWidth = lineWidth;
      const end = closeLoop ? n + 1 : n;
      for (let k = kLow; k <= kHigh; k++) {
        ctx.beginPath();
        let drawing = false;
        for (let i = 0; i < end; i++) {
          const idx = i % n;
          const tauU = tauUs[idx];
          if (!isFinite(tauU)) { drawing = false; continue; }
          const pt = pts[idx];
          const x = this.toX(tauU + k);
          const y = this.toY(pt.v);
          if (drawing) ctx.lineTo(x, y); else ctx.moveTo(x, y);
          drawing = true;
        }
        ctx.stroke();
      }
      ctx.restore();
    };

    // Per-edge stroke of a polygon (U_k or V_k): split vertices by
    // floor(s) bin into 4 contiguous slices and stroke each in its own
    // colour. drawPolyline only handles a single colour, so we call it
    // per bin with the corresponding slice (plus the next slice's first
    // vertex so the corner chord is drawn in this bin's colour).
    const edgeColors = [T.edge0, T.edge1, T.edge2, T.edge3];
    const strokePolygonByEdge = (poly: PolygonPoint[]): void => {
      const slices: PolygonPoint[][] = [[], [], [], []];
      const binOf = (p: PolygonPoint): number => {
        const s = p.s;
        if (typeof s !== 'number' || !isFinite(s)) return 0;
        return Math.max(0, Math.min(3, Math.floor(((s % 4) + 4) % 4)));
      };
      const N = poly.length;
      for (let i = 0; i < N; i++) {
        const a = poly[i];
        const bin = binOf(a);
        slices[bin].push(a);
        // Include the next vertex in this bin's slice so the corner
        // chord (from this bin's last vertex into the next bin) is
        // drawn in this bin's colour. The next bin will moveTo from
        // its own first vertex regardless, so no double-draw.
        const b = poly[(i + 1) % N];
        const nextBin = binOf(b);
        if (nextBin !== bin) slices[bin].push(b);
      }
      for (let c = 0; c < 4; c++) {
        if (slices[c].length >= 2) {
          drawPolyline(slices[c], edgeColors[c], 1.5, (t) => t, false);
        }
      }
    };

    if (this.polygon && this.polygon.length > 2) strokePolygonByEdge(this.polygon);
    if (this.vkPolygon && this.showVk && this.vkPolygon.length > 2) strokePolygonByEdge(this.vkPolygon);

    // ∂D₀ (yellow) and ∂D₁ = ρ(∂D₀) (green) boundary curves.
    if (this.showBoundaries && this.boundaryD0 && this.boundaryD0.length > 1) {
      drawPolyline(this.boundaryD0, T.d0Line, 1.5, (t) => t, true);
      drawPolyline(this.boundaryD0, T.d1Line, 1.5, (t) => -t, true);
    }

    // User-drawn shapes: stroke each visible shape in its own colour.
    for (const sh of this.shapes) {
      if (!sh.visible || sh.vertices.length < 2) continue;
      drawPolyline(sh.vertices, sh.color, 1.5, (t) => t, sh.closed);
    }

    // P markers — render at any τ-shift that lands inside the window.
    {
      const r = this.range;
      const kLow = Math.floor(r.tauMin);
      const kHigh = Math.floor(r.tauMax);
      for (const pt of this.pPoints) {
        if (pt.v < r.vMin || pt.v > r.vMax) continue;
        for (let k = kLow; k <= kHigh; k++) {
          const tauU = pt.tau + k;
          if (tauU < r.tauMin || tauU > r.tauMax) continue;
          const x = this.toX(tauU);
          const y = this.toY(pt.v);
          ctx.fillStyle = T.pMarkerFill;
          ctx.strokeStyle = T.pMarkerStroke;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(x, y, 5, 0, Math.PI * 2);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = T.pMarkerFill;
          ctx.font = 'bold 12px -apple-system, system-ui, sans-serif';
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.strokeStyle = T.pMarkerStroke;
          ctx.lineWidth = 3;
          const label = pt.label ?? 'P';
          ctx.strokeText(label, x + 8, y);
          ctx.fillText(label, x + 8, y);
        }
      }
    }

    // Border + axis labels
    ctx.strokeStyle = T.plotBorder;
    ctx.lineWidth = 1;
    ctx.strokeRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    ctx.fillStyle = T.textMuted;
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
      ctx.strokeStyle = T.textMuted;
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
    ctx.fillStyle = T.textMuted;
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
