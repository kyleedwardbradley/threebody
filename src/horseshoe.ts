import { initTheme, mountThemeToggle } from './theme';
import { mountPanelExport } from './exportPdf';
initTheme();
import { HorseshoeCanvas, type ViewRect, type GridSnapshot } from './horseshoeCanvas';
import { saveState, loadState } from './persist';
import HorseshoeWorker from './horseshoe-worker?worker';
mountThemeToggle();
import type {
  HorseshoeMainToWorker,
  HorseshoeWorkerToMain,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const canvas = new HorseshoeCanvas($<HTMLCanvasElement>('horseshoe-canvas'));
mountPanelExport({
  container: canvas.canvas.parentElement!,
  getCanvas: () => canvas.canvas,
  label: 'Horseshoe: polar disc',
  filename: 'horseshoe-polar',
});

// Last-applied P points are remembered so the page state snapshot can cache
// them (they're not re-derivable from cfg alone).
let lastPPoints: { tau: number; v: number; label?: string }[] = [];
// Coordinate-picker state (declared early so the state snapshot can read it).
let pickedCoord: { tau: number; v: number } | null = null;

// All shared state goes through these so the views stay in lockstep. Each
// also schedules a (debounced) persist so the panel's state survives
// navigation away and back.
function applyPPoints(pts: { tau: number; v: number; label?: string }[]): void {
  lastPPoints = pts;
  canvas.setPPoints(pts); scheduleSave();
}
function applyBeginGrid(
  n: number,
  tauMin: number, tauMax: number,
  vMin: number, vMax: number,
): void {
  canvas.beginGrid(n, tauMin, tauMax, vMin, vMax);
}
function applyGridRow(row: number, tauStars: Float32Array, vStars: Float32Array): void {
  canvas.setGridRow(row, tauStars, vStars);
  scheduleSave();
}
function applyClearGrid(): void {
  canvas.clearGrid(); scheduleSave();
}
function applyShowGrid(on: boolean): void {
  canvas.setShowGrid(on); scheduleSave();
}
function applyShowImage(on: boolean): void {
  canvas.setShowImage(on); scheduleSave();
}

interface Cfg {
  e: number;
  vMax: number;
  maxPeriods: number;
  n: number;
}
const cfg: Cfg = {
  e: 0.5, vMax: 3.2, maxPeriods: 5, n: 200,
};

let worker: Worker | null = null;
type Phase = 'idle' | 'grid'
  | 'finding-p'        // bisecting on the symmetry-line v_esc
  | 'boundary-initial' // initial K-sample ∂D₀ bisection
  | 'boundary-refining' // adaptive refinement of ∂D₀ at screen scale
  | 'preimage';        // φ⁻¹(∂D₀): reflect-shoot-reflect the escape curve
let phase: Phase = 'idle';

// ---------- ∂D₀ / ∂D₁ boundary ----------

interface D0Point { tau: number; vEsc: number; }
interface D0Gap { tauA: number; vA: number; tauB: number; vB: number; dist: number; }

const d0Points: D0Point[] = [];   // sorted by tau ∈ [0, 1)
const d0Heap: D0Gap[] = [];       // max-heap on screen dist
let d0Pending: { tauMid: number; gap: D0Gap }[] = [];
// φ⁻¹(∂D₀): first preimage of the escape curve, in the SAME order as the
// d0Points snapshot it was shot from (folded manifold arc; NaN entries
// mark source points whose reflected shoot escaped forward).
const d0PrePoints: { tau: number; v: number }[] = [];
const D0_INITIAL_K = 64;
const D0_BATCH = 8;
const D0_CAP = 5000;
const D0_THRESHOLD = 2;           // visual pixels
const D0_BISECT_STEPS = 18;

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

// Physics parameters affect every shot — grid and boundaries go stale.
bindNumeric('e', 'e-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0, Math.min(0.999, v)) },
  (v) => { cfg.e = v; updateTabLinks(); invalidateAll(); });

bindNumeric('tmax', 'tmax-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(1, Math.min(1000, Math.round(v))) },
  (v) => { cfg.maxPeriods = v; invalidateAll(); });

// vMax is just a display scale — rescale, never invalidate.
bindNumeric('vmax', 'vmax-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0.01, v) },
  (v) => { cfg.vMax = v; canvas.setVMax(v); scheduleSave(); });

// Grid resolution only changes the grid scan.
bindNumeric('n', 'n-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(50, Math.min(1000, Math.round(v))) },
  (v) => { cfg.n = v; invalidateGrid(); });

// ---------- Buttons ----------

$('run-grid').addEventListener('click', () => runGrid());
$('stop-grid').addEventListener('click', () => stopAll());
$('toggle-grid').addEventListener('click', () => {
  const next = !canvas.getShowGrid();
  applyShowGrid(next);
  $('toggle-grid').textContent = next ? 'Hide grid' : 'Show grid';
});
$('toggle-image').addEventListener('click', () => {
  const next = !canvas.getShowImage();
  applyShowImage(next);
  $('toggle-image').textContent = next ? 'Hide image' : 'Show image';
});
$('run-boundaries').addEventListener('click', () => runBoundaries());
$('refine-boundaries').addEventListener('click', () => startBoundaryRefinement());
$('preimage-boundaries').addEventListener('click', () => runPreimage());
$('toggle-boundaries').addEventListener('click', () => {
  const next = !canvas.getShowBoundaries();
  canvas.setShowBoundaries(next);
  $('toggle-boundaries').textContent = next ? 'Hide boundaries' : 'Show boundaries';
  scheduleSave();
});

// ---------- Zoom tool + view history (left panel only) ----------

const viewHistory: (ViewRect | null)[] = [null]; // [0] = full polar view
let viewIdx = 0;
let zoomToolActive = false;

function applyView(): void {
  canvas.setViewRect(viewHistory[viewIdx]);
  updateZoomButtons();
  scheduleSave();
}
function pushView(region: ViewRect | null): void {
  // Browser-style truncation: drop forward history beyond current index.
  viewHistory.length = viewIdx + 1;
  viewHistory.push(region);
  viewIdx = viewHistory.length - 1;
  applyView();
}
function goHome(): void { pushView(null); }
function goBack(): void { if (viewIdx > 0) { viewIdx--; applyView(); } }
function goForward(): void {
  if (viewIdx < viewHistory.length - 1) { viewIdx++; applyView(); }
}
function updateZoomButtons(): void {
  $<HTMLButtonElement>('zoom-back').disabled = viewIdx === 0;
  $<HTMLButtonElement>('zoom-fwd').disabled  = viewIdx === viewHistory.length - 1;
  $<HTMLButtonElement>('zoom-home').disabled = viewHistory[viewIdx] === null;
  $<HTMLButtonElement>('zoom-tool').classList.toggle('active', zoomToolActive);
}

$('zoom-tool').addEventListener('click', () => {
  zoomToolActive = !zoomToolActive;
  canvas.setZoomToolActive(zoomToolActive);
  updateZoomButtons();
});
$('zoom-home').addEventListener('click', goHome);
$('zoom-back').addEventListener('click', goBack);
$('zoom-fwd').addEventListener('click', goForward);

canvas.onZoomBoxDrawn = (region) => {
  pushView(region);
  zoomToolActive = false;
  canvas.setZoomToolActive(false);
  updateZoomButtons();
};

$('reset').addEventListener('click', () => {
  stopAll();
  applyClearGrid();
  applyPPoints([]);
  canvas.setBoundaryD0(null);
  canvas.setBoundaryPre(null);
  d0Points.length = 0;
  d0PrePoints.length = 0;
  d0Heap.length = 0;
  d0Pending = [];
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

// ---------- Invalidation: keep display in sync with parameters ----------

function invalidateGrid(): void {
  const hadGrid = canvas.hasGrid();
  if (worker && phase === 'grid') {
    worker.postMessage({ type: 'stop' } as HorseshoeMainToWorker);
    killWorker();
    phase = 'idle';
  }
  applyClearGrid();
  if (hadGrid) $('status').textContent = 'grid cleared (parameters changed)';
}

function invalidateAll(): void {
  invalidateGrid();
  applyPPoints([]);  // P depends on e and maxPeriods
  d0Points.length = 0;
  d0PrePoints.length = 0;
  d0Heap.length = 0;
  d0Pending = [];
  canvas.setBoundaryD0(null);
  canvas.setBoundaryPre(null);
}

function stopAll(): void {
  // finding-p / boundary / preimage phases just fall through to idle.
  if (worker) {
    const m: HorseshoeMainToWorker = { type: 'stop' };
    worker.postMessage(m);
    killWorker();
  }
  phase = 'idle';
}

function runGrid(): void {
  if (phase !== 'idle') return;
  // Scan only the (τ, v) range visible in the current viewport, subdivided
  // at the requested resolution N. With no zoom this is the full disc.
  const b = canvas.getViewportPolarBounds();
  applyBeginGrid(cfg.n, b.tauMin, b.tauMax, b.vMin, b.vMax);
  const w = ensureWorker();
  const m: HorseshoeMainToWorker = {
    type: 'gridScan',
    req: {
      e: cfg.e, maxPeriods: cfg.maxPeriods, n: cfg.n,
      tauMin: b.tauMin, tauMax: b.tauMax, vMin: b.vMin, vMax: b.vMax,
    },
  };
  w.postMessage(m);
  phase = 'grid';
  $('status').textContent =
    `grid… 0 / ${cfg.n}  (τ∈[${b.tauMin.toFixed(3)}, ${b.tauMax.toFixed(3)}], v∈[${b.vMin.toFixed(3)}, ${b.vMax.toFixed(3)}])`;
}

// Wrap (-tau*) into [0, 1) so the rendered angle is in the standard
// τ-window the rest of the code uses.
function wrap1(t: number): number { return ((t % 1) + 1) % 1; }

// Visual screen-pixel coords of (τ, v) — accounts for the current
// viewport-zoom transform on the main canvas. Boundary refinement compares
// gaps in visual pixels so a 1-pixel threshold means 1 pixel as seen.
function screenXY(tau: number, v: number): { x: number; y: number } {
  const g = canvas.getDiscGeometry();
  const r = (v / g.vMax) * g.R;
  const a = tau * 2 * Math.PI - Math.PI / 2;
  const nx = g.cx + r * Math.cos(a);
  const ny = g.cy + r * Math.sin(a);
  const vr = canvas.getViewRect();
  if (!vr) return { x: nx, y: ny };
  const cw = canvas.canvas.clientWidth;
  const ch = canvas.canvas.clientHeight;
  return {
    x: ((nx - vr.x) / vr.w) * cw,
    y: ((ny - vr.y) / vr.h) * ch,
  };
}

// ---------- ∂D₀ boundary computation + adaptive refinement ----------

function runBoundaries(): void {
  if (phase !== 'idle') return;
  d0Points.length = 0;
  d0Heap.length = 0;
  d0Pending = [];
  d0PrePoints.length = 0;
  canvas.setBoundaryD0(null);
  canvas.setBoundaryPre(null);   // stale once ∂D₀ is recomputed
  const tau0s = Array.from({ length: D0_INITIAL_K }, (_, i) => i / D0_INITIAL_K);
  ensureWorker().postMessage({
    type: 'findEscape',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, steps: D0_BISECT_STEPS },
  } as HorseshoeMainToWorker);
  phase = 'boundary-initial';
  $('status').textContent = `computing ∂D₀… ${D0_INITIAL_K} initial bisections`;
}

function pushD0Gap(a: D0Point, b: D0Point): void {
  const pa = screenXY(a.tau, a.vEsc);
  const pb = screenXY(b.tau, b.vEsc);
  const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  if (dist <= D0_THRESHOLD) return;
  d0Heap.push({ tauA: a.tau, vA: a.vEsc, tauB: b.tau, vB: b.vEsc, dist });
  let k = d0Heap.length - 1;
  while (k > 0) {
    const p = (k - 1) >>> 1;
    if (d0Heap[p].dist >= d0Heap[k].dist) break;
    [d0Heap[p], d0Heap[k]] = [d0Heap[k], d0Heap[p]];
    k = p;
  }
}
function popD0Gap(): D0Gap | undefined {
  if (d0Heap.length === 0) return undefined;
  const top = d0Heap[0];
  const last = d0Heap.pop()!;
  if (d0Heap.length > 0) {
    d0Heap[0] = last;
    let k = 0;
    for (;;) {
      const l = 2 * k + 1, r = l + 1;
      let m = k;
      if (l < d0Heap.length && d0Heap[l].dist > d0Heap[m].dist) m = l;
      if (r < d0Heap.length && d0Heap[r].dist > d0Heap[m].dist) m = r;
      if (m === k) break;
      [d0Heap[m], d0Heap[k]] = [d0Heap[k], d0Heap[m]];
      k = m;
    }
  }
  return top;
}
function insertD0Sorted(pt: D0Point): void {
  let lo = 0, hi = d0Points.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (d0Points[mid].tau < pt.tau) lo = mid + 1;
    else hi = mid;
  }
  d0Points.splice(lo, 0, pt);
}
function applyBoundary(): void {
  const pts = d0Points.map((p) => ({ tau: p.tau, v: p.vEsc }));
  canvas.setBoundaryD0(pts);
}

function consumeBoundaryInitial(vEscs: Float32Array): void {
  d0Points.length = 0;
  for (let i = 0; i < D0_INITIAL_K; i++) {
    const v = vEscs[i];
    if (isFinite(v)) d0Points.push({ tau: i / D0_INITIAL_K, vEsc: v });
  }
  d0Heap.length = 0;
  applyBoundary();
  boundariesDone('threshold');
  // Refinement is now manual via the "Refine D0/D1" button — the initial
  // K=64 bisection lands close enough to the curve that going further is
  // only useful when the user asks for it.
}

function startBoundaryRefinement(): void {
  if (phase !== 'idle') return;
  if (d0Points.length < 2) {
    $('status').textContent = 'no boundaries to refine — compute D₀/D₁ first';
    return;
  }
  ensureWorker();
  d0Heap.length = 0;
  const n = d0Points.length;
  for (let i = 0; i < n; i++) {
    pushD0Gap(d0Points[i], d0Points[(i + 1) % n]);
  }
  if (d0Heap.length === 0) {
    killWorker();
    $('status').textContent =
      `boundaries: all gaps already ≤ ${D0_THRESHOLD} px — nothing to refine`;
    return;
  }
  phase = 'boundary-refining';
  boundaryRefineStep();
}

function boundaryRefineStep(): void {
  if (phase !== 'boundary-refining' || !worker) return;
  if (d0Points.length >= D0_CAP) { boundariesDone('cap'); return; }
  if (d0Heap.length === 0) { boundariesDone('threshold'); return; }
  d0Pending = [];
  const tau0s: number[] = [];
  while (d0Pending.length < D0_BATCH) {
    const g = popD0Gap();
    if (!g) break;
    if (g.dist <= D0_THRESHOLD) break;
    // midpoint τ with wrap handling
    let tauMid: number;
    if (g.tauB > g.tauA) tauMid = (g.tauA + g.tauB) / 2;
    else { tauMid = (g.tauA + g.tauB + 1) / 2; if (tauMid >= 1) tauMid -= 1; }
    d0Pending.push({ tauMid, gap: g });
    tau0s.push(tauMid);
  }
  if (tau0s.length === 0) { boundariesDone('threshold'); return; }
  worker.postMessage({
    type: 'findEscape',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, steps: D0_BISECT_STEPS },
  } as HorseshoeMainToWorker);
  const longest = d0Pending[0]?.gap.dist ?? 0;
  $('status').textContent =
    `refining ∂D₀… N=${d0Points.length}  longest=${longest.toFixed(1)}px`;
}

