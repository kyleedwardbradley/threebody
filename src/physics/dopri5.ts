// Dormand–Prince 5(4) with FSAL and PI step-size control.
// Cubic Hermite dense output over the last accepted step for crossing refinement.

export type RHS = (t: number, y: Float64Array, dy: Float64Array) => void;

// DOPRI5 coefficients (Hairer, Nørsett, Wanner, "Solving ODEs I", p.178).
const c2 = 1 / 5, c3 = 3 / 10, c4 = 4 / 5, c5 = 8 / 9;
const a21 = 1 / 5;
const a31 = 3 / 40, a32 = 9 / 40;
const a41 = 44 / 45, a42 = -56 / 15, a43 = 32 / 9;
const a51 = 19372 / 6561, a52 = -25360 / 2187, a53 = 64448 / 6561, a54 = -212 / 729;
const a61 = 9017 / 3168, a62 = -355 / 33, a63 = 46732 / 5247, a64 = 49 / 176, a65 = -5103 / 18656;
const a71 = 35 / 384, a73 = 500 / 1113, a74 = 125 / 192, a75 = -2187 / 6784, a76 = 11 / 84;
// error = (b - b*)
const e1 = 71 / 57600, e3 = -71 / 16695, e4 = 71 / 1920,
      e5 = -17253 / 339200, e6 = 22 / 525, e7 = -1 / 40;

export interface DoPri5Options {
  rtol?: number;
  atol?: number;
  h0?: number;
  hMax?: number;
  hMin?: number;
}

export class DoPri5 {
  readonly n: number;
  readonly rhs: RHS;
  readonly rtol: number;
  readonly atol: number;
  readonly hMax: number;
  readonly hMin: number;

  t: number;
  h: number;
  y: Float64Array;
  f: Float64Array;               // derivative at current t (FSAL)

  // Snapshot of the previous step for dense output.
  tLast = 0;
  hLast = 0;
  yLast: Float64Array;
  fLast: Float64Array;

  private k2: Float64Array;
  private k3: Float64Array;
  private k4: Float64Array;
  private k5: Float64Array;
  private k6: Float64Array;
  private k7: Float64Array;
  private yTmp: Float64Array;
  private yNew: Float64Array;
  private errPrev = 1;

  constructor(y0: Float64Array, t0: number, rhs: RHS, opts: DoPri5Options = {}) {
    this.n = y0.length;
    this.rhs = rhs;
    this.rtol = opts.rtol ?? 1e-9;
    this.atol = opts.atol ?? 1e-12;
    this.hMax = opts.hMax ?? 1.0;
    this.hMin = opts.hMin ?? 1e-14;

    this.t = t0;
    this.h = opts.h0 ?? 1e-3;
    this.y = new Float64Array(y0);
    this.f = new Float64Array(this.n);

    this.yLast = new Float64Array(this.n);
    this.fLast = new Float64Array(this.n);

    this.k2 = new Float64Array(this.n);
    this.k3 = new Float64Array(this.n);
    this.k4 = new Float64Array(this.n);
    this.k5 = new Float64Array(this.n);
    this.k6 = new Float64Array(this.n);
    this.k7 = new Float64Array(this.n);
    this.yTmp = new Float64Array(this.n);
    this.yNew = new Float64Array(this.n);

    rhs(t0, this.y, this.f);
  }

