import * as THREE from "three";

/**
 * Manual GS cleanup: brush / floater / auto-clean → hide those splats in bulk.
 * Works directly on Spark's packed splats (getSplat/setSplat + needsUpdate); hiding
 * sets a splat's scale to zero so it stops rendering. Original scales are cached so
 * hides are reversible (undo / restore-all).
 */
const ZERO = new THREE.Vector3(0, 0, 0);

export class SplatEditor {
  private ps: any = null;          // packedSplats
  private n = 0;
  private centers!: Float32Array;  // 3n — cached splat positions (for screen selection)
  private origScale!: Float32Array; // 3n — original scales (to restore on show/undo)
  private opacityArr!: Float32Array; // n — cached opacity (for auto-cleanup)
  private hiddenFlag!: Uint8Array; // n — 1 if currently hidden
  private _ready = false;
  // brush stroke: screen positions are projected ONCE per stroke (camera is fixed while painting)
  private sx!: Float32Array; private sy!: Float32Array; private svis!: Uint8Array;
  private strokeSet = new Set<number>();

  get ready() { return this._ready; }
  get count() { return this.n; }
  isHidden(i: number) { return !!this.hiddenFlag?.[i]; }

  /** Row indices (source order) of the splats still visible — what the export keeps from the main scene. */
  visibleIndices(): Uint32Array {
    if (!this._ready) return new Uint32Array(0);
    let m = 0; for (let i = 0; i < this.n; i++) if (!this.hiddenFlag[i]) m++;
    const out = new Uint32Array(m); let k = 0;
    for (let i = 0; i < this.n; i++) if (!this.hiddenFlag[i]) out[k++] = i;
    return out;
  }

  /** Up to `maxN` visible splat centres transformed by `m` (flat xyz) — input for the origin / level tools. */
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

  /**
   * Surface pick for hover / pivot / double-click. Spark's own raycast tests every
   * splat ellipsoid on the main thread (≈250 ms per pick on 3.1M splats — that was the
   * stutter while orbiting). This walks a fixed subsample of the cached centres (≤ ~400k)
   * and returns the nearest one inside a thin cone around the ray — a few ms, and plenty
   * for choosing an orbit pivot or a point to fly to. `tanThr` = cone half-angle (tan).
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

  /** Read all splats once and cache positions + scales. Call after a GS loads. */
  analyze(mesh: any) {
    this._ready = false;
    this.ps = mesh.packedSplats;
    this.n = this.ps.getNumSplats?.() ?? 0;
    if (!this.n) return;
    this.centers = new Float32Array(this.n * 3);
    this.origScale = new Float32Array(this.n * 3);
    this.opacityArr = new Float32Array(this.n);
    this.hiddenFlag = new Uint8Array(this.n);
    this.sx = new Float32Array(this.n); this.sy = new Float32Array(this.n); this.svis = new Uint8Array(this.n);
    let k = 0;
    mesh.forEachSplat((_i: number, c: THREE.Vector3, s: THREE.Vector3, _q: THREE.Quaternion, op: number) => {
      const j = k * 3;
      this.centers[j] = c.x; this.centers[j + 1] = c.y; this.centers[j + 2] = c.z;
      this.origScale[j] = s.x; this.origScale[j + 1] = s.y; this.origScale[j + 2] = s.z;
      this.opacityArr[k] = op;
      k++;
    });
    this._ready = true;
  }

