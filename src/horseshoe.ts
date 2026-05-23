import { HorseshoeCanvas, type SectorRect, type PolygonPoint } from './horseshoeCanvas';
import HorseshoeWorker from './horseshoe-worker?worker';
import type {
  HorseshoeMainToWorker,
  HorseshoeWorkerToMain,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const canvas = new HorseshoeCanvas($<HTMLCanvasElement>('horseshoe-canvas'));

interface Cfg {
  e: number;
  vMax: number;
  maxPeriods: number;
  n: number;
  // Sector
  tauS: number; tauE: number;
  vS: number; vE: number;
  k: number;
}
const cfg: Cfg = {
  e: 0.5, vMax: 10, maxPeriods: 5, n: 100,
  tauS: 0.10, tauE: 0.18, vS: 0.30, vE: 0.60, k: 80,
};

let worker: Worker | null = null;
type Phase = 'idle' | 'grid' | 'sector-initial' | 'sector-refining';
let phase: Phase = 'idle';

// ---------- Sector image: polygon + adaptive refinement ----------

interface PolygonNode {
  s: number;          // boundary parameter ∈ [0, 4) (edge id is floor(s))
  tau0: number;       // input domain coords
  v0: number;
  tau: number;        // output codomain (NaN if escaped)
  v: number;
  escaped: boolean;
}

interface Gap {
  sA: number; sB: number;     // effective bounds (sB > sA, may exceed 4 for wrap)
  ax: number; ay: number;     // screen coords of endpoints
  bx: number; by: number;
  dist: number;               // screen pixels
}

interface PendingGap {
  gap: Gap;
  sMid: number;               // effective midpoint (may exceed 4 for wrap)
  tau0: number; v0: number;
}

const polygonNodes: PolygonNode[] = [];   // sorted by s in [0, 4)
const heap: Gap[] = [];                   // max-heap on dist
let pending: PendingGap[] = [];
const REFINE_BATCH = 32;
const THRESHOLD_PX = 1;
let refineCap = 50_000;

function boundaryParam(s: number, c = cfg): { tau0: number; v0: number } {
  const sm = ((s % 4) + 4) % 4;
  const edge = Math.floor(sm) % 4;
  const t = sm - edge;
  switch (edge) {
    case 0: return { tau0: c.tauS, v0: c.vS + (c.vE - c.vS) * t };
    case 1: return { tau0: c.tauS + (c.tauE - c.tauS) * t, v0: c.vE };
    case 2: return { tau0: c.tauE, v0: c.vE + (c.vS - c.vE) * t };
    default: return { tau0: c.tauE + (c.tauS - c.tauE) * t, v0: c.vS };
  }
}

function screenXY(tau: number, v: number): { x: number; y: number } {
  const g = canvas.getDiscGeometry();
  const r = (v / g.vMax) * g.R;
  const a = tau * 2 * Math.PI - Math.PI / 2;
  return { x: g.cx + r * Math.cos(a), y: g.cy + r * Math.sin(a) };
}

// Max-heap on Gap.dist.
function hPush(g: Gap): void {
  heap.push(g);
  let i = heap.length - 1;
  while (i > 0) {
    const p = (i - 1) >>> 1;
    if (heap[p].dist >= heap[i].dist) break;
    [heap[p], heap[i]] = [heap[i], heap[p]];
    i = p;
  }
}
function hPop(): Gap | undefined {
  if (heap.length === 0) return undefined;
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1;
      let m = i;
      if (l < heap.length && heap[l].dist > heap[m].dist) m = l;
      if (r < heap.length && heap[r].dist > heap[m].dist) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i], heap[m]];
      i = m;
    }
  }
  return top;
}
function hPeek(): Gap | undefined { return heap[0]; }

function insertSorted(node: PolygonNode): void {
  let lo = 0, hi = polygonNodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (polygonNodes[mid].s < node.s) lo = mid + 1; else hi = mid;
  }
  polygonNodes.splice(lo, 0, node);
}

function pushGapMaybe(a: PolygonNode, b: PolygonNode, sA: number, sBEff: number): void {
  if (a.escaped || b.escaped) return;
  const pa = screenXY(a.tau, a.v);
  const pb = screenXY(b.tau, b.v);
  const dx = pb.x - pa.x, dy = pb.y - pa.y;
  const dist = Math.hypot(dx, dy);
  if (dist <= THRESHOLD_PX) return;
  hPush({ sA, sB: sBEff, ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y, dist });
}

