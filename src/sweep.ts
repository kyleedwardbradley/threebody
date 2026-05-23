import { SweepPolar, type SweepPlotMode, type SweepColorMode } from './sweepPolar';
import SweepWorker from './sweep-worker?worker';
import type {
  SweepMainToWorker,
  SweepWorkerToMain,
  SweepRequest,
  SweepResult,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const polarDomain = new SweepPolar($<HTMLCanvasElement>('polar-canvas-domain'));
const polarCodomain = new SweepPolar($<HTMLCanvasElement>('polar-canvas-codomain'));
// Left: (τ*, v₀) — angle = return phase, radius = initial velocity.
polarDomain.setLabel('τ* vs v₀');
polarDomain.setRadiusSource('v0');
// Right: (τ*, |v*|) — codomain.
polarCodomain.setLabel('τ* vs |v*|');
polarCodomain.setRadiusSource('vStar');
polarCodomain.setAutoGrow(true);

// Feed both panels from one stream of sweep results.
function addPoints(items: SweepResult[]): void {
  polarDomain.add(items);
  polarCodomain.add(items);
}
function clearPoints(): void {
  polarDomain.clear();
  polarCodomain.clear();
}
// The plot the refinement queue measures gaps on (always the domain panel).
const polar = polarDomain;

function applyMode(v: SweepPlotMode): void {
  polarDomain.setMode(v); polarCodomain.setMode(v);
}
function applyColor(v: SweepColorMode): void {
  polarDomain.setColor(v); polarCodomain.setColor(v);
}
function applyDotSize(v: number): void {
  polarDomain.setDotSize(v); polarCodomain.setDotSize(v);
}
function applyDomainRange(lo: number, hi: number): void {
  polarDomain.setRange(lo, hi);
  // Colour scale follows the v₀ range on both panels.
  polarDomain.setColorRange(lo, hi);
  polarCodomain.setColorRange(lo, hi);
  // Give the codomain panel a starting range; it'll auto-grow if needed.
  const { vMin: cMin, vMax: cMax } = polarCodomain.getRange();
  if (cMax <= 0 || cMax < hi) polarCodomain.setRange(0, Math.max(hi, cMax));
}

let worker: Worker | null = null;
let running = false;
type Phase = 'idle' | 'initial' | 'refining';
let phase: Phase = 'idle';

// ---------- Adaptive refinement (priority queue on screen-distance gaps) ----------

interface Gap {
  vA: number; xA: number; yA: number;
  vB: number; xB: number; yB: number;
  dist: number; // pixels
}

// Max-heap on Gap.dist.
const heap: Gap[] = [];
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

// Refinement parameters set at start.
let thresholdPx = 0;
let shotsCap = 0;
let pendingGaps: Gap[] = []; // gaps whose midpoints are in flight; aligned with shotResults order
const REFINE_BATCH = 32;

// Refinement geometry: the (τ*, v₀) left panel.
function discRadius(): number { return polar.getDiscRadius(); }
function discCenter(): { cx: number; cy: number } {
  const c = polar.canvas;
  return { cx: c.clientWidth / 2, cy: c.clientHeight / 2 };
}
function screenCoords(p: SweepResult): { x: number; y: number } | null {
  if (p.escaped) return null;
  const { vMin, vMax } = polar.getRange();
  const range = vMax - vMin;
  if (range <= 0) return null;
  const R = discRadius();
  const r = ((p.v0 - vMin) / range) * R;
  if (r < 0 || r > R) return null;
  const a = p.tau * 2 * Math.PI - Math.PI / 2;
  const { cx, cy } = discCenter();
  return { x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) };
}
function gapBetween(a: SweepResult, b: SweepResult): Gap | null {
  if (a.escaped || b.escaped) return null;
  const sa = screenCoords(a), sb = screenCoords(b);
  if (!sa || !sb) return null;
  const dx = sb.x - sa.x, dy = sb.y - sa.y;
  return { vA: a.v0, xA: sa.x, yA: sa.y, vB: b.v0, xB: sb.x, yB: sb.y, dist: Math.hypot(dx, dy) };
}