  // Take one accepted step. Returns the step size used.
  step(): number {
    const { n, rhs, y, f, k2, k3, k4, k5, k6, k7, yTmp, yNew, rtol, atol } = this;
    let h = this.h;
    let err = 1;

    for (let attempt = 0; attempt < 20; attempt++) {
      const t = this.t;

      for (let i = 0; i < n; i++) yTmp[i] = y[i] + h * a21 * f[i];
      rhs(t + c2 * h, yTmp, k2);

      for (let i = 0; i < n; i++) yTmp[i] = y[i] + h * (a31 * f[i] + a32 * k2[i]);
      rhs(t + c3 * h, yTmp, k3);

      for (let i = 0; i < n; i++) yTmp[i] = y[i] + h * (a41 * f[i] + a42 * k2[i] + a43 * k3[i]);
      rhs(t + c4 * h, yTmp, k4);

      for (let i = 0; i < n; i++) yTmp[i] = y[i] + h * (a51 * f[i] + a52 * k2[i] + a53 * k3[i] + a54 * k4[i]);
      rhs(t + c5 * h, yTmp, k5);

      for (let i = 0; i < n; i++) yTmp[i] = y[i] + h * (a61 * f[i] + a62 * k2[i] + a63 * k3[i] + a64 * k4[i] + a65 * k5[i]);
      rhs(t + h, yTmp, k6);

      for (let i = 0; i < n; i++) yNew[i] = y[i] + h * (a71 * f[i] + a73 * k3[i] + a74 * k4[i] + a75 * k5[i] + a76 * k6[i]);
      rhs(t + h, yNew, k7);

      // error estimate (weighted RMS)
      let sum = 0;
      for (let i = 0; i < n; i++) {
        const ei = h * (e1 * f[i] + e3 * k3[i] + e4 * k4[i] + e5 * k5[i] + e6 * k6[i] + e7 * k7[i]);
        const sc = atol + rtol * Math.max(Math.abs(y[i]), Math.abs(yNew[i]));
        const r = ei / sc;
        sum += r * r;
      }
      err = Math.sqrt(sum / n);

      if (err <= 1 || h <= this.hMin * 1.0001) break;
      const factor = Math.max(0.1, 0.9 * Math.pow(err, -0.2));
      h *= factor;
      if (h < this.hMin) h = this.hMin;
    }

    // Accept — copy current state into "last" buffers for dense output.
    for (let i = 0; i < n; i++) {
      this.yLast[i] = y[i];
      this.fLast[i] = f[i];
    }
    this.tLast = this.t;
    this.hLast = h;
    this.t += h;
    for (let i = 0; i < n; i++) {
      y[i] = yNew[i];
      f[i] = k7[i]; // FSAL
    }

    // PI controller for next step.
    const safe = 0.9;
    const alpha = 0.7 / 5;
    const beta = 0.4 / 5;
    const errSafe = Math.max(err, 1e-10);
    const fac = Math.min(5, Math.max(0.1,
      safe * Math.pow(errSafe, -alpha) * Math.pow(this.errPrev, beta)));
    this.errPrev = errSafe;
    this.h = Math.min(this.hMax, h * fac);

    return h;
  }

  // Cubic Hermite interpolation over the last accepted step.
  // θ ∈ [0,1] maps linearly to [tLast, tLast + hLast].
  interp(theta: number, out: Float64Array): void {
    const { n, hLast, yLast, fLast, y, f } = this;
    const t2 = theta * theta;
    const t3 = t2 * theta;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + theta;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    for (let i = 0; i < n; i++) {
      out[i] = h00 * yLast[i] + h10 * hLast * fLast[i] + h01 * y[i] + h11 * hLast * f[i];
    }
  }

  // dY/dt at θ (derivative w.r.t. time, not θ).
  interpDeriv(theta: number, out: Float64Array): void {
    const { n, hLast, yLast, fLast, y, f } = this;
    const dh00 = 6 * theta * theta - 6 * theta;
    const dh10 = 3 * theta * theta - 4 * theta + 1;
    const dh01 = -6 * theta * theta + 6 * theta;
    const dh11 = 3 * theta * theta - 2 * theta;
    const inv = 1 / hLast;
    for (let i = 0; i < n; i++) {
      out[i] = inv * (dh00 * yLast[i] + dh10 * hLast * fLast[i]
                    + dh01 * y[i]     + dh11 * hLast * f[i]);
    }
  }
}