function buildInitialHeap(): void {
  heap.length = 0;
  const n = polygonNodes.length;
  if (n < 2) return;
  for (let i = 0; i < n; i++) {
    const a = polygonNodes[i];
    const b = polygonNodes[(i + 1) % n];
    const sBEff = (i === n - 1) ? b.s + 4 : b.s;
    pushGapMaybe(a, b, a.s, sBEff);
  }
}

function redrawPolygon(): void {
  canvas.setPolygon(polygonNodes.map((n) => ({
    tau: n.tau, v: n.v, escaped: n.escaped,
  })));
}

// ---------- bindNumeric (shared pattern) ----------

function bindNumeric(
  sliderId: string,
  numId: string,
  opts: { toNum?: (v: number) => string; fromNum?: (s: string) => number | null; clamp: (v: number) => number },
  commit: (value: number) => void
): void {
  const slider = $<HTMLInputElement>(sliderId);
  const num = $<HTMLInputElement>(numId);
  const toNum = opts.toNum ?? ((v) => v.toString());
  const fromNum = opts.fromNum ?? ((s) => {
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  });
  const apply = (v: number, source: 'slider' | 'num') => {
    const clamped = opts.clamp(v);
    if (source !== 'slider') slider.value = String(clamped);
    if (source !== 'num') num.value = toNum(clamped);
    commit(clamped);
  };
  slider.addEventListener('input', () => apply(parseFloat(slider.value), 'slider'));
  num.addEventListener('change', () => {
    const p = fromNum(num.value);
    if (p === null) { num.value = toNum(parseFloat(slider.value)); return; }
    apply(p, 'num');
  });
  num.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
  });
}

// ---------- Bindings ----------

bindNumeric('e', 'e-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0, Math.min(0.999, v)) },
  (v) => { cfg.e = v; updateTabLinks(); });

bindNumeric('vmax', 'vmax-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0.01, v) },
  (v) => { cfg.vMax = v; canvas.setVMax(v); updateSectorDisplay(); });

bindNumeric('tmax', 'tmax-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(1, Math.min(1000, Math.round(v))) },
  (v) => { cfg.maxPeriods = v; });

bindNumeric('n', 'n-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(50, Math.min(1000, Math.round(v))) },
  (v) => { cfg.n = v; });

bindNumeric('taus', 'taus-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => ((v % 1) + 1) % 1 },
  (v) => { cfg.tauS = v; updateSectorDisplay(); });

bindNumeric('taue', 'taue-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => ((v % 1) + 1) % 1 },
  (v) => { cfg.tauE = v; updateSectorDisplay(); });

bindNumeric('vs', 'vs-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0, v) },
  (v) => { cfg.vS = v; updateSectorDisplay(); });

bindNumeric('ve', 've-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0, v) },
  (v) => { cfg.vE = v; updateSectorDisplay(); });

bindNumeric('k', 'k-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(4, Math.min(2000, Math.round(v))) },
  (v) => { cfg.k = v; });

// ---------- Buttons ----------

$('run-grid').addEventListener('click', () => runGrid());
$('stop-grid').addEventListener('click', () => stopAll());
$('toggle-grid').addEventListener('click', () => {
  const next = !canvas.getShowGrid();
  canvas.setShowGrid(next);
  $('toggle-grid').textContent = next ? 'Hide grid' : 'Show grid';
});
$('run-sector').addEventListener('click', () => runSector());
$('reset').addEventListener('click', () => {
  stopAll();
  canvas.clearGrid();
  canvas.setPolygon(null);
  polygonNodes.length = 0;
  heap.length = 0;
  pending = [];
  $('status').textContent = 'ready';
});

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new HorseshoeWorker();
  worker.onmessage = onWorkerMsg;
  return worker;
}

function killWorker(): void {
  if (!worker) return;
  worker.terminate();
  worker = null;
}

