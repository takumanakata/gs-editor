import type { FrameState } from "../viewer/SceneFrame";
import { snapDeg } from "../viewer/sceneFit";

export type SceneGizmo = "translate" | "rotate" | null;

export interface TransformPanelCallbacks {
  onAutoOrigin: () => void;
  onPickOrigin: () => void;
  onFloor: () => void;
  onAutoLevel: () => void;
  onFlip: (axis: "x" | "z") => void;
  onReset: () => void;
  /** Live field edits arrive with commit=false (while typing); commit=true on change/blur, ½, ×2. */
  onFields: (s: FrameState, commit: boolean) => void;
  onSnap: (stepDeg: number | null) => void;
  onGizmo: (mode: SceneGizmo) => void;
  onMeasure: () => void;
  onMeasureApply: (realMeters: number) => void;
  onGuides: (grid: boolean, axes: boolean) => void;
}

const SNAPS: (number | null)[] = [90, 45, 15, 5, null];

/**
 * 「原点と向き」 panel — edits the whole-scene transform (SceneFrame) with buttons a
 * non-expert can read: fix the origin, level the scene, flip it, set the scale, and
 * see the numbers in metres / degrees. Everything here is previewed live and baked
 * into the file on export.
 */
export class TransformPanel {
  readonly el: HTMLElement;
  private pos: HTMLInputElement[] = [];
  private rot: HTMLInputElement[] = [];
  private scale!: HTMLInputElement;
  private snap: number | null = 15;
  private snapChips: HTMLElement[] = [];
  private gizBtns: HTMLButtonElement[] = [];
  private pickBtn!: HTMLButtonElement;
  private measureBtn!: HTMLButtonElement;
  private measureBox!: HTMLElement;
  private measured!: HTMLElement;
  private realIn!: HTMLInputElement;
  private measuredM = 0;
  private editing = false;

