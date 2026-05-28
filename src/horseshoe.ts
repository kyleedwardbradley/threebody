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
    tau: n.tau, v: n.v, escaped: n.escaped, s: n.s,
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
$('preimage-boundaries').addEventListener('click', () => runPreimage());
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
  canvas.setBoundaryPre(null);
  zoom.setBoundaryPre(null);
  d0Points.length = 0;
  d0PrePoints.length = 0;
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
  d0PrePoints.length = 0;
  d0Heap.length = 0;
  d0Pending = [];
  canvas.setBoundaryD0(null);
  zoom.setBoundaryD0(null);
  canvas.setBoundaryPre(null);
  zoom.setBoundaryPre(null);
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
    ? vkPolygonNodes.map((n) => ({ tau: n.tau, v: n.v, escaped: n.escaped, s: n.s }))
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
  d0PrePoints.length = 0;
  canvas.setBoundaryD0(null);
  zoom.setBoundaryD0(null);
  canvas.setBoundaryPre(null);   // stale once ∂D₀ is recomputed
  zoom.setBoundaryPre(null);
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
  zoom.setBoundaryPre(null);
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
  zoom.setBoundaryPre(d0PrePoints.slice());
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
      } else if (phase === 'preimage') {
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
initShapesUI();

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
// sector / V_k / shape phases.
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
    (v) => { shapeSampleN = v; });
  const pen = $<HTMLButtonElement>('pen-toggle');
  pen.addEventListener('click', () => {
    canvas.setPenMode(!canvas.getPenMode());
    pen.classList.toggle('active', canvas.getPenMode());
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
    zoom.setShapes(shapeStore.list());
  });
  // Initial render.
  canvas.setShapes(shapeStore.list());
  zoom.setShapes(shapeStore.list());
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
