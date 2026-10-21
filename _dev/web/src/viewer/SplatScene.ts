import * as THREE from "three";
import { PackedSplats, SparkRenderer, SplatFileType, SplatMesh } from "@sparkjsdev/spark";
import { computeStartFrame, type StartFrame } from "./startFrame";

/** Spark tells .ply / .spz / .sog by their bytes but .splat / .ksplat only by the URL — and a dropped file is a blob: URL with no extension. */
const TYPE_BY_EXT: Record<string, SplatFileType> = { ply: SplatFileType.PLY, spz: SplatFileType.SPZ, splat: SplatFileType.SPLAT, ksplat: SplatFileType.KSPLAT, sog: SplatFileType.PCSOGSZIP };

/**
 * Spark inside the three.js scene, holding any number of GS meshes (one per object).
 * Each mesh is parented under the root the caller hands in (the object's transform
 * group). `prepare()` sorts everything once per frame.
 *
 * Reading and drawing are separate: `read()` gives the splats (CPU), `add()` draws a set
 * of splats — for a big scan that is a thinned copy (see ScanData), never the whole file.
 */
export class SplatScene {
  /** Viewer convention: file (OpenCV, Y-down) → view (Y-up) is a 180° turn about X. */
  static readonly FILE_FLIP = new THREE.Quaternion(1, 0, 0, 0);
  private spark: SparkRenderer;
  readonly meshes: SplatMesh[] = [];
  /** First view of the first scan (shared rule with the Layouter, see startFrame.ts). */
  startFrame: StartFrame | null = null;

  constructor(renderer: THREE.WebGLRenderer, private scene: THREE.Scene) {
    this.spark = new SparkRenderer({ renderer });
    this.spark.autoUpdate = false; // sorted once per frame by prepare()
    this.scene.add(this.spark);
  }

  prepare(camera: THREE.Camera) { this.spark.update({ scene: this.scene, camera }); }

  /** Read a GS file (.ply/.spz/.splat/.ksplat/.sog) into CPU splats. `fileName` tells the format of a blob: URL. */
  async read(url: string, fileName: string): Promise<PackedSplats> {
    const fileType = TYPE_BY_EXT[(fileName.split(".").pop() || "").toLowerCase()];
    const ps = new PackedSplats({ url, fileName, fileType });
    await ps.initialized;
    return ps;
  }

  /** Draw `packed` under `root`. */
  async add(packed: PackedSplats, root: THREE.Object3D): Promise<SplatMesh> {
    const mesh = new SplatMesh({ packedSplats: packed });
    await mesh.initialized;
    // GS files are typically OpenCV convention (Y-down); flip 180° about X to sit upright
    // in three.js Y-up. The viewer's convention, not part of the user's correction: the
    // export removes it again (see FILE_FLIP).
    mesh.quaternion.copy(SplatScene.FILE_FLIP);
    root.add(mesh);
    mesh.updateMatrixWorld(true);
    this.meshes.push(mesh);
    return mesh;
  }

  /** The first view, from the splats being drawn (a thinned copy frames the same). */
  computeStart(packed: PackedSplats, mesh: SplatMesh) { this.startFrame = computeStartFrame(packed as any, mesh.matrixWorld); }

  /** Stop drawing a mesh. Its splats belong to the caller (ScanData) and are left alone. */
  remove(mesh: SplatMesh) {
    const i = this.meshes.indexOf(mesh);
    if (i >= 0) this.meshes.splice(i, 1);
    mesh.removeFromParent();
    const m = mesh as any;
    m.packedSplats = undefined; m.splats = undefined; m.extSplats = undefined;
    mesh.dispose();
  }

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
}