  constructor(host: HTMLElement, private cb: TransformPanelCallbacks) {
    const el = document.createElement("div");
    el.id = "panel-frame"; el.className = "panel glass";
    el.innerHTML = `
      <h3><i class="ti ti-axis-x"></i> 原点と向き（シーン全体）</h3>
      <div class="tp-sec">1. 原点を合わせる</div>
      <div class="tp-row">
        <button class="cb-btn" id="tp-auto-origin" title="いちばん密度の高い場所を原点(0,0,0)にします"><i class="ti ti-focus-centered"></i> 自動</button>
        <button class="cb-btn" id="tp-pick-origin" title="3Dビューでクリックした場所を原点にします"><i class="ti ti-crosshair"></i> クリックで指定</button>
      </div>
      <div class="tp-row">
        <button class="cb-btn" id="tp-floor" title="いちばん低い面が Y=0（グリッド）に乗るように上下に動かします。向きを直してから使います"><i class="ti ti-arrow-bar-to-down"></i> 床に接地 (Y=0)</button>
      </div>
      <div class="field xyz"><label>位置 m</label><input class="num" id="tp-px" type="number" step="0.01"><input class="num" id="tp-py" type="number" step="0.01"><input class="num" id="tp-pz" type="number" step="0.01"></div>

      <div class="tp-sec">2. 向きを直す <span class="tp-dim">（原点を中心に回ります）</span></div>
      <div class="tp-row">
        <button class="cb-btn" id="tp-level" title="いちばん大きな床面を見つけて水平にします"><i class="ti ti-wand"></i> 自動で水平に</button>
      </div>
      <div class="tp-row">
        <button class="cb-btn" id="tp-flip-x" title="上下をひっくり返す（X軸で180°）"><i class="ti ti-flip-vertical"></i> 上下反転</button>
        <button class="cb-btn" id="tp-flip-z" title="前後をひっくり返す（Y軸で180°）"><i class="ti ti-flip-horizontal"></i> 前後反転</button>
      </div>
      <div class="field xyz"><label>回転°</label><input class="num" id="tp-rx" type="number" step="15"><input class="num" id="tp-ry" type="number" step="15"><input class="num" id="tp-rz" type="number" step="15"></div>
      <div class="field"><label>スナップ</label><div class="chips" id="tp-snap">${SNAPS.map((s) => `<div class="chip${s === 15 ? " on" : ""}" data-s="${s ?? ""}">${s == null ? "なし" : s + "°"}</div>`).join("")}</div></div>
      <div class="tp-row">
        <button class="cb-btn" data-giz="rotate" title="3Dビューのハンドルをドラッグして回します（Shiftでスナップ解除）"><i class="ti ti-rotate-360"></i> ドラッグで回す</button>
        <button class="cb-btn" data-giz="translate" title="3Dビューのハンドルをドラッグして動かします"><i class="ti ti-arrows-move"></i> ドラッグで動かす</button>
      </div>

      <div class="tp-sec">3. 大きさ（メートル）</div>
      <div class="field"><label>倍率</label><input class="num" id="tp-scale" type="number" step="0.01" min="0.0001"><button class="ico tp-mini" id="tp-half" title="半分に">½</button><button class="ico tp-mini" id="tp-double" title="2倍に">×2</button></div>
      <div class="tp-row"><button class="cb-btn" id="tp-measure" title="3Dビューで2点をクリックし、実際の距離を入力すると倍率が決まります"><i class="ti ti-ruler-measure"></i> 2点間の距離で決める</button></div>
      <div id="tp-measure-box" class="hidden">
        <div class="tp-dim">計測: <b id="tp-measured">—</b></div>
        <div class="tp-row"><label class="tp-lbl">実際の距離</label><input class="num" id="tp-real" type="number" step="0.01" min="0.001" placeholder="m"><span class="tp-dim">m</span><button class="cb-btn" id="tp-real-go">適用</button></div>
      </div>

      <div class="tp-sec">表示</div>
      <div class="tp-row tp-checks">
        <label><input type="checkbox" id="tp-grid" checked> グリッド (1m)</label>
        <label><input type="checkbox" id="tp-axes" checked> 軸</label>
        <span style="flex:1"></span>
        <button class="cb-btn" id="tp-reset" title="原点・向き・大きさを元に戻す"><i class="ti ti-refresh"></i> リセット</button>
      </div>
      <div class="tp-hint">「書き出し」を押すと、この修正をファイルに焼き込みます</div>
    `;
    host.appendChild(el);
    this.el = el;
    const q = <T extends HTMLElement>(id: string) => el.querySelector("#" + id) as T;

    q<HTMLButtonElement>("tp-auto-origin").onclick = () => cb.onAutoOrigin();
    this.pickBtn = q<HTMLButtonElement>("tp-pick-origin");
    this.pickBtn.onclick = () => cb.onPickOrigin();
    q<HTMLButtonElement>("tp-floor").onclick = () => cb.onFloor();
    q<HTMLButtonElement>("tp-level").onclick = () => cb.onAutoLevel();
    q<HTMLButtonElement>("tp-flip-x").onclick = () => cb.onFlip("x");
    q<HTMLButtonElement>("tp-flip-z").onclick = () => cb.onFlip("z");
    q<HTMLButtonElement>("tp-reset").onclick = () => cb.onReset();

    this.pos = ["tp-px", "tp-py", "tp-pz"].map((id) => q<HTMLInputElement>(id));
    this.rot = ["tp-rx", "tp-ry", "tp-rz"].map((id) => q<HTMLInputElement>(id));
    this.scale = q<HTMLInputElement>("tp-scale");
    const emit = (snapRot: boolean) => {
      const n = (f: HTMLInputElement, d = 0) => { const v = parseFloat(f.value); return isFinite(v) ? v : d; };
      const rot = this.rot.map((f) => (snapRot ? snapDeg(n(f), this.snap) : n(f))) as [number, number, number];
      if (snapRot) this.rot.forEach((f, i) => (f.value = String(rot[i])));
      cb.onFields({ pos: this.pos.map((f) => n(f)) as [number, number, number], rotDeg: rot, scale: Math.max(1e-4, n(this.scale, 1)) }, snapRot);
    };
    const all = [...this.pos, ...this.rot, this.scale];
    all.forEach((f) => {
      f.onfocus = () => (this.editing = true);
      f.onblur = () => (this.editing = false);
      f.oninput = () => emit(false);           // live while typing (no snapping mid-typing)
      f.onchange = () => emit(true);           // commit: snap the angles to the current step
      f.onkeydown = (e) => { if (e.key === "Enter") f.blur(); };
    });
    q<HTMLButtonElement>("tp-half").onclick = () => { this.scale.value = String(+(parseFloat(this.scale.value) || 1) / 2); emit(true); };
    q<HTMLButtonElement>("tp-double").onclick = () => { this.scale.value = String(+(parseFloat(this.scale.value) || 1) * 2); emit(true); };

    this.snapChips = Array.from(el.querySelectorAll("#tp-snap .chip")) as HTMLElement[];
    this.snapChips.forEach((c) => (c.onclick = () => this.setSnap(c.dataset.s ? +c.dataset.s : null)));
    this.setSnap(15);

    this.gizBtns = Array.from(el.querySelectorAll("[data-giz]")) as HTMLButtonElement[];
    this.gizBtns.forEach((b) => (b.onclick = () => {
      const m = b.dataset.giz as "translate" | "rotate";
      const on = b.classList.contains("on");
      cb.onGizmo(on ? null : m);
    }));

    this.measureBtn = q<HTMLButtonElement>("tp-measure");
    this.measureBtn.onclick = () => cb.onMeasure();
    this.measureBox = q<HTMLElement>("tp-measure-box");
    this.measured = q<HTMLElement>("tp-measured");
    this.realIn = q<HTMLInputElement>("tp-real");
    const applyReal = () => { const v = parseFloat(this.realIn.value); if (v > 0 && this.measuredM > 0) cb.onMeasureApply(v); };
    q<HTMLButtonElement>("tp-real-go").onclick = applyReal;
    this.realIn.onkeydown = (e) => { if (e.key === "Enter") applyReal(); };

    const grid = q<HTMLInputElement>("tp-grid"), axes = q<HTMLInputElement>("tp-axes");
    grid.onchange = axes.onchange = () => cb.onGuides(grid.checked, axes.checked);
  }

