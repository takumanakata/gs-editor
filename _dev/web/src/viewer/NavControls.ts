import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type ViewName = "front" | "back" | "right" | "left" | "top" | "bottom";

/**
 * Blender-style navigation, nothing else:
 *   middle-drag        orbit (around the selection, or the surface under the cursor)
 *   Shift+middle-drag  pan
 *   Ctrl+middle-drag   dolly
 *   wheel              dolly
 *   numpad 1 / 3 / 7   front / right / top  (Ctrl = the opposite side), 5 = ortho toggle
 *   Home               frame the scene
 * The left button is never used here: it belongs to the tools (selection, gizmo).
 * On load the camera gently sways around the start pose until first use.
 */
export class NavControls {
  private orbit: OrbitControls;
  private blocked = false;   // true while the transform gizmo is being dragged
  private interacted = false;
  private startPos = new THREE.Vector3(8, 6, 8);
  private startTarget = new THREE.Vector3(0, 1, 0);
  private sceneSize = 4;
  private swayAmp = 0.2;
  private swayT = 0;
  private tween?: { fromP: THREE.Vector3; toP: THREE.Vector3; fromQ: THREE.Quaternion; toQ: THREE.Quaternion; toT: THREE.Vector3; t: number; dur: number };
  /** Who decides the orbit pivot when a middle-drag starts (selection centre, surface pick…). */
  pivotProvider: ((clientX: number, clientY: number) => THREE.Vector3 | null) | null = null;
  /** Called when the user starts rotating by hand (auto-perspective leaves an axis view). */
  onRotateStart: (() => void) | null = null;
  /** Called on every orbit change (the view cube follows). */
  onChange: (() => void) | null = null;

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.target.set(0, 1, 0);
    const NONE = -1 as unknown as THREE.MOUSE;
    this.orbit.mouseButtons = { LEFT: NONE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: NONE };
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.zoomSpeed = 0.8;
    this.orbit.rotateSpeed = 0.9;
    this.orbit.panSpeed = 0.9;
    this.orbit.enabled = true;
    this.orbit.addEventListener("start", () => this.touch());
    this.orbit.addEventListener("change", () => this.onChange?.());
    this.orbit.update();