function consumeBoundaryRefinement(vEscs: Float32Array): void {
  for (let i = 0; i < d0Pending.length; i++) {
    const p = d0Pending[i];
    const v = vEscs[i];
    if (!isFinite(v)) continue;
    const newPt: D0Point = { tau: p.tauMid, vEsc: v };
    insertD0Sorted(newPt);
    pushD0Gap({ tau: p.gap.tauA, vEsc: p.gap.vA }, newPt);
    pushD0Gap(newPt, { tau: p.gap.tauB, vEsc: p.gap.vB });
  }
  d0Pending = [];
  applyBoundary();
  boundaryRefineStep();
}

function boundariesDone(reason: 'threshold' | 'cap' | 'stopped'): void {
  phase = 'idle';
  killWorker();
  const tag = reason === 'cap' ? ` (hit ${D0_CAP}-pt cap)` :
              reason === 'stopped' ? ' (stopped)' : '';
  $('status').textContent = `∂D₀ done.  N=${d0Points.length}${tag}`;
}

// ---------- φ⁻¹(∂D₀): first preimage of the escape curve ----------
//
// The escape curve ∂D₀ = {v = v_esc(τ)} is one (graph) branch of the
// stable manifold of infinity; its reflection ∂D₁ = ρ(∂D₀) is the
// unstable branch, and as single-valued graphs they meet only at the two
// reversibility-fixed phases τ = 0, ½. The extra homoclinic corners of
// Moser's lens live on the next fold of the manifold: φ⁻¹(∂D₀). By Moser's
// Lemma 2 (φ⁻¹ = ρ φ ρ) we get it with one forward shoot per ∂D₀ sample —
// reflect (τ, v_esc) → (-τ, v_esc), shoot forward through φ, reflect the
// crossing back. Points whose reflected state escapes forward (no φ image)
// are dropped as NaN, breaking the polyline there.
function runPreimage(): void {
  if (phase !== 'idle') return;
  if (d0Points.length < 2) {
    $('status').textContent = 'compute D₀/D₁ first, then Preimage D₀';
    return;
  }
  d0PrePoints.length = 0;
  canvas.setBoundaryPre(null);
  const tau0s: number[] = [];
  const v0s: number[] = [];
  for (const p of d0Points) {
    tau0s.push(wrap1(-p.tau));   // ρ: reflect the escape sample
    v0s.push(p.vEsc);
  }
  ensureWorker().postMessage({
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  } as HorseshoeMainToWorker);
  phase = 'preimage';
  $('status').textContent =
    `computing φ⁻¹(∂D₀)… ${tau0s.length} shots (refine D₀/D₁ first for a sharper fold)`;
}

