import { HorseshoeCanvas, type SectorRect, type PolygonPoint, type ViewRect } from './horseshoeCanvas';
import { HorseshoeZoom, type ZoomRange } from './horseshoeZoom';
import HorseshoeWorker from './horseshoe-worker?worker';
import type {
  HorseshoeMainToWorker,
  HorseshoeWorkerToMain,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const canvas = new HorseshoeCanvas($<HTMLCanvasElement>('horseshoe-canvas'));
const zoom = new HorseshoeZoom($<HTMLCanvasElement>('horseshoe-zoom'));

// All shared state goes through these so the two views stay in lockstep.
function applySector(s: SectorRect | null): void {
  canvas.setSector(s); zoom.setSector(s);
}
function applyPolygon(pts: PolygonPoint[] | null): void {
  canvas.setPolygon(pts); zoom.setPolygon(pts);
}
function applySpiralPair(left: PolygonPoint[] | null, right: PolygonPoint[] | null): void {
  canvas.setSpiralPair(left, right); zoom.setSpiralPair(left, right);
}
function applyPPoints(pts: { tau: number; v: number; label?: string }[]): void {
  canvas.setPPoints(pts); zoom.setPPoints(pts);
}
function applyBeginGrid(
  n: number,
  tauMin: number, tauMax: number,
  vMin: number, vMax: number,
): void {
  canvas.beginGrid(n, tauMin, tauMax, vMin, vMax);
  zoom.beginGrid(n, tauMin, tauMax, vMin, vMax);
}
function applyGridRow(row: number, tauStars: Float32Array, vStars: Float32Array): void {
  canvas.setGridRow(row, tauStars, vStars);
  zoom.setGridRow(row, tauStars, vStars);
}
function applyClearGrid(): void {
  canvas.clearGrid(); zoom.clearGrid();
}
function applyShowGrid(on: boolean): void {
  canvas.setShowGrid(on); zoom.setShowGrid(on);
}
function applyShowImage(on: boolean): void {
  canvas.setShowImage(on); zoom.setShowImage(on);
}

// Zoom range = sector with 30% margin on each side (clamped to v ≥ 0).
function updateZoomRange(): void {
  const tS = tauStart(), tE = tauEnd();
  const dTau = Math.max(1e-6, tE - tS);
  const dV = Math.max(1e-6, cfg.vE - cfg.vS);
  const range: ZoomRange = {
    tauMin: tS - 0.3 * dTau,
    tauMax: tE + 0.3 * dTau,
    vMin: Math.max(0, cfg.vS - 0.3 * dV),
    vMax: cfg.vE + 0.3 * dV,
  };
  zoom.setRange(range);
}

interface Cfg {
  e: number;
  vMax: number;
  maxPeriods: number;
  n: number;
  // Sector: τ window described by central phase + half-width. The
  // actual edges are tauC ± tauD, which may go outside [0, 1) when the
  // window straddles the τ = 0 seam — we deliberately keep them as a
  // continuous representation (e.g. [-0.1, 0.1]) so downstream code
  // doesn't have to deal with seam wraparound artifacts.
  tauC: number; tauD: number;
  vS: number; vE: number;
  k: number;
}
const cfg: Cfg = {
  e: 0.5, vMax: 3.2, maxPeriods: 5, n: 200,
  tauC: 0.265, tauD: 0.011, vS: 0.300, vE: 1.848, k: 3800,
};
function tauStart(): number { return cfg.tauC - cfg.tauD; }
function tauEnd(): number { return cfg.tauC + cfg.tauD; }

let worker: Worker | null = null;
type Phase = 'idle' | 'grid'
  | 'finding-p'        // bisecting on the symmetry-line v_esc
  | 'sector-spirals'   // shooting the two τ-spirals at matched v
  | 'sector-edges'     // shooting top + bottom connectors at the effective vE
  | 'sector-refining'  // priority-queue refinement on the closed boundary
  | 'boundary-initial' // initial K-sample ∂D₀ bisection
  | 'boundary-refining'; // adaptive refinement of ∂D₀ at screen scale
let phase: Phase = 'idle';

// ---------- ∂D₀ / ∂D₁ boundary ----------

interface D0Point { tau: number; vEsc: number; }
interface D0Gap { tauA: number; vA: number; tauB: number; vB: number; dist: number; }

const d0Points: D0Point[] = [];   // sorted by tau ∈ [0, 1)
const d0Heap: D0Gap[] = [];       // max-heap on screen dist
let d0Pending: { tauMid: number; gap: D0Gap }[] = [];
const D0_INITIAL_K = 64;
const D0_BATCH = 8;
const D0_CAP = 5000;
const D0_THRESHOLD = 1;           // visual pixels
const D0_BISECT_STEPS = 18;

// Effective vE — clamped down from cfg.vE if either τ-spiral escapes
// before reaching cfg.vE. Polygon and overlay both use this.
let effVE: number = 0;
let spiralK = 0;   // K for the most recent spiral request
let edgeKtau = 0;  // K for the most recent top/bottom edge request

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
// Refine one gap per round-trip so we strictly process the longest
// remaining segment first (no batch can outrun a sub-gap created mid-batch).
const REFINE_BATCH = 1;
const THRESHOLD_PX = 1;
let refineCap = 50_000;
let lastRedrawAt = 0;
const REDRAW_INTERVAL_MS = 30;

function throttledRedraw(): void {
  const now = performance.now();
  if (now - lastRedrawAt >= REDRAW_INTERVAL_MS) {
    redrawPolygon();
    lastRedrawAt = now;
  }
}

// Boundary parameter s ∈ [0, 4):
//   edge 0 (s∈[0,1)): left spiral  τ=tauS, v: vS → effVE
//   edge 1 (s∈[1,2)): top connect  v=effVE, τ: tauS → tauE
//   edge 2 (s∈[2,3)): right spiral τ=tauE, v: effVE → vS
//   edge 3 (s∈[3,4)): bottom       v=vS, τ: tauE → tauS
function boundaryParam(s: number): { tau0: number; v0: number } {
  const vUpper = effVE > 0 ? effVE : cfg.vE;
  const sm = ((s % 4) + 4) % 4;
  const edge = Math.floor(sm) % 4;
  const t = sm - edge;
  switch (edge) {
    case 0: return { tau0: tauStart(), v0: cfg.vS + (vUpper - cfg.vS) * t };
    case 1: return { tau0: tauStart() + (tauEnd() - tauStart()) * t, v0: vUpper };
    case 2: return { tau0: tauEnd(), v0: vUpper + (cfg.vS - vUpper) * t };
    default: return { tau0: tauEnd() + (tauStart() - tauEnd()) * t, v0: cfg.vS };
  }
}

// Visual screen-pixel coords of (τ, v) — accounts for the current
// viewport-zoom transform on the main canvas. Refinement compares gaps in
// visual pixels so a 1-pixel threshold means 1 pixel as the user sees it.
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
  applyPolygon(polygonNodes.map((n) => ({
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

// Physics parameters affect every shot — both grid and polygon go stale.
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
  (v) => { cfg.vMax = v; canvas.setVMax(v); updateSectorDisplay(); });

// Grid resolution only changes the grid scan, not the polygon.
bindNumeric('n', 'n-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(50, Math.min(1000, Math.round(v))) },
  (v) => { cfg.n = v; invalidateGrid(); });

// Sector geometry only affects the forward image (polygon).
// τ window is described as central phase ± half-width so it can straddle
// the τ=0 seam continuously (e.g. tauC=0, tauD=0.1 → [-0.1, 0.1]).
bindNumeric('tauc', 'tauc-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => ((v % 1) + 1) % 1 },
  (v) => { cfg.tauC = v; invalidatePolygon(); });

bindNumeric('taud', 'taud-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0, Math.min(0.5, v)) },
  (v) => { cfg.tauD = v; invalidatePolygon(); });

bindNumeric('vs', 'vs-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0, v) },
  (v) => { cfg.vS = v; invalidatePolygon(); });

bindNumeric('ve', 've-num',
  { toNum: (v) => v.toFixed(3), clamp: (v) => Math.max(0, v) },
  (v) => { cfg.vE = v; invalidatePolygon(); });

bindNumeric('k', 'k-num',
  { toNum: (v) => Math.round(v).toString(),
    clamp: (v) => Math.max(4, Math.min(5000, Math.round(v))) },
  (v) => { cfg.k = v; invalidatePolygon(); });

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
$('toggle-boundaries').addEventListener('click', () => {
  const next = !canvas.getShowBoundaries();
  canvas.setShowBoundaries(next);
  $('toggle-boundaries').textContent = next ? 'Hide boundaries' : 'Show boundaries';
});
$('toggle-vk').addEventListener('click', () => {
  const next = !canvas.getShowVk();
  canvas.setShowVk(next);
  $('toggle-vk').textContent = next ? 'Hide V_k' : 'Show V_k';
});

// ---------- Zoom tool + view history (left panel only) ----------

const viewHistory: (ViewRect | null)[] = [null]; // [0] = full polar view
let viewIdx = 0;
let zoomToolActive = false;

function applyView(): void {
  canvas.setViewRect(viewHistory[viewIdx]);
  updateZoomButtons();
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

$('run-sector').addEventListener('click', () => runSector());
$('refine-sector').addEventListener('click', () => startRefinement());
$('reset').addEventListener('click', () => {
  stopAll();
  applyClearGrid();
  applyPolygon(null);
  applySpiralPair(null, null);
  applyPPoints([]);
  canvas.setBoundaryD0(null);
  d0Points.length = 0;
  d0Heap.length = 0;
  d0Pending = [];
  polygonNodes.length = 0;
  heap.length = 0;
  pending = [];
  effVE = 0;
  updateSectorDisplay();
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

function invalidatePolygon(): void {
  const hadPolygon = polygonNodes.length > 0;
  if (worker && (phase === 'sector-spirals' || phase === 'sector-edges' || phase === 'sector-refining')) {
    worker.postMessage({ type: 'stop' } as HorseshoeMainToWorker);
    killWorker();
    phase = 'idle';
  }
  polygonNodes.length = 0;
  heap.length = 0;
  pending = [];
  effVE = 0;
  applyPolygon(null);
  applySpiralPair(null, null);
  updateSectorDisplay();
  if (hadPolygon) $('status').textContent = 'sector image cleared (parameters changed)';
}

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
  invalidatePolygon();
  applyPPoints([]);  // P depends on e and maxPeriods
  d0Points.length = 0;
  d0Heap.length = 0;
  d0Pending = [];
  canvas.setBoundaryD0(null);
}

function stopAll(): void {
  const wasSector = phase === 'sector-spirals' || phase === 'sector-edges' || phase === 'sector-refining';
  // finding-p just falls through to idle below
  if (worker) {
    const m: HorseshoeMainToWorker = { type: 'stop' };
    worker.postMessage(m);
    killWorker();
  }
  if (wasSector) {
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

function runSector(): void {
  if (phase !== 'idle') return;
  canvas.setVMax(cfg.vMax);
  polygonNodes.length = 0;
  heap.length = 0;
  pending = [];
  effVE = cfg.vE;          // start optimistic; may shrink after spirals come back
  updateSectorDisplay();   // show the user's full sector while we work

  const K = Math.max(4, Math.round(cfg.k));
  spiralK = K;
  refineCap = Math.min(50_000, Math.max(2000, 50 * 4 * K));

  // Shoot 2K samples: K at τ=tauS, K at τ=tauE, both at matched v values
  // from vS to cfg.vE.
  const tau0s: number[] = [];
  const v0s: number[] = [];
  for (let k = 0; k < K; k++) {
    const v = cfg.vS + (cfg.vE - cfg.vS) * (K === 1 ? 0 : k / (K - 1));
    tau0s.push(tauStart()); v0s.push(v);
  }
  for (let k = 0; k < K; k++) {
    const v = cfg.vS + (cfg.vE - cfg.vS) * (K === 1 ? 0 : k / (K - 1));
    tau0s.push(tauEnd()); v0s.push(v);
  }
  const w = ensureWorker();
  w.postMessage({
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  });
  phase = 'sector-spirals';
  $('status').textContent = `tracing two τ-spirals (matched v)… ${2 * K} shots`;
}

function consumeSpiralResults(
  tauStars: Float32Array, vStars: Float32Array, escapes: Uint8Array,
): void {
  const K = spiralK;
  // Find first k where either spiral escapes — that bounds effective vE.
  let escIdx = K;
  for (let k = 0; k < K; k++) {
    if (escapes[k] === 1 || escapes[K + k] === 1) { escIdx = k; break; }
  }
  if (escIdx === 0) {
    phase = 'idle';
    killWorker();
    $('status').textContent =
      'sector image: every spiral sample escaped — lower vS, narrow τ range, or pick a smaller sector';
    return;
  }
  const validCount = escIdx; // 0..validCount-1 are valid
  effVE = (K === 1)
    ? cfg.vS
    : cfg.vS + (cfg.vE - cfg.vS) * (validCount - 1) / (K - 1);
  updateSectorDisplay();

  // Build the two spiral edges into polygonNodes.
  polygonNodes.length = 0;
  // Track the matched pair separately so the canvases can render the
  // area between them as small per-row quads (cleaner than filling the
  // self-intersecting polygon as one shape).
  const leftSpiral: PolygonPoint[] = [];
  const rightSpiral: PolygonPoint[] = [];
  // Left spiral (edge 0, s ∈ [0, 1)).
  for (let k = 0; k < validCount; k++) {
    const v0 = cfg.vS + (cfg.vE - cfg.vS) * (k / (K - 1));
    const s = validCount <= 1 ? 0 : k / validCount;
    polygonNodes.push({
      s, tau0: tauStart(), v0,
      tau: tauStars[k], v: vStars[k], escaped: false,
    });
    leftSpiral.push({ tau: tauStars[k], v: vStars[k], escaped: false });
  }
  // Right spiral (edge 2, s ∈ [2, 3)) — walks effVE → vS in boundary order,
  // so node k of the walk corresponds to input index (validCount - 1 - k).
  for (let k = 0; k < validCount; k++) {
    const inputIdx = validCount - 1 - k;
    const v0 = cfg.vS + (cfg.vE - cfg.vS) * (inputIdx / (K - 1));
    const s = validCount <= 1 ? 2 : 2 + k / validCount;
    polygonNodes.push({
      s, tau0: tauEnd(), v0,
      tau: tauStars[K + inputIdx], v: vStars[K + inputIdx],
      escaped: false,
    });
  }
  // Right spiral in v-ascending order to match left (paired by index k).
  for (let k = 0; k < validCount; k++) {
    rightSpiral.push({
      tau: tauStars[K + k], v: vStars[K + k], escaped: false,
    });
  }
  applySpiralPair(leftSpiral, rightSpiral);

  // Now shoot top (v=effVE) and bottom (v=vS) connectors.
  const Kt = K;
  edgeKtau = Kt;
  const t0s: number[] = [];
  const v0s: number[] = [];
  for (let k = 0; k < Kt; k++) {
    const t = Kt === 1 ? 0.5 : k / (Kt - 1);
    t0s.push(tauStart() + (tauEnd() - tauStart()) * t);
    v0s.push(effVE);
  }
  for (let k = 0; k < Kt; k++) {
    const t = Kt === 1 ? 0.5 : k / (Kt - 1);
    t0s.push(tauEnd() + (tauStart() - tauEnd()) * t);
    v0s.push(cfg.vS);
  }
  const w = ensureWorker();
  w.postMessage({
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s: t0s, v0s },
  });
  phase = 'sector-edges';
  const truncMsg = validCount < K
    ? ` (effVE=${effVE.toFixed(4)} from cfg vE=${cfg.vE.toFixed(4)})`
    : '';
  $('status').textContent = `tracing top/bottom edges… ${2 * Kt} shots${truncMsg}`;
}

function consumeEdgeResults(
  tauStars: Float32Array, vStars: Float32Array, escapes: Uint8Array,
): void {
  const K = edgeKtau;
  // Top edge (s ∈ [1, 2)).
  for (let k = 0; k < K; k++) {
    const t = K === 1 ? 0.5 : k / (K - 1);
    const s = 1 + k / K; // strictly < 2
    polygonNodes.push({
      s,
      tau0: tauStart() + (tauEnd() - tauStart()) * t, v0: effVE,
      tau: tauStars[k], v: vStars[k],
      escaped: escapes[k] === 1,
    });
  }
  // Bottom edge (s ∈ [3, 4)).
  for (let k = 0; k < K; k++) {
    const t = K === 1 ? 0.5 : k / (K - 1);
    const s = 3 + k / K;
    polygonNodes.push({
      s,
      tau0: tauEnd() + (tauStart() - tauEnd()) * t, v0: cfg.vS,
      tau: tauStars[K + k], v: vStars[K + k],
      escaped: escapes[K + k] === 1,
    });
  }
  polygonNodes.sort((a, b) => a.s - b.s);
  redrawPolygon();
  phase = 'idle';
  killWorker();
  const nEsc = polygonNodes.reduce((s, n) => s + (n.escaped ? 1 : 0), 0);
  $('status').textContent =
    `sector image: N=${polygonNodes.length}${nEsc ? `, ${nEsc} escaped` : ''} — click Refine to subdivide`;
}

function startRefinement(): void {
  if (phase !== 'idle') return;
  if (polygonNodes.length < 2) {
    $('status').textContent = 'no sector image to refine — compute one first';
    return;
  }
  refineCap = Math.min(50_000, Math.max(2000, 50 * polygonNodes.length));
  ensureWorker();
  phase = 'sector-refining';
  buildInitialHeap();
  if (heap.length === 0) {
    phase = 'idle';
    killWorker();
    $('status').textContent =
      `sector image: N=${polygonNodes.length} — all gaps already ≤ ${THRESHOLD_PX} px`;
    return;
  }
  refineStep();
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

// ---------- ∂D₀ boundary computation + adaptive refinement ----------

function runBoundaries(): void {
  if (phase !== 'idle') return;
  d0Points.length = 0;
  d0Heap.length = 0;
  d0Pending = [];
  canvas.setBoundaryD0(null);
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
  canvas.setBoundaryD0(d0Points.map((p) => ({ tau: p.tau, v: p.vEsc })));
}

function consumeBoundaryInitial(vEscs: Float32Array): void {
  d0Points.length = 0;
  for (let i = 0; i < D0_INITIAL_K; i++) {
    const v = vEscs[i];
    if (isFinite(v)) d0Points.push({ tau: i / D0_INITIAL_K, vEsc: v });
  }
  // Build initial heap (cyclic adjacency)
  d0Heap.length = 0;
  const n = d0Points.length;
  for (let i = 0; i < n; i++) {
    pushD0Gap(d0Points[i], d0Points[(i + 1) % n]);
  }
  applyBoundary();
  if (d0Heap.length === 0) { boundariesDone('threshold'); return; }
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

function onWorkerMsg(ev: MessageEvent<HorseshoeWorkerToMain>): void {
  const m = ev.data;
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
      if (phase === 'sector-spirals') {
        consumeSpiralResults(tauStars, vStars, escapes);
      } else if (phase === 'sector-edges') {
        consumeEdgeResults(tauStars, vStars, escapes);
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
        throttledRedraw();
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
  // After a sector compute we know effVE — clamp the displayed sector's vE
  // to it so the blue overlay matches the polygon's effective input range.
  const top = effVE > 0 ? Math.min(effVE, cfg.vE) : cfg.vE;
  const s: SectorRect = {
    tauS: tauStart(), tauE: tauEnd(), vS: cfg.vS, vE: top,
  };
  applySector(s);
  updateZoomRange();
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
cfg.tauC = parseFloat($<HTMLInputElement>('tauc').value);
cfg.tauD = parseFloat($<HTMLInputElement>('taud').value);
cfg.vS = parseFloat($<HTMLInputElement>('vs').value);
cfg.vE = parseFloat($<HTMLInputElement>('ve').value);
cfg.k = parseInt($<HTMLInputElement>('k').value, 10);

readQuery();
updateTabLinks();
canvas.setVMax(cfg.vMax);
updateSectorDisplay();
updateZoomButtons();
