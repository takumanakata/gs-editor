export type Tool = "select" | "move" | "rotate" | "scale" | "origin";
export type SelectVariant = "box" | "circle" | "lasso";
export type CtxAction = "delete" | "invert" | "selectAll" | "deselect" | "setOrigin" | "focus";
export type ObjectAction = "activate" | "toggle" | "remove";
export type VolumeKind = "box" | "sphere";

export interface EditorCallbacks {
  onTool: (t: Tool) => void;
  onSelectVariant: (v: SelectVariant) => void;
  onReplaceFile: (f: File) => void;
  onExport: (fmt: string) => void;
  onTheme: (t: "dark" | "light") => void;
  onContext: (a: CtxAction) => void;
  onObject: (a: ObjectAction, id: number) => void;
  onAddVolume: (kind: VolumeKind) => void;
  onDimsVisible: (on: boolean) => void;
  onVolumeShow: (on: boolean) => void;
  /** Draw the active scan whole (true) or thinned (false). */
  onDisplay: (full: boolean) => void;
}

/** `drawn`: splats actually drawn for this scan; `light`: thinned now (null = small enough to always draw whole). */
export interface SceneInfo { name: string; format: string; bytes: number; total: number; visible: number; sceneTotal: number; drawn: number; light: boolean | null; sceneDrawn: number }
export interface ObjectRow { id: number; name: string; visible: boolean; active: boolean; splats: number; kind: "object" | VolumeKind }

const VARIANTS: { id: SelectVariant; icon: string; label: string }[] = [
  { id: "box", icon: "ti-square-dashed", label: "Select Box" },
  { id: "circle", icon: "ti-circle-dashed", label: "Select Circle" },
  { id: "lasso", icon: "ti-lasso", label: "Select Lasso" },
];
const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "move", icon: "ti-arrows-move", label: "Move the object", key: "G" },
  { id: "rotate", icon: "ti-rotate-360", label: "Rotate about the object origin", key: "R" },
  { id: "scale", icon: "ti-arrows-maximize", label: "Scale about the object origin", key: "S" },
  { id: "origin", icon: "ti-focus-centered", label: "Move the object origin only (click the scan to set it)", key: "O" },
];

/**
 * The shell: full-screen viewport with floating glass UI (design.md) laid out like
 * Blender — a tool rail on the left (one Select tool whose box / circle / lasso
 * variants open by swiping right from it), a docked panel column on the right
 * (import, Objects, Transform, Dimensions, Info, history, Export), a hint strip at
 * the bottom and the navigation cube top-right. English except the import and
 * history sections, which the user reads in Japanese.
 */
export class Editor {
  readonly ui: HTMLElement;
  readonly stage: HTMLElement;
  readonly mounts: { intake: HTMLElement; transform: HTMLElement; volume: HTMLElement; history: HTMLElement; overlay: HTMLElement };
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private selBtn: HTMLButtonElement; private flyout: HTMLElement;
  private hint: HTMLElement; private msg: HTMLElement; private selPill: HTMLElement; private busy: HTMLElement;
  private msgTimer = 0;
  private loader: HTMLElement;
  private rect: HTMLElement; private circle: HTMLElement; private lassoSvg: HTMLElement; private lasso: SVGPathElement;
  private ctx: HTMLElement;
  private numEl: HTMLElement;
  private dims: { w: HTMLElement; d: HTMLElement; h: HTMLElement; chk: HTMLInputElement };
  private volShow: HTMLInputElement;
  private dimLbls: HTMLElement[];
  private info: { name: HTMLElement; format: HTMLElement; size: HTMLElement; splats: HTMLElement; note: HTMLElement; replace: HTMLButtonElement; dispRow: HTMLElement; disp: HTMLSelectElement };
  private objList: HTMLElement;
  private fmtSel: HTMLSelectElement;
  private replacePick: HTMLInputElement;

