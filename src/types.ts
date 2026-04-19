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

export type WorkerToMain =
  | { type: 'snapshot'; snap: Snapshot }
  | { type: 'crossings'; items: CrossingMsg[] }
  | { type: 'done'; count: number }
  | { type: 'status'; running: boolean; count: number; t: number };