function stopAll(): void {
  const wasRefining = phase === 'sector-refining' || phase === 'sector-initial';
  if (worker) {
    const m: HorseshoeMainToWorker = { type: 'stop' };
    worker.postMessage(m);
    killWorker();
  }
  if (wasRefining) {
    phase = 'idle';
    redrawPolygon();
    $('status').textContent = `sector image stopped.  N=${polygonNodes.length}`;
  } else {
    phase = 'idle';
  }
  pending = [];
}

function runGrid(): void {
  if (phase !== 'idle') return;
  canvas.beginGrid(cfg.n, cfg.vMax);
  const w = ensureWorker();
  const m: HorseshoeMainToWorker = {
    type: 'gridScan',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, n: cfg.n, vMax: cfg.vMax },
  };
  w.postMessage(m);
  phase = 'grid';
  $('status').textContent = `grid… 0 / ${cfg.n}`;
}

// Initial inputs (4K samples around the boundary) with their s parameters.
let initialInputs: { s: number; tau0: number; v0: number }[] = [];

function runSector(): void {
  if (phase !== 'idle') return;
  canvas.setVMax(cfg.vMax);
  polygonNodes.length = 0;
  heap.length = 0;
  pending = [];

  const K = Math.max(4, Math.round(cfg.k));
  // Walk the rectangle boundary at s = 0, 1/K, ..., 4 - 1/K (4K samples).
  // No duplicate corner point; the closing gap (last → first) is the wrap.
  initialInputs = [];
  for (let edge = 0; edge < 4; edge++) {
    for (let k = 0; k < K; k++) {
      const s = edge + k / K;
      const p = boundaryParam(s);
      initialInputs.push({ s, tau0: p.tau0, v0: p.v0 });
    }
  }
  refineCap = Math.min(50_000, Math.max(2000, 50 * initialInputs.length));

  const tau0s = initialInputs.map((p) => p.tau0);
  const v0s = initialInputs.map((p) => p.v0);
  const w = ensureWorker();
  const m: HorseshoeMainToWorker = {
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  };
  w.postMessage(m);
  phase = 'sector-initial';
  $('status').textContent = `tracing sector… ${initialInputs.length} shots`;
}

function refineStep(): void {
  if (!worker || phase !== 'sector-refining') return;
  if (polygonNodes.length >= refineCap) { refineDone('cap'); return; }
  const top = hPeek();
  if (!top || top.dist <= THRESHOLD_PX) { refineDone('threshold'); return; }

  pending = [];
  const tau0s: number[] = [];
  const v0s: number[] = [];
  const remaining = refineCap - polygonNodes.length;
  const batchTarget = Math.min(REFINE_BATCH, remaining);
  while (pending.length < batchTarget) {
    const g = hPop();
    if (!g) break;
    if (g.dist <= THRESHOLD_PX) break;
    const sMid = 0.5 * (g.sA + g.sB);
    const { tau0, v0 } = boundaryParam(sMid);
    pending.push({ gap: g, sMid, tau0, v0 });
    tau0s.push(tau0);
    v0s.push(v0);
  }
  if (pending.length === 0) { refineDone('threshold'); return; }
  const m: HorseshoeMainToWorker = {
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  };
  worker.postMessage(m);
  $('status').textContent =
    `refining sector image… N=${polygonNodes.length}  longest=${top.dist.toFixed(1)}px`;
}

function refineDone(reason: 'threshold' | 'cap' | 'stopped'): void {
  phase = 'idle';
  redrawPolygon();
  killWorker();
  const tag = reason === 'cap' ? ` (hit ${refineCap}-pt cap)` :
              reason === 'stopped' ? ' (stopped)' : '';
  $('status').textContent = `sector image done.  N=${polygonNodes.length}${tag}`;
}

