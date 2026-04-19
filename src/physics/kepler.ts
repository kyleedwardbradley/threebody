// Units: 2Gm = 1, relative-orbit semi-major axis a_rel = 1 → period T = 2π.
// Each body has a_body = 1/2; distance from origin r_body = (1 - e cos E)/2.

export const TWO_PI = 2 * Math.PI;
export const PERIOD = TWO_PI;

// Newton iteration on Kepler's equation E - e sin E = M.
export function solveKepler(M: number, e: number): number {
  let m = M % TWO_PI;
  if (m > Math.PI) m -= TWO_PI;
  if (m < -Math.PI) m += TWO_PI;

  let E = m + e * Math.sin(m);
  for (let i = 0; i < 30; i++) {
    const f = E - e * Math.sin(E) - m;
    const fp = 1 - e * Math.cos(E);
    const dE = f / fp;
    E -= dE;
    if (Math.abs(dE) < 1e-14) break;
  }
  return E;
}

export interface BodyState {
  r: number;   // distance from origin
  x: number;   // body-1 x
  y: number;   // body-1 y
  E: number;   // eccentric anomaly
}

// Mean anomaly is offset by π so that (t=0, τ0=0) corresponds to mutual apogee (E=π).
// τ0 ∈ [0,1) is the fractional year at which the simulation is started.
export function bodyState(t: number, tau0: number, e: number): BodyState {
  const M = Math.PI + TWO_PI * (tau0 + t / PERIOD);
  const E = solveKepler(M, e);
  const cosE = Math.cos(E);
  const sinE = Math.sin(E);
  const r = 0.5 * (1 - e * cosE);
  const x = 0.5 * (cosE - e);
  const y = 0.5 * Math.sqrt(Math.max(0, 1 - e * e)) * sinE;
  return { r, x, y, E };
}

// Lightweight variant returning only r (used inside the ODE RHS hot path).
export function bodyRadius(t: number, tau0: number, e: number): number {
  const M = Math.PI + TWO_PI * (tau0 + t / PERIOD);
  const E = solveKepler(M, e);
  return 0.5 * (1 - e * Math.cos(E));
}
