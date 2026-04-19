import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const TRAIL_CAPACITY = 4096;         // absolute buffer upper bound
const TRAIL_BASE_RGB = [0.4, 1.0, 0.6] as const; // newest-point color

const RIPPLE_DURATION_MS = 450;
const RIPPLE_GROWTH = 6;             // final scale relative to initial ring
const RIPPLE_MAX_ACTIVE = 24;
const RIPPLE_COLOR_UP = 0x66ff99;
const RIPPLE_COLOR_DOWN = 0xff6a9a;

interface Ripple {
  mesh: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  born: number;
}

export class View3D {
  private container: HTMLElement;
  private renderer: THREE.WebGLRenderer;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;

  private body1: THREE.Mesh;
  private body2: THREE.Mesh;
  private particle: THREE.Mesh;
  private orbit1: THREE.Line;
  private orbit2: THREE.Line;

  private trailPositions: Float32Array;
  private trailColors: Float32Array;
  private trailGeometry: THREE.BufferGeometry;
  private trailPoints: THREE.Points;
  private trailIdx = 0;
  private trailCount = 0;
  private trailMax = 512;

  private rippleGeometry: THREE.RingGeometry;
  private ripples: Ripple[] = [];
  private ripplePool: THREE.Mesh[] = [];

  constructor(container: HTMLElement) {
    this.container = container;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x06060e);

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio || 1);
    container.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 100);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(2.4, 2.4, 1.8);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.1;
    this.controls.target.set(0, 0, 0);

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.DirectionalLight(0xffffff, 0.75);
    key.position.set(4, 3, 5);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x88aaff, 0.25);
    fill.position.set(-3, -2, 1);
    this.scene.add(fill);

    // z-axis reference line (extended, dim)
    const zGeo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, -4), new THREE.Vector3(0, 0, 4),
    ]);
    this.scene.add(new THREE.Line(zGeo, new THREE.LineBasicMaterial({
      color: 0x2a4a80, transparent: true, opacity: 0.5,
    })));

    // x-y plane grid
    const grid = new THREE.GridHelper(2, 20, 0x223048, 0x151a28);
    grid.rotation.x = Math.PI / 2;
    this.scene.add(grid);

    // Bodies
    const bodyMat = new THREE.MeshStandardMaterial({
      color: 0xffcc66, emissive: 0x332211, roughness: 0.45, metalness: 0.1,
    });
    const bodyGeo = new THREE.SphereGeometry(0.045, 24, 16);
    this.body1 = new THREE.Mesh(bodyGeo, bodyMat);
    this.body2 = new THREE.Mesh(bodyGeo, bodyMat);
    this.scene.add(this.body1, this.body2);

    // Particle on z-axis (half the original radius)
    const pMat = new THREE.MeshStandardMaterial({
      color: 0x88ffaa, emissive: 0x1f5a35, roughness: 0.4,
    });
    this.particle = new THREE.Mesh(new THREE.SphereGeometry(0.015, 16, 12), pMat);
    this.scene.add(this.particle);

    // Orbit ellipses (set in setEccentricity)
    const orbitMat = new THREE.LineBasicMaterial({ color: 0x445575 });
    this.orbit1 = new THREE.Line(new THREE.BufferGeometry(), orbitMat);
    this.orbit2 = new THREE.Line(new THREE.BufferGeometry(), orbitMat);
    this.scene.add(this.orbit1, this.orbit2);

    // Particle trail: Points with per-vertex color, recomputed each frame to produce a fade.
    this.trailPositions = new Float32Array(TRAIL_CAPACITY * 3);
    this.trailColors = new Float32Array(TRAIL_CAPACITY * 3);
    this.trailGeometry = new THREE.BufferGeometry();
    this.trailGeometry.setAttribute('position',
      new THREE.BufferAttribute(this.trailPositions, 3));
    this.trailGeometry.setAttribute('color',
      new THREE.BufferAttribute(this.trailColors, 3));
    this.trailGeometry.setDrawRange(0, 0);
    this.trailPoints = new THREE.Points(
      this.trailGeometry,
      new THREE.PointsMaterial({
        size: 3, sizeAttenuation: false,
        vertexColors: true,
        transparent: true, depthWrite: false,
      })
    );
    this.scene.add(this.trailPoints);

    // Shared ring geometry for crossing ripples (one allocation).
    this.rippleGeometry = new THREE.RingGeometry(0.055, 0.075, 48);

    this.onResize();
    const ro = new ResizeObserver(() => this.onResize());
    ro.observe(container);
  }

  triggerRipple(sign: number): void {
    const color = sign >= 0 ? RIPPLE_COLOR_UP : RIPPLE_COLOR_DOWN;

    let mesh = this.ripplePool.pop();
    let material: THREE.MeshBasicMaterial;
    if (!mesh) {
      material = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      mesh = new THREE.Mesh(this.rippleGeometry, material);
    } else {
      material = mesh.material as THREE.MeshBasicMaterial;
      material.color.setHex(color);
      material.opacity = 0.9;
    }
    mesh.scale.set(1, 1, 1);
    mesh.position.set(0, 0, 0);
    this.scene.add(mesh);
    this.ripples.push({ mesh, material, born: performance.now() });

    // Bound active ripples — oldest is recycled.
    while (this.ripples.length > RIPPLE_MAX_ACTIVE) {
      const oldest = this.ripples.shift()!;
      this.scene.remove(oldest.mesh);
      this.ripplePool.push(oldest.mesh);
    }
  }

  private updateRipples(now: number): void {
    for (let i = this.ripples.length - 1; i >= 0; i--) {
      const r = this.ripples[i];
      const age = (now - r.born) / RIPPLE_DURATION_MS;
      if (age >= 1) {
        this.scene.remove(r.mesh);
        this.ripplePool.push(r.mesh);
        this.ripples.splice(i, 1);
        continue;
      }
      const scale = 1 + age * RIPPLE_GROWTH;
      r.mesh.scale.set(scale, scale, 1);
      // Ease-out fade (quadratic)
      r.material.opacity = 0.9 * (1 - age) * (1 - age);
    }
  }

  setEccentricity(e: number): void {
    const N = 256;
    const pts1: THREE.Vector3[] = [];
    const pts2: THREE.Vector3[] = [];
    for (let i = 0; i <= N; i++) {
      const E = (i / N) * Math.PI * 2;
      const x = 0.5 * (Math.cos(E) - e);
      const y = 0.5 * Math.sqrt(Math.max(0, 1 - e * e)) * Math.sin(E);
      pts1.push(new THREE.Vector3(x, y, 0));
      pts2.push(new THREE.Vector3(-x, -y, 0));
    }
    this.orbit1.geometry.dispose();
    this.orbit2.geometry.dispose();
    this.orbit1.geometry = new THREE.BufferGeometry().setFromPoints(pts1);
    this.orbit2.geometry = new THREE.BufferGeometry().setFromPoints(pts2);
  }

  // Resize the visible ring without losing recent points. Keeps the newest
  // min(trailCount, newMax) samples and re-lays them at the head of the buffer.
  setTrailLength(n: number): void {
    const newMax = Math.max(0, Math.min(n | 0, TRAIL_CAPACITY));
    if (newMax === this.trailMax) return;

    if (newMax === 0) {
      this.trailMax = 0;
      this.clearTrail();
      return;
    }

    const keep = Math.min(this.trailCount, newMax);
    if (keep === 0) {
      this.trailMax = newMax;
      this.trailIdx = 0;
      this.trailCount = 0;
      this.trailGeometry.setDrawRange(0, 0);
      return;
    }

    const oldMax = Math.max(1, this.trailMax);
    const oldIdx = this.trailIdx;
    const pos = this.trailPositions;
    const tmp = new Float32Array(keep * 3);
    // Fill tmp oldest → newest.
    for (let i = 0; i < keep; i++) {
      const ageFromNewest = keep - 1 - i;
      const src = ((oldIdx - 1 - ageFromNewest) + oldMax) % oldMax;
      tmp[i * 3]     = pos[src * 3];
      tmp[i * 3 + 1] = pos[src * 3 + 1];
      tmp[i * 3 + 2] = pos[src * 3 + 2];
    }
    pos.set(tmp);

    this.trailMax = newMax;
    this.trailCount = keep;
    this.trailIdx = keep % newMax;
    this.recomputeTrailColors();
    this.trailGeometry.setDrawRange(0, keep);
    (this.trailGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  clearTrail(): void {
    this.trailIdx = 0;
    this.trailCount = 0;
    this.trailGeometry.setDrawRange(0, 0);
    (this.trailGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  update(bx: number, by: number, z: number): void {
    this.body1.position.set(bx, by, 0);
    this.body2.position.set(-bx, -by, 0);
    this.particle.position.set(0, 0, z);

    if (this.trailMax === 0) {
      if (this.trailCount !== 0) this.clearTrail();
      return;
    }

    const pos = this.trailPositions;
    const i = this.trailIdx * 3;
    pos[i] = 0; pos[i + 1] = 0; pos[i + 2] = z;
    this.trailIdx = (this.trailIdx + 1) % this.trailMax;
    this.trailCount = Math.min(this.trailCount + 1, this.trailMax);

    this.recomputeTrailColors();

    this.trailGeometry.setDrawRange(0, this.trailCount);
    (this.trailGeometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (this.trailGeometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  // Age-based color ramp: newest bright, oldest dark → fades into background.
  private recomputeTrailColors(): void {
    const colors = this.trailColors;
    const n = this.trailCount;
    const max = this.trailMax;
    const idx = this.trailIdx;
    const denom = Math.max(1, n - 1);
    const [r0, g0, b0] = TRAIL_BASE_RGB;

    for (let k = 0; k < n; k++) {
      // age = 0 for newest, n-1 for oldest
      const age = ((idx - 1 - k) + max) % max;
      const t = 1 - age / denom;           // 1 → newest, 0 → oldest
      const fade = t * t;                  // quadratic — more aggressive late fade
      const j = k * 3;
      colors[j]     = r0 * fade;
      colors[j + 1] = g0 * fade;
      colors[j + 2] = b0 * fade;
    }
  }

  render(): void {
    this.updateRipples(performance.now());
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private onResize(): void {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}
