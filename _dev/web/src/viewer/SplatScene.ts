import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { computeStartFrame, type StartFrame } from "./startFrame";

/**
 * Renders a Gaussian Splatting scene via Spark inside an existing three.js scene.
 * Spark sorts/draws splats within the normal renderer.render() call — no per-frame
 * hook is required. `load()` swaps in a new GS file; `splatCount` reports size.
 */
export class SplatScene {
  /** Viewer convention: file (OpenCV, Y-down) → view (Y-up) is a 180° turn about X. */
  static readonly FILE_FLIP = new THREE.Quaternion(1, 0, 0, 0);
  private spark: SparkRenderer;
  private mesh?: SplatMesh;
  /** First view of the loaded file (shared rule with GSレイアウター, see startFrame.ts). */
  startFrame: StartFrame | null = null;

  /** `root` = the parent every loaded mesh goes under (the whole-scene transform group). */
  constructor(private renderer: THREE.WebGLRenderer, private scene: THREE.Scene, private root: THREE.Object3D = scene) {
    this.spark = new SparkRenderer({ renderer });
    // Sort once per frame ourselves (prepare()) instead of Spark's per-render auto-sort,
    // so extra render passes (e.g. the AI-separation capture) never re-sort mid-frame.
    this.spark.autoUpdate = false;
    this.scene.add(this.spark);
  }

  /** Sort splats once per frame for the given (main) camera, before rendering passes. */
  prepare(camera: THREE.Camera) { this.spark.update({ scene: this.scene, camera }); }

  /** Remove the current splats from the scene entirely (free GPU + drop the handle). */
  clear() {
    this.startFrame = null;
    if (this.mesh) {
      this.mesh.removeFromParent();
      this.mesh.dispose();
      this.mesh = undefined;
    }
  }

  /** Load a GS file (.ply/.spz/.splat/.ksplat/.sog). Resolves once it is on-GPU. */
  async load(url: string): Promise<SplatMesh> {
    this.clear(); // never leave the previous scene lingering behind a new load
    const mesh = new SplatMesh({ url });
    await mesh.initialized; // Spark: Promise<SplatMesh> resolved when ready
    // GS files are typically OpenCV convention (Y-down); flip 180° about X to sit
    // upright in three.js Y-up. (Spark docs: quaternion.set(1,0,0,0) = OpenCV->OpenGL.)
    // This flip is the viewer's convention, NOT part of the user's correction: export
    // removes it again so the file stays in the usual GS convention (see FILE_FLIP).
    mesh.quaternion.copy(SplatScene.FILE_FLIP);
    mesh.raycastable = true; // enable cursor picking on the splat surface
    this.root.add(mesh);
    mesh.updateMatrixWorld(true);
    this.mesh = mesh;
    // Vote over the ORIGINAL splats, now, before any edit touches them — the same
    // call GSレイアウター makes, so both apps open the file on the same picture.
    this.startFrame = computeStartFrame(mesh.packedSplats as any, mesh.matrixWorld);
    return mesh;
  }

  get current(): SplatMesh | undefined { return this.mesh; }

  /** World-space bounding box of the splats (for framing the start view). */
  getBoundsWorld(): THREE.Box3 | null {
    if (!this.mesh) return null;
    this.mesh.updateMatrixWorld();
    try { return this.mesh.getBoundingBox(true).applyMatrix4(this.mesh.matrixWorld); }
    catch { return null; }
  }

  /**
   * Find the densest, "meatiest" region of the splats — where to start the view.
   * Votes splats into a coarse voxel grid, weighting tight/opaque splats heavily and
   * big background sheets lightly, then returns the world centroid + spread of the
   * busiest neighbourhood. (Two cheap passes over the splats; runs once on load.)
   */
  densestRegion(): { center: THREE.Vector3; radius: number } | null {
    const m = this.mesh;
    if (!m) return null;
    let box: THREE.Box3;
    try { box = m.getBoundingBox(true); } catch { return null; }
    const size = new THREE.Vector3().subVectors(box.max, box.min);
    if (size.x <= 0 || size.y <= 0 || size.z <= 0) return null;
    const N = 24;
    const grid = new Float32Array(N * N * N);
    const inv = new THREE.Vector3(N / size.x, N / size.y, N / size.z);
    const clampI = (v: number) => (v < 0 ? 0 : v >= N ? N - 1 : v);
    const total = this.splatCount;
    const step = Math.max(1, Math.floor(total / 400000)); // cap ~400k samples per pass
    const w8 = (sx: number, sy: number, sz: number, op: number) => {
      const ms = (sx + sy + sz) / 3;
      return (op > 0 ? op : 1) / (1 + ms * ms); // tight + opaque splats vote most
    };
    let n = 0;
    m.forEachSplat((_i: number, c: THREE.Vector3, s: THREE.Vector3, _q: THREE.Quaternion, op: number) => {
      if (n++ % step) return;
      const gx = clampI(Math.floor((c.x - box.min.x) * inv.x));
      const gy = clampI(Math.floor((c.y - box.min.y) * inv.y));
      const gz = clampI(Math.floor((c.z - box.min.z) * inv.z));
      grid[(gx * N + gy) * N + gz] += w8(s.x, s.y, s.z, op);
    });
    let max = -1, mi = 0;
    for (let k = 0; k < grid.length; k++) if (grid[k] > max) { max = grid[k]; mi = k; }
    if (max <= 0) return null;
    const mgz = mi % N, mgy = ((mi / N) | 0) % N, mgx = (mi / (N * N)) | 0;
    const sum = new THREE.Vector3(); let wsum = 0, sq = 0; n = 0;
    m.forEachSplat((_i: number, c: THREE.Vector3, s: THREE.Vector3, _q: THREE.Quaternion, op: number) => {
      if (n++ % step) return;
      const gx = clampI(Math.floor((c.x - box.min.x) * inv.x));
      const gy = clampI(Math.floor((c.y - box.min.y) * inv.y));
      const gz = clampI(Math.floor((c.z - box.min.z) * inv.z));
      if (Math.abs(gx - mgx) <= 1 && Math.abs(gy - mgy) <= 1 && Math.abs(gz - mgz) <= 1) {
        const w = w8(s.x, s.y, s.z, op);
        sum.addScaledVector(c, w); wsum += w;
        sq += w * (c.x * c.x + c.y * c.y + c.z * c.z);
      }
    });
    if (wsum <= 0) return null;
    const meanLocal = sum.multiplyScalar(1 / wsum);
    const variance = Math.max(0, sq / wsum - meanLocal.lengthSq());
    const cell = Math.max(size.x, size.y, size.z) / N;
    const radius = Math.sqrt(variance) * 1.4 + cell * 0.5;
    m.updateMatrixWorld();
    return { center: meanLocal.clone().applyMatrix4(m.matrixWorld), radius };
  }

  /** Raycast the splat surface; returns the world hit point or null. */
  pick(raycaster: THREE.Raycaster): THREE.Vector3 | null {
    if (!this.mesh) return null;
    const hits: THREE.Intersection[] = [];
    try { this.mesh.raycast(raycaster, hits); } catch { return null; }
    return hits.length ? hits[0].point.clone() : null;
  }

  /** Actual numeric splat count (mesh.numSplats is a reactive Dyno, not a number). */
  get splatCount(): number {
    const m = this.mesh;
    if (!m) return 0;
    return m.splats?.getNumSplats() ?? m.packedSplats?.numSplats ?? 0;
  }
}
