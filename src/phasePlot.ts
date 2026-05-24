// Poincaré section in the (z, z') plane: one point per binary period, taken
// whenever the orbital phase τ passes a fixed value (we default to τ = 0,
// mutual apogee — the convention used in Hevia & Rañada 1996).

import { getPalette, onThemeChange } from './theme';

export interface PhasePoint { z: number; v: number; }

export class PhasePlot {
  readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private points: PhasePoint[] = [];
  private zMax: number | null = null;   // null = autoscale
  private vMax: number | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D context unavailable');
    this.ctx = ctx;
    this.resize();
    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas);
    onThemeChange(() => this.draw());
  }

  clear(): void {
    this.points = [];
    this.draw();
  }

  add(items: PhasePoint[]): void {
    for (const p of items) this.points.push(p);
    this.draw();
  }

  setZMax(v: number | null): void {
    if (v !== null && (!isFinite(v) || v <= 0)) return;
    this.zMax = v;
    this.draw();
  }

  setVMax(v: number | null): void {
    if (v !== null && (!isFinite(v) || v <= 0)) return;
    this.vMax = v;
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

  private draw(): void {
    const ctx = this.ctx;
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const pal = getPalette();
    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = pal.bgCanvasOuter;
    ctx.fillRect(0, 0, w, h);

    const pad = { l: 34, r: 14, t: 10, b: 22 };
    const plotW = Math.max(0, w - pad.l - pad.r);
    const plotH = Math.max(0, h - pad.t - pad.b);
    if (plotW === 0 || plotH === 0) return;

    // Autoscale if not overridden.
    let zExt = this.zMax, vExt = this.vMax;
    if (zExt === null || vExt === null) {
      let maxZ = 0.1, maxV = 0.1;
      for (const p of this.points) {
        const az = Math.abs(p.z), av = Math.abs(p.v);
        if (az > maxZ) maxZ = az;
        if (av > maxV) maxV = av;
      }
      if (zExt === null) zExt = niceCeil(maxZ);
      if (vExt === null) vExt = niceCeil(maxV);
    }

    const xOf = (z: number) => pad.l + plotW * (0.5 + 0.5 * (z / zExt!));
    const yOf = (v: number) => pad.t + plotH * (0.5 - 0.5 * (v / vExt!));

    // Frame
    ctx.strokeStyle = pal.gridLineStrong;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.l, pad.t, plotW, plotH);

    // Axes (z = 0, v = 0)
    ctx.strokeStyle = pal.plotBorder;
    ctx.beginPath();
    ctx.moveTo(pad.l, pad.t + plotH / 2);
    ctx.lineTo(pad.l + plotW, pad.t + plotH / 2);
    ctx.moveTo(pad.l + plotW / 2, pad.t);
    ctx.lineTo(pad.l + plotW / 2, pad.t + plotH);
    ctx.stroke();

    // Labels
    ctx.fillStyle = pal.textMuted;
    ctx.font = '10px -apple-system, system-ui, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    ctx.fillText(`+${vExt.toFixed(2)}`, pad.l - 4, pad.t + 4);
    ctx.fillText('0',                   pad.l - 4, pad.t + plotH / 2);
    ctx.fillText(`-${vExt.toFixed(2)}`, pad.l - 4, pad.t + plotH - 4);
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    ctx.fillText(`${(-zExt).toFixed(2)}`, pad.l, pad.t + plotH + 4);
    ctx.fillText('0', pad.l + plotW / 2, pad.t + plotH + 4);
    ctx.fillText(`+${zExt.toFixed(2)}`, pad.l + plotW, pad.t + plotH + 4);
    ctx.textAlign = 'left';
    ctx.fillText(`z, z'   N = ${this.points.length}`, pad.l + 4, pad.t + 2);

    // Points (drop off-frame). Use a colour that stands out against both
    // dark and light backgrounds via the theme palette.
    ctx.fillStyle = pal.colorDn;
    for (const p of this.points) {
      if (Math.abs(p.z) > zExt || Math.abs(p.v) > vExt) continue;
      const x = xOf(p.z);
      const y = yOf(p.v);
      ctx.beginPath();
      ctx.arc(x, y, 1.4, 0, Math.PI * 2);
      ctx.fill();
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
