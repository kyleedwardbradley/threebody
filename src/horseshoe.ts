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
  e: 0.5, vMax: 1.0, maxPeriods: 5, n: 100,
  tauS: 0.10, tauE: 0.18, vS: 0.30, vE: 0.60, k: 80,
};

let worker: Worker | null = null;
type Phase = 'idle' | 'grid' | 'sector';
let phase: Phase = 'idle';

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
  (v) => { cfg.vMax = v; updateSectorDisplay(); });

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
$('run-sector').addEventListener('click', () => runSector());
$('reset').addEventListener('click', () => {
  stopAll();
  canvas.clearGrid();
  canvas.setPolygon(null);
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
  if (!worker) { phase = 'idle'; return; }
  const m: HorseshoeMainToWorker = { type: 'stop' };
  worker.postMessage(m);
  killWorker();
  phase = 'idle';
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

function runSector(): void {
  if (phase !== 'idle') return;
  // Build the four edges, each with K samples. Walk the rectangle's
  // boundary in order so the resulting list traces a closed polygon.
  const K = Math.max(4, Math.round(cfg.k));
  const inputs: { tau0: number; v0: number }[] = [];
  // Edge A: τ = tauS, v: vS → vE
  for (let k = 0; k <= K; k++) {
    const t = k / K;
    inputs.push({ tau0: cfg.tauS, v0: cfg.vS + (cfg.vE - cfg.vS) * t });
  }
  // Edge B: v = vE, τ: tauS → tauE (no wrap; user picks adjacent τs)
  for (let k = 1; k <= K; k++) {
    const t = k / K;
    inputs.push({ tau0: cfg.tauS + (cfg.tauE - cfg.tauS) * t, v0: cfg.vE });
  }
  // Edge C: τ = tauE, v: vE → vS
  for (let k = 1; k <= K; k++) {
    const t = k / K;
    inputs.push({ tau0: cfg.tauE, v0: cfg.vE + (cfg.vS - cfg.vE) * t });
  }
  // Edge D: v = vS, τ: tauE → tauS
  for (let k = 1; k <= K; k++) {
    const t = k / K;
    inputs.push({ tau0: cfg.tauE + (cfg.tauS - cfg.tauE) * t, v0: cfg.vS });
  }
  const tau0s = inputs.map((p) => p.tau0);
  const v0s = inputs.map((p) => p.v0);

  const w = ensureWorker();
  const m: HorseshoeMainToWorker = {
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  };
  w.postMessage(m);
  phase = 'sector';
  $('status').textContent = `tracing sector… ${inputs.length} shots`;
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
      const pts: PolygonPoint[] = [];
      for (let i = 0; i < tauStars.length; i++) {
        pts.push({
          tau: tauStars[i],
          v: vStars[i],
          escaped: escapes[i] === 1,
        });
      }
      canvas.setPolygon(pts);
      phase = 'idle';
      killWorker();
      const nEsc = pts.reduce((s, p) => s + (p.escaped ? 1 : 0), 0);
      $('status').textContent = `sector image: ${pts.length} pts, ${nEsc} escaped`;
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
updateSectorDisplay();
