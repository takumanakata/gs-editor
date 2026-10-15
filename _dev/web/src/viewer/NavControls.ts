import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export type NavMode = "orbit" | "fly";

const MOVE_KEYS = /^(Key[WASDQE])$/;

/**
 * SuperSplat-style navigation.
 *  - orbit (default): cursor visible. Left-drag orbits, right-drag pans, wheel
 *    dollies, double-click a surface to gently fly there.
 *  - fly: engaged automatically the moment you press WASD/QE (or click the drone
 *    icon). Pointer locks (cursor hides, crosshair shows), mouse looks, WASD/QE fly
 *    slowly & smoothly, wheel adjusts speed. Esc releases → back to orbit.
 * On load the camera gently sways around a framed start pose until first use.
 */
export class NavControls {
  private orbit: OrbitControls;
  private mode: NavMode = "orbit";
  private keys = new Set<string>();
  /**
   * When each key was last SEEN. A held key auto-repeats keydown, so a fresh timestamp
   * means it is genuinely still down. This is the cure for the runaway-movement bug:
   * a keyup can go missing (pointer-lock transitions, alt-tab, focus moving to a
   * field) and the camera would then fly forward forever.
   */
  private seen = new Map<string, number>();
  private static readonly KEY_TTL = 900; // ms — comfortably above OS repeat delay
  private euler = new THREE.Euler(0, 0, 0, "YXZ");
  private vel = new THREE.Vector3();
  private baseSpeed = 2;     // scene-scaled cruise speed (slow, like SuperSplat)
  private speedMul = 1;      // wheel-adjusted multiplier while locked
  private locked = false;
  private blocked = false;   // true while the transform gizmo is being dragged
  private interacted = false;
  private startPos = new THREE.Vector3(8, 6, 8);
  private startTarget = new THREE.Vector3(0, 1, 0);
  private sceneSize = 4;
  private swayAmp = 0.2;
  private swayT = 0;
  private onLock?: (locked: boolean) => void;
  private onModeCb?: (mode: NavMode) => void;
  private tween?: { fromP: THREE.Vector3; toP: THREE.Vector3; fromQ: THREE.Quaternion; toQ: THREE.Quaternion; toT: THREE.Vector3; t: number; dur: number };

  constructor(private camera: THREE.PerspectiveCamera, private dom: HTMLElement) {
    this.orbit = new OrbitControls(camera, dom);
    this.orbit.target.set(0, 1, 0);
    // Left-drag rotates the view, middle-drag pans, wheel dollies. The host disables orbit
    // while the cursor is over a gizmo handle, so LEFT still drives the gizmo.
    this.orbit.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: -1 as unknown as THREE.MOUSE };
    this.orbit.enableDamping = true;
    this.orbit.dampingFactor = 0.12;
    this.orbit.enabled = true;
    this.orbit.addEventListener("start", () => this.touch()); // any orbit input stops the intro sway
    this.orbit.update();

    const clearInput = () => { this.keys.clear(); this.seen.clear(); this.vel.set(0, 0, 0); };

    window.addEventListener("keydown", (e) => {
      if ((e.target as HTMLElement)?.tagName === "INPUT") return; // don't fly while typing in a field
      this.keys.add(e.code);
      this.seen.set(e.code, performance.now());
      if (MOVE_KEYS.test(e.code)) { this.touch(); if (this.mode !== "fly") this.engage(); } // WASD → auto drone mode
    });
    window.addEventListener("keyup", (e) => { this.keys.delete(e.code); this.seen.delete(e.code); });
    // focus can move away without a keyup ever arriving; treat that as all-keys-up
    window.addEventListener("focus", clearInput);
    document.addEventListener("pointerlockerror", clearInput);
    // a key can get "stuck" if its keyup is lost during a focus change (e.g. the
    // pointer-lock transition, or alt-tab) — flush all input on those events.
    window.addEventListener("blur", clearInput);
    document.addEventListener("visibilitychange", () => { if (document.hidden) clearInput(); });