function startRefinement(): void {
  heap.length = 0;
  pendingGaps = [];
  thresholdPx = 1;
  shotsCap = Math.min(20 * cfg.n, 100_000);
  const pts = polar.getPoints();
  for (let i = 0; i + 1 < pts.length; i++) {
    const g = gapBetween(pts[i], pts[i + 1]);
    if (g && g.dist > thresholdPx) hPush(g);
  }
  if (heap.length === 0) {
    phase = 'idle';
    running = false;
    setButtonsRunning();
    $('status').textContent = `done.  N = ${polar.getCount()}  (no gaps to refine)`;
    if (worker) { worker.terminate(); worker = null; }
    return;
  }
  phase = 'refining';
  refineStep();
}

function refineStep(): void {
  if (!worker || !running) return;
  if (phase !== 'refining') return;
  // Stop conditions.
  const totalShots = polar.getCount();
  if (totalShots >= shotsCap) { refinementDone('cap'); return; }
  const top = hPeek();
  if (!top || top.dist <= thresholdPx) { refinementDone('threshold'); return; }

  // Pop up to REFINE_BATCH gaps that are still above threshold.
  pendingGaps = [];
  const v0s: number[] = [];
  const remaining = shotsCap - totalShots;
  const batchTarget = Math.min(REFINE_BATCH, remaining);
  while (pendingGaps.length < batchTarget) {
    const g = hPop();
    if (!g) break;
    if (g.dist <= thresholdPx) break; // all remaining are below
    pendingGaps.push(g);
    v0s.push(0.5 * (g.vA + g.vB));
  }
  if (pendingGaps.length === 0) { refinementDone('threshold'); return; }
  const msg: SweepMainToWorker = {
    type: 'shoot', e: cfg.e, tau0: cfg.tau0, maxPeriods: cfg.maxPeriods, v0s,
  };
  worker.postMessage(msg);
  $('status').textContent =
    `refining… N = ${totalShots}  longest gap = ${top.dist.toFixed(1)}px  (≤ ${thresholdPx.toFixed(1)}px)`;
}

function consumeShotResults(items: SweepResult[]): void {
  // Pair results with pendingGaps by index. Add the new point, push the two new sub-gaps.
  addPoints(items);
  for (let i = 0; i < items.length && i < pendingGaps.length; i++) {
    const newP = items[i];
    const parent = pendingGaps[i];
    if (newP.escaped) continue; // either sub-gap straddles escape → skip both
    const sa = screenCoords(newP);
    if (!sa) continue;
    const leftDx = sa.x - parent.xA, leftDy = sa.y - parent.yA;
    const leftDist = Math.hypot(leftDx, leftDy);
    if (leftDist > thresholdPx) {
      hPush({
        vA: parent.vA, xA: parent.xA, yA: parent.yA,
        vB: newP.v0, xB: sa.x, yB: sa.y, dist: leftDist,
      });
    }
    const rightDx = parent.xB - sa.x, rightDy = parent.yB - sa.y;
    const rightDist = Math.hypot(rightDx, rightDy);
    if (rightDist > thresholdPx) {
      hPush({
        vA: newP.v0, xA: sa.x, yA: sa.y,
        vB: parent.vB, xB: parent.xB, yB: parent.yB, dist: rightDist,
      });
    }
  }
  pendingGaps = [];
  refineStep();
}

function refinementDone(reason: 'threshold' | 'cap' | 'stopped'): void {
  phase = 'idle';
  running = false;
  heap.length = 0;
  pendingGaps = [];
  setButtonsRunning();
  const tag = reason === 'cap' ? ` (hit ${shotsCap}-sample cap)` :
              reason === 'stopped' ? ' (stopped)' : '';
  $('status').textContent = `done.  N = ${polar.getCount()}${tag}`;
  if (worker) { worker.terminate(); worker = null; }
}

const cfg: SweepRequest = {
  e: 0.5,
  tau0: 0,
  v0Min: 0.05,
  v0Max: 2,
  n: 2000,
  spacing: 'linear',
  maxPeriods: 1000,
};

let plotMode: SweepPlotMode = 'scatter';
let plotColor: SweepColorMode = 'v0';

// ---------- bindNumeric (cloned from main.ts) ----------

