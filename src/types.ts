export interface SimParamsMsg {
  e: number;
  v0: number;
  tau0: number;
  maxCrossings: number;
}

// speed: finite positive number → realtime multiplier (1 period / 2s at speed=1).
// speed === +Infinity → fast-as-possible (no wall-clock cap).
export const FAST_SPEED = Number.POSITIVE_INFINITY;

export type MainToWorker =
  | { type: 'reset'; params: SimParamsMsg; speed: number; autoStart: boolean }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'setSpeed'; speed: number };

export interface Snapshot {
  t: number;
  tau: number;
  z: number;
  v: number;
  bx: number;
  by: number;
}

export interface CrossingMsg {
  t: number;
  tau: number;
  v: number;
}

export interface PoincareMsg {
  t: number;
  z: number;
  v: number;
}

export type WorkerToMain =
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'crossings'; items: CrossingMsg[] }
  | { type: 'poincare'; items: PoincareMsg[] }
  | { type: 'done'; count: number }
  | { type: 'escape'; t: number; count: number }
  | { type: 'status'; running: boolean; count: number; t: number };

// ----- Velocity-sweep page -----

export interface SweepRequest {
  e: number;
  tau0: number;
  v0Min: number;
  v0Max: number;
  n: number;
  spacing: 'linear' | 'log';
  maxPeriods: number;
}

export interface SweepResult {
  v0: number;
  t: number;       // first-return time (non-modulo, sim units)
  tau: number;     // first-return phase = frac(tau0 + t/T)
  v: number;       // signed velocity at first return
  escaped: boolean;
}

export type SweepMainToWorker =
  | { type: 'start'; req: SweepRequest }
  | { type: 'shoot'; e: number; tau0: number; maxPeriods: number; v0s: number[] }
  | { type: 'stop' };

export type SweepWorkerToMain =
  | { type: 'progress'; done: number; total: number }
  | { type: 'result'; items: SweepResult[] }
  | { type: 'shotResults'; items: SweepResult[] }
  | { type: 'done' };

// Which quantity drives the radial coordinate of a sweep polar plot.
//  'v0'    — radius = v₀ (initial vertical velocity)
//  'vStar' — radius = |v*| (velocity at first return — codomain panel)
export type RadiusSource = 'v0' | 'vStar';
