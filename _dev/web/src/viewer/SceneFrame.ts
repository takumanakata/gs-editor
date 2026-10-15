import * as THREE from "three";

/** What the panel shows (Blender's Location / Rotation / Scale, in the viewer's Y-up terms). */
export interface FrameState { pos: [number, number, number]; rotDeg: [number, number, number]; scale: number; }
/** The full transform for history / sidecar: the root's placement plus the object origin. */
export interface FrameJSON { root: [number, number, number]; rotDeg: [number, number, number]; scale: number; pivot: [number, number, number] }

/**
 * One transform for the WHOLE scan, modelled like a Blender object: the scan has an
 * ORIGIN of its own (`pivot`, a point in the scan), rotation and scale happen about
 * that origin, and "Location" is where that origin sits in the world. The world
 * origin (the fixed marker + grid) is what you align the object origin to: set the
 * origin on the spot of the scan you care about, clear its location (Alt+G), then
 * rotate and scale about it.
 *
 * `root` holds the loaded mesh; the same matrix is baked into the exported file.
 */
export class SceneFrame {
  readonly root = new THREE.Group();
  /** The object origin, in root-local coordinates (moves with the scan). */
  readonly pivot = new THREE.Vector3();
  private onChange?: () => void;

  constructor(scene: THREE.Scene) {
    this.root.name = "sceneFrame";
    scene.add(this.root);
  }

  setOnChange(fn: () => void) { this.onChange = fn; }
  private changed() { this.root.updateMatrixWorld(true); this.onChange?.(); }

  /** The object origin in world space. */
  worldPivot(): THREE.Vector3 { this.root.updateMatrixWorld(true); return this.pivot.clone().applyMatrix4(this.root.matrixWorld); }

  get state(): FrameState {
    const e = new THREE.Euler().setFromQuaternion(this.root.quaternion, "XYZ");
    const d = (r: number) => (r * 180) / Math.PI;
    const p = this.worldPivot();
    return { pos: [p.x, p.y, p.z], rotDeg: [d(e.x), d(e.y), d(e.z)], scale: this.root.scale.x };
  }

  isIdentity(): boolean {
    const s = this.state;
    return s.pos.every((v) => Math.abs(v) < 1e-9) && s.rotDeg.every((v) => Math.abs(v) < 1e-9) && Math.abs(s.scale - 1) < 1e-9 && this.pivot.lengthSq() < 1e-18;
  }

  // ── the object origin ──
  setPivotWorld(p: THREE.Vector3) { this.root.updateMatrixWorld(true); this.pivot.copy(p).applyMatrix4(this.root.matrixWorld.clone().invert()); this.changed(); }
  movePivotWorld(d: THREE.Vector3) { this.setPivotWorld(this.worldPivot().add(d)); }

  // ── location (= where the object origin is) ──
  setLocationWorld(target: THREE.Vector3) { this.root.position.add(target.clone().sub(this.worldPivot())); this.changed(); }
  translateWorld(d: THREE.Vector3) { this.root.position.add(d); this.changed(); }
  clearLocation() { this.setLocationWorld(new THREE.Vector3()); }

  // ── rotation / scale about the object origin ──
  rotateAboutPivot(q: THREE.Quaternion) {
    const P = this.worldPivot();
    this.root.position.sub(P).applyQuaternion(q).add(P);
    this.root.quaternion.premultiply(q);
    this.changed();
  }
  setRotationDeg(x: number, y: number, z: number) {
    const r = (v: number) => (v * Math.PI) / 180;
    const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(r(x), r(y), r(z), "XYZ"));
    this.rotateAboutPivot(target.multiply(this.root.quaternion.clone().invert()));
  }
  clearRotation() { this.rotateAboutPivot(this.root.quaternion.clone().invert()); }
  scaleAboutPivot(k: number) {
    if (!(k > 0) || !isFinite(k)) return;
    const P = this.worldPivot();
    this.root.position.sub(P).multiplyScalar(k).add(P);
    this.root.scale.multiplyScalar(k);
    this.changed();
  }
  setScale(k: number) { if (k > 0 && isFinite(k)) this.scaleAboutPivot(k / this.root.scale.x); }
  clearScale() { this.setScale(1); }

  /** Everything back to the file as loaded (origin at the file's origin). */
  reset() { this.root.position.set(0, 0, 0); this.root.quaternion.identity(); this.root.scale.setScalar(1); this.pivot.set(0, 0, 0); this.changed(); }

  toJSON(): FrameJSON {
    const e = new THREE.Euler().setFromQuaternion(this.root.quaternion, "XYZ");
    const d = (r: number) => (r * 180) / Math.PI;
    return { root: [this.root.position.x, this.root.position.y, this.root.position.z], rotDeg: [d(e.x), d(e.y), d(e.z)], scale: this.root.scale.x, pivot: [this.pivot.x, this.pivot.y, this.pivot.z] };
  }
  fromJSON(j: any): boolean {
    if (!j || !Array.isArray(j.rotDeg) || typeof j.scale !== "number") return false;
    const root = Array.isArray(j.root) ? j.root : Array.isArray(j.pos) ? j.pos : [0, 0, 0]; // old sidecars stored `pos`
    const r = (x: number) => (x * Math.PI) / 180;
    this.root.position.set(+root[0] || 0, +root[1] || 0, +root[2] || 0);
    this.root.quaternion.setFromEuler(new THREE.Euler(r(+j.rotDeg[0] || 0), r(+j.rotDeg[1] || 0), r(+j.rotDeg[2] || 0), "XYZ"));
    this.root.scale.setScalar(+j.scale > 0 ? +j.scale : 1);
    const p = Array.isArray(j.pivot) ? j.pivot : [0, 0, 0];
    this.pivot.set(+p[0] || 0, +p[1] || 0, +p[2] || 0);
    this.changed();
    return true;
  }
}