function bindNumeric(
  sliderId: string,
  numId: string,
  opts: { toNum?: (v: number) => string; fromNum?: (s: string) => number | null; clamp: (v: number) => number },
  commit: (value: number) => void
): { set: (v: number) => void } {
  const slider = $<HTMLInputElement>(sliderId);
  const num = $<HTMLInputElement>(numId);
  const toNum = opts.toNum ?? ((v) => v.toString());
  const fromNum = opts.fromNum ?? ((s) => {
    const n = parseFloat(s);
    return isFinite(n) ? n : null;
  });

  const applyValue = (v: number, source: 'slider' | 'num' | 'init') => {
    const clamped = opts.clamp(v);
    if (source !== 'slider') slider.value = String(clamped);
    if (source !== 'num') num.value = toNum(clamped);
    commit(clamped);
  };

  slider.addEventListener('input', () => applyValue(parseFloat(slider.value), 'slider'));
  num.addEventListener('change', () => {
    const parsed = fromNum(num.value);
    if (parsed === null) { num.value = toNum(parseFloat(slider.value)); return; }
    applyValue(parsed, 'num');
  });
  num.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
  });

  return { set: (v) => applyValue(v, 'init') };
}

// ---------- Bindings ----------

const eSetter = bindNumeric('e', 'e-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0, Math.min(0.999, v)) },
  (v) => { cfg.e = v; updateTabLinks(); });

const tau0Setter = bindNumeric('tau0', 'tau0-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => ((v % 1) + 1) % 1 },
  (v) => { cfg.tau0 = v; updateTabLinks(); });

const v0MinSetter = bindNumeric('v0min', 'v0min-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(1e-4, v) },
  (v) => { cfg.v0Min = v; applyDomainRange(cfg.v0Min, cfg.v0Max); });

const v0MaxSetter = bindNumeric('v0max', 'v0max-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(1e-4, v) },
  (v) => { cfg.v0Max = v; applyDomainRange(cfg.v0Min, cfg.v0Max); });

const nSetter = bindNumeric('n', 'n-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(1, Math.min(1_000_000, Math.round(v))) },
  (v) => { cfg.n = v; });

const tmaxSetter = bindNumeric('tmax', 'tmax-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(1, Math.min(100_000, Math.round(v))) },
  (v) => { cfg.maxPeriods = v; });

bindNumeric('dot', 'dot-num',
  { toNum: (v) => v.toFixed(1), clamp: (v) => Math.max(0.1, Math.min(20, v)) },
  (v) => { applyDotSize(v); });

// Segmented controls
function bindSeg<T extends string>(
  attr: string,
  onChange: (value: T) => void,
): (v: T) => void {
  const btns = Array.from(document.querySelectorAll<HTMLButtonElement>(`button.seg-btn[${attr}]`));
  const apply = (v: T) => {
    for (const b of btns) b.classList.toggle('active', b.getAttribute(attr) === v);
    onChange(v);
  };
  for (const b of btns) {
    b.addEventListener('click', () => apply(b.getAttribute(attr) as T));
  }
  return apply;
}

const setSpacing = bindSeg<'linear' | 'log'>('data-spacing', (v) => { cfg.spacing = v; });
const setMode = bindSeg<SweepPlotMode>('data-mode', (v) => { plotMode = v; applyMode(v); });
const setColor = bindSeg<SweepColorMode>('data-color', (v) => {
  plotColor = v;
  applyColor(v);
  const leg = document.getElementById('color-legend');
  if (leg) leg.textContent = v === 'time' ? 't* (blue → red)' : 'v₀ (purple → yellow)';
});

// Buttons
$('run').addEventListener('click', () => startSweep());
$('pause').addEventListener('click', () => stopSweep());
$('reset').addEventListener('click', () => {
  stopSweep();
  clearPoints();
  $('status').textContent = 'ready';
});

function setButtonsRunning(): void {
  $('run').classList.toggle('active', running);
  $('pause').classList.toggle('active', !running);
}

function startSweep(): void {
  if (running) return;
  if (cfg.v0Max <= cfg.v0Min) {
    $('status').textContent = 'v₀ max must be > v₀ min';
    return;
  }
  if (cfg.spacing === 'log' && cfg.v0Min <= 0) {
    $('status').textContent = 'log spacing requires v₀ min > 0';
    return;
  }
  clearPoints();
  applyDomainRange(cfg.v0Min, cfg.v0Max);
  polarCodomain.setRange(0, Math.max(0.5, cfg.v0Max));
  heap.length = 0;
  pendingGaps = [];

  worker = new SweepWorker();
  worker.onmessage = (ev: MessageEvent<SweepWorkerToMain>) => {
    const m = ev.data;
    switch (m.type) {
      case 'result':
        addPoints(m.items);
        break;
      case 'progress':
        if (phase === 'initial') $('status').textContent = `running… ${m.done} / ${m.total}`;
        break;
      case 'done':
        // Initial sweep finished; transition to refinement (if anything to do).
        if (running && phase === 'initial') startRefinement();
        break;
      case 'shotResults':
        if (running && phase === 'refining') consumeShotResults(m.items);
        break;
    }
  };
  const start: SweepMainToWorker = { type: 'start', req: { ...cfg } };
  worker.postMessage(start);
  running = true;
  phase = 'initial';
  setButtonsRunning();
  $('status').textContent = `running… 0 / ${cfg.n}`;
}

