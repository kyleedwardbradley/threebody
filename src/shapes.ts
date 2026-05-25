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
