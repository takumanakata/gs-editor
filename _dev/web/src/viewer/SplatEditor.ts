import * as THREE from "three";

/**
 * Per-splat editing on Spark's packed splats (getSplat/setSplat + needsUpdate):
 *   - selection: box / circle / lasso on the screen; selected splats are tinted
 *   - delete: hide the selection (scale → 0, reversible — the edit history keeps batches)
 * Everything is manual; there is no automatic cleanup here.
 */
const ZERO = new THREE.Vector3(0, 0, 0);
const SEL_COLOR = new THREE.Color(0xffa028); // Blender's selection orange
const SEL_MIX = 0.65;

export type SelectMode = "set" | "add" | "sub";

export class SplatEditor {
  private ps: any = null;          // packedSplats
  private n = 0;
  private centers!: Float32Array;  // 3n — cached splat positions (local / file space)
  private origScale!: Float32Array; // 3n — original scales (to restore on show/undo)
  private origColor!: Float32Array; // 3n — original colours (to untint on deselect)
  private hiddenFlag!: Uint8Array; // n — 1 if currently hidden
  private selFlag!: Uint8Array;    // n — 1 if selected
  private selCount = 0;
  private _ready = false;
  // screen projection of every visible splat (refreshed per gesture: the camera is fixed meanwhile)
  private sx!: Float32Array; private sy!: Float32Array; private svis!: Uint8Array;
  private projW = 0; private projH = 0;

  get ready() { return this._ready; }
  get count() { return this.n; }
  get selectedCount() { return this.selCount; }
  isHidden(i: number) { return !!this.hiddenFlag?.[i]; }

  /** Row indices (source order) of the splats still visible — what the export keeps. */
  visibleIndices(): Uint32Array {
    if (!this._ready) return new Uint32Array(0);
    let m = 0; for (let i = 0; i < this.n; i++) if (!this.hiddenFlag[i]) m++;
    const out = new Uint32Array(m); let k = 0;
    for (let i = 0; i < this.n; i++) if (!this.hiddenFlag[i]) out[k++] = i;
    return out;
  }

  /** Up to `maxN` visible splat centres transformed by `m` (flat xyz) — for dimensions. */
  sampleCenters(m: THREE.Matrix4 | null, maxN = 80000): Float32Array {
    if (!this._ready) return new Float32Array(0);
    const vis = this.visibleIndices();
    const step = Math.max(1, Math.ceil(vis.length / maxN));
    const out = new Float32Array(Math.ceil(vis.length / step) * 3);
    const v = new THREE.Vector3(); let k = 0;
    for (let t = 0; t < vis.length; t += step) {
      const j = vis[t] * 3;
      v.set(this.centers[j], this.centers[j + 1], this.centers[j + 2]);
      if (m) v.applyMatrix4(m);
      out[k++] = v.x; out[k++] = v.y; out[k++] = v.z;
    }
    return out.subarray(0, k);
  }

  /** World-space centroid of the selection (the orbit pivot while something is selected). */
  selectionCenter(worldMatrix: THREE.Matrix4): THREE.Vector3 | null {
    if (!this._ready || !this.selCount) return null;
    const c = new THREE.Vector3(); let k = 0;
    const step = Math.max(1, Math.ceil(this.selCount / 50000));
    let seen = 0;
    for (let i = 0; i < this.n; i++) {
      if (!this.selFlag[i]) continue;
      if (seen++ % step) continue;
      const j = i * 3; c.x += this.centers[j]; c.y += this.centers[j + 1]; c.z += this.centers[j + 2]; k++;
    }
    if (!k) return null;
    return c.multiplyScalar(1 / k).applyMatrix4(worldMatrix);
  }

