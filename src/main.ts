import { initTheme, mountThemeToggle } from './theme';
initTheme();
import { View3D } from './view3d';
import { PolarPlot } from './polarPlot';
import { TimePlot } from './timePlot';
import { PhasePlot } from './phasePlot';
import { bodyState } from './physics/kepler';
mountThemeToggle();
import SimWorker from './worker?worker';
import {
  FAST_SPEED,
  type MainToWorker,
  type WorkerToMain,
  type SimParamsMsg,
  type Snapshot,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const view3d = new View3D($('view3d'));
const polar = new PolarPlot($<HTMLCanvasElement>('polar-canvas'));
const phasePlot = new PhasePlot($<HTMLCanvasElement>('phase-canvas'));
const ztPlot = new TimePlot($<HTMLCanvasElement>('zt-canvas'));

const worker: Worker = new SimWorker();

let params: SimParamsMsg = { e: 0.5, v0: 0.5, tau0: 0, maxCrossings: 1000 };
let speed = 1;
let trailQuality = 0.4;
let isPaused = false;
let latestSnap: Snapshot | null = null;

// ---------- Speed mapping (slider 0..101 ↔ multiplier) ----------

const SPEED_MIN = 0.2;
const SPEED_MAX = 20;
const SPEED_STEPS = 100;

function speedFromIndex(i: number): number {
  if (i >= SPEED_STEPS + 1) return FAST_SPEED;
  const frac = Math.max(0, Math.min(SPEED_STEPS, i)) / SPEED_STEPS;
  return SPEED_MIN * Math.pow(SPEED_MAX / SPEED_MIN, frac);
}

function indexFromSpeed(s: number): number {
  if (!isFinite(s)) return SPEED_STEPS + 1;
  const clamped = Math.max(SPEED_MIN, Math.min(SPEED_MAX, s));
  const frac = Math.log(clamped / SPEED_MIN) / Math.log(SPEED_MAX / SPEED_MIN);
  return Math.round(frac * SPEED_STEPS);
}

function formatSpeed(s: number): string {
  if (!isFinite(s)) return 'MAX';
  if (s >= 10) return `${s.toFixed(1)}×`;
  if (s >= 1) return `${s.toFixed(2)}×`;
  return `${s.toFixed(3)}×`;
}

function parseSpeed(raw: string): number | null {
  const txt = raw.trim().toLowerCase();
  if (txt === '' || txt === 'max' || txt === 'fast' || txt === '∞' || txt === 'inf') {
    return FAST_SPEED;
  }
  const cleaned = txt.replace(/[×x\s]/g, '');
  const n = parseFloat(cleaned);
  if (!isFinite(n) || n <= 0) return null;
  return n;
}

// ---------- Trail ----------

const TRAIL_BASE = 12;
const TRAIL_PER_SPEED = 35;
const TRAIL_CAP = 4096;

function computeTrailLength(q: number, s: number): number {
  if (q <= 0) return 0;
  const scaledSpeed = isFinite(s) ? Math.min(s, SPEED_MAX) : SPEED_MAX * 2;
  const raw = Math.floor(q * (TRAIL_BASE + TRAIL_PER_SPEED * scaledSpeed));
  return Math.max(0, Math.min(TRAIL_CAP, raw));
}

// ---------- Input binding helpers ----------

// Numeric param: slider ↔ number input mirror each other; both route through `commit`.
function bindNumeric(
  sliderId: string, numId: string,
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

  const applyValue = (v: number, source: 'slider' | 'num') => {
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

  return { set: (v) => applyValue(v, 'slider') };
}

// ---------- UI wiring ----------

function send(m: MainToWorker) { worker.postMessage(m); }

function updateButtons(): void {
  $('run').classList.toggle('active', !isPaused);
  $('pause').classList.toggle('active', isPaused);
}

function updateGhosts(): void {
  const g = bodyState(0, params.tau0, params.e);
  view3d.setGhostPositions(g.x, g.y);
  view3d.setGhostsVisible(!isFinite(speed));
}

function restart(): void {
  view3d.setEccentricity(params.e);
  view3d.clearTrail();
  polar.clear();
  phasePlot.clear();
  ztPlot.clear();
  updateGhosts();
  send({ type: 'reset', params, speed, autoStart: !isPaused });
  updateButtons();
}

// eccentricity
bindNumeric('e', 'e-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0, Math.min(0.999, v)) },
  (v) => { params.e = v; updateTabLinks(); restart(); });

// v0 (allow |v| > slider range via number input)
bindNumeric('v0', 'v0-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => v },
  (v) => { params.v0 = v; restart(); });

// tau0
bindNumeric('tau0', 'tau0-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => ((v % 1) + 1) % 1 },
  (v) => { params.tau0 = v; updateTabLinks(); restart(); });

// max crossings
bindNumeric('max', 'max-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(1, Math.round(v)) },
  (v) => { params.maxCrossings = v; restart(); });

// Speed needs special handling (slider is log-mapped indices; num is text with "max").
{
  const slider = $<HTMLInputElement>('speed');
  const num = $<HTMLInputElement>('speed-num');

  const applySpeed = (newSpeed: number, source: 'slider' | 'num') => {
    speed = newSpeed;
    if (source !== 'slider') slider.value = String(indexFromSpeed(newSpeed));
    if (source !== 'num') num.value = formatSpeed(newSpeed);
    send({ type: 'setSpeed', speed });
    applyTrail();
    view3d.setGhostsVisible(!isFinite(speed));
  };
  slider.addEventListener('input', () => {
    applySpeed(speedFromIndex(parseInt(slider.value, 10)), 'slider');
  });
  num.addEventListener('change', () => {
    const parsed = parseSpeed(num.value);
    if (parsed === null) { num.value = formatSpeed(speed); return; }
    applySpeed(parsed, 'num');
  });
  num.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
  });
}

