import * as THREE from "three";

/**
 * Renderer + scene + the two cameras (perspective, and an orthographic twin for the
 * axis views — the twin copies the perspective camera's pose every frame, so every
 * control keeps driving ONE camera). Also the fixed references the user aligns the
 * scan against: the 1 m floor grid and the orange origin dot with its axes.
 */
export class Scene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly ortho: THREE.OrthographicCamera;
  private _ortho = false;
  private updaters: ((dt: number) => void)[] = [];
  private resizers: (() => void)[] = [];
  private clock = new THREE.Clock();

  private container: HTMLElement;
  private baseRatio = 1;
  private moving = false;
  private grid!: THREE.GridHelper;
  private axes!: THREE.Group;
  private originDot!: THREE.Mesh;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Splat rendering is fill-rate bound: cap the pixel ratio and drop it while moving.
    this.baseRatio = Math.min(window.devicePixelRatio, 1.25);
    this.renderer.setPixelRatio(this.baseRatio);
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111418);
    // floor grid (1 m cells at y=0) and the world origin: the references that do not move
    this.grid = new THREE.GridHelper(80, 80, 0x7a817a, 0x3d433d);
    (this.grid.material as THREE.Material).transparent = true; (this.grid.material as THREE.Material).opacity = 0.55;
    this.grid.layers.set(1);
    this.scene.add(this.grid);
    this.axes = new THREE.Group();
    // Blender's axis colours: X red, Y(Blender) green along three.js −Z, Z(Blender) blue along three.js +Y
    const axisLine = (dir: THREE.Vector3, color: number, len: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([dir.clone().multiplyScalar(-len), dir.clone().multiplyScalar(len)]);
      const m = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.75 });
      const l = new THREE.Line(g, m); l.renderOrder = 998; return l;
    };
    this.axes.add(axisLine(new THREE.Vector3(1, 0, 0), 0xe0423c, 40), axisLine(new THREE.Vector3(0, 0, 1), 0x7bb33a, 40));
    this.originDot = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffa028, depthTest: false }));
    this.originDot.renderOrder = 999;
    this.axes.add(this.originDot);
    this.axes.traverse((o) => o.layers.set(1));
    this.scene.add(this.axes);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.0));

    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 5000);
    this.camera.position.set(8, 6, 8);
    this.camera.lookAt(0, 1, 0);
    this.camera.layers.enable(1); // the view also sees guide-layer objects (grid, origin)
    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
    this.ortho.layers.enable(1);

    new ResizeObserver(() => this.handleResize()).observe(container);
  }

  add(obj: THREE.Object3D) { this.scene.add(obj); }
  setGuides(grid: boolean, axes: boolean) { this.grid.visible = grid; this.axes.visible = axes; }

  /** The camera to render / pick with right now. */
  get activeCamera(): THREE.Camera { return this._ortho ? this.ortho : this.camera; }
  get isOrtho() { return this._ortho; }
  setOrtho(on: boolean) { this._ortho = on; }

  /** Keep the orthographic twin on the perspective camera's pose; its frustum spans the same view at `target`'s depth. */
  syncOrtho(target: THREE.Vector3) {
    const o = this.ortho, c = this.camera;
    o.position.copy(c.position); o.quaternion.copy(c.quaternion);
    const d = Math.max(c.position.distanceTo(target), 0.01);
    const half = d * Math.tan(THREE.MathUtils.degToRad(c.fov) / 2);
    o.top = half; o.bottom = -half; o.left = -half * c.aspect; o.right = half * c.aspect;
    o.near = -5000; o.far = 5000;
    o.updateProjectionMatrix();
    // the origin dot keeps a constant screen size
    const s = Math.max(0.004 * d, 0.004);
    this.originDot.scale.setScalar(s);
  }

  /** Render at 0.6× while the camera is being moved; restore when it settles. */
  setMoving(m: boolean) {
    if (m === this.moving) return;
    this.moving = m;
    this.renderer.setPixelRatio(m ? Math.max(0.6, this.baseRatio * 0.6) : this.baseRatio);
    this.handleResize();
  }
  setBackground(hex: number) { (this.scene.background as THREE.Color).set(hex); }
  onUpdate(fn: (dt: number) => void) { this.updaters.push(fn); }
  onResize(fn: () => void) { this.resizers.push(fn); }

  private handleResize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (w === 0 || h === 0) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    for (const r of this.resizers) r();
  }

  start() {
    const loop = () => {
      const dt = this.clock.getDelta();
      for (const u of this.updaters) u(dt);
      this.renderer.render(this.scene, this.activeCamera);
      requestAnimationFrame(loop);
    };
    loop();
  }
}
