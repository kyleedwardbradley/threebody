// User-drawn shapes on the (τ, v) diagram, plus their mapped/refined
// children. A single in-memory store; the UI subscribes to onChange.

export type ShapeId = string;

export interface Shape {
  id: ShapeId;
  name: string;
  vertices: { tau: number; v: number }[]; // ordered along the shape
  closed: boolean;                        // polygon if true, polyline if false
  color: string;                          // canvas-renderable colour string
  visible: boolean;
  // Optional lineage when this shape was created from another via φ.
  parent?: {
    id: ShapeId;
    via: 'forward' | 'backward';
    iterates: number;  // total composed iterates: 1 for first map, 2 for φ², etc.
  };
  // Per-vertex source-sample positions captured at map time. Only set on
  // mapped (child) shapes. Refinement bisects edges of `sourceVertices`
  // — these are the resampled positions on the original source curve
  // (arc-length spaced) that were shot to produce each `vertices` entry.
  // Always satisfies sourceVertices.length === vertices.length.
  sourceVertices?: { tau: number; v: number }[];
}

// Colour palette for fresh shapes — readable on both dark and light
// themes (no pure white / near-black). Cycled in order.
const PALETTE = [
  '#ff8a3a', // orange
  '#3acdff', // cyan
  '#a8ff5a', // lime
  '#ff66c4', // pink
  '#ffd24a', // gold
  '#9b7bff', // violet
  '#5fd07a', // green
  '#ff5a5a', // red
];

class ShapeStore {
  private shapes: Shape[] = [];
  private nextNum = 1;
  private palIdx = 0;
  private listeners = new Set<() => void>();

  list(): readonly Shape[] { return this.shapes; }
  get(id: ShapeId): Shape | undefined {
    return this.shapes.find((s) => s.id === id);
  }
  add(init: Partial<Shape> & Pick<Shape, 'vertices' | 'closed'>): Shape {
    const id = `sh_${Date.now().toString(36)}_${this.nextNum++}`;
    const color = init.color ?? PALETTE[this.palIdx++ % PALETTE.length];
    const name  = init.name  ?? `Shape ${this.shapes.length + 1}`;
    const shape: Shape = {
      id, name, color, visible: true,
      vertices: init.vertices,
      closed: init.closed,
      parent: init.parent,
      sourceVertices: init.sourceVertices,
    };
    this.shapes.push(shape);
    this.emit();
    return shape;
  }
  update(id: ShapeId, patch: Partial<Shape>): void {
    const s = this.get(id);
    if (!s) return;
    Object.assign(s, patch);
    this.emit();
  }
  replaceVertices(id: ShapeId, vertices: Shape['vertices']): void {
    const s = this.get(id);
    if (!s) return;
    s.vertices = vertices;
    this.emit();
  }
  remove(id: ShapeId): void {
    const i = this.shapes.findIndex((s) => s.id === id);
    if (i < 0) return;
    this.shapes.splice(i, 1);
    this.emit();
  }
  clear(): void {
    this.shapes.length = 0;
    this.nextNum = 1;
    this.palIdx = 0;
    this.emit();
  }
  onChange(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }
  private emit(): void {
    for (const cb of this.listeners) cb();
  }
}

export const shapeStore = new ShapeStore();

// Closure snap distance in screen pixels: clicking within this radius of
// the first vertex closes the active draw stroke as a polygon.
export const CLOSURE_SNAP_PX = 8;

// Default per-shape refinement target (forward-image segment ≤ this).
export const SHAPE_REFINE_PX = 1;

