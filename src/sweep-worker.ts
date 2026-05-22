import { Sim } from './physics/sim';
import { PERIOD } from './physics/kepler';
import type {
  SweepMainToWorker,
  SweepWorkerToMain,
  SweepRequest,
  SweepResult,
} from './types';

const BATCH_SIZE = 64;
const YIELD_EVERY_MS = 12;
const PROGRESS_EVERY = 64;

let running = false;

function post(msg: SweepWorkerToMain) { (self as unknown as Worker).postMessage(msg); }

function buildV0s(req: SweepRequest): Float64Array {
  const { v0Min, v0Max, n, spacing } = req;
  const out = new Float64Array(n);
  if (n === 1) { out[0] = v0Min; return out; }
  if (spacing === 'log') {
    const a = Math.log(Math.max(1e-12, v0Min));
    const b = Math.log(Math.max(1e-12, v0Max));
    for (let k = 0; k < n; k++) out[k] = Math.exp(a + (b - a) * k / (n - 1));
  } else {
    for (let k = 0; k < n; k++) out[k] = v0Min + (v0Max - v0Min) * k / (n - 1);
  }
  return out;
}

function runOne(v0: number, e: number, tau0: number, maxPeriods: number): SweepResult {
  const sim = new Sim({ e, v0, tau0, maxCrossings: 1 });
  const tMax = maxPeriods * PERIOD;
  // Step in 1-period chunks so the escape check inside Sim has chances to fire.
  while (
    sim.crossings.length === 0 &&
    !sim.escaped &&
    sim.integrator.t < tMax
  ) {
    const next = Math.min(tMax, sim.integrator.t + PERIOD);
    sim.advanceTo(next);
    if (sim.integrator.h < 1e-14) break;
  }

  if (sim.crossings.length > 0) {
    const c = sim.crossings[0];
    return { v0, t: c.t, tau: c.tau, v: c.v, escaped: false };
  }
  // No first return — either escaped or hit max time. Report the current
  // calendar phase so the caller can place the dot somewhere sensible.
  const t = sim.integrator.t;
  const tau = mod1(tau0 + t / PERIOD);
  const v = sim.integrator.y[1];
  return { v0, t, tau, v, escaped: true };
}

function mod1(x: number): number {
  const m = x - Math.floor(x);
  return m < 0 ? m + 1 : m;
}

async function runSweep(req: SweepRequest): Promise<void> {
  const v0s = buildV0s(req);
  const total = v0s.length;
  running = true;

  let batch: SweepResult[] = [];
  let lastYield = performance.now();
  let lastProgress = 0;

  for (let i = 0; i < total; i++) {
    if (!running) break;
    const res = runOne(v0s[i], req.e, req.tau0, req.maxPeriods);
    batch.push(res);

    if (batch.length >= BATCH_SIZE) {
      post({ type: 'result', items: batch });
      batch = [];
    }

    if (i - lastProgress >= PROGRESS_EVERY) {
      post({ type: 'progress', done: i + 1, total });
      lastProgress = i;
    }

    const now = performance.now();
    if (now - lastYield > YIELD_EVERY_MS) {
      // Let incoming messages (e.g. stop) be processed.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }

  if (batch.length) post({ type: 'result', items: batch });
  post({ type: 'progress', done: total, total });
  post({ type: 'done' });
  running = false;
}

async function runShoot(
  e: number,
  tau0: number,
  maxPeriods: number,
  v0s: number[],
): Promise<void> {
  running = true;
  const out: SweepResult[] = [];
  let lastYield = performance.now();
  for (let i = 0; i < v0s.length; i++) {
    if (!running) break;
    out.push(runOne(v0s[i], e, tau0, maxPeriods));
    const now = performance.now();
    if (now - lastYield > YIELD_EVERY_MS) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      lastYield = performance.now();
    }
  }
  post({ type: 'shotResults', items: out });
  running = false;
}

self.onmessage = (ev: MessageEvent<SweepMainToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'start':
      if (running) return;
      running = true;
      runSweep(m.req);
      break;
    case 'shoot':
      if (running) return;
      running = true;
      runShoot(m.e, m.tau0, m.maxPeriods, m.v0s);
      break;
    case 'stop':
      running = false;
      break;
  }
};
