import * as THREE from "three";
import { NumField } from "./NumField";
import { fromBlenderPos, toBlenderPos, type V3 } from "./blenderAxes";

export type VolumeKind = "box" | "sphere";
export type VolumeMode = "inside" | "outside";

/** A clip volume (world space, axis-aligned): splats are kept inside it or outside it. */
export interface ClipVolume {
  id: number; name: string; kind: VolumeKind;
  center: THREE.Vector3; size: THREE.Vector3; radius: number;
  mode: VolumeMode; enabled: boolean; showBounds: boolean;
}

export interface VolumePanelCallbacks {
  /** Any field changed (fields already written into the volume). commit=false while dragging. */
  onChange: (commit: boolean) => void;
}

/**
 * The dock's "Clip Volume" section: the active volume's name, keep inside / outside,
 * centre and size (Blender axes), bounds visibility. The gizmo tools (G / S) edit the
 * same numbers in the viewport.
 */
export class VolumePanel {
  readonly el: HTMLElement;
  private vol: ClipVolume | null = null;
  private name: HTMLInputElement; private mode: HTMLSelectElement; private show: HTMLInputElement; private enabled: HTMLInputElement;
  private center: NumField[] = []; private size: NumField[] = []; private radius: NumField;
  private sizeGrp: HTMLElement; private radGrp: HTMLElement;

  constructor(host: HTMLElement, private cb: VolumePanelCallbacks) {
    const el = document.createElement("div");
    el.className = "vp";
    el.innerHTML = `
      <div class="vp-row"><label>Name</label><input type="text" id="vp-name" spellcheck="false"></div>
      <div class="vp-row"><label>Keep</label><select id="vp-mode"><option value="inside">Inside — hide everything outside</option><option value="outside">Outside — hide everything inside</option></select></div>
      <div class="vp-row"><label class="chk"><input type="checkbox" id="vp-enabled"> Enabled</label><label class="chk"><input type="checkbox" id="vp-show"> Show bounds</label></div>
      <div class="tp-grp"><div class="tp-lbl">Center <span class="dim">m</span></div><div class="tp-fields" id="vp-center"></div></div>
      <div class="tp-grp" id="vp-size-grp"><div class="tp-lbl">Size <span class="dim">m</span></div><div class="tp-fields" id="vp-size"></div></div>
      <div class="tp-grp" id="vp-rad-grp"><div class="tp-lbl">Radius <span class="dim">m</span></div><div class="tp-fields" id="vp-radius"></div></div>
      <div class="note">Clipped splats are hidden, cannot be selected and are left out of the export. Several volumes combine.</div>
    `;
    host.appendChild(el);
    this.el = el;
    const q = <T extends HTMLElement>(id: string) => el.querySelector("#" + id) as T;
    this.name = q("vp-name"); this.mode = q("vp-mode"); this.show = q("vp-show"); this.enabled = q("vp-enabled");
    this.sizeGrp = q("vp-size-grp"); this.radGrp = q("vp-rad-grp");
    const axes: ("x" | "y" | "z")[] = ["x", "y", "z"];
    const push = (c: boolean) => this.pushFields(c);
    this.center = axes.map((a) => new NumField(q("vp-center"), { label: a.toUpperCase(), unit: "m", precision: 3, dragStep: 0.01, snap: 0.1, color: a }, (_v, c) => push(c)));
    this.size = axes.map((a) => new NumField(q("vp-size"), { label: a.toUpperCase(), unit: "m", precision: 3, dragStep: 0.01, snap: 0.1, min: 0.001, color: a }, (_v, c) => push(c)));
    this.radius = new NumField(q("vp-radius"), { label: "r", unit: "m", precision: 3, dragStep: 0.01, snap: 0.1, min: 0.001 }, (_v, c) => push(c));
    const order = [...this.center, ...this.size, this.radius];
    order.forEach((f, i) => (f.onTab = (back) => { let j = i; do { j = (j + (back ? order.length - 1 : 1)) % order.length; } while (!order[j].el.offsetParent); order[j].beginEdit(); }));
    this.name.addEventListener("keydown", (e) => e.stopPropagation());
    this.name.onchange = () => { if (this.vol) { this.vol.name = this.name.value.trim() || this.vol.name; cb.onChange(true); } };
    this.mode.onchange = () => { if (this.vol) { this.vol.mode = this.mode.value as VolumeMode; cb.onChange(true); } };
    this.show.onchange = () => { if (this.vol) { this.vol.showBounds = this.show.checked; cb.onChange(true); } };
    this.enabled.onchange = () => { if (this.vol) { this.vol.enabled = this.enabled.checked; cb.onChange(true); } };
  }

  private pushFields(commit: boolean) {
    const v = this.vol; if (!v) return;
    const c = fromBlenderPos(this.center.map((f) => f.get()) as V3);
    v.center.set(c[0], c[1], c[2]);
    if (v.kind === "box") { const s = this.size.map((f) => f.get()); v.size.set(s[0], s[2], s[1]); } // Blender X,Y,Z → three x,z,y (sizes are positive, no sign)
    else v.radius = this.radius.get();
    this.cb.onChange(commit);
  }

  /** Show this volume (null hides the fields). Called on every change from the viewport too. */
  set(v: ClipVolume | null) {
    this.vol = v;
    this.el.classList.toggle("hidden", !v);
    if (!v) return;
    if (document.activeElement !== this.name) this.name.value = v.name;
    this.mode.value = v.mode; this.show.checked = v.showBounds; this.enabled.checked = v.enabled;
    const c = toBlenderPos([v.center.x, v.center.y, v.center.z]);
    this.center.forEach((f, i) => f.set(c[i]));
    this.sizeGrp.classList.toggle("hidden", v.kind !== "box"); this.radGrp.classList.toggle("hidden", v.kind !== "sphere");
    const s: V3 = [v.size.x, v.size.z, v.size.y];
    this.size.forEach((f, i) => f.set(s[i]));
    this.radius.set(v.radius);
  }
  get busy() { return [...this.center, ...this.size, this.radius].some((f) => f.busy); }
}