// Resample a polyline (or closed polygon) to N points by arc length in
// (τ, v) space, treating each consecutive pair as a straight segment.
// τ is unwrapped relative to the previous vertex (each step in (-0.5,
// 0.5]) so the arc length is correct across the τ=0 seam.
//
// For closed shapes the resampling spans the closing edge too (the
// implicit chord from last vertex back to first) and returns N distinct
// vertices distributed around the loop.
//
// If verts.length < 2 returns a copy of verts (nothing to interpolate).
export function resamplePolyline(
  verts: { tau: number; v: number }[],
  closed: boolean,
  N: number,
): { tau: number; v: number }[] {
  if (verts.length < 2 || N < 2) {
    return verts.map((p) => ({ tau: p.tau, v: p.v }));
  }
  // Build unwrapped representation: keep tau on a continuous line so
  // arc length is accurate; we'll re-wrap when returning the resamples.
  const n = verts.length;
  const uw: { tau: number; v: number }[] = [{ tau: verts[0].tau, v: verts[0].v }];
  for (let i = 1; i < n; i++) {
    let dt = verts[i].tau - uw[i - 1].tau;
    dt -= Math.round(dt);
    uw.push({ tau: uw[i - 1].tau + dt, v: verts[i].v });
  }
  if (closed) {
    let dt = verts[0].tau - uw[n - 1].tau;
    dt -= Math.round(dt);
    uw.push({ tau: uw[n - 1].tau + dt, v: verts[0].v });
  }
  // Cumulative arc length.
  const cum: number[] = [0];
  for (let i = 1; i < uw.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(
      uw[i].tau - uw[i - 1].tau,
      uw[i].v - uw[i - 1].v,
    ));
  }
  const total = cum[cum.length - 1];
  if (total === 0) {
    return Array.from({ length: N }, () => ({ tau: verts[0].tau, v: verts[0].v }));
  }
  // For closed shapes, N samples cover the full loop with the last
  // distinct from the first (parametric spacing total / N). For open
  // polylines, N samples from start to end inclusive (spacing total / (N-1)).
  const step = closed ? (total / N) : (total / (N - 1));
  const out: { tau: number; v: number }[] = new Array(N);
  let cursor = 0;
  const wrap1 = (t: number) => ((t % 1) + 1) % 1;
  for (let k = 0; k < N; k++) {
    const target = k * step;
    while (cursor < cum.length - 1 && cum[cursor + 1] < target) cursor++;
    if (cursor >= cum.length - 1) {
      out[k] = { tau: wrap1(uw[uw.length - 1].tau), v: uw[uw.length - 1].v };
      continue;
    }
    const c0 = cum[cursor], c1 = cum[cursor + 1];
    const t = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
    const p0 = uw[cursor], p1 = uw[cursor + 1];
    out[k] = {
      tau: wrap1(p0.tau + t * (p1.tau - p0.tau)),
      v:   p0.v + t * (p1.v - p0.v),
    };
  }
  return out;
}

// Schema for the JSON file format (export/import).
export interface ShapesFile {
  format: 'threebody-shapes';
  version: 1;
  createdAt: string;
  params?: { e: number; maxPeriods: number };
  shapes: Shape[];
}

export function serializeShapes(extras?: ShapesFile['params']): string {
  const file: ShapesFile = {
    format: 'threebody-shapes',
    version: 1,
    createdAt: new Date().toISOString(),
    params: extras,
    shapes: shapeStore.list().map((s) => ({ ...s, vertices: s.vertices.map((p) => ({ ...p })) })),
  };
  return JSON.stringify(file, null, 2);
}

export function deserializeShapes(text: string): Shape[] {
  const obj = JSON.parse(text) as unknown;
  if (!obj || typeof obj !== 'object') throw new Error('not a JSON object');
  const f = obj as Partial<ShapesFile>;
  if (f.format !== 'threebody-shapes') throw new Error('not a shapes file (wrong format tag)');
  if (f.version !== 1) throw new Error(`unsupported version: ${f.version}`);
  if (!Array.isArray(f.shapes)) throw new Error('missing shapes array');
  // Light validation per shape.
  for (const s of f.shapes) {
    if (typeof s.id !== 'string' || typeof s.name !== 'string'
     || !Array.isArray(s.vertices) || typeof s.closed !== 'boolean'
     || typeof s.color !== 'string') {
      throw new Error('malformed shape entry');
    }
    for (const v of s.vertices) {
      if (typeof v.tau !== 'number' || typeof v.v !== 'number') {
        throw new Error('vertex coords must be numbers');
      }
    }
  }
  return f.shapes;
}
