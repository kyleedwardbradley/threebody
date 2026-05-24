import { initTheme, mountThemeToggle } from './theme';
import { mountPanelExport } from './exportPdf';
initTheme();
import { HorseshoeCanvas, type SectorRect, type PolygonPoint, type ViewRect } from './horseshoeCanvas';
import { HorseshoeZoom, type ZoomRange } from './horseshoeZoom';
import HorseshoeWorker from './horseshoe-worker?worker';
mountThemeToggle();
import type {
  HorseshoeMainToWorker,
  HorseshoeWorkerToMain,
} from './types';

const $ = <T extends HTMLElement = HTMLElement>(id: string) =>
  document.getElementById(id) as T;

const canvas = new HorseshoeCanvas($<HTMLCanvasElement>('horseshoe-canvas'));
const zoom = new HorseshoeZoom($<HTMLCanvasElement>('horseshoe-zoom'));
mountPanelExport({
  container: canvas.canvas.parentElement!,
  getCanvas: () => canvas.canvas,
  label: 'Horseshoe: polar disc',
  filename: 'horseshoe-polar',
});
mountPanelExport({
  container: zoom.canvas.parentElement!,
  getCanvas: () => zoom.canvas,
  label: 'Cartesian zoom around sector',
  filename: 'horseshoe-cartesian',
});

// All shared state goes through these so the two views stay in lockstep.
function applySector(s: SectorRect | null): void {
  canvas.setSector(s); zoom.setSector(s);
}
function applyPolygon(pts: PolygonPoint[] | null): void {
  canvas.setPolygon(pts); zoom.setPolygon(pts);
}
function applyVkPolygon(pts: PolygonPoint[] | null): void {
  canvas.setVkPolygon(pts); zoom.setVkPolygon(pts);
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
  tauC: 0.000, tauD: 0.011, vS: 0.300, vE: 1.848, k: 3800,
};
function tauStart(): number { return cfg.tauC - cfg.tauD; }
function tauEnd(): number { return cfg.tauC + cfg.tauD; }

let worker: Worker | null = null;
type Phase = 'idle' | 'grid'
  | 'finding-p'        // bisecting on the symmetry-line v_esc
  | 'sector-spirals'   // shooting the two τ-spirals at matched v
  | 'sector-edges'     // shooting top + bottom connectors at the effective vE
  | 'sector-refining'  // round-based refinement on the closed boundary
  | 'vk-spirals'       // V_k: shoot reflected sector's two τ-spirals via φ
  | 'vk-edges'         // V_k: shoot reflected sector's top + bottom connectors
  | 'vk-refining'      // V_k: round-based refinement on V_k boundary
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
const D0_THRESHOLD = 2;           // visual pixels
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
// V_k polygon — populated by runVk(). For τc-symmetric sectors this is
// the mirror of polygonNodes (τ → -τ). For other τc it's built from a
// separate forward-φ shoot of the reflected sector with the τ-images
// negated back (Moser's Lemma 2: φ⁻¹ = ρ φ ρ).
const vkPolygonNodes: PolygonNode[] = [];
let vkSpiralK = 0;
let vkEdgeKtau = 0;
let vkEffVE = 0;
let vkPending: PendingGap[] = [];
const heap: Gap[] = [];                   // max-heap on dist
let pending: PendingGap[] = [];
// Refine one gap per round-trip so we strictly process the longest
// remaining segment first (no batch can outrun a sub-gap created mid-batch).
const REFINE_BATCH = 64;
const THRESHOLD_PX = 1;
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
  (v) => { cfg.tauC = v; updateVkButton(); invalidatePolygon(); });

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
$('refine-boundaries').addEventListener('click', () => startBoundaryRefinement());
$('toggle-boundaries').addEventListener('click', () => {
  const next = !canvas.getShowBoundaries();
  canvas.setShowBoundaries(next);
  zoom.setShowBoundaries(next);
  $('toggle-boundaries').textContent = next ? 'Hide boundaries' : 'Show boundaries';
});
$('run-vk').addEventListener('click', () => runVk());
$('refine-vk').addEventListener('click', () => startVkRefinement());
$('toggle-vk').addEventListener('click', () => {
  if (vkPolygonNodes.length === 0) return;
  const next = !canvas.getShowVk();
  canvas.setShowVk(next);
  zoom.setShowVk(next);
  $('toggle-vk').textContent = next ? 'Hide V_k' : 'Show V_k';
});

