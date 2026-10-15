/**
 * A Blender-style number field: drag left/right to change the value, click to type,
 * Ctrl while dragging snaps to steps, Shift makes it fine. Enter commits, Esc cancels.
 * `onChange(value, commit)`: commit=false while dragging / typing, true when released / entered.
 */
export interface NumFieldOpts {
  label: string;          // "X", "Y", "Z", "倍率"…
  unit?: string;          // "m", "°"
  precision?: number;     // decimals shown
  dragStep?: number;      // value change per pixel of drag
  snap?: number;          // Ctrl snapping step
  min?: number;
  max?: number;
  color?: "x" | "y" | "z";
}

export class NumField {
  readonly el: HTMLElement;
  private valueEl: HTMLElement;
  private input: HTMLInputElement;
  private value = 0;
  private editing = false;
  private dragging = false;
  readonly label: string;

  constructor(host: HTMLElement, private opts: NumFieldOpts, private onChange: (v: number, commit: boolean) => void) {
    this.label = opts.label;
    const el = document.createElement("div");
    el.className = "nf" + (opts.color ? ` nf-${opts.color}` : "");
    el.innerHTML = `<span class="nf-l">${opts.label}</span><span class="nf-v"></span><span class="nf-u">${opts.unit ?? ""}</span><input class="nf-in" type="text" inputmode="decimal" spellcheck="false">`;
    host.appendChild(el);
    this.el = el;
    this.valueEl = el.querySelector(".nf-v") as HTMLElement;
    this.input = el.querySelector(".nf-in") as HTMLInputElement;

    let down: { x: number; v0: number; moved: boolean; id: number } | null = null;
    el.addEventListener("pointerdown", (e) => {
      if (this.editing || e.button !== 0) return;
      down = { x: e.clientX, v0: this.value, moved: false, id: e.pointerId };
      try { el.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
      e.preventDefault();
    });
    el.addEventListener("pointermove", (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      if (!down.moved && Math.abs(dx) < 3) return;
      if (!down.moved) { down.moved = true; this.dragging = true; el.classList.add("drag"); }
      const step = (this.opts.dragStep ?? 0.01) * (e.shiftKey ? 0.1 : 1);
      let v = down.v0 + dx * step;
      if (e.ctrlKey && this.opts.snap) v = Math.round(v / this.opts.snap) * this.opts.snap;
      this.setInternal(this.clamp(v), false);
    });
    const finish = (e: PointerEvent) => {
      if (!down) return;
      const wasDrag = down.moved; down = null;
      el.classList.remove("drag"); this.dragging = false;
      if (wasDrag) this.onChange(this.value, true);
      else this.beginEdit();
      e.preventDefault();
    };
    el.addEventListener("pointerup", finish);
    el.addEventListener("pointercancel", finish);

    this.input.addEventListener("keydown", (e) => {
      e.stopPropagation(); // the viewport's shortcuts must not fire while typing
      if (e.key === "Enter") { this.commitEdit(); }
      else if (e.key === "Escape") { this.cancelEdit(); }
    });
    this.input.addEventListener("keyup", (e) => e.stopPropagation());
    this.input.addEventListener("blur", () => { if (this.editing) this.commitEdit(); });
  }

  private clamp(v: number) {
    if (this.opts.min != null) v = Math.max(this.opts.min, v);
    if (this.opts.max != null) v = Math.min(this.opts.max, v);
    return v;
  }
  private fmt(v: number) { return v.toFixed(this.opts.precision ?? 2); }
  private setInternal(v: number, commit: boolean) { this.value = v; this.valueEl.textContent = this.fmt(v); this.onChange(v, commit); }

  /** Reflect an outside value (ignored while the user is typing or dragging it). */
  set(v: number) { if (this.editing || this.dragging) return; this.value = v; this.valueEl.textContent = this.fmt(v); }
  get() { return this.value; }
  get busy() { return this.editing || this.dragging; }

  beginEdit() {
    this.editing = true; this.el.classList.add("edit");
    this.input.value = this.fmt(this.value);
    this.input.focus(); this.input.select();
  }
  private commitEdit() {
    const t = this.input.value.trim().replace(/,/g, ".");
    this.editing = false; this.el.classList.remove("edit");
    // allow simple arithmetic like Blender ("1.5*2", "90-15")
    let v = NaN;
    if (/^[\d\s.+\-*/()]+$/.test(t)) { try { v = Function(`"use strict"; return (${t});`)(); } catch { v = NaN; } }
    if (typeof v === "number" && isFinite(v)) this.setInternal(this.clamp(v), true);
    else this.valueEl.textContent = this.fmt(this.value);
  }
  private cancelEdit() { this.editing = false; this.el.classList.remove("edit"); this.valueEl.textContent = this.fmt(this.value); }
}
