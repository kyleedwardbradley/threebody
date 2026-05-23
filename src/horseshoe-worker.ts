import { Sim } from './physics/sim';
import { PERIOD } from './physics/kepler';
import type {
  HorseshoeMainToWorker,
  HorseshoeWorkerToMain,
  HorseshoeRowMsg,
  HorseshoeShootMsg,
} from './types';

const YIELD_MS = 12;

let running = false;

function post(m: HorseshoeWorkerToMain, transfer?: Transferable[]) {
  (self as unknown as Worker).postMessage(m, transfer ?? []);
}

interface ShotResult { tau: number; v: number; escaped: boolean; }

function shoot(tau0: number, v0: number, e: number, maxPeriods: number): ShotResult {
  const sim = new Sim({ e, v0, tau0, maxCrossings: 1 });
  const tMax = maxPeriods * PERIOD;
  while (sim.crossings.length === 0 && !sim.escaped && sim.integrator.t < tMax) {
    sim.advanceTo(Math.min(tMax, sim.integrator.t + PERIOD));
    if (sim.integrator.h < 1e-14) break;
  }
  if (sim.crossings.length > 0) {
    const c = sim.crossings[0];
    return { tau: c.tau, v: Math.abs(c.v), escaped: false };
  }
  return { tau: NaN, v: NaN, escaped: true };
}

async function gridScan(e: number, maxPeriods: number, n: number, vMax: number): Promise<void> {
  let lastYield = performance.now();
  for (let j = 0; j < n; j++) {
    if (!running) break;
    const v0 = ((j + 0.5) / n) * vMax;
    const tauStars = new Float32Array(n);
    const vStars = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const tau0 = (i + 0.5) / n;
      const r = shoot(tau0, v0, e, maxPeriods);
      tauStars[i] = r.escaped ? NaN : r.tau;
      vStars[i] = r.escaped ? NaN : r.v;
      const now = performance.now();
      if (now - lastYield > YIELD_MS) {
        await new Promise<void>((res) => setTimeout(res, 0));
        lastYield = performance.now();
        if (!running) break;
      }
    }
    const rowMsg: HorseshoeRowMsg = { row: j, tauStars, vStars };
    post({ type: 'gridRow', msg: rowMsg }, [tauStars.buffer, vStars.buffer]);
    if (j % Math.max(1, Math.floor(n / 20)) === 0) {
      post({ type: 'gridProgress', done: j + 1, total: n });
    }
  }
  post({ type: 'gridDone' });
  running = false;
}

async function shootMany(
  e: number, maxPeriods: number, tau0s: number[], v0s: number[],
): Promise<void> {
  const n = tau0s.length;
  const tauStars = new Float32Array(n);
  const vStars = new Float32Array(n);
  const escapes = new Uint8Array(n);
  let lastYield = performance.now();
  for (let i = 0; i < n; i++) {
    if (!running) break;
    const r = shoot(tau0s[i], v0s[i], e, maxPeriods);
    tauStars[i] = r.tau;
    vStars[i] = r.v;
    escapes[i] = r.escaped ? 1 : 0;
    const now = performance.now();
    if (now - lastYield > YIELD_MS) {
      await new Promise<void>((res) => setTimeout(res, 0));
      lastYield = performance.now();
    }
  }
  const msg: HorseshoeShootMsg = { tauStars, vStars, escapes };
  post({ type: 'shotResults', msg }, [tauStars.buffer, vStars.buffer, escapes.buffer]);
  running = false;
}

self.onmessage = (ev: MessageEvent<HorseshoeMainToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'gridScan':
      if (running) return;
      running = true;
      gridScan(m.req.e, m.req.maxPeriods, m.req.n, m.req.vMax);
      break;
    case 'shoot':
      if (running) return;
      running = true;
      shootMany(m.req.e, m.req.maxPeriods, m.req.tau0s, m.req.v0s);
      break;
    case 'stop':
      running = false;
      post({ type: 'stopped' });
      break;
  }
};