function consumePreimage(
  tauStars: Float32Array, vStars: Float32Array, escapes: Uint8Array,
): void {
  d0PrePoints.length = 0;
  let kept = 0;
  for (let i = 0; i < d0Points.length; i++) {
    if (escapes[i] === 1 || !isFinite(tauStars[i]) || !isFinite(vStars[i])) {
      // No φ-preimage on the section: break the polyline here.
      d0PrePoints.push({ tau: NaN, v: NaN });
      continue;
    }
    // ρ again: reflect the forward crossing back.
    d0PrePoints.push({ tau: wrap1(-tauStars[i]), v: vStars[i] });
    kept++;
  }
  canvas.setBoundaryPre(d0PrePoints.slice());
  phase = 'idle';
  killWorker();
  const dropped = d0Points.length - kept;
  $('status').textContent =
    `φ⁻¹(∂D₀) done.  N=${kept}${dropped ? `, ${dropped} escaped` : ''}` +
    ` — dotted; crossings with the solid pair are the lens corners`;
}

function onWorkerMsg(ev: MessageEvent<HorseshoeWorkerToMain>): void {
  const m = ev.data;
  // Shape jobs (forward/backward map, refinement) ride on plain shoot
  // round-trips and steal results from the normal dispatcher when a
  // shapeJob is in flight.
  if (m.type === 'shotResults' && shapeJob) {
    const { tauStars, vStars, escapes } = m.msg;
    if (shapeJob.kind === 'map') consumeShapeMap(tauStars, vStars, escapes);
    else                          consumeShapeRefine(tauStars, vStars, escapes);
    return;
  }
  switch (m.type) {
    case 'gridRow':
      applyGridRow(m.msg.row, m.msg.tauStars, m.msg.vStars);
      break;
    case 'gridProgress':
      $('status').textContent = `grid… ${m.done} / ${m.total}`;
      break;
    case 'gridDone':
      killWorker();
      // Now find P points (∂D₀ ∩ symmetry line at τ=0 and τ=0.5).
      phase = 'finding-p';
      ensureWorker().postMessage({
        type: 'findEscape',
        req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s: [0, 0.5], steps: 20 },
      } as HorseshoeMainToWorker);
      $('status').textContent =
        `grid done (${cfg.n}×${cfg.n} = ${cfg.n * cfg.n} cells).  Finding P…`;
      break;
    case 'escapeFound': {
      if (phase === 'finding-p') {
        const labels = ['P_a', 'P_p'];
        const pts: { tau: number; v: number; label?: string }[] = [];
        for (let i = 0; i < m.vEscs.length; i++) {
          const v = m.vEscs[i];
          if (isFinite(v)) pts.push({ tau: i === 0 ? 0 : 0.5, v, label: labels[i] });
        }
        applyPPoints(pts);
        killWorker();
        phase = 'idle';
        const parts = pts.map((p) => `${p.label}=v_esc(${p.tau.toFixed(1)})=${p.v.toFixed(3)}`);
        $('status').textContent = `grid done.  ${parts.join('  ')}`;
      } else if (phase === 'boundary-initial') {
        consumeBoundaryInitial(m.vEscs);
      } else if (phase === 'boundary-refining') {
        consumeBoundaryRefinement(m.vEscs);
      }
      break;
    }
    case 'shotResults': {
      const { tauStars, vStars, escapes } = m.msg;
      if (phase === 'preimage') {
        consumePreimage(tauStars, vStars, escapes);
      }
      break;
    }
    case 'stopped':
      phase = 'idle';
      $('status').textContent = 'stopped';
      break;
  }
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

