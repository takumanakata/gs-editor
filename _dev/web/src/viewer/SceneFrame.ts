import * as THREE from "three";

/** What the panel shows (Blender's Location / Rotation / Scale), RELATIVE to the applied baseline. */
export interface FrameState { pos: [number, number, number]; rotDeg: [number, number, number]; scale: number; }
/** The full transform for history / sidecar: the root's placement, the object origin and the applied baseline. */
export interface FrameJSON {
  root: [number, number, number]; rotDeg: [number, number, number]; scale: number; pivot: [number, number, number];
  base?: { q: [number, number, number, number]; p: [number, number, number]; s: number };
}

/**
 * One transform for a scan, modelled like a Blender object: the scan has an ORIGIN of
 * its own (`pivot`, a point in the scan), rotation and scale happen about that origin,
 * and "Location" is where that origin sits. The world origin (the fixed marker + grid)
 * is what you align the object origin to.
 *
 * "Apply Transform" (Ctrl+A) makes the current placement the baseline: the panel then
 * reads 0 / 0 / 1 and further edits are relative to it, while the real transform that
 * gets baked into the file is unchanged.
 */
export class SceneFrame {
  readonly root = new THREE.Group();
  /** The object origin, in root-local coordinates (moves with the scan). */
  readonly pivot = new THREE.Vector3();
  private base = { q: new THREE.Quaternion(), p: new THREE.Vector3(), s: 1 };
  private onChange?: () => void;

  constructor(scene: THREE.Scene) {
    this.root.name = "sceneFrame";
    scene.add(this.root);
  }

  setOnChange(fn: () => void) { this.onChange = fn; }
  private changed() { this.root.updateMatrixWorld(true); this.onChange?.(); }

  /** The object origin in world space. */
  worldPivot(): THREE.Vector3 { this.root.updateMatrixWorld(true); return this.pivot.clone().applyMatrix4(this.root.matrixWorld); }

  /** Relative to the applied baseline. */
  get state(): FrameState {
    const qRel = this.root.quaternion.clone().multiply(this.base.q.clone().invert());
    const e = new THREE.Euler().setFromQuaternion(qRel, "XYZ");
    const d = (r: number) => (r * 180) / Math.PI;
    const p = this.worldPivot().sub(this.base.p);
    return { pos: [p.x, p.y, p.z], rotDeg: [d(e.x), d(e.y), d(e.z)], scale: this.root.scale.x / this.base.s };
  }

  isIdentity(): boolean {
    return this.root.position.lengthSq() < 1e-18 && Math.abs(this.root.quaternion.w) > 1 - 1e-9 && Math.abs(this.root.scale.x - 1) < 1e-9
      && this.pivot.lengthSq() < 1e-18 && this.base.p.lengthSq() < 1e-18 && Math.abs(this.base.q.w) > 1 - 1e-9 && Math.abs(this.base.s - 1) < 1e-9;
  }

  // ── the object origin ──
  setPivotWorld(p: THREE.Vector3) { this.root.updateMatrixWorld(true); this.pivot.copy(p).applyMatrix4(this.root.matrixWorld.clone().invert()); this.changed(); }
  movePivotWorld(d: THREE.Vector3) { this.setPivotWorld(this.worldPivot().add(d)); }

  // ── location (relative to the baseline) ──
  setLocationWorld(rel: THREE.Vector3) { this.root.position.add(rel.clone().add(this.base.p).sub(this.worldPivot())); this.changed(); }
  translateWorld(d: THREE.Vector3) { this.root.position.add(d); this.changed(); }
  clearLocation() { this.setLocationWorld(new THREE.Vector3()); }

  // ── rotation / scale about the object origin (field values relative to the baseline) ──
  rotateAboutPivot(q: THREE.Quaternion) {
    const P = this.worldPivot();
    this.root.position.sub(P).applyQuaternion(q).add(P);
    this.root.quaternion.premultiply(q);
    this.changed();
  }
  setRotationDeg(x: number, y: number, z: number) {
    const r = (v: number) => (v * Math.PI) / 180;
    const target = new THREE.Quaternion().setFromEuler(new THREE.Euler(r(x), r(y), r(z), "XYZ")).multiply(this.base.q);
    this.rotateAboutPivot(target.multiply(this.root.quaternion.clone().invert()));
  }
  clearRotation() { this.setRotationDeg(0, 0, 0); }
  scaleAboutPivot(k: number) {
    if (!(k > 0) || !isFinite(k)) return;
    const P = this.worldPivot();
    this.root.position.sub(P).multiplyScalar(k).add(P);
    this.root.scale.multiplyScalar(k);
    this.changed();
  }
  setScale(rel: number) { if (rel > 0 && isFinite(rel)) this.scaleAboutPivot((rel * this.base.s) / this.root.scale.x); }
  clearScale() { this.setScale(1); }

  /** The current placement becomes the zero the panel measures from (the baked transform is unchanged). */
  applyTransform() { this.base = { q: this.root.quaternion.clone(), p: this.worldPivot(), s: this.root.scale.x }; this.changed(); }

  /** Everything back to the file as loaded. */
  reset() { this.root.position.set(0, 0, 0); this.root.quaternion.identity(); this.root.scale.setScalar(1); this.pivot.set(0, 0, 0); this.base = { q: new THREE.Quaternion(), p: new THREE.Vector3(), s: 1 }; this.changed(); }

  toJSON(): FrameJSON {
    const e = new THREE.Euler().setFromQuaternion(this.root.quaternion, "XYZ");
    const d = (r: number) => (r * 180) / Math.PI;
    const b = this.base;
    return { root: [this.root.position.x, this.root.position.y, this.root.position.z], rotDeg: [d(e.x), d(e.y), d(e.z)], scale: this.root.scale.x, pivot: [this.pivot.x, this.pivot.y, this.pivot.z],
      base: { q: [b.q.x, b.q.y, b.q.z, b.q.w], p: [b.p.x, b.p.y, b.p.z], s: b.s } };
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
    const b = j.base;
    this.base = b && Array.isArray(b.q) && Array.isArray(b.p)
      ? { q: new THREE.Quaternion(+b.q[0] || 0, +b.q[1] || 0, +b.q[2] || 0, +b.q[3] || 1).normalize(), p: new THREE.Vector3(+b.p[0] || 0, +b.p[1] || 0, +b.p[2] || 0), s: +b.s > 0 ? +b.s : 1 }
      : { q: new THREE.Quaternion(), p: new THREE.Vector3(), s: 1 };
    this.changed();
    return true;
  }
}
