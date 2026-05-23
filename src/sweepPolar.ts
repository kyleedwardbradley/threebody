import type { SweepResult, RadiusSource } from './types';

export type SweepPlotMode = 'scatter' | 'line';
export type SweepColorMode = 'v0' | 'time';

// Polar plot of one dot per shot: θ = 2π·τ*, radius = v₀.
// Escape shots are drawn on an outer ring at v₀_max·1.05.
export class SweepPolar {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private points: SweepResult[] = [];
  private vMin = 0;
  private vMax = 2;
  private mode: SweepPlotMode = 'scatter';
  private color: SweepColorMode = 'v0';
  private timeMaxHint = 100; // max t (sim units) for time-colour gradient; auto-grows
  private dotSize = 1.7;
  private radiusSource: RadiusSource = 'v0';
  private autoGrow = false;          // grow vMax to fit incoming data
  private label: string | null = null;
  private colorRange: { lo: number; hi: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.resize();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
  }

  clear(): void {
    this.points = [];
    this.timeMaxHint = 100;
    this.draw();
  }

  add(items: SweepResult[]): void {
    let grow = 0;
    for (const p of items) {
      this.insertSorted(p);
      if (!p.escaped && p.t > this.timeMaxHint) this.timeMaxHint = p.t;
      if (this.autoGrow && !p.escaped) {
        const r = this.radiusSource === 'v0' ? p.v0 : Math.abs(p.v);
        if (r > grow) grow = r;
      }
    }
    if (this.autoGrow && grow > this.vMax) this.vMax = grow * 1.1;
    this.draw();
  }