// Trail quality
{
  const slider = $<HTMLInputElement>('trail');
  const num = $<HTMLInputElement>('trail-num');
  const applyTrailVal = (q: number, source: 'slider' | 'num') => {
    const clamped = Math.max(0, Math.min(100, Math.round(q)));
    trailQuality = clamped / 100;
    if (source !== 'slider') slider.value = String(clamped);
    if (source !== 'num') num.value = String(clamped);
    applyTrail();
  };
  slider.addEventListener('input', () => applyTrailVal(parseInt(slider.value, 10), 'slider'));
  num.addEventListener('change', () => {
    const n = parseFloat(num.value);
    if (!isFinite(n)) { num.value = String(Math.round(trailQuality * 100)); return; }
    applyTrailVal(n, 'num');
  });
  num.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
  });
}

function applyTrail(): void {
  const n = computeTrailLength(trailQuality, speed);
  view3d.setTrailLength(n);
}

// Buttons
// Polar plot |v| max
{
  const num = $<HTMLInputElement>('vmax-num');
  const apply = () => {
    const n = parseFloat(num.value);
    if (!isFinite(n) || n <= 0) { num.value = polar.getVMax().toString(); return; }
    polar.setVMax(n);
    num.value = n.toString();
  };
  num.addEventListener('change', apply);
  num.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
  });
  polar.setVMax(parseFloat(num.value));
}

// z(t) plot |z| max ("auto" or a number)
{
  const num = $<HTMLInputElement>('zmax-num');
  const apply = () => {
    const raw = num.value.trim().toLowerCase();
    if (raw === '' || raw === 'auto') { ztPlot.setZMax(null); num.value = 'auto'; return; }
    const n = parseFloat(raw);
    if (!isFinite(n) || n <= 0) { num.value = 'auto'; ztPlot.setZMax(null); return; }
    ztPlot.setZMax(n);
    num.value = n.toString();
  };
  num.addEventListener('change', apply);
  num.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
  });
  apply();
}

