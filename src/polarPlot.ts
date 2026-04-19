export interface PolarPoint { tau: number; v: number; }

// Polar scatter: θ = 2π·τ (with τ=0 at "top", clockwise through the year),
// radius = |v|, color encodes sign of v. Radial axis is user-controlled.
export class PolarPlot {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private points: PolarPoint[] = [];
  private vMax = 2;

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
    this.draw();
  }

  add(items: PolarPoint[]): void {
    for (const p of items) this.points.push(p);
    this.draw();
  }

  setVMax(v: number): void {
    if (!isFinite(v) || v <= 0) return;
    this.vMax = v;
    this.draw();
  }

  getVMax(): number { return this.vMax; }

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
    const R = Math.max(0, Math.min(w, h) / 2 - 28);
    if (R <= 0) return;

    const rMax = this.vMax;

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
      ctx.fillText(((rMax * i) / rings).toFixed(2), cx + 3, cy - r - 2);
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
    const months = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];
    for (let m = 0; m < 12; m++) {
      const a = angleForTau((m + 0.5) / 12);
      ctx.fillText(months[m], cx + (R + 14) * Math.cos(a), cy + (R + 14) * Math.sin(a));
    }

    // Points (clipped to the axis; off-scale samples are dropped)
    for (const p of this.points) {
      const mag = Math.abs(p.v);
      if (mag > rMax) continue;
      const a = angleForTau(p.tau);
      const r = (mag / rMax) * R;
      const x = cx + r * Math.cos(a);
      const y = cy + r * Math.sin(a);
      ctx.fillStyle = p.v >= 0 ? '#66ff99' : '#ff6a9a';
      ctx.beginPath();
      ctx.arc(x, y, 1.9, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.fillStyle = '#8a8fa5';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`N = ${this.points.length}`, 10, 8);
  }
}

// τ = 0 → angle = -π/2 (top); increases clockwise.
function angleForTau(tau: number): number {
  return tau * 2 * Math.PI - Math.PI / 2;
}