// ---------- Coordinate picker ----------

function formatPick(p: { tau: number; v: number } | null): string {
  if (!p) return 'no point picked';
  const tau = ((p.tau % 1) + 1) % 1;
  return `τ₀ = ${tau.toFixed(4)}    v₀ = ${p.v.toFixed(4)}`;
}

function setPicked(p: { tau: number; v: number } | null): void {
  pickedCoord = p;
  $('pick-readout').textContent = formatPick(p);
  $<HTMLButtonElement>('pick-open').disabled = p === null;
  canvas.setPickedPoint(p);
  scheduleSave();
}

function setPickMode(on: boolean): void {
  canvas.setPickMode(on);
  $('pick-toggle').classList.toggle('active', on);
  if (on) {
    // Pick mode is mutually exclusive with the pen and zoom tools.
    if (canvas.getPenMode()) {
      canvas.setPenMode(false);
      $('pen-toggle').classList.remove('active');
    }
    if (zoomToolActive) {
      zoomToolActive = false;
      canvas.setZoomToolActive(false);
      updateZoomButtons();
    }
  }
}

function initPicker(): void {
  $('pick-toggle').addEventListener('click', () => setPickMode(!canvas.getPickMode()));
  canvas.onPick = (p) => setPicked(p);
  $('pick-open').addEventListener('click', () => {
    if (!pickedCoord) return;
    const tau = ((pickedCoord.tau % 1) + 1) % 1;
    const q = new URLSearchParams();
    q.set('e', cfg.e.toFixed(6));
    q.set('tau0', tau.toFixed(6));
    q.set('v0', pickedCoord.v.toFixed(6));
    persistHorseshoe();  // flush state before leaving the page
    window.location.href = './index.html?' + q.toString();
  });
}