function onWorkerMsg(ev: MessageEvent<HorseshoeWorkerToMain>): void {
  const m = ev.data;
  switch (m.type) {
    case 'gridRow':
      canvas.setGridRow(m.msg.row, m.msg.tauStars);
      break;
    case 'gridProgress':
      $('status').textContent = `grid… ${m.done} / ${m.total}`;
      break;
    case 'gridDone':
      phase = 'idle';
      killWorker();
      $('status').textContent = `grid done.  ${cfg.n}×${cfg.n} = ${cfg.n * cfg.n} cells`;
      break;
    case 'shotResults': {
      const { tauStars, vStars, escapes } = m.msg;
      if (phase === 'sector-initial') {
        // Build polygon nodes from initial 4K samples, then start refinement.
        polygonNodes.length = 0;
        for (let i = 0; i < initialInputs.length; i++) {
          const inp = initialInputs[i];
          polygonNodes.push({
            s: inp.s, tau0: inp.tau0, v0: inp.v0,
            tau: tauStars[i], v: vStars[i],
            escaped: escapes[i] === 1,
          });
        }
        // polygonNodes is already sorted by s (we built it in order).
        redrawPolygon();
        phase = 'sector-refining';
        buildInitialHeap();
        refineStep();
      } else if (phase === 'sector-refining') {
        // Pair results with pending gaps; insert midpoints, push sub-gaps.
        for (let i = 0; i < pending.length; i++) {
          const p = pending[i];
          const tau = tauStars[i];
          const v = vStars[i];
          const esc = escapes[i] === 1;
          const sActual = ((p.sMid % 4) + 4) % 4;
          const node: PolygonNode = {
            s: sActual, tau0: p.tau0, v0: p.v0,
            tau, v, escaped: esc,
          };
          insertSorted(node);
          if (esc) continue;
          const mid = screenXY(tau, v);
          const dxA = mid.x - p.gap.ax, dyA = mid.y - p.gap.ay;
          const distA = Math.hypot(dxA, dyA);
          if (distA > THRESHOLD_PX) {
            hPush({
              sA: p.gap.sA, sB: p.sMid,
              ax: p.gap.ax, ay: p.gap.ay, bx: mid.x, by: mid.y,
              dist: distA,
            });
          }
          const dxB = p.gap.bx - mid.x, dyB = p.gap.by - mid.y;
          const distB = Math.hypot(dxB, dyB);
          if (distB > THRESHOLD_PX) {
            hPush({
              sA: p.sMid, sB: p.gap.sB,
              ax: mid.x, ay: mid.y, bx: p.gap.bx, by: p.gap.by,
              dist: distB,
            });
          }
        }
        pending = [];
        redrawPolygon();
        refineStep();
      }
      break;
    }
    case 'stopped':
      phase = 'idle';
      $('status').textContent = 'stopped';
      break;
  }
}

// ---------- Sector display ----------

function updateSectorDisplay(): void {
  const s: SectorRect = {
    tauS: cfg.tauS, tauE: cfg.tauE, vS: cfg.vS, vE: cfg.vE,
  };
  canvas.setSector(s);
}

// ---------- URL query carry-over ----------

function updateTabLinks(): void {
  const q = new URLSearchParams();
  q.set('e', cfg.e.toFixed(4));
  const search = '?' + q.toString();
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('.tab-bar a'))) {
    if (a.getAttribute('data-page') === 'horseshoe') continue;
    const href = a.getAttribute('href') ?? '';
    const base = href.split('?')[0];
    a.setAttribute('href', base + search);
  }
}

function readQuery(): void {
  const p = new URLSearchParams(window.location.search);
  const en = parseFloat(p.get('e') ?? '');
  if (isFinite(en)) {
    cfg.e = Math.max(0, Math.min(0.999, en));
    $<HTMLInputElement>('e').value = String(cfg.e);
    $<HTMLInputElement>('e-num').value = cfg.e.toFixed(3);
  }
}

// ---------- Init ----------

cfg.e = parseFloat($<HTMLInputElement>('e').value);
cfg.vMax = parseFloat($<HTMLInputElement>('vmax').value);
cfg.maxPeriods = parseInt($<HTMLInputElement>('tmax').value, 10);
cfg.n = parseInt($<HTMLInputElement>('n').value, 10);
cfg.tauS = parseFloat($<HTMLInputElement>('taus').value);
cfg.tauE = parseFloat($<HTMLInputElement>('taue').value);
cfg.vS = parseFloat($<HTMLInputElement>('vs').value);
cfg.vE = parseFloat($<HTMLInputElement>('ve').value);
cfg.k = parseInt($<HTMLInputElement>('k').value, 10);

readQuery();
updateTabLinks();
canvas.setVMax(cfg.vMax);
updateSectorDisplay();