  /**
   * Surface pick for the orbit pivot / measure. Walks a fixed subsample of the cached
   * centres (≤ ~400k) and returns the nearest one inside a thin cone around the ray.
   */
  pickRay(ray: THREE.Ray, worldMatrix: THREE.Matrix4, tanThr = 0.006): THREE.Vector3 | null {
    if (!this._ready || !this.n) return null;
    const inv = worldMatrix.clone().invert();
    const o = ray.origin.clone().applyMatrix4(inv);
    const d = ray.direction.clone().transformDirection(inv); // unit, local space (uniform scale assumed)
    const step = Math.max(1, Math.ceil(this.n / 400000));
    const thr2 = tanThr * tanThr;
    let bestT = Infinity, bi = -1;
    const c = this.centers;
    for (let i = 0; i < this.n; i += step) {
      if (this.hiddenFlag[i]) continue;
      const j = i * 3;
      const vx = c[j] - o.x, vy = c[j + 1] - o.y, vz = c[j + 2] - o.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t <= 1e-4 || t >= bestT) continue;
      const perp2 = vx * vx + vy * vy + vz * vz - t * t;
      if (perp2 < thr2 * t * t) { bestT = t; bi = i; }
    }
    if (bi < 0) return null;
    return new THREE.Vector3(c[bi * 3], c[bi * 3 + 1], c[bi * 3 + 2]).applyMatrix4(worldMatrix);
  }

  /** `count` original (source-space) centres spread over the file — lets the export verify row order. */
  refPoints(count = 64): { index: number; x: number; y: number; z: number }[] {
    if (!this._ready || !this.n) return [];
    const out: { index: number; x: number; y: number; z: number }[] = [];
    const step = Math.max(1, Math.floor(this.n / count));
    for (let i = 0; i < this.n && out.length < count; i += step) out.push({ index: i, x: this.centers[i * 3], y: this.centers[i * 3 + 1], z: this.centers[i * 3 + 2] });
    return out;
  }
  get hiddenCount() { let c = 0; for (let i = 0; i < this.n; i++) c += this.hiddenFlag[i]; return c; }

  /** Read all splats once and cache positions, scales and colours. Call after a GS loads. */
  analyze(mesh: any) {
    this._ready = false;
    this.ps = mesh.packedSplats;
    this.n = this.ps.getNumSplats?.() ?? 0;
    this.selCount = 0;
    if (!this.n) return;
    this.centers = new Float32Array(this.n * 3);
    this.origScale = new Float32Array(this.n * 3);
    this.origColor = new Float32Array(this.n * 3);
    this.hiddenFlag = new Uint8Array(this.n);
    this.selFlag = new Uint8Array(this.n);
    this.sx = new Float32Array(this.n); this.sy = new Float32Array(this.n); this.svis = new Uint8Array(this.n);
    let k = 0;
    mesh.forEachSplat((_i: number, c: THREE.Vector3, s: THREE.Vector3, _q: THREE.Quaternion, _op: number, col: THREE.Color) => {
      const j = k * 3;
      this.centers[j] = c.x; this.centers[j + 1] = c.y; this.centers[j + 2] = c.z;
      this.origScale[j] = s.x; this.origScale[j + 1] = s.y; this.origScale[j + 2] = s.z;
      this.origColor[j] = col.r; this.origColor[j + 1] = col.g; this.origColor[j + 2] = col.b;
      k++;
    });
    this._ready = true;
  }

  // ── screen projection (one per gesture) ────────────────────────────────
  /** Project every visible splat to pixel coords (the camera is fixed during a gesture). */
  project(camera: THREE.Camera, w: number, h: number, worldMatrix?: THREE.Matrix4) {
    if (!this._ready) return;
    this.projW = w; this.projH = h;
    const v = new THREE.Vector3();
    for (let i = 0; i < this.n; i++) {
      this.svis[i] = 0;
      if (this.hiddenFlag[i]) continue;
      const j = i * 3;
      v.set(this.centers[j], this.centers[j + 1], this.centers[j + 2]);
      if (worldMatrix) v.applyMatrix4(worldMatrix);
      v.project(camera);
      if (v.z < -1 || v.z > 1) continue;
      this.sx[i] = (v.x * 0.5 + 0.5) * w; this.sy[i] = (-v.y * 0.5 + 0.5) * h; this.svis[i] = 1;
    }
  }

  // ── selection ──────────────────────────────────────────────────────────
  private setSel(i: number, on: boolean) {
    if (!!this.selFlag[i] === on) return;
    this.selFlag[i] = on ? 1 : 0; this.selCount += on ? 1 : -1;
    const s = this.ps.getSplat(i);
    const j = i * 3;
    const col = new THREE.Color(this.origColor[j], this.origColor[j + 1], this.origColor[j + 2]);
    if (on) col.lerp(SEL_COLOR, SEL_MIX);
    this.ps.setSplat(i, s.center, s.scales, s.quaternion, s.opacity, col);
  }

  /** Apply a screen-space test to the projected splats. `mode`: set replaces, add extends, sub removes. */
  private applyTest(inside: (x: number, y: number) => boolean, mode: SelectMode): number {
    if (!this._ready) return 0;
    let changed = 0;
    if (mode === "set") { for (let i = 0; i < this.n; i++) if (this.selFlag[i] && !(this.svis[i] && inside(this.sx[i], this.sy[i]))) { this.setSel(i, false); changed++; } }
    for (let i = 0; i < this.n; i++) {
      if (!this.svis[i] || !inside(this.sx[i], this.sy[i])) continue;
      const want = mode !== "sub";
      if (!!this.selFlag[i] !== want) { this.setSel(i, want); changed++; }
    }
    if (changed) this.ps.needsUpdate = true;
    return changed;
  }

  selectRect(x0: number, y0: number, x1: number, y1: number, mode: SelectMode) {
    const l = Math.min(x0, x1), r = Math.max(x0, x1), t = Math.min(y0, y1), b = Math.max(y0, y1);
    return this.applyTest((x, y) => x >= l && x <= r && y >= t && y <= b, mode);
  }
  /** Circle select paints: only ever adds (or subtracts), never resets. */
  selectCircle(cx: number, cy: number, radius: number, mode: "add" | "sub") {
    const r2 = radius * radius;
    return this.applyTest((x, y) => { const dx = x - cx, dy = y - cy; return dx * dx + dy * dy <= r2; }, mode);
  }
  selectLasso(poly: { x: number; y: number }[], mode: SelectMode) {
    if (poly.length < 3) return 0;
    let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
    for (const p of poly) { minx = Math.min(minx, p.x); maxx = Math.max(maxx, p.x); miny = Math.min(miny, p.y); maxy = Math.max(maxy, p.y); }
    const inside = (x: number, y: number) => {
      if (x < minx || x > maxx || y < miny || y > maxy) return false;
      let c = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const pi = poly[i], pj = poly[j];
        if ((pi.y > y) !== (pj.y > y) && x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) c = !c;
      }
      return c;
    };
    return this.applyTest(inside, mode);
  }
  selectAll() { if (!this._ready) return; for (let i = 0; i < this.n; i++) if (!this.hiddenFlag[i]) this.setSel(i, true); this.ps.needsUpdate = true; }
  deselectAll() { if (!this._ready || !this.selCount) return; for (let i = 0; i < this.n; i++) this.setSel(i, false); this.ps.needsUpdate = true; }
  selectedIndices(): number[] { const out: number[] = []; if (!this._ready) return out; for (let i = 0; i < this.n; i++) if (this.selFlag[i]) out.push(i); return out; }

  // ── hide / show (delete is "hide the selection") ───────────────────────
  /** Hide the given splats (scale→0). Returns the indices that actually changed — the undo batch. */
  hide(indices: number[] | Uint32Array): number[] {
    const batch: number[] = [];
    if (!this._ready || !indices.length) return batch;
    for (const i of indices) {
      if (this.hiddenFlag[i]) continue;
      if (this.selFlag[i]) this.setSel(i, false); // hidden splats are never "selected"
      const s = this.ps.getSplat(i);
      this.ps.setSplat(i, s.center, ZERO, s.quaternion, s.opacity, s.color);
      this.hiddenFlag[i] = 1;
      batch.push(i);
    }
    if (batch.length) this.ps.needsUpdate = true;
    return batch;
  }

  /** Show hidden splats again (the inverse of hide for the same batch). */
  restore(indices: number[] | Uint32Array) {
    if (!this._ready) return;
    const sc = new THREE.Vector3();
    let any = false;
    for (const i of indices) {
      if (!this.hiddenFlag[i]) continue;
      const j = i * 3;
      sc.set(this.origScale[j], this.origScale[j + 1], this.origScale[j + 2]);
      const s = this.ps.getSplat(i);
      this.ps.setSplat(i, s.center, sc, s.quaternion, s.opacity, s.color);
      this.hiddenFlag[i] = 0; any = true;
    }
    if (any) this.ps.needsUpdate = true;
  }

  /** Indices of everything currently hidden (for "show all" as one history step). */
  hiddenIndices(): number[] {
    const all: number[] = [];
    if (!this._ready) return all;
    for (let i = 0; i < this.n; i++) if (this.hiddenFlag[i]) all.push(i);
    return all;
  }
}
