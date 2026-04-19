import { Sim } from './physics/sim';
import { bodyState, PERIOD } from './physics/kepler';
import {
  FAST_SPEED,
  type MainToWorker,
  type WorkerToMain,
  type Snapshot,
  type CrossingMsg,
  type PoincareMsg,
} from './types';

// Baseline: speed=1 ⇒ 1 period per 2 wall seconds ⇒ 0.5 periods/s of sim time.
const BASE_SIM_PER_WALL_SEC = 0.5 * PERIOD;
const SNAPSHOT_MS = 16;            // ≈60 Hz
const STATUS_MS = 250;
const FAST_BUDGET_MS = 8;          // per tick in fast mode

let sim: Sim | null = null;
let speed: number = FAST_SPEED;    // default: fast-as-possible
let running = false;

let wallStart = 0;
let simStart = 0;
let lastSnapshotAt = 0;
let lastStatusAt = 0;
let scheduled = false;
let poincareSent = 0;

function post(msg: WorkerToMain) { (self as unknown as Worker).postMessage(msg); }

function schedule() {
  if (scheduled || !running) return;
  scheduled = true;
  setTimeout(() => { scheduled = false; tick(); }, 0);
}

function tick() {
  if (!running || !sim) return;
  const now = performance.now();
  const fresh: CrossingMsg[] = [];

  if (!isFinite(speed)) {
    const deadline = now + FAST_BUDGET_MS;
    while (performance.now() < deadline && sim.crossings.length < sim.params.maxCrossings) {
      const chunk = sim.advanceTo(sim.integrator.t + PERIOD * 2);
      for (const x of chunk) fresh.push(x);
      if (chunk.length === 0 && sim.integrator.h < 1e-13) break;
    }
  } else {
    const target = simStart + ((now - wallStart) / 1000) * speed * BASE_SIM_PER_WALL_SEC;
    if (target > sim.integrator.t) {
      const chunk = sim.advanceTo(target);
      for (const x of chunk) fresh.push(x);
    }
  }

  if (fresh.length) post({ type: 'crossings', items: fresh });

  if (sim.poincare.length > poincareSent) {
    const newItems: PoincareMsg[] = [];
    for (let i = poincareSent; i < sim.poincare.length; i++) {
      const s = sim.poincare[i];
      newItems.push({ t: s.t, z: s.z, v: s.v });
    }
    poincareSent = sim.poincare.length;
    post({ type: 'poincare', items: newItems });
  }

  if (now - lastSnapshotAt >= SNAPSHOT_MS) {
    lastSnapshotAt = now;
    post({ type: 'snapshot', snap: snapshot() });
  }
  if (now - lastStatusAt >= STATUS_MS) {
    lastStatusAt = now;
    post({ type: 'status', running, count: sim.crossings.length, t: sim.integrator.t });
  }

  if (sim.escaped) {
    running = false;
    post({ type: 'snapshot', snap: snapshot() });
    post({ type: 'escape', t: sim.escapeTime, count: sim.crossings.length });
    return;
  }

  if (sim.crossings.length >= sim.params.maxCrossings) {
    running = false;
    post({ type: 'snapshot', snap: snapshot() });
    post({ type: 'done', count: sim.crossings.length });
    return;
  }

  schedule();
}

function snapshot(): Snapshot {
  const { integrator, params } = sim!;
  const s = bodyState(integrator.t, params.tau0, params.e);
  const tau = mod1(params.tau0 + integrator.t / PERIOD);
  return {
    t: integrator.t,
    tau,
    z: integrator.y[0],
    v: integrator.y[1],
    bx: s.x,
    by: s.y,
  };
}

function mod1(x: number): number {
  const m = x - Math.floor(x);
  return m < 0 ? m + 1 : m;
}

self.onmessage = (ev: MessageEvent<MainToWorker>) => {
  const m = ev.data;
  switch (m.type) {
    case 'reset':
      sim = new Sim(m.params);
      speed = m.speed;
      running = m.autoStart;
      wallStart = performance.now();
      simStart = 0;
      lastSnapshotAt = 0;
      lastStatusAt = 0;
      poincareSent = 0;
      post({ type: 'snapshot', snap: snapshot() });
      post({ type: 'status', running, count: 0, t: 0 });
      // Emit any Poincaré sample taken at t=0 right away.
      if (sim.poincare.length > 0) {
        const items: PoincareMsg[] = sim.poincare.map((s) => ({ t: s.t, z: s.z, v: s.v }));
        poincareSent = sim.poincare.length;
        post({ type: 'poincare', items });
      }
      if (running) schedule();
      break;
    case 'pause':
      running = false;
      if (sim) post({ type: 'status', running, count: sim.crossings.length, t: sim.integrator.t });
      break;
    case 'resume':
      if (!sim || sim.crossings.length >= sim.params.maxCrossings) return;
      running = true;
      wallStart = performance.now();
      simStart = sim.integrator.t;
      schedule();
      break;
    case 'setSpeed':
      speed = m.speed;
      if (sim) {
        wallStart = performance.now();
        simStart = sim.integrator.t;
      }
      break;
  }
};