// True when R is centred on one of the two symmetry lines (τc = 0 =
// mutual apogee P_a, or τc = 0.5 = mutual perihelion P_b). Then ρ(R) = R
// and V_k = ρ(U_k) follows from Moser's Lemma 2 — no separate shoot.
function isSectorSymmetric(): boolean {
  const t = ((cfg.tauC % 1) + 1) % 1;
  return Math.abs(t) < 1e-6 || Math.abs(t - 0.5) < 1e-6;
}
function updateVkButton(): void {
  const btn = $<HTMLButtonElement>('toggle-vk');
  btn.disabled = vkPolygonNodes.length === 0;
  btn.title = btn.disabled
    ? 'Click "Compute V_k" first'
    : 'Toggle V_k = φ⁻¹(R) ∩ R overlay';
  if (btn.disabled && canvas.getShowVk()) {
    canvas.setShowVk(false);
    zoom.setShowVk(false);
    btn.textContent = 'Show V_k';
  }
}

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
  zoom.setBoundaryD0(null);
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
  if (worker && (phase === 'sector-spirals' || phase === 'sector-edges'
              || phase === 'sector-refining' || phase === 'vk-spirals'
              || phase === 'vk-edges' || phase === 'vk-refining')) {
    worker.postMessage({ type: 'stop' } as HorseshoeMainToWorker);
    killWorker();
    phase = 'idle';
  }
  polygonNodes.length = 0;
  vkPolygonNodes.length = 0;
  heap.length = 0;
  pending = [];
  effVE = 0;
  vkEffVE = 0;
  applyPolygon(null);
  applyVkPolygon(null);
  applySpiralPair(null, null);
  updateSectorDisplay();
  updateRefineButton();
  updateVkButton();
  updateVkRefineButton();
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
  zoom.setBoundaryD0(null);
}