// Phase portrait axes ("auto" or a number each)
function bindAxisInput(inputId: string, setter: (v: number | null) => void) {
  const num = $<HTMLInputElement>(inputId);
  const apply = () => {
    const raw = num.value.trim().toLowerCase();
    if (raw === '' || raw === 'auto') { setter(null); num.value = 'auto'; return; }
    const n = parseFloat(raw);
    if (!isFinite(n) || n <= 0) { num.value = 'auto'; setter(null); return; }
    setter(n);
    num.value = n.toString();
  };
  num.addEventListener('change', apply);
  num.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') (ev.target as HTMLInputElement).blur();
  });
  apply();
}
bindAxisInput('phase-zmax-num', (v) => phasePlot.setZMax(v));
bindAxisInput('phase-vmax-num', (v) => phasePlot.setVMax(v));

$('run').addEventListener('click', () => {
  isPaused = false;
  send({ type: 'resume' });
  updateButtons();
});
$('pause').addEventListener('click', () => {
  isPaused = true;
  send({ type: 'pause' });
  updateButtons();
});
$('reset').addEventListener('click', restart);

// Worker messages
worker.onmessage = (ev: MessageEvent<WorkerToMain>) => {
  const m = ev.data;
  switch (m.type) {
    case 'snapshot':
      latestSnap = m.snap;
      ztPlot.add(m.snap.t, m.snap.z);
      break;
    case 'crossings':
      polar.add(m.items);
      for (const c of m.items) view3d.triggerRipple(c.v);
      break;
    case 'poincare':
      phasePlot.add(m.items);
      break;
    case 'status':
      $('status').textContent =
        `t = ${m.t.toFixed(2)}   N = ${m.count}   ${m.running ? 'running' : 'paused'}`;
      break;
    case 'done':
      $('status').textContent = `done.  N = ${m.count}`;
      break;
    case 'escape':
      $('status').textContent = `ESCAPE (t = ${m.t.toFixed(4)})   N = ${m.count}`;
      break;
  }
};

function frame(): void {
  if (latestSnap) view3d.update(latestSnap.bx, latestSnap.by, latestSnap.z);
  view3d.render();
  requestAnimationFrame(frame);
}

// Initial sync of displayed values from slider defaults.
params.e = parseFloat($<HTMLInputElement>('e').value);
params.v0 = parseFloat($<HTMLInputElement>('v0').value);
params.tau0 = parseFloat($<HTMLInputElement>('tau0').value);
params.maxCrossings = parseInt($<HTMLInputElement>('max').value, 10);
speed = speedFromIndex(parseInt($<HTMLInputElement>('speed').value, 10));
trailQuality = parseInt($<HTMLInputElement>('trail').value, 10) / 100;

// Apply URL query overrides (?e=&tau0=) carried in from the sibling page.
{
  const p = new URLSearchParams(window.location.search);
  const eq = parseFloat(p.get('e') ?? '');
  const tq = parseFloat(p.get('tau0') ?? '');
  if (isFinite(eq)) params.e = Math.max(0, Math.min(0.999, eq));
  if (isFinite(tq)) params.tau0 = ((tq % 1) + 1) % 1;
  $<HTMLInputElement>('e').value = String(params.e);
  $<HTMLInputElement>('tau0').value = String(params.tau0);
}

$<HTMLInputElement>('e-num').value = params.e.toFixed(3);
$<HTMLInputElement>('v0-num').value = params.v0.toFixed(3);
$<HTMLInputElement>('tau0-num').value = params.tau0.toFixed(3);
$<HTMLInputElement>('max-num').value = params.maxCrossings.toString();
$<HTMLInputElement>('speed-num').value = formatSpeed(speed);
$<HTMLInputElement>('trail-num').value = String(Math.round(trailQuality * 100));

function updateTabLinks(): void {
  const q = new URLSearchParams();
  q.set('e', params.e.toFixed(4));
  q.set('tau0', params.tau0.toFixed(4));
  const search = '?' + q.toString();
  for (const a of Array.from(document.querySelectorAll<HTMLAnchorElement>('.tab-bar a'))) {
    const href = a.getAttribute('href') ?? '';
    const base = href.split('?')[0];
    a.setAttribute('href', base + search);
  }
}

updateButtons();
updateTabLinks();
view3d.setEccentricity(params.e);
applyTrail();
updateGhosts();
send({ type: 'reset', params, speed, autoStart: !isPaused });
requestAnimationFrame(frame);
