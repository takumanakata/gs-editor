import * as THREE from "three";
import type { ViewName } from "./NavControls";

/**
 * The navigation cube (top-right of the viewport), as in most CG packages: it turns
 * with the camera; click a face to snap to that view; drag it to orbit. Pure CSS 3D —
 * no second WebGL context.
 *
 * Faces are labelled in Blender's terms, which the panel also uses: Blender Y is
 * three.js −Z, Blender Z is three.js Y. So the face whose outward normal is +Z(three)
 * is Blender's FRONT (−Y), +Y(three) is TOP.
 */
export class ViewCube {
  readonly el: HTMLElement;
  private cube: HTMLElement;
  private m = new THREE.Matrix4();

  constructor(host: HTMLElement, private onView: (v: ViewName) => void, private onDrag: (phase: "down" | "move" | "up", x: number, y: number) => void) {
    const el = document.createElement("div");
    el.id = "viewcube";
    el.innerHTML = `<div class="vc-scene"><div class="vc-cube">
      <div class="vc-face vc-front" data-v="front">前<small>Front</small></div>
      <div class="vc-face vc-back" data-v="back">後<small>Back</small></div>
      <div class="vc-face vc-right" data-v="right">右<small>Right</small></div>
      <div class="vc-face vc-left" data-v="left">左<small>Left</small></div>
      <div class="vc-face vc-top" data-v="top">上<small>Top</small></div>
      <div class="vc-face vc-bottom" data-v="bottom">下<small>Bottom</small></div>
    </div></div>`;
    host.appendChild(el);
    this.el = el;
    this.cube = el.querySelector(".vc-cube") as HTMLElement;

    // click = snap to the face; a drag (> 4 px) orbits the main view instead
    let down: { x: number; y: number; dragging: boolean } | null = null;
    el.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      down = { x: e.clientX, y: e.clientY, dragging: false };
      el.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => {
      if (!down) return;
      if (!down.dragging && Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) { down.dragging = true; onDrag("down", down.x, down.y); }
      if (down.dragging) onDrag("move", e.clientX, e.clientY);
    });
    el.addEventListener("pointerup", (e) => {
      if (!down) return;
      if (down.dragging) onDrag("up", e.clientX, e.clientY);
      else { const f = (e.target as HTMLElement).closest(".vc-face") as HTMLElement | null; if (f) onView(f.dataset.v as ViewName); }
      down = null;
    });
  }

  /** Turn the cube like the world seen from `camera` (world→view rotation). */
  update(camera: THREE.Camera) {
    const q = camera.quaternion.clone().invert();
    this.m.makeRotationFromQuaternion(q);
    const e = this.m.elements;
    // CSS matrix3d is column-major like three.js; flip the Y row for the screen's Y-down
    this.cube.style.transform = `matrix3d(${e[0]},${-e[1]},${e[2]},0, ${e[4]},${-e[5]},${e[6]},0, ${e[8]},${-e[9]},${e[10]},0, 0,0,0,1)`;
  }
}