// ---------- State persistence (cache results across navigation) ----------

interface HsState {
  v: 1;
  cfg: Cfg;
  shapeSampleN: number;
  toggles: { grid: boolean; image: boolean; boundaries: boolean };
  view: { history: (ViewRect | null)[]; idx: number };
  d0Points: D0Point[];
  d0PrePoints: { tau: number; v: number }[];
  pPoints: { tau: number; v: number; label?: string }[];
  picked: { tau: number; v: number } | null;
  grid: GridSnapshot | null;
  shapes: string;       // serializeShapes() output
}

function buildSnapshot(includeGrid: boolean): HsState {
  return {
    v: 1,
    cfg: { ...cfg },
    shapeSampleN,
    toggles: {
      grid: canvas.getShowGrid(),
      image: canvas.getShowImage(),
      boundaries: canvas.getShowBoundaries(),
    },
    view: { history: viewHistory.slice(), idx: viewIdx },
    d0Points: d0Points.map((p) => ({ ...p })),
    d0PrePoints: d0PrePoints.map((p) => ({ ...p })),
    pPoints: lastPPoints,
    picked: pickedCoord,
    grid: includeGrid ? canvas.getGridSnapshot() : null,
    shapes: serializeShapes(),
  };
}

// Write current state to storage. Tries with the (large) grid cache first;
// if storage rejects it (quota), retries without the grid.
function persistHorseshoe(): void {
  if (hsSaveTimer) { clearTimeout(hsSaveTimer); hsSaveTimer = 0; }
  if (!saveState('horseshoe', buildSnapshot(true))) {
    saveState('horseshoe', buildSnapshot(false));
  }
}

let hsSaveTimer = 0;
let restoring = false;   // suppress save churn while applying a snapshot
function scheduleSave(): void {
  if (restoring) return;
  if (hsSaveTimer) clearTimeout(hsSaveTimer);
  hsSaveTimer = window.setTimeout(persistHorseshoe, 400);
}

function setCtl(slider: string, num: string, value: number, fmt: (n: number) => string): void {
  $<HTMLInputElement>(slider).value = String(value);
  $<HTMLInputElement>(num).value = fmt(value);
}

function restoreHorseshoe(): boolean {
  const s = loadState<HsState>('horseshoe');
  if (!s || s.v !== 1) return false;
  restoring = true;
  try {
    // cfg + form controls.
    Object.assign(cfg, s.cfg);
    const i3 = (v: number) => v.toFixed(3);
    const ri = (v: number) => Math.round(v).toString();
    setCtl('e', 'e-num', cfg.e, i3);
    setCtl('vmax', 'vmax-num', cfg.vMax, i3);
    setCtl('tmax', 'tmax-num', cfg.maxPeriods, ri);
    setCtl('n', 'n-num', cfg.n, ri);
    shapeSampleN = s.shapeSampleN;
    setCtl('shape-n', 'shape-n-num', shapeSampleN, ri);

    // Computation state arrays.
    d0Points.length = 0; d0Points.push(...s.d0Points);
    d0PrePoints.length = 0; d0PrePoints.push(...s.d0PrePoints);

    // View history.
    viewHistory.length = 0;
    viewHistory.push(...(s.view.history.length ? s.view.history : [null]));
    viewIdx = Math.max(0, Math.min(viewHistory.length - 1, s.view.idx));

    canvas.setVMax(cfg.vMax);

    // Grid (cached result) — restore before overlays.
    if (s.grid) canvas.restoreGrid(s.grid);
    else applyClearGrid();

    // Derived overlays from the restored arrays.
    if (d0Points.length > 0) applyBoundary();
    else canvas.setBoundaryD0(null);
    if (d0PrePoints.length > 0) canvas.setBoundaryPre(d0PrePoints.slice());
    else canvas.setBoundaryPre(null);
    applyPPoints(s.pPoints);

    // Toggles + button labels.
    applyShowGrid(s.toggles.grid);
    $('toggle-grid').textContent = s.toggles.grid ? 'Hide grid' : 'Show grid';
    applyShowImage(s.toggles.image);
    $('toggle-image').textContent = s.toggles.image ? 'Hide image' : 'Show image';
    canvas.setShowBoundaries(s.toggles.boundaries);
    $('toggle-boundaries').textContent = s.toggles.boundaries ? 'Hide boundaries' : 'Show boundaries';

    // Shapes.
    try {
      const loaded = deserializeShapes(s.shapes);
      shapeStore.clear();
      for (const sh of loaded) {
        shapeStore.add({
          name: sh.name, vertices: sh.vertices, closed: sh.closed,
          color: sh.color, parent: sh.parent, sampleN: sh.sampleN,
          edgeColors: sh.edgeColors, edgeIdx: sh.edgeIdx,
          sourceVertices: sh.sourceVertices,
        });
      }
    } catch { /* ignore malformed shape cache */ }

    // Picked point.
    setPicked(s.picked);

    // View state.
    applyView();
  } finally {
    restoring = false;
  }
  return true;
}

// ---------- Init ----------

cfg.e = parseFloat($<HTMLInputElement>('e').value);
cfg.vMax = parseFloat($<HTMLInputElement>('vmax').value);
cfg.maxPeriods = parseInt($<HTMLInputElement>('tmax').value, 10);
cfg.n = parseInt($<HTMLInputElement>('n').value, 10);

readQuery();
updateTabLinks();
canvas.setVMax(cfg.vMax);
updateZoomButtons();
initShapesUI();
initPicker();