function stopAll(): void {
  const wasUk = phase === 'sector-spirals' || phase === 'sector-edges'
             || phase === 'sector-refining';
  const wasVk = phase === 'vk-spirals' || phase === 'vk-edges'
             || phase === 'vk-refining';
  // finding-p just falls through to idle below
  if (worker) {
    const m: HorseshoeMainToWorker = { type: 'stop' };
    worker.postMessage(m);
    killWorker();
  }
  if (wasUk) {
    phase = 'idle';
    redrawPolygon();
    $('status').textContent = `sector image stopped.  N=${polygonNodes.length}`;
  } else if (wasVk) {
    phase = 'idle';
    applyVk();
    $('status').textContent = `V_k stopped.  N=${vkPolygonNodes.length}`;
  } else {
    phase = 'idle';
  }
  pending = [];
  vkPending = [];
  updateRefineButton();
  updateVkRefineButton();
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
  const validCount = escIdx; // keep ALL non-escape samples; never truncate
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
  // Left spiral (edge 0, s ∈ [0, 1]). Spans the full edge from vS at s=0
  // to vUpper at s=1 with even s spacing 1/(validCount-1). The s=1 node
  // is the top-left corner — the top edge will later add a duplicate node
  // at s=1 with identical (tau0, v0), which is harmless.
  for (let k = 0; k < validCount; k++) {
    const v0 = cfg.vS + (cfg.vE - cfg.vS) * (k / (K - 1));
    const s = validCount <= 1 ? 0 : k / (validCount - 1);
    polygonNodes.push({
      s, tau0: tauStart(), v0,
      tau: tauStars[k], v: vStars[k], escaped: false,
    });
    leftSpiral.push({ tau: tauStars[k], v: vStars[k], escaped: false });
  }
  // Right spiral (edge 2, s ∈ [2, 3]). Walks effVE → vS in boundary order,
  // so node k of the walk corresponds to input index (validCount - 1 - k).
  // Spacing 1/(validCount-1) so s=2 is the top-right corner and s=3 is the
  // bottom-right corner — both shared with adjacent edges.
  for (let k = 0; k < validCount; k++) {
    const inputIdx = validCount - 1 - k;
    const v0 = cfg.vS + (cfg.vE - cfg.vS) * (inputIdx / (K - 1));
    const s = validCount <= 1 ? 2 : 2 + k / (validCount - 1);
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
  // Top edge (s ∈ [1, 2]). Spacing 1/(K-1) so s=1 and s=2 are the corners
  // shared with the left and right spirals respectively.
  for (let k = 0; k < K; k++) {
    const t = K === 1 ? 0.5 : k / (K - 1);
    const s = K === 1 ? 1.5 : 1 + k / (K - 1);
    polygonNodes.push({
      s,
      tau0: tauStart() + (tauEnd() - tauStart()) * t, v0: effVE,
      tau: tauStars[k], v: vStars[k],
      escaped: escapes[k] === 1,
    });
  }
  // Bottom edge (s ∈ [3, 4]). s=3 is the bottom-right corner (shared with
  // right spiral); s=4 ≡ s=0 (mod 4) is the bottom-left corner (shared with
  // left spiral, but at the wrap seam).
  for (let k = 0; k < K; k++) {
    const t = K === 1 ? 0.5 : k / (K - 1);
    const s = K === 1 ? 3.5 : 3 + k / (K - 1);
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

// ---------- V_k = φ⁻¹(R) ∩ R ---------------------------------------------
//
// Moser's Lemma 2: φ⁻¹ = ρ φ ρ where ρ(τ, v) = (-τ, v). So the V_k
// polygon (image of R's boundary under φ⁻¹) is built by:
//
//   1) Reflect each boundary point: (τ, v) → (-τ, v).
//   2) Shoot through the forward Poincaré map φ.
//   3) Reflect the result: (τ*, v*) → (-τ*, v*).
//
// When R is symmetric (τc=0 or 0.5), ρ(R) = R as a SET, so the input
// shots are at the same physical (τ0, v0) values as the U_k shots —
// just paired differently across the boundary. Easiest path: take the
// existing polygonNodes and negate τ on each, no shooting needed.
//
// For asymmetric R, the reflected sector boundary sits at -τC instead
// of τC, so we run a parallel shoot batch (spirals then top/bottom)
// just like runSector, with each input τ0 negated and each output τ*
// negated back before storage.

function applyVk(): void {
  applyVkPolygon(vkPolygonNodes.length > 0
    ? vkPolygonNodes.map((n) => ({ tau: n.tau, v: n.v, escaped: n.escaped }))
    : null);
}

function runVk(): void {
  if (phase !== 'idle') return;
  if (polygonNodes.length === 0) {
    $('status').textContent = 'compute the sector image first, then V_k';
    return;
  }

  if (isSectorSymmetric()) {
    // Fast path: V_k = ρ(U_k). Copy polygonNodes with τ negated.
    vkPolygonNodes.length = 0;
    for (const n of polygonNodes) {
      vkPolygonNodes.push({
        s: n.s, tau0: -n.tau0, v0: n.v0,
        tau: -n.tau, v: n.v, escaped: n.escaped,
      });
    }
    applyVk();
    updateVkButton();
    updateVkRefineButton();
    $('status').textContent =
      `V_k = ρ(U_k) (symmetric sector): N=${vkPolygonNodes.length}`;
    return;
  }

  // Asymmetric: shoot the reflected sector through φ.
  vkPolygonNodes.length = 0;
  applyVk();
  const K = Math.max(4, Math.round(cfg.k));
  vkSpiralK = K;
  // Inputs: reflected τ0, original v0. ρ(tauStart) = -tauStart = +tauD,
  // ρ(tauEnd) = -tauEnd = -tauD (for τc=0); in general, ρ(τc±τd) = -τc∓τd.
  const tau0s: number[] = [];
  const v0s: number[] = [];
  const tauStartR = -tauStart();
  const tauEndR = -tauEnd();
  for (let k = 0; k < K; k++) {
    const v = cfg.vS + (cfg.vE - cfg.vS) * (K === 1 ? 0 : k / (K - 1));
    tau0s.push(tauStartR); v0s.push(v);
  }
  for (let k = 0; k < K; k++) {
    const v = cfg.vS + (cfg.vE - cfg.vS) * (K === 1 ? 0 : k / (K - 1));
    tau0s.push(tauEndR); v0s.push(v);
  }
  const w = ensureWorker();
  w.postMessage({
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  });
  phase = 'vk-spirals';
  $('status').textContent = `V_k: shooting ρ(R) spirals… ${2 * K} shots`;
}

// Wrap (-tau*) into [0, 1) so the rendered angle is in the standard
// τ-window the rest of the code uses.
function wrap1(t: number): number { return ((t % 1) + 1) % 1; }

function consumeVkSpiralResults(
  tauStars: Float32Array, vStars: Float32Array, escapes: Uint8Array,
): void {
  const K = vkSpiralK;
  let escIdx = K;
  for (let k = 0; k < K; k++) {
    if (escapes[k] === 1 || escapes[K + k] === 1) { escIdx = k; break; }
  }
  if (escIdx === 0) {
    phase = 'idle'; killWorker();
    $('status').textContent = 'V_k: every spiral sample escaped — try a smaller sector';
    return;
  }
  const validCount = escIdx;
  vkEffVE = (K === 1)
    ? cfg.vS
    : cfg.vS + (cfg.vE - cfg.vS) * (validCount - 1) / (K - 1);
  // Build the two V_k spiral edges. Stored (τ, v) gets ρ applied to τ.
  // The polygon's s parameterisation walks the REFLECTED rectangle CCW
  // in (-τ0, v0) space, but since we negate τ outputs the visible curve
  // ends up CW in (τ, v) space — that's still a valid closed polygon.
  vkPolygonNodes.length = 0;
  const tauStartR = -tauStart();
  const tauEndR = -tauEnd();
  for (let k = 0; k < validCount; k++) {
    const v0 = cfg.vS + (cfg.vE - cfg.vS) * (k / (K - 1));
    const s = validCount <= 1 ? 0 : k / (validCount - 1);
    const tau = wrap1(-tauStars[k]);
    vkPolygonNodes.push({
      s, tau0: tauStartR, v0,
      tau, v: vStars[k], escaped: false,
    });
  }
  for (let k = 0; k < validCount; k++) {
    const inputIdx = validCount - 1 - k;
    const v0 = cfg.vS + (cfg.vE - cfg.vS) * (inputIdx / (K - 1));
    const s = validCount <= 1 ? 2 : 2 + k / (validCount - 1);
    const tau = wrap1(-tauStars[K + inputIdx]);
    vkPolygonNodes.push({
      s, tau0: tauEndR, v0,
      tau, v: vStars[K + inputIdx], escaped: false,
    });
  }

  // Shoot top/bottom connectors of the reflected sector.
  vkEdgeKtau = K;
  const t0s: number[] = [];
  const v0s: number[] = [];
  for (let k = 0; k < K; k++) {
    const t = K === 1 ? 0.5 : k / (K - 1);
    t0s.push(tauStartR + (tauEndR - tauStartR) * t);
    v0s.push(vkEffVE);
  }
  for (let k = 0; k < K; k++) {
    const t = K === 1 ? 0.5 : k / (K - 1);
    t0s.push(tauEndR + (tauStartR - tauEndR) * t);
    v0s.push(cfg.vS);
  }
  worker!.postMessage({
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s: t0s, v0s },
  });
  phase = 'vk-edges';
  $('status').textContent = `V_k: shooting ρ(R) top/bottom edges… ${2 * K} shots`;
}

function consumeVkEdgeResults(
  tauStars: Float32Array, vStars: Float32Array, escapes: Uint8Array,
): void {
  const K = vkEdgeKtau;
  const tauStartR = -tauStart();
  const tauEndR = -tauEnd();
  // Top edge (s ∈ [1, 2]) and bottom (s ∈ [3, 4]).
  for (let k = 0; k < K; k++) {
    const t = K === 1 ? 0.5 : k / (K - 1);
    const s = K === 1 ? 1.5 : 1 + k / (K - 1);
    const tau = wrap1(-tauStars[k]);
    vkPolygonNodes.push({
      s,
      tau0: tauStartR + (tauEndR - tauStartR) * t, v0: vkEffVE,
      tau, v: vStars[k], escaped: escapes[k] === 1,
    });
  }
  for (let k = 0; k < K; k++) {
    const t = K === 1 ? 0.5 : k / (K - 1);
    const s = K === 1 ? 3.5 : 3 + k / (K - 1);
    const tau = wrap1(-tauStars[K + k]);
    vkPolygonNodes.push({
      s,
      tau0: tauEndR + (tauStartR - tauEndR) * t, v0: cfg.vS,
      tau, v: vStars[K + k], escaped: escapes[K + k] === 1,
    });
  }
  vkPolygonNodes.sort((a, b) => a.s - b.s);
  applyVk();
  updateVkButton();
  updateVkRefineButton();
  phase = 'idle';
  killWorker();
  $('status').textContent = `V_k done. N=${vkPolygonNodes.length}`;
}

// V_k uses the same boundary parameterization as U_k (the rectangle's
// perimeter), with two ρ-reflections wrapped around the shoot: the
// input τ0 is negated before the worker call, and the result's τ* is
// negated (and wrapped to [0, 1)) before storage.
function vkInsertSorted(node: PolygonNode): void {
  let lo = 0, hi = vkPolygonNodes.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (vkPolygonNodes[mid].s < node.s) lo = mid + 1; else hi = mid;
  }
  vkPolygonNodes.splice(lo, 0, node);
}

function vkScreenXY(tau: number, v: number): { x: number; y: number } {
  // Mirror screenXY: project (τ, v) into main-canvas pixel space so the
  // chord-length threshold means "1 visual pixel" the user actually sees.
  return screenXY(tau, v);
}

function startVkRefinement(): void {
  if (phase === 'vk-refining') { stopAll(); return; }
  if (phase !== 'idle') return;
  if (vkPolygonNodes.length < 2) {
    $('status').textContent = 'no V_k to refine — compute V_k first';
    return;
  }
  ensureWorker();
  phase = 'vk-refining';
  updateVkRefineButton();
  vkRefineStep();
}

function updateVkRefineButton(): void {
  const btn = $<HTMLButtonElement>('refine-vk');
  if (!btn) return;
  btn.textContent = phase === 'vk-refining' ? 'Cancel' : 'Refine V_k';
  btn.disabled = vkPolygonNodes.length === 0 && phase !== 'vk-refining';
}

function vkRefineStep(): void {
  if (!worker || phase !== 'vk-refining') return;
  const candidates: PendingGap[] = [];
  let longest = 0;
  const N = vkPolygonNodes.length;
  for (let i = 0; i < N; i++) {
    const a = vkPolygonNodes[i];
    const b = vkPolygonNodes[(i + 1) % N];
    if (a.escaped || b.escaped) continue;
    const pa = vkScreenXY(a.tau, a.v);
    const pb = vkScreenXY(b.tau, b.v);
    const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (dist <= THRESHOLD_PX) continue;
    const sBEff = (i === N - 1) ? b.s + 4 : b.s;
    const sMid = 0.5 * (a.s + sBEff);
    // boundaryParam gives the (τ0, v0) on the ORIGINAL sector boundary.
    // For V_k we shoot the REFLECTED sector, so negate τ0.
    const orig = boundaryParam(sMid);
    candidates.push({
      gap: { sA: a.s, sB: sBEff, ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y, dist },
      sMid, tau0: -orig.tau0, v0: orig.v0,
    });
    if (dist > longest) longest = dist;
  }
  if (candidates.length === 0) { vkRefineDone('threshold'); return; }
  vkPending = candidates;
  const tau0s = candidates.map((c) => c.tau0);
  const v0s = candidates.map((c) => c.v0);
  worker.postMessage({
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  });
  $('status').textContent =
    `refining V_k… N=${vkPolygonNodes.length}  round=${candidates.length}  longest=${longest.toFixed(1)}px`;
}

function consumeVkRefineResults(
  tauStars: Float32Array, vStars: Float32Array, escapes: Uint8Array,
): void {
  for (let i = 0; i < vkPending.length; i++) {
    const p = vkPending[i];
    if (escapes[i] === 1) continue;
    const sActual = ((p.sMid % 4) + 4) % 4;
    // Reflect result back: τ → -τ (wrapped into [0, 1)).
    vkInsertSorted({
      s: sActual, tau0: p.tau0, v0: p.v0,
      tau: wrap1(-tauStars[i]), v: vStars[i], escaped: false,
    });
  }
  vkPending = [];
  applyVk();
  vkRefineStep();
}

function vkRefineDone(reason: 'threshold' | 'stopped'): void {
  phase = 'idle';
  vkPending = [];
  applyVk();
  killWorker();
  updateVkRefineButton();
  const tag = reason === 'stopped' ? ' (stopped)' : '';
  $('status').textContent = `V_k refine done. N=${vkPolygonNodes.length}${tag}`;
}

// ---------- Refinement: round-based iteration over all segments -----------
//
// Each round walks every consecutive polygon-node pair, computes the screen
// distance, and shoots the parametric midpoint sMid = (sA + sB)/2 of any
// segment longer than THRESHOLD_PX. All the midpoints from that round come
// back together and get inserted at their sMid positions; the next round
// walks the (now denser) polygon. Done when a round finds no segments above
// threshold, or when the user clicks the Refine button (which is labelled
// "Cancel" while refinement is running).
//
// No chaos filter, no dot-product check, no truncation. A midpoint of s
// always maps to the curve's image at that s, so the inserted point belongs
// in parametric order between its neighbors — even if the chord from A to B
// happens to skip windings and the screen midpoint sits "outside" the chord.
// The polygon image is what it is.
//
// The only thing we drop is escape: if a midpoint shoot escapes there's no
// (τ*, v*) to insert, so that segment stays as a chord until next round
// (where it'll be picked up again and re-shot — but the same v0 will escape
// again, so effectively it's stable).

function startRefinement(): void {
  if (phase === 'sector-refining') { stopAll(); return; }
  if (phase !== 'idle') return;
  if (polygonNodes.length < 2) {
    $('status').textContent = 'no sector image to refine — compute one first';
    return;
  }
  ensureWorker();
  phase = 'sector-refining';
  updateRefineButton();
  refineStep();
}

function updateRefineButton(): void {
  const btn = $<HTMLButtonElement>('refine-sector');
  btn.textContent = phase === 'sector-refining' ? 'Cancel' : 'Refine';
}

function refineStep(): void {
  if (!worker || phase !== 'sector-refining') return;

  // Collect every segment that still exceeds the threshold.
  const candidates: PendingGap[] = [];
  let longest = 0;
  const N = polygonNodes.length;
  for (let i = 0; i < N; i++) {
    const a = polygonNodes[i];
    const b = polygonNodes[(i + 1) % N];
    if (a.escaped || b.escaped) continue;
    const pa = screenXY(a.tau, a.v);
    const pb = screenXY(b.tau, b.v);
    const dist = Math.hypot(pb.x - pa.x, pb.y - pa.y);
    if (dist <= THRESHOLD_PX) continue;
    const sBEff = (i === N - 1) ? b.s + 4 : b.s;
    const sMid = 0.5 * (a.s + sBEff);
    const { tau0, v0 } = boundaryParam(sMid);
    candidates.push({
      gap: { sA: a.s, sB: sBEff, ax: pa.x, ay: pa.y, bx: pb.x, by: pb.y, dist },
      sMid, tau0, v0,
    });
    if (dist > longest) longest = dist;
  }
  if (candidates.length === 0) { refineDone('threshold'); return; }

  pending = candidates;
  const tau0s = candidates.map((c) => c.tau0);
  const v0s = candidates.map((c) => c.v0);
  worker.postMessage({
    type: 'shoot',
    req: { e: cfg.e, maxPeriods: cfg.maxPeriods, tau0s, v0s },
  });
  $('status').textContent =
    `refining sector image… N=${polygonNodes.length}  round=${candidates.length}  longest=${longest.toFixed(1)}px`;
}

function consumeRefineResults(
  tauStars: Float32Array, vStars: Float32Array, escapes: Uint8Array,
): void {
  for (let i = 0; i < pending.length; i++) {
    const p = pending[i];
    if (escapes[i] === 1) continue;
    const sActual = ((p.sMid % 4) + 4) % 4;
    insertSorted({
      s: sActual, tau0: p.tau0, v0: p.v0,
      tau: tauStars[i], v: vStars[i], escaped: false,
    });
  }
  pending = [];
  throttledRedraw();
  refineStep();
}

function refineDone(reason: 'threshold' | 'stopped'): void {
  phase = 'idle';
  pending = [];
  redrawPolygon();
  killWorker();
  updateRefineButton();
  const tag = reason === 'stopped' ? ' (stopped)' : '';
  $('status').textContent = `sector image done.  N=${polygonNodes.length}${tag}`;
}

// ---------- ∂D₀ boundary computation + adaptive refinement ----------

function runBoundaries(): void {
  if (phase !== 'idle') return;
  d0Points.length = 0;
  d0Heap.length = 0;
  d0Pending = [];
  canvas.setBoundaryD0(null);
  zoom.setBoundaryD0(null);
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
  zoom.setBoundaryD0(pts);
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
        consumeRefineResults(tauStars, vStars, escapes);
      } else if (phase === 'vk-spirals') {
        consumeVkSpiralResults(tauStars, vStars, escapes);
      } else if (phase === 'vk-edges') {
        consumeVkEdgeResults(tauStars, vStars, escapes);
      } else if (phase === 'vk-refining') {
        consumeVkRefineResults(tauStars, vStars, escapes);
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
updateVkButton();
updateVkRefineButton();
