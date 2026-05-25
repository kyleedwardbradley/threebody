// Construct Moser's region R in (τ, v) space as the set of points whose
// perpendicular distance to D₀ is at most o₁ AND whose perpendicular
// distance to D₁ = ρ(D₀) is at most o₂. The boundary of R is four arcs:
// two parallel to D₀ at ±o₁ (the "long" sides, running along the unstable
// manifold), and two parallel to D₁ at ±o₂ (the "end caps").
//
// Only valid when D₁ = ρ(D₀), i.e. when the sector is centred on a
// symmetry line (τc = 0 or 0.5). Otherwise D₁ must be computed
// independently from backward integration (out of scope here).

export interface CurvePoint { tau: number; v: number; }

interface OffsetCurve {
  // One closed copy of the underlying curve, offset perpendicularly by
  // the signed distance `offset`. Points are stored in the same parameter
  // order as the source curve.
  source: 'D0' | 'D1';
  sign: 1 | -1;
  pts: CurvePoint[];
}

// Parallel-curve offset: each point shifted by `offset` along the unit
// normal. Source curve is assumed densely sampled and ordered along τ.
// The normal is (−tangent_v, tangent_τ) / |tangent|; sign chooses which
// of the two normal directions.
function offsetCurve(src: CurvePoint[], offset: number): CurvePoint[] {
  const n = src.length;
  if (n < 2 || offset === 0) {
    return src.map((p) => ({ tau: p.tau, v: p.v }));
  }
  const out: CurvePoint[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const prev = src[(i - 1 + n) % n];
    const next = src[(i + 1) % n];
    let dtau = next.tau - prev.tau;
    const dv = next.v - prev.v;
    // Source D₀ is sampled cyclically in τ ∈ [0, 1); unwrap large jumps.
    if (dtau > 0.5) dtau -= 1;
    if (dtau < -0.5) dtau += 1;
    const len = Math.hypot(dtau, dv);
    if (len < 1e-12) {
      out[i] = { tau: src[i].tau, v: src[i].v };
      continue;
    }
    const nx = -dv / len;
    const ny = dtau / len;
    out[i] = {
      tau: src[i].tau + offset * nx,
      v: src[i].v + offset * ny,
    };
  }
  return out;
}

// Reflect a curve across τ = 0: τ → −τ (mod 1), v unchanged. Used to
// obtain D₁ from D₀ on the symmetric-sector branches.
function reflectCurve(src: CurvePoint[]): CurvePoint[] {
  return src.map((p) => ({ tau: ((-p.tau) % 1 + 1) % 1, v: p.v }));
}

// Standard 2D segment intersection. Returns the intersection point and
// the parametric positions (t1, t2) on each segment, or null if they
// don't cross within [0, 1]².
interface SegIsect {
  pt: CurvePoint;
  t1: number; // along (a1 → a2)
  t2: number; // along (b1 → b2)
}
function segSegIntersect(
  a1: CurvePoint, a2: CurvePoint,
  b1: CurvePoint, b2: CurvePoint,
): SegIsect | null {
  const dx1 = a2.tau - a1.tau, dy1 = a2.v - a1.v;
  const dx2 = b2.tau - b1.tau, dy2 = b2.v - b1.v;
  const denom = dx1 * dy2 - dy1 * dx2;
  if (Math.abs(denom) < 1e-14) return null;
  const dx3 = b1.tau - a1.tau, dy3 = b1.v - a1.v;
  const t1 = (dx3 * dy2 - dy3 * dx2) / denom;
  const t2 = (dx3 * dy1 - dy3 * dx1) / denom;
  if (t1 < 0 || t1 > 1 || t2 < 0 || t2 > 1) return null;
  return {
    pt: { tau: a1.tau + t1 * dx1, v: a1.v + t1 * dy1 },
    t1, t2,
  };
}

// Find the first crossing of two polylines A and B by sweeping segments.
// Returns the intersection and the segment indices i, j where it lies, or
// null if they don't cross. With a hint (iStart, jStart), the search
// starts near a previous crossing — handy when you want all four
// crossings of two curves in order.
interface PolyIsect extends SegIsect { i: number; j: number; }
function polylineIntersect(
  A: CurvePoint[], B: CurvePoint[],
  iStart = 0, jStart = 0,
): PolyIsect | null {
  for (let i = iStart; i < A.length - 1; i++) {
    for (let j = (i === iStart ? jStart : 0); j < B.length - 1; j++) {
      const hit = segSegIntersect(A[i], A[i + 1], B[j], B[j + 1]);
      if (hit) return { ...hit, i, j };
    }
  }
  return null;
}

