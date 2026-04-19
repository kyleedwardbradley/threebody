// Rolling z(t) scope. Accepts (t, z) samples from worker snapshots;
// draws the most recent `capacity` as a polyline with t on the x-axis
// (in units of the orbital period T = 2π) and z on the y-axis.

const CAPACITY = 4096;

export class TimePlot {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly times = new Float64Array(CAPACITY);
  private readonly zs = new Float64Array(CAPACITY);
  private idx = 0;
  private count = 0;
  private zMaxOverride: number | null = null;   // null = autoscale

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
    this.idx = 0;
    this.count = 0;
    this.draw();
  }

  add(t: number, z: number): void {
    this.times[this.idx] = t;
    this.zs[this.idx] = z;
    this.idx = (this.idx + 1) % CAPACITY;
    this.count = Math.min(this.count + 1, CAPACITY);
    this.draw();
  }

  setZMax(v: number | null): void {
    if (v !== null && (!isFinite(v) || v <= 0)) return;
    this.zMaxOverride = v;
    this.draw();
  }

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

  private orderedIndex(k: number): number {
    // k = 0 → oldest sample in the ring; k = count-1 → newest.
    const start = this.count < CAPACITY ? 0 : this.idx;
    return (start + k) % CAPACITY;
  }

  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#06060e';
    ctx.fillRect(0, 0, w, h);

    const pad = { l: 34, r: 14, t: 10, b: 22 };
    const plotW = Math.max(0, w - pad.l - pad.r);
    const plotH = Math.max(0, h - pad.t - pad.b);
    if (plotW === 0 || plotH === 0) return;

    // Find t range.
    let tMin = Infinity, tMax = -Infinity;
    let zAbsMax = 0;
    for (let k = 0; k < this.count; k++) {
      const i = this.orderedIndex(k);
      const t = this.times[i];
      const z = this.zs[i];
      if (t < tMin) tMin = t;
      if (t > tMax) tMax = t;
      const az = Math.abs(z);
      if (az > zAbsMax) zAbsMax = az;
    }
    if (!isFinite(tMin) || tMax <= tMin) { tMin = 0; tMax = 1; }

    const zMax = this.zMaxOverride ?? niceCeil(Math.max(zAbsMax, 1e-3));

    const T = 2 * Math.PI;
    const xOf = (t: number) => pad.l + ((t - tMin) / (tMax - tMin)) * plotW;
    const yOf = (z: number) => pad.t + plotH * (0.5 - 0.5 * (z / zMax));

    // Axes box
    ctx.strokeStyle = '#1e2638';
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.l, pad.t, plotW, plotH);

    // z = 0 midline
    ctx.strokeStyle = '#2a3348';
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + plotH / 2);
    ctx.lineTo(pad.l + plotW, pad.t + plotH / 2);
    ctx.stroke();

    // y gridlines at ±zMax/2
    ctx.strokeStyle = '#141a28';
    for (const zLine of [zMax / 2, -zMax / 2]) {
      ctx.beginPath();
      const y = yOf(zLine);
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
    }

    // vertical gridlines at each integer period within window
    const pFirst = Math.ceil(tMin / T);
    const pLast  = Math.floor(tMax / T);
    ctx.strokeStyle = '#141a28';
    for (let p = pFirst; p <= pLast; p++) {
      const x = xOf(p * T);
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
    }

    // Axis labels
    ctx.fillStyle = '#8a8fa5';
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText(`+${zMax.toFixed(2)}`, pad.l - 4, pad.t + 4);
    ctx.fillText('0',                   pad.l - 4, pad.t + plotH / 2);
    ctx.fillText(`-${zMax.toFixed(2)}`, pad.l - 4, pad.t + plotH - 4);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText(`t / T  ∈  [${(tMin / T).toFixed(2)}, ${(tMax / T).toFixed(2)}]`,
      pad.l, pad.t + plotH + 4);

    // The curve
    if (this.count >= 2) {
      ctx.strokeStyle = '#88ffaa';
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      for (let k = 0; k < this.count; k++) {
        const i = this.orderedIndex(k);
        const x = xOf(this.times[i]);
        const y = yOf(Math.max(-zMax, Math.min(zMax, this.zs[i])));
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }
}

function niceCeil(x: number): number {
  if (!isFinite(x) || x <= 0) return 1;
  const exp = Math.floor(Math.log10(x));
  const base = Math.pow(10, exp);
  const m = x / base;
  const nice = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
  return nice * base;
}