    // Blender's modifier scheme on the MIDDLE button. OrbitControls reads
    // mouseButtons.MIDDLE at pointerdown, so set it just before it looks.
    dom.addEventListener("pointerdown", (e) => {
      if (e.button !== 1) return;
      // OrbitControls itself turns Shift+ROTATE into a pan (and Shift+PAN back into a
      // rotate!), so the only remap needed is Ctrl → dolly
      this.orbit.mouseButtons.MIDDLE = e.ctrlKey ? THREE.MOUSE.DOLLY : THREE.MOUSE.ROTATE;
      if (!e.shiftKey && !e.ctrlKey) {
        const p = this.pivotProvider?.(e.clientX, e.clientY);
        if (p) this.setPivot(p);
        this.onRotateStart?.();
      }
    }, { capture: true });
    dom.addEventListener("contextmenu", (e) => e.preventDefault());
    window.addEventListener("wheel", () => this.touch(), { passive: true });
  }

  private touch() { this.interacted = true; }

  /** Called by the host when the transform gizmo starts/stops dragging. */
  setGizmoDragging(b: boolean) { this.blocked = b; this.orbit.enabled = !b; }
  setOrbitEnabled(b: boolean) { this.orbit.enabled = b && !this.blocked; }
  isBlocked() { return this.blocked; }

  /**
   * Re-pivot the orbit onto `p` WITHOUT a view jump: keep the look direction and put
   * the pivot straight ahead at p's depth (Blender "auto depth").
   */
  setPivot(p: THREE.Vector3) {
    const dist = this.camera.position.distanceTo(p);
    if (dist < 1e-4) return;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.orbit.target.copy(this.camera.position).addScaledVector(fwd, dist);
    this.touch();
  }

  /** Place the camera at a framed start pose (looking at target); restarts the intro sway. */
  setStart(pos: THREE.Vector3, target: THREE.Vector3, size = 4) {
    this.startPos.copy(pos); this.startTarget.copy(target);
    this.camera.position.copy(pos); this.camera.lookAt(target);
    this.orbit.target.copy(target); this.orbit.update();
    this.sceneSize = size;
    this.swayAmp = size * 0.008;
    this.interacted = false; this.swayT = 0;
    this.tween = undefined;
  }

  /** Smoothly move to look at `target` from `pos` (axis views, framing). */
  flyTo(pos: THREE.Vector3, target: THREE.Vector3, dur = 0.35) {
    this.touch();
    const m = new THREE.Matrix4().lookAt(pos, target, this.camera.up);
    const toQ = new THREE.Quaternion().setFromRotationMatrix(m);
    const fromQ = this.camera.quaternion.clone();
    if (fromQ.dot(toQ) < 0) toQ.set(-toQ.x, -toQ.y, -toQ.z, -toQ.w);
    this.tween = { fromP: this.camera.position.clone(), toP: pos.clone(), fromQ, toQ, toT: target.clone(), t: 0, dur };
    this.orbit.target.copy(target);
  }

  /** Smoothly fly to a point: gentle dolly-in + slerp orientation. */
  focusOn(point: THREE.Vector3) {
    let dir = new THREE.Vector3().subVectors(this.camera.position, point);
    let dist = dir.length();
    if (dist < 1e-3) { dir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion); dist = 1; }
    dir.normalize();
    const newDist = Math.max(this.sceneSize * 0.05, dist * 0.8);
    this.flyTo(point.clone().add(dir.multiplyScalar(newDist)), point, 0.6);
  }

  /** Axis view: camera on the view's axis at the current distance, looking at the pivot. */
  viewFrom(view: ViewName) {
    const t = this.orbit.target.clone();
    const d = Math.max(this.camera.position.distanceTo(t), this.sceneSize * 0.2, 0.5);
    const dir = { front: [0, 0, 1], back: [0, 0, -1], right: [1, 0, 0], left: [-1, 0, 0], top: [0, 1, 0], bottom: [0, -1, 0] }[view];
    const pos = t.clone().add(new THREE.Vector3(dir[0], dir[1], dir[2]).multiplyScalar(d));
    // looking straight down/up, `up` must not be parallel to the view: lookAt uses camera.up (Y)
    if (view === "top" || view === "bottom") pos.z += d * 1e-4;
    this.flyTo(pos, t);
  }

  /** Frame a bounding box: look at its centre from the current direction, far enough to fit. */
  frameBox(box: THREE.Box3) {
    const c = box.getCenter(new THREE.Vector3());
    const r = box.getSize(new THREE.Vector3()).length() * 0.5 || 1;
    const dir = new THREE.Vector3().subVectors(this.camera.position, this.orbit.target).normalize();
    if (dir.lengthSq() < 1e-6) dir.set(0.5, 0.4, 1).normalize();
    const d = r / Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2) * 1.1;
    this.flyTo(c.clone().addScaledVector(dir, d), c);
  }

  recenter() { this.setStart(this.startPos, this.startTarget, this.sceneSize); this.touch(); }
  getTarget(): THREE.Vector3 { return this.orbit.target.clone(); }
  getSceneSize() { return this.sceneSize; }

  /** Shift the camera, its pivot and the start pose by `d` (the scene moved by `d`: nothing moves on screen). */
  shiftView(d: THREE.Vector3) {
    this.camera.position.add(d); this.orbit.target.add(d);
    this.startPos.add(d); this.startTarget.add(d);
    this.tween = undefined;
    this.orbit.update();
  }

  /** Scale the view about `pivot` by `k` (the scene was scaled the same way). */
  scaleView(k: number, pivot: THREE.Vector3) {
    for (const p of [this.camera.position, this.orbit.target, this.startPos, this.startTarget]) p.sub(pivot).multiplyScalar(k).add(pivot);
    this.sceneSize *= k; this.swayAmp *= k;
    this.tween = undefined;
    this.orbit.update();
  }

  /** Drive an orbit rotation from outside (the view cube is dragged): synthetic middle-drag. */
  syntheticDrag(phase: "down" | "move" | "up", x: number, y: number) {
    const init: PointerEventInit = { bubbles: true, cancelable: true, pointerId: 999, pointerType: "mouse", isPrimary: true, clientX: x, clientY: y, button: phase === "move" ? -1 : 1, buttons: phase === "up" ? 0 : 4 };
    const type = phase === "down" ? "pointerdown" : phase === "move" ? "pointermove" : "pointerup";
    if (phase === "down") { this.orbit.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE; this.onRotateStart?.(); }
    // a synthetic drag from the view cube must not be read as "Shift held" — the init has no modifiers
    this.dom.dispatchEvent(new PointerEvent(type, init));
  }

  update(dt: number) {
    if (this.tween) {
      this.tween.t += dt;
      const a = Math.min(1, this.tween.t / this.tween.dur);
      const e = a * a * a * (a * (a * 6 - 15) + 10); // smootherstep
      this.camera.position.lerpVectors(this.tween.fromP, this.tween.toP, e);
      this.camera.quaternion.copy(this.tween.fromQ).slerp(this.tween.toQ, e);
      if (a >= 1) { this.orbit.target.copy(this.tween.toT); this.orbit.update(); this.tween = undefined; }
      this.onChange?.();
      return;
    }
    if (!this.interacted) { // gentle intro sway around the start pose
      this.swayT += dt;
      this.camera.position.set(
        this.startPos.x + Math.sin(this.swayT * 0.5) * this.swayAmp,
        this.startPos.y + Math.sin(this.swayT * 0.37) * this.swayAmp * 0.6,
        this.startPos.z + Math.cos(this.swayT * 0.45) * this.swayAmp,
      );
      this.camera.lookAt(this.startTarget);
      this.onChange?.();
      return;
    }
    this.orbit.update();
  }
}