// All crossings of two polylines, in encounter order along A.
function allCrossings(A: CurvePoint[], B: CurvePoint[]): PolyIsect[] {
  const out: PolyIsect[] = [];
  for (let i = 0; i < A.length - 1; i++) {
    for (let j = 0; j < B.length - 1; j++) {
      const hit = segSegIntersect(A[i], A[i + 1], B[j], B[j + 1]);
      if (hit) out.push({ ...hit, i, j });
    }
  }
  return out;
}

// Resample an arc of a cyclic polyline into K equally-spaced points (by
// arc length). The arc goes from the fractional position (iA, tA) to
// (iB, tB) along the curve, choosing the SHORTER of the two cyclic
// directions. This is essential when corner indices land on opposite
// sides of the array but the true short arc wraps through index 0.
function resampleArc(
  pts: CurvePoint[], iA: number, tA: number, iB: number, tB: number, K: number,
): CurvePoint[] {
  const N = pts.length;
  if (N < 2) return [];
  const lerp = (p: CurvePoint, q: CurvePoint, t: number): CurvePoint => ({
    tau: p.tau + t * (q.tau - p.tau),
    v: p.v + t * (q.v - p.v),
  });
  // Build the two candidate walks (forward and backward in index, both
  // cyclic) and pick the shorter by total Euclidean arc length.
  const walk = (forward: boolean): CurvePoint[] => {
    const out: CurvePoint[] = [];
    // Start point.
    out.push(lerp(pts[iA], pts[(iA + 1) % N], tA));
    if (forward) {
      let k = (iA + 1) % N;
      // include indices iA+1, iA+2, ..., iB (cyclically). Stop after at
      // most N steps to avoid infinite loops on degenerate input.
      for (let count = 0; count < N; count++) {
        if (k === ((iB + 1) % N)) break;
        out.push(pts[k]);
        if (k === iB) break;
        k = (k + 1) % N;
      }
    } else {
      let k = iA;
      for (let count = 0; count < N; count++) {
        if (k === iB) { /* will append end below */ break; }
        out.push(pts[k]);
        k = (k - 1 + N) % N;
      }
    }
    // End point.
    out.push(lerp(pts[iB], pts[(iB + 1) % N], tB));
    return out;
  };
  const fwd = walk(true);
  const bwd = walk(false);
  const arcLen = (poly: CurvePoint[]): number => {
    let s = 0;
    for (let i = 1; i < poly.length; i++) {
      s += Math.hypot(poly[i].tau - poly[i - 1].tau, poly[i].v - poly[i - 1].v);
    }
    return s;
  };
  const lenF = arcLen(fwd), lenB = arcLen(bwd);
  const segPts = lenF <= lenB ? fwd : bwd;

  // Cumulative arc length, then resample.
  const cum: number[] = [0];
  for (let k = 1; k < segPts.length; k++) {
    cum.push(cum[k - 1] + Math.hypot(
      segPts[k].tau - segPts[k - 1].tau,
      segPts[k].v - segPts[k - 1].v,
    ));
  }
  const total = cum[cum.length - 1];
  if (total === 0 || K < 2) {
    return [segPts[0], segPts[segPts.length - 1]];
  }
  const out: CurvePoint[] = new Array(K);
  let cursor = 0;
  for (let k = 0; k < K; k++) {
    const target = (k / (K - 1)) * total;
    while (cursor < cum.length - 1 && cum[cursor + 1] < target) cursor++;
    const c0 = cum[cursor], c1 = cum[cursor + 1];
    const t = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
    out[k] = lerp(segPts[cursor], segPts[cursor + 1], t);
  }
  return out;
}

export interface RBoundary {
  // Boundary of R as four arcs in CCW order (each arc has K samples).
  // arc0: D₀ + o₁ (one long side)         → s ∈ [0, 1)
  // arc1: D₁ + o₂ (one end cap)           → s ∈ [1, 2)
  // arc2: D₀ − o₁ (other long side)       → s ∈ [2, 3)
  // arc3: D₁ − o₂ (other end cap)         → s ∈ [3, 4)
  arcs: [CurvePoint[], CurvePoint[], CurvePoint[], CurvePoint[]];
  corners: [CurvePoint, CurvePoint, CurvePoint, CurvePoint];
}

