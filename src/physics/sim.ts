import { bodyRadius, PERIOD } from './kepler';
import { DoPri5 } from './dopri5';

export interface SimParams {
  e: number;
  v0: number;
  tau0: number;
  maxCrossings: number;
  rtol?: number;
  atol?: number;
}

export interface Crossing {
  t: number;     // simulation time (in units where period = 2π)
  tau: number;   // calendar phase in [0,1)
  v: number;     // z' at crossing (signed)
}

// Threshold beyond which the binary is effectively a point mass at the origin.
// Orbital radius is ≤ (1+e)/2 ≤ 1; Z_FAR = 10 puts relative error in the
// potential ~(1/200) — small enough that the asymptotic escape criterion holds.
const Z_FAR = 10;

// Particle on the z-axis subject to two symmetric orbiting bodies.
// y = [z, z'],  z'' = -z / (r² + z²)^{3/2},  with r = bodyRadius(t).
export class Sim {
  readonly params: SimParams;
  readonly integrator: DoPri5;
  readonly crossings: Crossing[] = [];

  escaped = false;
  escapeTime = 0;

  private yInterp = new Float64Array(2);
  private dInterp = new Float64Array(2);

  constructor(params: SimParams) {
    this.params = params;
    const { e, v0, tau0 } = params;
    const y0 = new Float64Array([0, v0]);

    const rhs = (t: number, y: Float64Array, dy: Float64Array) => {
      const r = bodyRadius(t, tau0, e);
      const z = y[0];
      const d2 = r * r + z * z;
      dy[0] = y[1];
      dy[1] = -z / (d2 * Math.sqrt(d2));
    };

    this.integrator = new DoPri5(y0, 0, rhs, {
      rtol: params.rtol ?? 1e-9,
      atol: params.atol ?? 1e-12,
      h0: 1e-3,
      hMax: PERIOD / 64, // keep step small enough to resolve orbit features
    });
  }

  // Advance to tEnd (or until max crossings reached, or escape detected).
  // Returns the new crossings recorded during this call.
  advanceTo(tEnd: number): Crossing[] {
    const I = this.integrator;
    const out: Crossing[] = [];
    const maxN = this.params.maxCrossings;

    while (I.t < tEnd && !this.escaped && this.crossings.length < maxN) {
      const remaining = tEnd - I.t;
      if (I.h > remaining) I.h = remaining;
      if (I.h < 1e-15) break;

      const zBefore = I.y[0];
      I.step();
      const zAfter = I.y[0];
      const vAfter = I.y[1];

      // Escape check: particle is far from the origin, moving outward, with
      // kinetic energy exceeding the asymptotic escape bound ½v² > 1/|z|.
      const absZ = Math.abs(zAfter);
      if (absZ > Z_FAR && vAfter * zAfter > 0 && 0.5 * vAfter * vAfter > 1 / absZ) {
        this.escaped = true;
        this.escapeTime = I.t;
        break;
      }

      if (zBefore === 0 && I.tLast === 0) continue;
      if (zBefore * zAfter < 0 || (zBefore !== 0 && zAfter === 0)) {
        const c = this.refineCrossing(zBefore, zAfter);
        if (c) {
          this.crossings.push(c);
          out.push(c);
          if (this.crossings.length >= maxN) break;
        }
      }
    }
    return out;
  }

  // Newton's method on the Hermite interpolant to locate z = 0.
  private refineCrossing(zBefore: number, zAfter: number): Crossing | null {
    const I = this.integrator;

    // Linear initial guess.
    let theta = zBefore / (zBefore - zAfter);
    if (!isFinite(theta) || theta <= 0 || theta >= 1) theta = 0.5;

    for (let iter = 0; iter < 20; iter++) {
      I.interp(theta, this.yInterp);
      I.interpDeriv(theta, this.dInterp);
      const z = this.yInterp[0];
      const dzdt = this.dInterp[0];
      if (Math.abs(dzdt) < 1e-30) break;
      // dz/dθ = dz/dt * h
      const dTheta = z / (dzdt * I.hLast);
      theta -= dTheta;
      if (theta < 0) theta = 0;
      if (theta > 1) theta = 1;
      if (Math.abs(dTheta) < 1e-14) break;
    }

    I.interp(theta, this.yInterp);
    const tCross = I.tLast + theta * I.hLast;
    const vCross = this.yInterp[1];
    const tau = mod1(this.params.tau0 + tCross / PERIOD);
    return { t: tCross, tau, v: vCross };
  }
}

function mod1(x: number): number {
  const m = x - Math.floor(x);
  return m < 0 ? m + 1 : m;
}
