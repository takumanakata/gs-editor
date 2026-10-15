import * as THREE from "three";
import { SparkRenderer, SplatMesh } from "@sparkjsdev/spark";
import { computeStartFrame, type StartFrame } from "./startFrame";

/**
 * Spark inside the three.js scene, holding any number of GS meshes (one per object).
 * Each mesh is parented under the root the caller hands in (the object's transform
 * group). `prepare()` sorts everything once per frame.
 */
export class SplatScene {
  /** Viewer convention: file (OpenCV, Y-down) → view (Y-up) is a 180° turn about X. */
  static readonly FILE_FLIP = new THREE.Quaternion(1, 0, 0, 0);
  private spark: SparkRenderer;
  readonly meshes: SplatMesh[] = [];
  /** First view of the most recently loaded file (shared rule with the Layouter, see startFrame.ts). */
  startFrame: StartFrame | null = null;

  constructor(renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    this.spark = new SparkRenderer({ renderer });
    this.spark.autoUpdate = false; // sorted once per frame by prepare()
    this.scene.add(this.spark);
  }

  prepare(camera: THREE.Camera) { this.spark.update({ scene: this.scene, camera }); }

  /** Load a GS file (.ply/.spz/.splat/.ksplat/.sog) under `root`. Resolves once it is on-GPU. */
  async load(url: string, root: THREE.Object3D): Promise<SplatMesh> {
    const mesh = new SplatMesh({ url });
    await mesh.initialized;
    // GS files are typically OpenCV convention (Y-down); flip 180° about X to sit upright
    // in three.js Y-up. The viewer's convention, not part of the user's correction: the
    // export removes it again (see FILE_FLIP).
    mesh.quaternion.copy(SplatScene.FILE_FLIP);
    mesh.raycastable = true;
    root.add(mesh);
    mesh.updateMatrixWorld(true);
    this.meshes.push(mesh);
    this.startFrame = computeStartFrame(mesh.packedSplats as any, mesh.matrixWorld);
    return mesh;
  }

  remove(mesh: SplatMesh) {
    const i = this.meshes.indexOf(mesh);
    if (i >= 0) this.meshes.splice(i, 1);
    mesh.removeFromParent();
    mesh.dispose();
  }

  clear() { for (const m of [...this.meshes]) this.remove(m); this.startFrame = null; }

  /** World-space bounding box of one mesh (or of all of them). */
  getBoundsWorld(mesh?: SplatMesh): THREE.Box3 | null {
    const list = mesh ? [mesh] : this.meshes;
    const box = new THREE.Box3();
    let any = false;
    for (const m of list) {
      m.updateMatrixWorld();
      try { box.union(m.getBoundingBox(true).applyMatrix4(m.matrixWorld)); any = true; } catch { /* not ready */ }
    }
    return any ? box : null;
  }

  static countOf(m: SplatMesh): number { return (m as any).splats?.getNumSplats?.() ?? (m as any).packedSplats?.numSplats ?? 0; }
  get splatCount(): number { return this.meshes.reduce((a, m) => a + SplatScene.countOf(m), 0); }
}