export interface ComputeRError { error: string; }

// Build R from a refined ∂D₀ point set and the offsets.
//
// d0Points: ordered along τ ∈ [0, 1), one sample per τ.
// K: samples per arc (so R's boundary has 4K points total).
// pNear: anchor (τ_p, v_p) used to pick the correct two crossings — the
//        intersections of (D₀ ± o₁) with (D₁ ± o₂) we want are the four
//        closest to P_a. Pass the equilibrium P_a here.
export function computeR(
  d0Points: CurvePoint[],
  o1: number,
  o2: number,
  K: number,
  pNear: CurvePoint,
): RBoundary | ComputeRError {
  if (d0Points.length < 4) return { error: 'D₀ has too few points; refine D₀ first.' };
  if (!(o1 > 0) || !(o2 > 0)) return { error: 'o₁ and o₂ must be positive.' };
  // Normal-direction offsets of D₀ and its reflection D₁.
  const d0Plus  = offsetCurve(d0Points,  o1);
  const d0Minus = offsetCurve(d0Points, -o1);
  const d1Src   = reflectCurve(d0Points);
  const d1Plus  = offsetCurve(d1Src,  o2);
  const d1Minus = offsetCurve(d1Src, -o2);

  // Four corners: (d0Plus, d1Plus), (d0Plus, d1Minus), (d0Minus, d1Plus),
  // (d0Minus, d1Minus). Pick the closest crossing to P_a for each pair —
  // far-away crossings are spurious (curves bend back and re-cross).
  const dist2 = (a: CurvePoint, b: CurvePoint) =>
    (a.tau - b.tau) ** 2 + (a.v - b.v) ** 2;
  const nearestCrossing = (A: CurvePoint[], B: CurvePoint[]): PolyIsect | null => {
    const all = allCrossings(A, B);
    if (all.length === 0) return null;
    let best = all[0];
    let bd = dist2(best.pt, pNear);
    for (let k = 1; k < all.length; k++) {
      const d = dist2(all[k].pt, pNear);
      if (d < bd) { best = all[k]; bd = d; }
    }
    return best;
  };

  const cPP = nearestCrossing(d0Plus,  d1Plus);
  const cPM = nearestCrossing(d0Plus,  d1Minus);
  const cMP = nearestCrossing(d0Minus, d1Plus);
  const cMM = nearestCrossing(d0Minus, d1Minus);
  if (!cPP || !cPM || !cMP || !cMM) {
    return { error: 'Could not find four corner intersections — try smaller offsets.' };
  }

  // Walk boundary CCW starting at corner (d0Plus, d1Plus):
  //   arc0 along d0Plus from cPP → cPM       (long side along D₀+o₁)
  //   arc1 along d1Minus from cPM → cMM      (end cap along D₁−o₂)
  //   arc2 along d0Minus from cMM → cMP      (long side along D₀−o₁)
  //   arc3 along d1Plus from cMP → cPP       (end cap along D₁+o₂)
  //
  // Each arc resamples to K equally-spaced points along its arc length.
  // resampleArc requires iA <= iB; if not, swap and reverse on return.
  const arc = (
    src: CurvePoint[], a: PolyIsect, b: PolyIsect, useATau: boolean,
  ): CurvePoint[] => {
    // useATau: read segment index from .i (when src is the A side of the
    // PolyIsect) vs .j (when src is B). resampleArc picks the shorter
    // cyclic direction internally.
    const iA = useATau ? a.i : a.j;
    const tA = useATau ? a.t1 : a.t2;
    const iB = useATau ? b.i : b.j;
    const tB = useATau ? b.t1 : b.t2;
    return resampleArc(src, iA, tA, iB, tB, K);
  };
  const arc0 = arc(d0Plus,  cPP, cPM, true);   // d0Plus  in A slot
  const arc1 = arc(d1Minus, cPM, cMM, false);  // d1Minus in B slot
  const arc2 = arc(d0Minus, cMM, cMP, true);
  const arc3 = arc(d1Plus,  cMP, cPP, false);

  return {
    arcs: [arc0, arc1, arc2, arc3],
    corners: [cPP.pt, cPM.pt, cMM.pt, cMP.pt],
  };
}