// ============================================================================
// SHAPES: user-drawn curves/polygons on the (τ, v) disc, with forward and
// backward Poincaré-map operations and round-based refinement on the forward
// image. Shape list is rendered into #shape-list and lives in shapeStore.
// ============================================================================

import { shapeStore, type Shape, type ShapeId, serializeShapes, deserializeShapes, resamplePolyline, resamplePolylineWithEdgeIdx, SHAPE_REFINE_PX, rotatedPalette, nearestPaletteIndex } from './shapes';

// Global setting for shape map operations: source curve is resampled to
// this many points (arc-length spaced in (τ, v)) before each map. Higher
// values give a smoother forward/backward image but cost more shots.
let shapeSampleN = 200;

// In-flight per-shape worker job. Only one job runs at a time across
// shape phases.
interface ShapeJob {
  kind: 'map' | 'refine';
  shapeId: ShapeId;
  via?: 'forward' | 'backward';     // for 'map'
  // For 'refine', each entry maps a shot result index back to the
  // source-edge index it bisects (so we know where to insert).
  refinePending?: { sourceEdge: number; sMid: { tau: number; v: number } }[];
}
let shapeJob: ShapeJob | null = null;

// ρ: (τ, v) → (-τ mod 1, v). Used to wrap backward shots through
// φ⁻¹ = ρ φ ρ (Moser's Lemma 2). Restricted to the symmetric-sector
// branches (τc ∈ {0, 0.5}) for V_k computation; shape mapping works
// for any τc since each vertex is shot independently.
function rho(tau: number): number {
  let t = -tau;
  t = ((t % 1) + 1) % 1;
  return t;
}

// Per-map state: the resampled source positions used to seed this map.
// Captured at startShapeMap and stored on the child shape so refinement
// has a 1:1 source-vertex array for edge bisection. The companion
// edgeIdx array tracks which SOURCE edge each sample fell on so the
// child shape can be coloured per-edge like its parent.
let mapSourceSamples: { tau: number; v: number }[] = [];
let mapSourceEdgeIdx: number[] = [];

function startShapeMap(shape: Shape, via: 'forward' | 'backward'): void {
  if (phase !== 'idle') return;
  if (shape.vertices.length === 0) return;
  ensureWorker();
  // Resample the source to N arc-length-spaced points so the image is
  // smooth even when the user drew only a few vertices. N comes from
  // the source shape's per-shape sampleN.
  const N = Math.max(2, Math.min(20000, Math.round(shape.sampleN)));
  let samples: { tau: number; v: number }[];
  let sampleEdgeIdx: number[];
  if (shape.vertices.length >= 2) {
    const r = resamplePolylineWithEdgeIdx(
      shape.vertices, shape.closed, N, shape.edgeIdx);
    samples = r.points;
    sampleEdgeIdx = r.edgeIdx;
  } else {
    samples = shape.vertices.map((p) => ({ tau: p.tau, v: p.v }));
    sampleEdgeIdx = shape.vertices.map((_, i) => shape.edgeIdx?.[i] ?? i);
  }
  mapSourceSamples = samples;
  mapSourceEdgeIdx = sampleEdgeIdx;
  const tau0s: number[] = [];
  const v0s: number[] = [];
  for (const p of samples) {
    tau0s.push(via === 'forward' ? p.tau : rho(p.tau));
    v0s.push(p.v);
  }
  shapeJob = { kind: 'map', shapeId: shape.id, via };
  worker!.postMessage({
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  });
  $('status').textContent =
    `mapping shape '${shape.name}' ${via} … ${samples.length} shots`;
}

function consumeShapeMap(tauStars: Float32Array, vStars: Float32Array, escapes: Uint8Array): void {
  if (!shapeJob || shapeJob.kind !== 'map') return;
  const src = shapeStore.get(shapeJob.shapeId);
  if (!src) { shapeJob = null; return; }
  const via = shapeJob.via!;
  const samples = mapSourceSamples;
  const vertices: { tau: number; v: number }[] = [];
  for (let i = 0; i < samples.length; i++) {
    if (escapes[i] === 1) {
      vertices.push({ tau: NaN, v: NaN });
      continue;
    }
    const t = via === 'forward' ? tauStars[i] : rho(tauStars[i]);
    vertices.push({ tau: t, v: vStars[i] });
  }
  const parentIter = src.parent?.via === via ? (src.parent.iterates + 1) : 1;
  const tag = via === 'forward' ? 'φ' : 'φ⁻¹';
  const itStr = parentIter === 1 ? '' : `${parentIter}`;
  shapeStore.add({
    name: `${tag}${itStr}(${src.name})`,
    vertices, closed: src.closed,
    parent: { id: src.id, via, iterates: parentIter },
    sourceVertices: samples.map((p) => ({ tau: p.tau, v: p.v })),
    // Mapped children inherit their parent's per-shape N so successive
    // iterates (φ², φ³, …) use the same resample density.
    sampleN: src.sampleN,
    // Inherit the parent's per-edge palette and per-sample edge index
    // so the child renders with the same colouring scheme.
    edgeColors: src.edgeColors ? src.edgeColors.slice() : undefined,
    edgeIdx: mapSourceEdgeIdx.slice(),
  });
  shapeJob = null;
  mapSourceSamples = [];
  mapSourceEdgeIdx = [];
  $('status').textContent = `mapped '${src.name}' ${via} (${samples.length} samples)`;
}

// Refinement: walk an image, bisect source edges whose image edge
// exceeds the threshold (visual px). One round per worker call. A click
// refines EVERY direct image of the source (forward and backward), one
// round each, processed sequentially because the worker handles one
// shoot batch at a time.
let refineQueue: ShapeId[] = [];