function stopSweep(): void {
  if (!running || !worker) return;
  if (phase === 'initial') {
    // Worker is in the middle of the initial sweep — ask it to stop.
    // It will emit 'done', and the 'done' handler will transition to refinement.
    // We want a hard stop instead.
    const stop: SweepMainToWorker = { type: 'stop' };
    worker.postMessage(stop);
    // Pre-empt the 'done' handler so it doesn't kick off refinement.
    phase = 'idle';
    running = false;
    setButtonsRunning();
    $('status').textContent = `stopped.  N = ${polar.getCount()}`;
    worker.terminate();
    worker = null;
  } else if (phase === 'refining') {
    // Stop the current in-flight batch and end refinement.
    const stop: SweepMainToWorker = { type: 'stop' };
    worker.postMessage(stop);
    refinementDone('stopped');
  }
}

// ---------- URL query carry-over ----------

function readQuery(): void {
  const p = new URLSearchParams(window.location.search);
  const getNum = (k: string) => {
    const v = p.get(k);
    if (v === null) return null;
    const n = parseFloat(v);
    return isFinite(n) ? n : null;
  };
  const e = getNum('e');     if (e !== null) eSetter.set(e);
  const t = getNum('tau0');  if (t !== null) tau0Setter.set(t);
  const vmin = getNum('v0min'); if (vmin !== null) v0MinSetter.set(vmin);
  const vmax = getNum('v0max'); if (vmax !== null) v0MaxSetter.set(vmax);
  const n = getNum('n');     if (n !== null) nSetter.set(n);
  const tmax = getNum('tmax'); if (tmax !== null) tmaxSetter.set(tmax);
  const sp = p.get('spacing');
  if (sp === 'linear' || sp === 'log') setSpacing(sp);
}

function updateTabLinks(): void {
  const q = new URLSearchParams();
  q.set('e', cfg.e.toFixed(4));
  q.set('tau0', cfg.tau0.toFixed(4));
  const search = '?' + q.toString();
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('.tab-bar a'))) {
    const href = a.getAttribute('href') ?? '';
    const base = href.split('?')[0];
    a.setAttribute('href', base + search);
  }
}

// ---------- Init ----------

// Initial sync from default slider values.
cfg.e = parseFloat($<HTMLInputElement>('e').value);
cfg.tau0 = parseFloat($<HTMLInputElement>('tau0').value);
cfg.v0Min = parseFloat($<HTMLInputElement>('v0min').value);
cfg.v0Max = parseFloat($<HTMLInputElement>('v0max').value);
cfg.n = parseInt($<HTMLInputElement>('n').value, 10);
cfg.maxPeriods = parseInt($<HTMLInputElement>('tmax').value, 10);

$<HTMLInputElement>('e-num').value = cfg.e.toFixed(3);
$<HTMLInputElement>('tau0-num').value = cfg.tau0.toFixed(3);
$<HTMLInputElement>('v0min-num').value = cfg.v0Min.toFixed(3);
$<HTMLInputElement>('v0max-num').value = cfg.v0Max.toFixed(3);
$<HTMLInputElement>('n-num').value = cfg.n.toString();
$<HTMLInputElement>('tmax-num').value = cfg.maxPeriods.toString();

{
  const dotSlider = $<HTMLInputElement>('dot');
  applyDotSize(parseFloat(dotSlider.value));
}

setMode(plotMode);
setColor(plotColor);
setSpacing(cfg.spacing);
applyDomainRange(cfg.v0Min, cfg.v0Max);
polarCodomain.setRange(0, Math.max(0.5, cfg.v0Max));

readQuery();
updateTabLinks();
setButtonsRunning();
