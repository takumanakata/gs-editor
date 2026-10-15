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
  private grid!: THREE.GridHelper;      // floor (XZ)
  private gridFront!: THREE.GridHelper; // vertical, facing the front/back views (XY plane)
  private gridSide!: THREE.GridHelper;  // vertical, facing the right/left views (YZ plane)
  private axisUp!: THREE.Line;          // Blender Z (three.js Y), shown in the side views
  private axes!: THREE.Group;
  private originDot!: THREE.Mesh;
  /** The scan's own origin (Blender's orange object-origin dot); the host positions it. */
  readonly objOrigin: THREE.Mesh;

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
    // Splats write no depth, so a grid always shows THROUGH the scan. Keep the floor grid
    // faint in perspective and bring it up only in the top view; in the front / side
    // views a vertical grid gives the heights (Blender does the same in ortho views).
    const mkGrid = () => { const g = new THREE.GridHelper(80, 80, 0x7a817a, 0x3d433d); const m = g.material as THREE.Material; m.transparent = true; m.opacity = 0.18; m.depthWrite = false; g.layers.set(1); this.scene.add(g); return g; };
    this.grid = mkGrid();
    this.gridFront = mkGrid(); this.gridFront.rotation.x = Math.PI / 2; this.gridFront.visible = false;
    this.gridSide = mkGrid(); this.gridSide.rotation.z = Math.PI / 2; this.gridSide.visible = false;
    this.axes = new THREE.Group();
    // Blender's axis colours: X red, Y(Blender) green along three.js −Z, Z(Blender) blue along three.js +Y
    const axisLine = (dir: THREE.Vector3, color: number, len: number) => {
      const g = new THREE.BufferGeometry().setFromPoints([dir.clone().multiplyScalar(-len), dir.clone().multiplyScalar(len)]);
      const m = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.75 });
      const l = new THREE.Line(g, m); l.renderOrder = 998; return l;
    };
    this.axes.add(axisLine(new THREE.Vector3(1, 0, 0), 0xe0423c, 40), axisLine(new THREE.Vector3(0, 0, 1), 0x7bb33a, 40));
    this.axisUp = axisLine(new THREE.Vector3(0, 1, 0), 0x3f7fd6, 40); this.axisUp.visible = false; this.axes.add(this.axisUp);
    this.originDot = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xdcdcd4, depthTest: false }));
    this.originDot.renderOrder = 999;
    this.axes.add(this.originDot);
    this.axes.traverse((o) => o.layers.set(1));
    this.scene.add(this.axes);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.0));
    this.objOrigin = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), new THREE.MeshBasicMaterial({ color: 0xffa028, depthTest: false }));
    this.objOrigin.renderOrder = 1000; this.objOrigin.layers.set(1); this.objOrigin.visible = false;
    this.scene.add(this.objOrigin);

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

  /** Which guides to show for the view: perspective (faint floor), top (strong floor), front / side (vertical grid + up axis). */
  setViewMode(mode: "persp" | "top" | "front" | "side") {
    const op = (g: THREE.GridHelper, v: number) => { (g.material as THREE.Material).opacity = v; };
    op(this.grid, mode === "top" ? 0.55 : 0.18);
    this.grid.visible = mode !== "front" && mode !== "side";
    this.gridFront.visible = mode === "front"; op(this.gridFront, 0.45);
    this.gridSide.visible = mode === "side"; op(this.gridSide, 0.45);
    this.axisUp.visible = mode === "front" || mode === "side";
  }

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
    const s = Math.max(0.003 * d, 0.003);
    this.originDot.scale.setScalar(s);
    this.objOrigin.scale.setScalar(s * 1.6);
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