  /**
   * Remove floating noise: hide splats sitting in near-empty space (few neighbours in a
   * voxel neighbourhood). `minNeighbors` = how many neighbours a splat needs to survive —
   * higher removes more. Returns the hidden batch (for the edit history).
   */
  removeFloaters(minNeighbors = 10): number[] {
    if (!this._ready) return [];
    // scene bounds (visible splats)
    let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity, zlo = Infinity, zhi = -Infinity;
    for (let i = 0; i < this.n; i++) {
      if (this.hiddenFlag[i]) continue;
      const j = i * 3, x = this.centers[j], y = this.centers[j + 1], z = this.centers[j + 2];
      if (x < lo) lo = x; if (x > hi) hi = x;
      if (y < ylo) ylo = y; if (y > yhi) yhi = y;
      if (z < zlo) zlo = z; if (z > zhi) zhi = z;
    }
    const diag = Math.hypot(hi - lo, yhi - ylo, zhi - zlo) || 1;
    const cell = diag / 256;            // voxel size
    const inv = 1 / cell;
    const S = 2048;                     // grid keys: clamp each axis to [0, S)
    const key = (gx: number, gy: number, gz: number) => (gx * S + gy) * S + gz;
    const vx = (x: number) => Math.min(S - 1, Math.max(0, Math.floor((x - lo) * inv)));
    const vy = (y: number) => Math.min(S - 1, Math.max(0, Math.floor((y - ylo) * inv)));
    const vz = (z: number) => Math.min(S - 1, Math.max(0, Math.floor((z - zlo) * inv)));
    // pass 1: occupancy counts
    const counts = new Map<number, number>();
    for (let i = 0; i < this.n; i++) {
      if (this.hiddenFlag[i]) continue;
      const j = i * 3;
      const k = key(vx(this.centers[j]), vy(this.centers[j + 1]), vz(this.centers[j + 2]));
      counts.set(k, (counts.get(k) || 0) + 1);
    }
    // pass 2: 27-neighbourhood sum; flag the lonely ones
    const doomed: number[] = [];
    for (let i = 0; i < this.n; i++) {
      if (this.hiddenFlag[i]) continue;
      const j = i * 3;
      const gx = vx(this.centers[j]), gy = vy(this.centers[j + 1]), gz = vz(this.centers[j + 2]);
      let sum = 0;
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        sum += counts.get(key(gx + dx, gy + dy, gz + dz)) || 0;
        if (sum > minNeighbors) { dx = dy = dz = 2; break; } // early out
      }
      if (sum <= minNeighbors) doomed.push(i);
    }
    return this.hide(doomed);
  }

  /**
   * One-click cleanup: prune faint (low-opacity), extreme-size (fog/sheet outliers),
   * needle-shaped (anisotropic) and isolated (sparse-neighbourhood / floater) splats —
   * conservatively, so legit surfaces survive. `strength` 0..1 scales aggressiveness.
   * Returns the hidden batch (for the edit history).
   */
  autoClean(strength = 0.4): number[] {
    if (!this._ready) return [];
    const n = this.n;
    const opMin = 0.015 + strength * 0.05;        // 0.015..0.065 faint cutoff
    const ratioMax = 200 - strength * 100;        // 200..100 needle ratio — only degenerate spikes (grass/foliage are legitimately elongated)
    const sizePct = 0.999 - strength * 0.006;     // top 0.1%..0.7% biggest = sheet/fog outliers
    const densFrac = 0.01 + strength * 0.09;      // remove the sparsest 1%..10% (floaters) — bounded

    // coarse voxel grid → 27-neighbourhood count per visible splat
    let lo = Infinity, hi = -Infinity, ylo = Infinity, yhi = -Infinity, zlo = Infinity, zhi = -Infinity;
    for (let i = 0; i < n; i++) { if (this.hiddenFlag[i]) continue; const j = i * 3, x = this.centers[j], y = this.centers[j + 1], z = this.centers[j + 2]; if (x < lo) lo = x; if (x > hi) hi = x; if (y < ylo) ylo = y; if (y > yhi) yhi = y; if (z < zlo) zlo = z; if (z > zhi) zhi = z; }
    const cell = (Math.hypot(hi - lo, yhi - ylo, zhi - zlo) || 1) / 128, inv = 1 / cell, S = 2048;
    const key = (gx: number, gy: number, gz: number) => (gx * S + gy) * S + gz;
    const vx = (x: number) => Math.min(S - 1, Math.max(0, Math.floor((x - lo) * inv)));
    const vy = (y: number) => Math.min(S - 1, Math.max(0, Math.floor((y - ylo) * inv)));
    const vz = (z: number) => Math.min(S - 1, Math.max(0, Math.floor((z - zlo) * inv)));
    const counts = new Map<number, number>();
    for (let i = 0; i < n; i++) { if (this.hiddenFlag[i]) continue; const j = i * 3; const k = key(vx(this.centers[j]), vy(this.centers[j + 1]), vz(this.centers[j + 2])); counts.set(k, (counts.get(k) || 0) + 1); }
    const nb = new Float32Array(n); const ms = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (this.hiddenFlag[i]) { nb[i] = -1; ms[i] = -1; continue; }
      const j = i * 3;
      ms[i] = (this.origScale[j] + this.origScale[j + 1] + this.origScale[j + 2]) / 3;
      const gx = vx(this.centers[j]), gy = vy(this.centers[j + 1]), gz = vz(this.centers[j + 2]);
      let sum = 0; for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) sum += counts.get(key(gx + dx, gy + dy, gz + dz)) || 0;
      nb[i] = sum;
    }
    // percentile thresholds (bounded removal that adapts to the scene)
    const nbVis = Float32Array.from(nb).filter((x) => x >= 0).sort();
    const msVis = Float32Array.from(ms).filter((x) => x >= 0).sort();
    const densCut = nbVis.length ? nbVis[Math.floor(nbVis.length * densFrac)] : 0;
    const scaleHi = msVis.length ? msVis[Math.min(msVis.length - 1, Math.floor(msVis.length * sizePct))] : Infinity;

    const doomed: number[] = [];
    for (let i = 0; i < n; i++) {
      if (this.hiddenFlag[i]) continue;
      const j = i * 3;
      const ratio = Math.max(this.origScale[j], this.origScale[j + 1], this.origScale[j + 2]) / (Math.min(this.origScale[j], this.origScale[j + 1], this.origScale[j + 2]) || 1e-6);
      if (this.opacityArr[i] < opMin || ms[i] > scaleHi || ratio > ratioMax || nb[i] <= densCut) doomed.push(i);
    }
    return this.hide(doomed);
  }

  // ── brush stroke (pen) ──────────────────────────────────────────────────
  /** Start a brush stroke: project every visible splat to pixel coords once (camera is fixed while painting). */
  beginStroke(camera: THREE.Camera, w: number, h: number, worldMatrix?: THREE.Matrix4) {
    if (!this._ready) return;
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
    this.strokeSet.clear();
  }

  /** Paint under the cursor: hide splats within `radius` px (live erase). Use during a clean stroke. */
  paintErase(cx: number, cy: number, radius: number) {
    const r2 = radius * radius; let any = false;
    for (let i = 0; i < this.n; i++) {
      if (!this.svis[i] || this.strokeSet.has(i)) continue;
      const dx = this.sx[i] - cx, dy = this.sy[i] - cy;
      if (dx * dx + dy * dy <= r2) { const s = this.ps.getSplat(i); this.ps.setSplat(i, s.center, ZERO, s.quaternion, s.opacity, s.color); this.hiddenFlag[i] = 1; this.strokeSet.add(i); any = true; }
    }
    if (any) this.ps.needsUpdate = true;
  }

  /** Finish a stroke: returns the erased indices (the caller records them in the edit history). */
  endStroke(): number[] {
    const arr = [...this.strokeSet];
    this.strokeSet.clear();
    return arr;
  }

  /** Hide the given splats (scale→0). Returns the indices that actually changed — the undo batch. */
  hide(indices: number[] | Uint32Array): number[] {
    const batch: number[] = [];
    if (!this._ready || !indices.length) return batch;
    for (const i of indices) {
      if (this.hiddenFlag[i]) continue;
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
