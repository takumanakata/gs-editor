import * as THREE from "three";

/** The whole-scene transform as shown in the panel (metres / degrees, Y-up). */
export interface FrameState { pos: [number, number, number]; rotDeg: [number, number, number]; scale: number; }

/**
 * One transform for the WHOLE scene: the loaded GS plus every separated object live
 * under `root`, so moving / rotating / scaling the root previews the correction live,
 * and the same matrix is baked into the exported file.
 *
 * Rotations and scaling pivot around the WORLD ORIGIN (where the axis gizmo sits):
 * set the origin first, then fix the orientation around it.
 */
export class SceneFrame {
  readonly root = new THREE.Group();
  private onChange?: () => void;

  constructor(scene: THREE.Scene) {
    this.root.name = "sceneFrame";
    scene.add(this.root);
  }

  setOnChange(fn: () => void) { this.onChange = fn; }
  private changed() { this.root.updateMatrixWorld(true); this.onChange?.(); }

  get state(): FrameState {
    const e = new THREE.Euler().setFromQuaternion(this.root.quaternion, "XYZ");
    const d = (r: number) => (r * 180) / Math.PI;
    return { pos: [this.root.position.x, this.root.position.y, this.root.position.z], rotDeg: [d(e.x), d(e.y), d(e.z)], scale: this.root.scale.x };
  }

  isIdentity(): boolean {
    const s = this.state;
    return s.pos.every((v) => Math.abs(v) < 1e-9) && s.rotDeg.every((v) => Math.abs(v) < 1e-9) && Math.abs(s.scale - 1) < 1e-9;
  }

  /** Set the full state (numeric fields / sidecar restore). Rotation is about the world origin. */
  setState(s: FrameState) {
    this.root.position.set(s.pos[0], s.pos[1], s.pos[2]);
    const r = (x: number) => (x * Math.PI) / 180;
    this.root.quaternion.setFromEuler(new THREE.Euler(r(s.rotDeg[0]), r(s.rotDeg[1]), r(s.rotDeg[2]), "XYZ"));
    this.root.scale.setScalar(s.scale > 0 ? s.scale : 1);
    this.changed();
  }

  /** Change only the rotation, keeping the world origin fixed (content swings around the axes). */
  setRotationDeg(x: number, y: number, z: number) {
    const r = (v: number) => (v * Math.PI) / 180;
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r(x), r(y), r(z), "XYZ"));
    const delta = q.clone().multiply(this.root.quaternion.clone().invert());
    this.root.position.applyQuaternion(delta);
    this.root.quaternion.copy(q);
    this.changed();
  }

  setPosition(p: THREE.Vector3) { this.root.position.copy(p); this.changed(); }
  setWorld(q: THREE.Quaternion, p: THREE.Vector3) { this.root.quaternion.copy(q); this.root.position.copy(p); this.changed(); }

  /** Shift the scene by `d` (world). */
  translateWorld(d: THREE.Vector3) { this.root.position.add(d); this.changed(); }

  /** Rotate the scene by `q` about the world origin. */
  rotateWorld(q: THREE.Quaternion) {
    this.root.position.applyQuaternion(q);
    this.root.quaternion.premultiply(q);
    this.changed();
  }

  /** Scale the scene by `k` about the world origin (uniform). */
  scaleBy(k: number) {
    if (!(k > 0) || !isFinite(k)) return;
    this.root.scale.multiplyScalar(k);
    this.root.position.multiplyScalar(k);
    this.changed();
  }

  setScale(k: number) { if (k > 0 && isFinite(k)) this.scaleBy(k / this.root.scale.x); }

  reset() { this.root.position.set(0, 0, 0); this.root.quaternion.identity(); this.root.scale.setScalar(1); this.changed(); }

  toJSON(): FrameState { return this.state; }
  fromJSON(j: any): boolean {
    if (!j || !Array.isArray(j.pos) || !Array.isArray(j.rotDeg) || typeof j.scale !== "number") return false;
    this.setState({ pos: [+j.pos[0] || 0, +j.pos[1] || 0, +j.pos[2] || 0], rotDeg: [+j.rotDeg[0] || 0, +j.rotDeg[1] || 0, +j.rotDeg[2] || 0], scale: +j.scale || 1 });
    return true;
  }
}