    // pointer-lock look (fly): movement events arrive on the document while locked
    document.addEventListener("pointerlockchange", () => {
      this.locked = document.pointerLockElement === this.dom;
      clearInput(); // never carry a held key across the lock transition (prevents runaway drift)
      if (!this.locked && this.mode === "fly") this.setMode("orbit"); // Esc → back to orbit
      this.onLock?.(this.locked);
    });
    document.addEventListener("mousemove", (e) => {
      if (!this.locked || this.blocked) return;
      this.euler.setFromQuaternion(this.camera.quaternion);
      this.euler.y -= e.movementX * 0.0022;
      this.euler.x -= e.movementY * 0.0022;
      this.euler.x = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, this.euler.x));
      this.camera.quaternion.setFromEuler(this.euler);
      this.touch();
    });
    // wheel adjusts fly speed while locked (orbit handles its own wheel-dolly)
    window.addEventListener("wheel", (e) => {
      if (this.locked) this.speedMul = Math.max(0.1, Math.min(12, this.speedMul * (e.deltaY < 0 ? 1.12 : 0.89)));
      else this.touch();
    }, { passive: true });
  }

  private touch() { this.interacted = true; }

  /** Is this key really still held? (see `seen`) */
  private held(code: string): boolean {
    if (!this.keys.has(code)) return false;
    const t = this.seen.get(code);
    if (t === undefined) return false;
    if (performance.now() - t > NavControls.KEY_TTL) { // stale: the keyup was lost
      this.keys.delete(code);
      this.seen.delete(code);
      return false;
    }
    return true;
  }

  /** Called by the host when the transform gizmo starts/stops dragging. */
  setGizmoDragging(b: boolean) { this.blocked = b; this.orbit.enabled = b ? false : this.mode === "orbit"; }
  setOrbitEnabled(b: boolean) { this.orbit.enabled = b && this.mode === "orbit"; }
  /** Free (or restore) the left mouse button so a host box-select can use it without orbiting. */
  setBoxSelecting(b: boolean) { this.orbit.mouseButtons.LEFT = (b ? -1 : THREE.MOUSE.ROTATE) as THREE.MOUSE; }

  isLocked() { return this.locked; }
  getMode() { return this.mode; }
  /**
   * Re-pivot the orbit onto the surface under the cursor WITHOUT a view jump. OrbitControls
   * always looks at its target, so we can't aim at an off-centre point without snapping the
   * view there. Instead we keep the current look direction and place the pivot straight ahead
   * at the hit's depth (Blender "auto depth"): no orientation change, but you orbit around the
   * thing you clicked because it sits on the new orbit radius.
   */
  setPivot(p: THREE.Vector3) {
    const dist = this.camera.position.distanceTo(p);
    if (dist < 1e-4) return;
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.orbit.target.copy(this.camera.position).addScaledVector(fwd, dist);
    this.touch();
  }
  setOnLock(fn: (locked: boolean) => void) { this.onLock = fn; }
  setOnMode(fn: (mode: NavMode) => void) { this.onModeCb = fn; }

  /** Enter fly mode and grab the pointer for mouse-look (from a click/keypress gesture). */
  engage() { this.setMode("fly"); if (!this.locked) { try { this.dom.requestPointerLock(); } catch { /* ignore */ } } }
  /** Re-grab the pointer if already flying but unlocked (e.g. after a stray Esc). */
  relock() { if (this.mode === "fly" && !this.locked) { try { this.dom.requestPointerLock(); } catch { /* ignore */ } } }

  setMode(mode: NavMode) {
    if (this.mode === mode) { this.onModeCb?.(mode); return; }
    this.mode = mode;
    this.orbit.enabled = mode === "orbit";
    if (mode === "orbit") {
      if (this.locked) document.exitPointerLock();
      this.syncOrbitToCamera(); // keep the camera exactly where flying left it (no snap to the old target)
    }
    this.touch();
    this.onModeCb?.(mode);
  }

  /** Re-anchor the orbit target onto the current view direction so switching to
   *  orbit doesn't yank the camera back toward a stale pivot. */
  private syncOrbitToCamera() {
    const dist = Math.max(this.sceneSize * 0.25, 0.5);
    const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.orbit.target.copy(this.camera.position).addScaledVector(fwd, dist);
    this.orbit.update();
  }

  /** Place the camera at a framed start pose (looking at target); restarts the intro sway. */
  setStart(pos: THREE.Vector3, target: THREE.Vector3, size = 4) {
    this.startPos.copy(pos); this.startTarget.copy(target);
    this.camera.position.copy(pos); this.camera.lookAt(target);
    this.orbit.target.copy(target); this.orbit.update();
    this.sceneSize = size;
    this.baseSpeed = Math.min(3, Math.max(0.4, size * 0.018)); // slow cruise, like SuperSplat
    this.speedMul = 1;
    this.swayAmp = size * 0.008;
    this.vel.set(0, 0, 0);
    this.interacted = false; this.swayT = 0;
  }

  /** Smoothly fly to a point: gentle dolly-in + slerp orientation (no direction flips). */
  focusOn(point: THREE.Vector3) {
    this.touch();
    let dir = new THREE.Vector3().subVectors(this.camera.position, point);
    let dist = dir.length();
    if (dist < 1e-3) { dir = new THREE.Vector3(0, 0, 1).applyQuaternion(this.camera.quaternion); dist = 1; }
    dir.normalize();
    const newDist = Math.max(this.sceneSize * 0.05, dist * 0.8);
    const toP = point.clone().add(dir.multiplyScalar(newDist));
    const m = new THREE.Matrix4().lookAt(toP, point, this.camera.up);
    const toQ = new THREE.Quaternion().setFromRotationMatrix(m);
    const fromQ = this.camera.quaternion.clone();
    if (fromQ.dot(toQ) < 0) toQ.set(-toQ.x, -toQ.y, -toQ.z, -toQ.w); // shortest slerp path
    this.tween = { fromP: this.camera.position.clone(), toP, fromQ, toQ, toT: point.clone(), t: 0, dur: 0.6 };
    this.orbit.target.copy(point); // set now so orbit doesn't pop when the tween ends
  }

  recenter() { this.setStart(this.startPos, this.startTarget, this.sceneSize); this.touch(); }

  /** Current orbit pivot (what the view is looking at). */
  getTarget(): THREE.Vector3 { return this.orbit.target.clone(); }

  /**
   * Shift the camera, its pivot and the remembered start pose by `d`. Used when the scene
   * itself is moved by `d` (origin tools): what is on screen stays exactly where it is and
   * only the grid / axes appear to jump.
   */
  shiftView(d: THREE.Vector3) {
    this.camera.position.add(d); this.orbit.target.add(d);
    this.startPos.add(d); this.startTarget.add(d);
    this.tween = undefined;
    if (this.mode === "orbit") this.orbit.update();
  }

  /** Scale the view about `pivot` by `k` (the scene was scaled the same way, so nothing moves on screen). */
  scaleView(k: number, pivot: THREE.Vector3) {
    for (const p of [this.camera.position, this.orbit.target, this.startPos, this.startTarget]) p.sub(pivot).multiplyScalar(k).add(pivot);
    this.sceneSize *= k; this.baseSpeed = Math.min(3, Math.max(0.4, this.sceneSize * 0.018)); this.swayAmp *= k;
    this.tween = undefined;
    if (this.mode === "orbit") this.orbit.update();
  }

  update(dt: number) {
    if (this.tween) {
      this.tween.t += dt;
      const a = Math.min(1, this.tween.t / this.tween.dur);
      const e = a * a * a * (a * (a * 6 - 15) + 10); // smootherstep
      this.camera.position.lerpVectors(this.tween.fromP, this.tween.toP, e);
      this.camera.quaternion.copy(this.tween.fromQ).slerp(this.tween.toQ, e);
      if (a >= 1) { this.orbit.target.copy(this.tween.toT); if (this.mode === "orbit") this.orbit.update(); this.tween = undefined; }
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
      return;
    }
    if (this.mode === "orbit") { this.orbit.update(); return; }

    // fly: smoothed WASD/QE with accel/decel
    const speed = this.baseSpeed * this.speedMul * (this.held("ShiftLeft") || this.held("ShiftRight") ? 3 : 1);
    const want = new THREE.Vector3();
    if (this.held("KeyW")) want.z -= 1;
    if (this.held("KeyS")) want.z += 1;
    if (this.held("KeyA")) want.x -= 1;
    if (this.held("KeyD")) want.x += 1;
    if (this.held("KeyE")) want.y += 1;
    if (this.held("KeyQ")) want.y -= 1;
    if (want.lengthSq() > 0) want.normalize().multiplyScalar(speed).applyQuaternion(this.camera.quaternion);
    if (want.lengthSq() === 0) {
      // Nothing held: brake LINEARLY so the camera reaches a genuine standstill. An
      // exponential ease never actually reaches zero, which left the view creeping
      // forward after a key was released (or its keyup was lost).
      const decel = this.baseSpeed * 6 * dt;
      const len = this.vel.length();
      if (len <= decel) this.vel.set(0, 0, 0);
      else this.vel.multiplyScalar((len - decel) / len);
    } else {
      this.vel.lerp(want, 1 - Math.exp(-dt * 4)); // gentle smoothing toward desired velocity
    }
    if (this.vel.lengthSq() > 0) this.camera.position.addScaledVector(this.vel, dt);
  }
}
