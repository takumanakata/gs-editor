import * as THREE from "three";

export class Scene {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  private updaters: ((dt: number) => void)[] = [];
  private resizers: (() => void)[] = [];
  private clock = new THREE.Clock();
  private renderFn: () => void = () => this.renderer.render(this.scene, this.camera);

  private container: HTMLElement;
  private baseRatio = 1;
  private moving = false;
  private grid!: THREE.GridHelper;
  private axes!: THREE.Group;

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    // Splat rendering is fill-rate bound, so device pixels are the single biggest
    // cost. Cap the ratio well below the display's, and drop further while the user
    // is actually moving the camera (see setMoving). Same numbers as GSレイアウター.
    this.baseRatio = Math.min(window.devicePixelRatio, 1.25);
    this.renderer.setPixelRatio(this.baseRatio);
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    container.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x111418);
    // ground grid (1 m cells at y=0) + axis gizmo at the world origin: the references the
    // user levels and centres the scene against. Guide layer 1 = hidden from the AI capture.
    this.grid = new THREE.GridHelper(80, 80, 0x7a817a, 0x3d433d);
    (this.grid.material as THREE.Material).transparent = true; (this.grid.material as THREE.Material).opacity = 0.55;
    this.grid.layers.set(1);
    this.scene.add(this.grid);
    this.axes = new THREE.Group();
    const ax = new THREE.AxesHelper(1.5); (ax.material as THREE.Material).depthTest = false; ax.renderOrder = 998;
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.035, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false }));
    dot.renderOrder = 998;
    this.axes.add(ax, dot);
    this.axes.traverse((o) => o.layers.set(1));
    this.scene.add(this.axes);
    this.scene.add(new THREE.AmbientLight(0xffffff, 1.0));

    this.camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 5000);
    this.camera.position.set(8, 6, 8);
    this.camera.lookAt(0, 1, 0);
    this.camera.layers.enable(1); // the view also sees guide-layer objects (grid, gizmo)

    new ResizeObserver(() => this.handleResize()).observe(container);
  }

  add(obj: THREE.Object3D) { this.scene.add(obj); }
  setGuides(grid: boolean, axes: boolean) { this.grid.visible = grid; this.axes.visible = axes; }

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
  setRenderFn(fn: () => void) { this.renderFn = fn; }

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
      this.renderFn();
      requestAnimationFrame(loop);
    };
    loop();
  }
}