  constructor(cb: EditorCallbacks, stage: HTMLElement, ui: HTMLElement) {
    this.ui = ui; this.stage = stage;
    ui.innerHTML = `
      <div id="topleft" class="glass">
        <span class="app-name">GSEditor</span>
        <button class="ico" id="themeBtn" title="Light / dark"><i class="ti ti-moon ic-moon"></i><i class="ti ti-sun ic-sun"></i></button>
      </div>

      <nav id="tools" class="glass">
        <div class="tgroup">
          <button class="tbtn" id="t-select" title="Select — W cycles box / circle / lasso, swipe right for the list"><i class="ti ti-square-dashed"></i><span class="tri"></span></button>
          <div id="flyout" class="glass hidden">${VARIANTS.map((v) => `<button class="tbtn" data-variant="${v.id}" title="${v.label}"><i class="ti ${v.icon}"></i></button>`).join("")}</div>
        </div>
        <div class="tsep"></div>
        <div class="tgroup">${TOOLS.map((t) => `<button class="tbtn" data-tool="${t.id}" title="${t.label} (${t.key})"><i class="ti ${t.icon}"></i></button>`).join("")}</div>
        <div class="tsep"></div>
        <div class="tgroup">
          <button class="tbtn" data-add="box" title="Add a Box Volume (hides splats outside it)"><i class="ti ti-cube"></i></button>
          <button class="tbtn" data-add="sphere" title="Add a Sphere Volume (hides splats outside it)"><i class="ti ti-sphere"></i></button>
        </div>
      </nav>

      <aside id="dock" class="glass">
        <section class="dsec" id="dsec-intake"><h3><i class="ti ti-chevron-down"></i>読み込み</h3><div class="dbody" id="dock-intake"></div></section>
        <section class="dsec pinned" id="dsec-objects"><h3><i class="ti ti-list-tree"></i>Outliner <span class="dim">click to make active</span></h3><div class="dbody"><div id="obj-list"></div></div></section>
        <section class="dsec" id="dsec-volume"><h3><i class="ti ti-chevron-down"></i>Clip Volume <label class="chk"><input type="checkbox" id="vol-show-chk"> Show</label></h3><div class="dbody" id="dock-volume"></div></section>
        <section class="dsec" id="dsec-transform"><h3><i class="ti ti-chevron-down"></i>Transform <span class="dim">Blender axes (Z up)</span></h3><div class="dbody" id="dock-transform"></div></section>
        <section class="dsec" id="dsec-dims">
          <h3><i class="ti ti-chevron-down"></i>Dimensions <label class="chk" title="Draw the box and its sizes in the viewport"><input type="checkbox" id="dims-chk"> Show</label></h3>
          <div class="dbody">
            <div class="kv"><span>Width X</span><b id="dim-w">—</b><span>Depth Y</span><b id="dim-d">—</b><span>Height Z</span><b id="dim-h">—</b></div>
            <div class="note">Body of the active object, stray splats excluded</div>
          </div>
        </section>
        <section class="dsec" id="dsec-info">
          <h3><i class="ti ti-chevron-down"></i>Info</h3>
          <div class="dbody">
            <div class="kv"><span>File</span><b id="inf-name">—</b><span>Format</span><b id="inf-format">—</b><span>Size</span><b id="inf-size">—</b><span>Splats</span><b id="inf-splats">—</b></div>
            <div class="vp-row hidden" id="inf-disp-row" title="Big scans are drawn thinned so the view stays smooth. Selecting, deleting and export always use every splat."><label>Display</label><select id="inf-disp"><option value="light">Light</option><option value="full">Full (every splat)</option></select></div>
            <button class="sbtn wide" id="inf-replace" title="Load another file into this object, keeping its transform and origin"><i class="ti ti-replace"></i> Replace File…</button>
            <div class="note" id="inf-note">Up to ~1M splats is comfortable in the browser; 3M+ gets heavy.</div>
          </div>
        </section>
        <section class="dsec" id="dsec-history"><h3><i class="ti ti-chevron-down"></i>History <span class="dim">クリックで戻る</span></h3><div class="dbody" id="dock-history"></div></section>
        <section class="dsec" id="dsec-export">
          <div class="exp-row"><select id="exp-fmt"><option value="spz">.spz — small file</option><option value="ply">.ply — universal</option><option value="splat">.splat — base color only</option></select></div>
          <button class="cta big" id="exp-go" title="Save all visible objects as one file with deletions, origins, rotations and scales baked in"><i class="ti ti-download"></i> Export</button>
        </section>
      </aside>

      <div id="status" class="glass"><span id="st-hint"></span><span id="st-msg"></span><span id="st-busy" class="hidden"><i class="ti ti-loader-2"></i> Working…</span><span id="st-sel"></span></div>

      <div id="overlay">
        <div id="selrect" class="hidden"></div>
        <div id="selcircle" class="hidden"></div>
        <svg id="lasso" class="hidden"><path d=""></path></svg>
        <div class="dimlbl hidden"></div><div class="dimlbl hidden"></div><div class="dimlbl hidden"></div>
        <div id="numinput" class="glass hidden"></div>
        <div id="ctxmenu" class="glass hidden">
          <button data-act="delete"><i class="ti ti-trash"></i>Delete Selected<kbd>X</kbd></button>
          <button data-act="invert"><i class="ti ti-switch-horizontal"></i>Invert Selection<kbd>Ctrl+I</kbd></button>
          <button data-act="selectAll"><i class="ti ti-square-check"></i>Select All<kbd>A</kbd></button>
          <button data-act="deselect"><i class="ti ti-square-off"></i>Deselect All<kbd>Alt+A</kbd></button>
          <hr>
          <button data-act="setOrigin"><i class="ti ti-focus-centered"></i>Set Origin Here</button>
          <button data-act="focus"><i class="ti ti-zoom-in-area"></i>Focus Here</button>
        </div>
        <div id="loader"><div class="ld-ring"></div><div class="ld-text">Loading…</div></div>
      </div>
      <input type="file" id="replace-pick" accept=".ply,.spz,.splat,.ksplat,.sog" class="hidden">
    `;
    const q = <T extends HTMLElement>(id: string) => ui.querySelector("#" + id) as T;
    const ov = q("overlay");
    this.mounts = { intake: q("dock-intake"), transform: q("dock-transform"), volume: q("dock-volume"), history: q("dock-history"), overlay: ov };
    ui.querySelectorAll<HTMLButtonElement>("#tools [data-add]").forEach((b) => (b.onclick = () => cb.onAddVolume(b.dataset.add as VolumeKind)));
    this.hint = q("st-hint"); this.msg = q("st-msg"); this.selPill = q("st-sel"); this.busy = q("st-busy");
    this.loader = q("loader"); this.rect = q("selrect"); this.circle = q("selcircle");
    this.lassoSvg = q("lasso"); this.lasso = this.lassoSvg.querySelector("path") as SVGPathElement;
    this.ctx = q("ctxmenu"); this.numEl = q("numinput");
    this.fmtSel = q("exp-fmt"); this.replacePick = q("replace-pick");
    this.dims = { w: q("dim-w"), d: q("dim-d"), h: q("dim-h"), chk: q("dims-chk") };
    this.volShow = q("vol-show-chk");
    this.dims.chk.onchange = () => cb.onDimsVisible(this.dims.chk.checked);
    this.volShow.onchange = () => cb.onVolumeShow(this.volShow.checked);
    for (const id of ["dsec-dims", "dsec-info", "dsec-history"]) q(id).classList.add("closed"); // collapsed by default
    this.dimLbls = Array.from(ov.querySelectorAll(".dimlbl")) as HTMLElement[];
    this.info = { name: q("inf-name"), format: q("inf-format"), size: q("inf-size"), splats: q("inf-splats"), note: q("inf-note"), replace: q("inf-replace"), dispRow: q("inf-disp-row"), disp: q("inf-disp") as HTMLSelectElement };
    this.objList = q("obj-list");
    this.selBtn = q("t-select"); this.flyout = q("flyout");

    for (const t of TOOLS) { const b = ui.querySelector(`[data-tool="${t.id}"]`) as HTMLButtonElement; this.toolBtns.set(t.id, b); b.onclick = () => cb.onTool(t.id); }
    // the Select tool: click = select; swipe right while pressed = the variant flyout (release over one to pick it)
    const openFly = () => this.flyout.classList.remove("hidden");
    const closeFly = () => this.flyout.classList.add("hidden");
    const variantAt = (x: number, y: number) => (document.elementFromPoint(x, y) as HTMLElement | null)?.closest("[data-variant]") as HTMLButtonElement | null;
    let press: { x: number; swiping: boolean } | null = null;
    this.selBtn.addEventListener("pointerdown", (e) => {
      if (e.button === 2) { openFly(); return; }
      if (e.button !== 0) return;
      press = { x: e.clientX, swiping: false };
      try { this.selBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    });
    this.selBtn.addEventListener("pointermove", (e) => {
      if (!press) return;
      if (!press.swiping && e.clientX - press.x > 14) { press.swiping = true; openFly(); }
      if (press.swiping) this.flyout.querySelectorAll<HTMLButtonElement>("[data-variant]").forEach((b) => b.classList.toggle("hover", b === variantAt(e.clientX, e.clientY)));
    });
    this.selBtn.addEventListener("pointerup", (e) => {
      if (!press) return;
      const p = press; press = null;
      if (p.swiping) { const v = variantAt(e.clientX, e.clientY); closeFly(); if (v) cb.onSelectVariant(v.dataset.variant as SelectVariant); cb.onTool("select"); }
      else cb.onTool("select");
      this.flyout.querySelectorAll(".hover").forEach((b) => b.classList.remove("hover"));
    });
    this.selBtn.addEventListener("contextmenu", (e) => e.preventDefault());
    this.flyout.querySelectorAll<HTMLButtonElement>("[data-variant]").forEach((b) => (b.onclick = () => { closeFly(); cb.onSelectVariant(b.dataset.variant as SelectVariant); cb.onTool("select"); }));
    document.addEventListener("pointerdown", (e) => { if (!this.flyout.contains(e.target as Node) && !this.selBtn.contains(e.target as Node)) closeFly(); }, { capture: true });
    // collapsible sections
    ui.querySelectorAll<HTMLElement>(".dsec:not(.pinned) h3").forEach((h) => (h.onclick = (e) => { if ((e.target as HTMLElement).closest("label,input,button")) return; h.parentElement!.classList.toggle("closed"); }));
    // replace / export / dims
    this.info.replace.onclick = () => this.replacePick.click();
    this.info.disp.onchange = () => cb.onDisplay(this.info.disp.value === "full");
    // a dropdown keeps keyboard focus after a pick, which mutes the shortcuts (X, Ctrl+Z …) until the next click
    for (const sel of Array.from(ui.querySelectorAll("select"))) sel.addEventListener("change", () => (sel as HTMLSelectElement).blur());
    this.replacePick.onchange = () => { const f = this.replacePick.files?.[0]; if (f) cb.onReplaceFile(f); this.replacePick.value = ""; };
    q<HTMLButtonElement>("exp-go").onclick = () => cb.onExport(this.fmtSel.value);
    // objects
    this.objList.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(".orow") as HTMLElement | null; if (!row) return;
      const id = +row.dataset.id!;
      const t = e.target as HTMLElement;
      if (t.closest(".eye")) cb.onObject("toggle", id);
      else if (t.closest(".ox")) cb.onObject("remove", id);
      else cb.onObject("activate", id);
    });
    // context menu
    this.ctx.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null; if (!b || b.disabled) return;
      this.hideContextMenu(); cb.onContext(b.dataset.act as CtxAction);
    });
    document.addEventListener("pointerdown", (e) => { if (!this.ctx.contains(e.target as Node)) this.hideContextMenu(); }, { capture: true });
    // theme: follows the system until chosen here
    const TKEY = "gseditor-theme-choice";
    const sysDark = matchMedia("(prefers-color-scheme: dark)");
    const apply = (t: string, save: boolean) => { document.documentElement.dataset.theme = t; if (save) { try { localStorage.setItem(TKEY, t); } catch { /* ignore */ } } cb.onTheme(t as "dark" | "light"); };
    let saved: string | null = null; try { saved = localStorage.getItem(TKEY); localStorage.removeItem("gseditor-theme"); } catch { /* ignore */ }
    apply(saved || (sysDark.matches ? "dark" : "light"), false);
    sysDark.addEventListener("change", () => { try { if (!localStorage.getItem(TKEY)) apply(sysDark.matches ? "dark" : "light", false); } catch { /* ignore */ } });
    q<HTMLButtonElement>("themeBtn").onclick = () => apply(document.documentElement.dataset.theme === "light" ? "dark" : "light", true);
  }

  setTool(t: Tool, variant: SelectVariant) {
    for (const [id, b] of this.toolBtns) b.classList.toggle("on", id === t);
    this.selBtn.classList.toggle("on", t === "select");
    const v = VARIANTS.find((x) => x.id === variant)!;
    (this.selBtn.querySelector("i") as HTMLElement).className = `ti ${v.icon}`;
    this.flyout.querySelectorAll<HTMLButtonElement>("[data-variant]").forEach((b) => b.classList.toggle("on", b.dataset.variant === variant));
  }
  setHint(text: string) { this.hint.textContent = text; }
  /** A transient message in the status strip (ms = 0 keeps it until the next message). */
  setMessage(text: string, ms = 4000) {
    window.clearTimeout(this.msgTimer);
    this.msg.textContent = text; this.msg.classList.add("show");
    if (ms > 0) this.msgTimer = window.setTimeout(() => this.msg.classList.remove("show"), ms);
  }
  /** A quiet "Working…" while a big scan is being processed in the background. */
  setBusy(b: boolean) { this.busy.classList.toggle("hidden", !b); }
  setSelection(n: number) { this.selPill.textContent = n ? `${n.toLocaleString()} selected` : ""; }
  setLoading(b: boolean) { this.loader.classList.toggle("show", b); }
  get dimsVisible() { return this.dims.chk.checked; }
  setVolumeShow(on: boolean) { this.volShow.checked = on; }
  setDims(d: { w: number; d: number; h: number } | null) {
    const f = (v: number) => `${v.toFixed(2)} m`;
    this.dims.w.textContent = d ? f(d.w) : "—"; this.dims.d.textContent = d ? f(d.d) : "—"; this.dims.h.textContent = d ? f(d.h) : "—";
  }
  /** Labels on the dimension box in the viewport: screen positions (stage px) or null to hide. */
  setDimLabels(items: ({ x: number; y: number; text: string } | null)[]) {
    this.dimLbls.forEach((el, i) => {
      const it = items[i];
      el.classList.toggle("hidden", !it);
      if (it) { el.textContent = it.text; el.style.left = `${it.x}px`; el.style.top = `${it.y}px`; }
    });
  }
  setInfo(i: SceneInfo | null) {
    this.info.replace.disabled = !i;
    if (!i) { this.info.name.textContent = "—"; this.info.format.textContent = "—"; this.info.size.textContent = "—"; this.info.splats.textContent = "—"; this.info.dispRow.classList.add("hidden"); return; }
    this.info.name.textContent = i.name; this.info.name.title = i.name;
    this.info.format.textContent = i.format.toUpperCase();
    this.info.size.textContent = i.bytes ? `${(i.bytes / 1048576).toFixed(1)} MB` : "—";
    this.info.splats.textContent = i.visible === i.total ? i.total.toLocaleString() : `${i.visible.toLocaleString()} / ${i.total.toLocaleString()}`;
    const M = (v: number) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : `${Math.round(v / 1000)}k`);
    this.info.dispRow.classList.toggle("hidden", i.light === null);
    if (i.light !== null) {
      this.info.disp.value = i.light ? "light" : "full";
      (this.info.disp.options[0] as HTMLOptionElement).text = i.light ? `Light (${M(i.drawn)} drawn)` : "Light";
    }
    const d = i.sceneDrawn;
    this.info.note.textContent = i.light ? `Drawing ${M(i.drawn)} of ${M(i.total)} splats so the view stays smooth. Selecting, deleting and export use every splat.`
      : d > 3_000_000 ? `Drawing ${M(d)} splats: heavy in the browser — expect lag.`
      : d > 1_000_000 ? `Drawing ${M(d)} splats: workable.`
      : "Up to ~1M drawn splats is comfortable in the browser; 3M+ gets heavy. Big scans are drawn thinned automatically.";
  }
  setObjects(rows: ObjectRow[]) {
    const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const icon = (k: ObjectRow["kind"]) => (k === "object" ? "ti-point" : k === "box" ? "ti-cube" : "ti-sphere");
    this.objList.innerHTML = rows.length ? rows.map((r) =>
      `<div class="orow${r.active ? " on" : ""}${r.visible ? "" : " off"}" data-id="${r.id}" title="${esc(r.name)}"><button class="eye" title="${r.kind === "object" ? "Show / hide" : "Enable / disable"}"><i class="ti ${r.visible ? "ti-eye" : "ti-eye-off"}"></i></button><i class="ti okind ${icon(r.kind)}"></i><span class="oname">${esc(r.name)}</span><span class="ocount">${r.kind === "object" ? (r.splats >= 1e6 ? (r.splats / 1e6).toFixed(1) + "M" : Math.round(r.splats / 1000) + "k") : ""}</span><button class="ox" title="Remove"><i class="ti ti-x"></i></button></div>`).join("")
      : `<div class="note">No objects yet — add files above</div>`;
  }
  /** Which detail sections apply to the active item (Transform / Dimensions / Info for an object, the volume panel for a volume). */
  setActiveKind(k: "object" | "volume" | null) {
    for (const id of ["dsec-transform", "dsec-dims", "dsec-info"]) (this.ui.querySelector("#" + id) as HTMLElement).classList.toggle("hidden", k !== "object");
    (this.ui.querySelector("#dsec-volume") as HTMLElement).classList.toggle("hidden", k !== "volume");
  }
  get exportFormat() { return this.fmtSel.value; }

  // ── selection overlays (stage pixel coords) ──
  showRect(x0: number, y0: number, x1: number, y1: number) {
    Object.assign(this.rect.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
    this.rect.classList.remove("hidden");
  }
  hideRect() { this.rect.classList.add("hidden"); }
  showCircle(x: number, y: number, r: number) {
    Object.assign(this.circle.style, { left: `${x}px`, top: `${y}px`, width: `${r * 2}px`, height: `${r * 2}px` });
    this.circle.classList.remove("hidden");
  }
  hideCircle() { this.circle.classList.add("hidden"); }
  showLasso(pts: { x: number; y: number }[]) {
    this.lassoSvg.classList.remove("hidden");
    this.lasso.setAttribute("d", pts.length ? "M" + pts.map((p) => `${p.x},${p.y}`).join(" L") + " Z" : "");
  }
  hideLasso() { this.lassoSvg.classList.add("hidden"); }
  setNumInput(text: string | null) { this.numEl.classList.toggle("hidden", !text); this.numEl.textContent = text || ""; }
  showContextMenu(x: number, y: number, hasSelection: boolean, hasScene: boolean) {
    this.ctx.classList.remove("hidden");
    this.ctx.querySelectorAll<HTMLButtonElement>("[data-act=delete],[data-act=deselect]").forEach((b) => (b.disabled = !hasSelection));
    this.ctx.querySelectorAll<HTMLButtonElement>("[data-act=invert],[data-act=selectAll],[data-act=setOrigin],[data-act=focus]").forEach((b) => (b.disabled = !hasScene));
    const r = this.stage.getBoundingClientRect();
    const w = this.ctx.offsetWidth, h = this.ctx.offsetHeight;
    this.ctx.style.left = `${Math.max(0, Math.min(x - r.left, r.width - w - 4))}px`;
    this.ctx.style.top = `${Math.max(0, Math.min(y - r.top, r.height - h - 4))}px`;
  }
  hideContextMenu() { this.ctx.classList.add("hidden"); }
}