// Refine one image by a single bisection round. Returns true if a worker
// job was posted (caller must await its result), false if the image has
// nothing left above the threshold (or lacks its source-sample track).
function refineImageOneRound(img: Shape): boolean {
  const srcSamples = img.sourceVertices;
  if (!srcSamples || srcSamples.length !== img.vertices.length) return false;
  // Walk image edges, find those above the threshold in SCREEN PIXELS.
  // For each long edge, bisect the matching source-sample edge — its
  // midpoint shot through φ gives the new image vertex.
  const via: 'forward' | 'backward' = img.parent?.via ?? 'forward';
  const threshold = SHAPE_REFINE_PX;
  const candidates: { sourceEdge: number; sMid: { tau: number; v: number } }[] = [];
  const N = img.vertices.length;
  const last = img.closed ? N : N - 1;
  for (let i = 0; i < last; i++) {
    const a = img.vertices[i];
    const b = img.vertices[(i + 1) % N];
    if (!isFinite(a.tau) || !isFinite(b.tau)) continue;
    const pa = screenXY(a.tau, a.v);
    const pb = screenXY(b.tau, b.v);
    const d = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (d <= threshold) continue;
    const sa = srcSamples[i];
    const sb = srcSamples[(i + 1) % N];
    // Midpoint in (τ, v), unwrapping τ across the seam.
    let dt = sb.tau - sa.tau;
    dt -= Math.round(dt);
    const midTau = ((sa.tau + dt / 2) % 1 + 1) % 1;
    const midV = 0.5 * (sa.v + sb.v);
    candidates.push({ sourceEdge: i, sMid: { tau: midTau, v: midV } });
  }
  if (candidates.length === 0) return false;
  ensureWorker();
  const tau0s = candidates.map((c) => via === 'forward' ? c.sMid.tau : rho(c.sMid.tau));
  const v0s = candidates.map((c) => c.sMid.v);
  shapeJob = { kind: 'refine', shapeId: img.id, refinePending: candidates };
  worker!.postMessage({
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  });
  $('status').textContent =
    `refining '${img.name}' (${via}): ${candidates.length} mid-edge shots`;
  return true;
}

// Pull images off the queue until one posts a job (then await its result)
// or the queue empties.
function processRefineQueue(): void {
  while (refineQueue.length > 0) {
    const img = shapeStore.get(refineQueue.shift()!);
    if (img && refineImageOneRound(img)) return;
  }
  $('status').textContent = 'refine: all images up to date';
}

function startShapeRefine(shape: Shape): void {
  if (phase !== 'idle' || shapeJob) return;
  const imgs = findImages(shape.id);
  if (imgs.length === 0) {
    $('status').textContent = `no image of '${shape.name}' — map it (→ or ←) first`;
    return;
  }
  refineQueue = imgs.map((s) => s.id);
  processRefineQueue();
}

function consumeShapeRefine(tauStars: Float32Array, vStars: Float32Array, escapes: Uint8Array): void {
  if (!shapeJob || shapeJob.kind !== 'refine' || !shapeJob.refinePending) return;
  const img = shapeStore.get(shapeJob.shapeId);
  if (!img || !img.sourceVertices) { shapeJob = null; return; }
  const via: 'forward' | 'backward' = img.parent?.via ?? 'forward';
  // Build new source-sample + image vertex lists by walking edges in
  // REVERSE source-edge order so earlier indices stay valid as we splice.
  const refined = shapeJob.refinePending
    .map((c, i) => ({
      sourceEdge: c.sourceEdge,
      sMid: c.sMid,
      escaped: escapes[i] === 1,
      tau: tauStars[i],
      v: vStars[i],
    }))
    .sort((a, b) => b.sourceEdge - a.sourceEdge);
  const srcV = img.sourceVertices.slice();
  const imgV = img.vertices.slice();
  const eiV = (img.edgeIdx ?? imgV.map((_, i) => i)).slice();
  let added = 0;
  for (const r of refined) {
    if (r.escaped) continue;
    const t = via === 'forward' ? r.tau : rho(r.tau);
    srcV.splice(r.sourceEdge + 1, 0, r.sMid);
    imgV.splice(r.sourceEdge + 1, 0, { tau: t, v: r.v });
    // New sample inherits the source-edge of the LEFT neighbour, which
    // is the edge being bisected — guaranteed in-bounds because we just
    // spliced at sourceEdge+1.
    eiV.splice(r.sourceEdge + 1, 0, eiV[r.sourceEdge] ?? 0);
    added++;
  }
  // Update image shape (vertices) and its sourceVertices in lockstep.
  shapeStore.update(img.id, { sourceVertices: srcV, edgeIdx: eiV });
  shapeStore.replaceVertices(img.id, imgV);
  shapeJob = null;
  $('status').textContent = `refined '${img.name}': +${added} samples (now ${imgV.length})`;
  // Continue with the next queued image (e.g. the backward map).
  processRefineQueue();
}

function findImages(parentId: ShapeId): Shape[] {
  // All direct (single-iterate) images of parentId — forward AND backward
  // — so refining a source propagates to every map it produced.
  return shapeStore.list().filter(
    (s) => s.parent?.id === parentId && s.parent?.iterates === 1);
}

// Shape jobs hook the existing onWorkerMsg dispatcher directly via the
// shapeJob check at the top of that function.

// ----- Shape list UI -----