  // Sorted-by-v0 insertion so line mode (and adaptive subdivision on the
  // main thread) can iterate in v0 order regardless of arrival order.
  private insertSorted(p: SweepResult): void {
    const arr = this.points;
    let lo = 0, hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (arr[mid].v0 < p.v0) lo = mid + 1; else hi = mid;
    }
    arr.splice(lo, 0, p);
  }

  // Ordered (by v0) view of current points — used by the refinement queue.
  getPoints(): readonly SweepResult[] { return this.points; }

  // Polar disc radius in CSS pixels, matching draw().
  getDiscRadius(): number {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    return Math.max(0, Math.min(w, h) / 2 - 36);
  }
  getRange(): { vMin: number; vMax: number } {
    return { vMin: this.vMin, vMax: this.vMax };
  }

  setRange(vMin: number, vMax: number): void {
    if (!isFinite(vMin) || !isFinite(vMax) || vMax <= vMin) return;
    this.vMin = vMin;
    this.vMax = vMax;
    this.draw();
  }

  setMode(m: SweepPlotMode): void { this.mode = m; this.draw(); }
  setColor(m: SweepColorMode): void { this.color = m; this.draw(); }
  setDotSize(px: number): void {
    if (!isFinite(px) || px <= 0) return;
    this.dotSize = px;
    this.draw();
  }
  getDotSize(): number { return this.dotSize; }
  setRadiusSource(s: RadiusSource): void { this.radiusSource = s; this.draw(); }
  setAutoGrow(on: boolean): void { this.autoGrow = on; }
  setLabel(s: string | null): void { this.label = s; this.draw(); }
  setColorRange(lo: number, hi: number): void {
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return;
    this.colorRange = { lo, hi };
    this.draw();
  }

  getCount(): number { return this.points.length; }

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

  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#06060e';
    ctx.fillRect(0, 0, w, h);

    const cx = w / 2;
    const cy = h / 2;
    // Reserve room for the escape ring at 1.05·R.
    const R = Math.max(0, Math.min(w, h) / 2 - 36);
    if (R <= 0) return;

    const rMin = this.vMin;
    const rMax = this.vMax;
    const range = rMax - rMin;

    // Rings
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
      const val = rMin + (range * i) / rings;
      ctx.fillText(val.toFixed(2), cx + 3, cy - r - 2);
    }

    // Month spokes + labels
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
    const months = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    for (let m = 0; m < 12; m++) {
      const a = angleForTau((m + 0.5) / 12);
      ctx.fillText(months[m], cx + (R + 22) * Math.cos(a), cy + (R + 22) * Math.sin(a));
    }

    const isV0 = this.radiusSource === 'v0';
    const radiusOf = (p: SweepResult): number => isV0 ? p.v0 : Math.abs(p.v);

    // Escape ring outline — only meaningful when radius = v₀ (otherwise
    // escape dots don't get pushed to a separate ring).
    const Resc = R * 1.05;
    if (isV0) {
      ctx.strokeStyle = '#3a1a2a';
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(cx, cy, Resc, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Line mode: connect non-escape points in v₀ order with a polyline.
    // Skip segments longer than 10% of the diagram width — keeps the regular
    // arcs visible without drawing chords across chaotic discontinuities.
    if (this.mode === 'line') {
      const maxSeg = 0.10 * 2 * R;
      const maxSeg2 = maxSeg * maxSeg;
      ctx.strokeStyle = '#3a5070';
      ctx.lineWidth = 1;
      ctx.beginPath();
      let prevX = 0, prevY = 0;
      let started = false;
      for (const p of this.points) {
        if (p.escaped) { started = false; continue; }
        const r = ((radiusOf(p) - rMin) / range) * R;
        if (r < 0 || r > R) { started = false; continue; }
        const a = angleForTau(p.tau);
        const x = cx + r * Math.cos(a);
        const y = cy + r * Math.sin(a);
        if (started) {
          const dx = x - prevX, dy = y - prevY;
          if (dx * dx + dy * dy <= maxSeg2) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        } else {
          ctx.moveTo(x, y);
        }
        prevX = x; prevY = y;
        started = true;
      }
      ctx.stroke();
    }

    // Points
    const timeMax = Math.max(1, this.timeMaxHint);
    const dot = this.dotSize;
    const escDot = Math.max(dot, dot * 1.05);
    for (const p of this.points) {
      if (p.escaped) {
        // Domain (radius=v₀): place on outer escape ring at last-known phase.
        // Codomain (radius=|v*|): τ* isn't meaningful for escapees → skip.
        if (!isV0) continue;
        const a = angleForTau(p.tau);
        const x = cx + Resc * Math.cos(a);
        const y = cy + Resc * Math.sin(a);
        ctx.fillStyle = '#ff3a6a';
        ctx.beginPath();
        ctx.arc(x, y, escDot, 0, Math.PI * 2);
        ctx.fill();
        continue;
      }
      const r = ((radiusOf(p) - rMin) / range) * R;
      if (r < 0 || r > R) continue;
      const a = angleForTau(p.tau);
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);

      if (this.color === 'time') {
        ctx.fillStyle = timeColor(p.t, timeMax);
      } else {
        // Colour by v₀ over the colour-range so the same dot is the same
        // hue in both domain and codomain panels.
        const cr = this.colorRange ?? { lo: rMin, hi: rMax };
        ctx.fillStyle = v0Color(p.v0, cr.lo, cr.hi);
      }
      ctx.beginPath();
      ctx.arc(x, y, dot, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#8a8fa5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`N = ${this.points.length}`, 10, 8);
    if (this.color === 'time') {
      ctx.fillText(`t ∈ [0, ${timeMax.toFixed(1)}]`, 10, 22);
    }
    if (this.label) {
      ctx.textAlign = 'right';
      ctx.fillStyle = '#8a8fa5';
      ctx.fillText(this.label, w - 10, 8);
    }
  }
}

function angleForTau(tau: number): number {
  return tau * 2 * Math.PI - Math.PI / 2;
}

// Cool→warm gradient over [0, tMax]. Returns an "rgb(...)" string.
function timeColor(t: number, tMax: number): string {
  const u = Math.max(0, Math.min(1, t / tMax));
  // Blue (cool) → cyan → yellow → red (warm).
  const r = Math.round(255 * Math.min(1, Math.max(0, 1.5 * u - 0.25)));
  const g = Math.round(255 * Math.min(1, Math.max(0, 1.5 - Math.abs(2 * u - 1) * 1.5)));
  const b = Math.round(255 * Math.min(1, Math.max(0, 1.25 - 2 * u)));
  return `rgb(${r},${g},${b})`;
}

// Plasma-style gradient over [vMin, vMax]: dark purple → magenta → orange → yellow.
// Skips green entirely so the densely-populated middle band doesn't visually flatten.
const PLASMA_STOPS: [number, number, number][] = [
  [ 13,   8, 135], // 0.00 deep purple
  [ 84,   2, 163], // 0.20 violet
  [139,  10, 165], // 0.40 magenta
  [185,  50, 137], // 0.55 pink
  [219,  92, 104], // 0.70 coral
  [244, 136,  73], // 0.82 orange
  [254, 188,  43], // 0.92 amber
  [240, 249,  33], // 1.00 yellow
];
function v0Color(v0: number, vMin: number, vMax: number): string {
  const u = Math.max(0, Math.min(1, (v0 - vMin) / Math.max(1e-12, vMax - vMin)));
  const n = PLASMA_STOPS.length;
  const x = u * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  const t = x - i;
  const a = PLASMA_STOPS[i], b = PLASMA_STOPS[i + 1];
  const r = Math.round(a[0] + (b[0] - a[0]) * t);
  const g = Math.round(a[1] + (b[1] - a[1]) * t);
  const bl = Math.round(a[2] + (b[2] - a[2]) * t);
  return `rgb(${r},${g},${bl})`;
}