  get snapStep() { return this.snap; }

  setSnap(step: number | null) {
    this.snap = step;
    this.snapChips.forEach((c) => c.classList.toggle("on", (c.dataset.s ? +c.dataset.s : null) === step));
    this.rot.forEach((f) => (f.step = String(step ?? 1)));
    this.cb.onSnap(step);
  }

  toggle(open?: boolean) { this.el.classList.toggle("open", open); }
  get isOpen() { return this.el.classList.contains("open"); }

  /** Reflect the live scene transform (skipped while the user is typing in a field). */
  setState(s: FrameState) {
    if (this.editing) return;
    const fmt = (v: number, d: number) => String(+v.toFixed(d));
    this.pos.forEach((f, i) => (f.value = fmt(s.pos[i], 3)));
    this.rot.forEach((f, i) => (f.value = fmt(s.rotDeg[i], 1)));
    this.scale.value = fmt(s.scale, 4);
  }

  /** Highlight which scene gizmo (if any) is active. */
  setGizmo(mode: SceneGizmo) { this.gizBtns.forEach((b) => b.classList.toggle("on", b.dataset.giz === mode)); }
  setPicking(on: boolean) { this.pickBtn.classList.toggle("on", on); }
  setMeasuring(on: boolean) { this.measureBtn.classList.toggle("on", on); }

  /** Show the measured distance (metres, current scale) and the real-distance field; null hides it. */
  setMeasured(d: number | null) {
    this.measuredM = d ?? 0;
    this.measureBox.classList.toggle("hidden", d == null);
    if (d != null) { this.measured.textContent = `${d.toFixed(3)} m`; this.realIn.value = ""; this.realIn.focus(); }
  }
}