function initShapesUI(): void {
  // Sample-count input drives the global shapeSampleN.
  bindNumeric('shape-n', 'shape-n-num',
    { toNum: (v) => Math.round(v).toString(),
      clamp: (v) => Math.max(2, Math.min(20000, Math.round(v))) },
    (v) => { shapeSampleN = v; scheduleSave(); });
  const pen = $<HTMLButtonElement>('pen-toggle');
  pen.addEventListener('click', () => {
    canvas.setPenMode(!canvas.getPenMode());
    pen.classList.toggle('active', canvas.getPenMode());
    // Pen and the coordinate picker are mutually exclusive.
    if (canvas.getPenMode() && canvas.getPickMode()) setPickMode(false);
  });
  canvas.onDrawCommit = (vertices, closed) => {
    shapeStore.add({ vertices, closed, sampleN: shapeSampleN });
    // Stay in pen mode so the user can keep drawing.
  };

  $('shapes-export').addEventListener('click', () => exportShapesFile());
  const fileInput = $<HTMLInputElement>('shapes-file');
  $('shapes-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    f.text().then((text) => {
      try {
        const loaded = deserializeShapes(text);
        shapeStore.clear();
        for (const s of loaded) {
          // re-add via store so ids are reissued cleanly; carry colours
          // and edge-palette so the imported shape renders identically.
          shapeStore.add({
            name: s.name, vertices: s.vertices, closed: s.closed,
            color: s.color, parent: s.parent,
            sampleN: s.sampleN,
            edgeColors: s.edgeColors, edgeIdx: s.edgeIdx,
            sourceVertices: s.sourceVertices,
          });
        }
        $('status').textContent = `loaded ${loaded.length} shapes from ${f.name}`;
      } catch (err) {
        $('status').textContent = `import failed: ${(err as Error).message}`;
      }
      fileInput.value = '';
    });
  });

  shapeStore.onChange(() => {
    renderShapeList();
    canvas.setShapes(shapeStore.list());
    scheduleSave();
  });
  // Initial render.
  canvas.setShapes(shapeStore.list());
  renderShapeList();
}

// Re-cycle a shape's per-edge palette from `startIdx`, and propagate the
// same start to its mapped images (which carry the same logical edges) so
// recolouring a source flows through to its forward/backward maps.
function recolorShape(id: ShapeId, startIdx: number): void {
  const s = shapeStore.get(id);
  if (!s) return;
  const numEdges = s.edgeColors?.length
    ?? (s.closed ? s.vertices.length : Math.max(1, s.vertices.length - 1));
  const edgeColors = rotatedPalette(startIdx, numEdges);
  shapeStore.update(id, { edgeColors, color: edgeColors[0] });
  for (const child of shapeStore.list()) {
    if (child.parent?.id === id) recolorShape(child.id, startIdx);
  }
}

function renderShapeList(): void {
  const container = $('shape-list');
  container.innerHTML = '';
  for (const sh of shapeStore.list()) {
    const row = document.createElement('div');
    row.className = 'shape-row';

    const sw = document.createElement('input');
    sw.type = 'color';
    const startColor = sh.edgeColors?.[0] ?? sh.color;
    sw.value = startColor.startsWith('#') ? startColor : '#888888';
    sw.className = 'sw';
    sw.title = 'Starting colour — segments cycle the palette from here';
    sw.addEventListener('input', () => recolorShape(sh.id, nearestPaletteIndex(sw.value)));
    row.appendChild(sw);

    const name = document.createElement('input');
    name.type = 'text';
    name.value = sh.name;
    name.className = 'name';
    name.addEventListener('change', () => shapeStore.update(sh.id, { name: name.value || sh.name }));
    row.appendChild(name);

    if (sh.parent) {
      const badge = document.createElement('span');
      badge.className = 'parent-badge';
      badge.textContent = sh.parent.via === 'forward' ? `→${sh.parent.iterates}` : `←${sh.parent.iterates}`;
      badge.title = `from ${sh.parent.id} (${sh.parent.via}, ${sh.parent.iterates}×)`;
      row.appendChild(badge);
    }

    const meta = document.createElement('span');
    meta.className = 'parent-badge';
    meta.textContent = `n=${sh.vertices.length}${sh.closed ? '◯' : ''}`;
    row.appendChild(meta);

    const nInput = document.createElement('input');
    nInput.type = 'text';
    nInput.value = String(sh.sampleN);
    nInput.className = 'shape-n-input';
    nInput.title = 'Resample to this many points before map (this shape only)';
    nInput.addEventListener('change', () => {
      const v = parseInt(nInput.value, 10);
      if (isFinite(v) && v >= 2) {
        shapeStore.update(sh.id, { sampleN: Math.min(20000, v) });
      } else {
        nInput.value = String(sh.sampleN);
      }
    });
    row.appendChild(nInput);

    const vis = document.createElement('button');
    vis.className = 'vis';
    vis.textContent = sh.visible ? '👁' : '·';
    vis.title = sh.visible ? 'Hide' : 'Show';
    vis.addEventListener('click', () => shapeStore.update(sh.id, { visible: !sh.visible }));
    row.appendChild(vis);

    const fwd = document.createElement('button');
    fwd.className = 'act'; fwd.textContent = '→'; fwd.title = 'Map forward (φ)';
    fwd.addEventListener('click', () => startShapeMap(sh, 'forward'));
    row.appendChild(fwd);

    const bwd = document.createElement('button');
    bwd.className = 'act'; bwd.textContent = '←'; bwd.title = 'Map backward (φ⁻¹)';
    bwd.addEventListener('click', () => startShapeMap(sh, 'backward'));
    row.appendChild(bwd);

    const ref = document.createElement('button');
    ref.className = 'act'; ref.textContent = '↻';
    ref.title = 'Refine images, forward & backward (one round)';
    ref.disabled = findImages(sh.id).length === 0;
    ref.addEventListener('click', () => startShapeRefine(sh));
    row.appendChild(ref);

    const del = document.createElement('button');
    del.className = 'act'; del.textContent = '✕'; del.title = 'Delete';
    del.addEventListener('click', () => shapeStore.remove(sh.id));
    row.appendChild(del);

    container.appendChild(row);
  }
}

function exportShapesFile(): void {
  const text = serializeShapes({ e: cfg.e, maxPeriods: cfg.maxPeriods });
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  const fname = `horseshoe-shapes-${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------- Restore cached state (runs last, after all declarations) ----------
// Restore overrides the default-seeded init above. On the first-ever visit
// (no cached state) the default init + ?e= handoff stands.
restoreHorseshoe();
// Flush any pending debounced save before the page unloads on a tab switch.
window.addEventListener('pagehide', persistHorseshoe);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') persistHorseshoe();
});
