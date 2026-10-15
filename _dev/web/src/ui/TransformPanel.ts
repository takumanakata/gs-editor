import type { FrameState } from "../viewer/SceneFrame";
import { NumField } from "./NumField";
import { fromBlender, toBlender, type BlenderState } from "./blenderAxes";

export interface TransformPanelCallbacks {
  /** The whole state in three.js terms (already converted from the Blender numbers shown). commit=false while dragging / typing. */
  onState: (s: FrameState, commit: boolean) => void;
  onClear: (what: "location" | "rotation" | "scale") => void;
  onReset: () => void;
}

/**
 * Blender's Transform panel: Location / Rotation / Scale as stacked X / Y / Z
 * drag-or-type fields, in Blender's Z-up numbers. Location is where the object
 * origin sits; rotation and scale are about that origin.
 */
export class TransformPanel {
  readonly el: HTMLElement;
  private pos: NumField[] = [];
  private rot: NumField[] = [];
  private scale!: NumField;
  private cur: BlenderState = { pos: [0, 0, 0], rotDeg: [0, 0, 0], scale: 1 };

  constructor(host: HTMLElement, cb: TransformPanelCallbacks) {
    const el = document.createElement("div");
    el.className = "tp";
    el.innerHTML = `
      <div class="tp-grp"><div class="tp-lbl">Location <span class="dim">m</span><button class="tp-clear" data-clear="location" title="Clear location: put the object origin on the world origin (Alt+G)">Alt+G</button></div><div class="tp-fields" id="tp-pos"></div></div>
      <div class="tp-grp"><div class="tp-lbl">Rotation <span class="dim">°, about the object origin</span><button class="tp-clear" data-clear="rotation" title="Clear rotation (Alt+R)">Alt+R</button></div><div class="tp-fields" id="tp-rot"></div></div>
      <div class="tp-grp"><div class="tp-lbl">Scale <span class="dim">uniform</span><button class="tp-clear" data-clear="scale" title="Clear scale (Alt+S)">Alt+S</button></div><div class="tp-fields" id="tp-scale"></div></div>
      <div class="tp-foot"><span class="dim">Drag to change, click to type. Ctrl snaps, Shift is fine.</span><button class="sbtn" id="tp-reset" title="Back to the file as loaded (origin included)"><i class="ti ti-refresh"></i> Reset</button></div>
    `;
    host.appendChild(el);
    this.el = el;
    const emit = (commit: boolean) => {
      this.cur = { pos: this.pos.map((f) => f.get()) as any, rotDeg: this.rot.map((f) => f.get()) as any, scale: Math.max(1e-4, this.scale.get()) };
      cb.onState(fromBlender(this.cur), commit);
    };
    const axes: ("x" | "y" | "z")[] = ["x", "y", "z"];
    const posHost = el.querySelector("#tp-pos") as HTMLElement, rotHost = el.querySelector("#tp-rot") as HTMLElement, scHost = el.querySelector("#tp-scale") as HTMLElement;
    this.pos = axes.map((a) => new NumField(posHost, { label: a.toUpperCase(), unit: "m", precision: 3, dragStep: 0.01, snap: 0.1, color: a }, (_v, c) => emit(c)));
    this.rot = axes.map((a) => new NumField(rotHost, { label: a.toUpperCase(), unit: "°", precision: 1, dragStep: 0.5, snap: 5, color: a }, (_v, c) => emit(c)));
    this.scale = new NumField(scHost, { label: "×", precision: 4, dragStep: 0.005, snap: 0.5, min: 0.0001 }, (_v, c) => emit(c));
    (el.querySelector("#tp-reset") as HTMLButtonElement).onclick = () => cb.onReset();
    el.querySelectorAll<HTMLButtonElement>(".tp-clear").forEach((b) => (b.onclick = () => cb.onClear(b.dataset.clear as any)));
  }

  /** Reflect the live scene transform (fields being dragged / typed are left alone). */
  setState(s: FrameState) {
    const b = toBlender(s);
    this.cur = b;
    this.pos.forEach((f, i) => f.set(b.pos[i]));
    this.rot.forEach((f, i) => f.set(b.rotDeg[i]));
    this.scale.set(b.scale);
  }
  get busy() { return [...this.pos, ...this.rot, this.scale].some((f) => f.busy); }
}
