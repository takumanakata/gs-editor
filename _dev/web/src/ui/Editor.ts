export type Tool = "select" | "move" | "rotate" | "scale" | "origin";
export type SelectVariant = "box" | "circle" | "lasso";
export type CtxAction = "delete" | "invert" | "selectAll" | "deselect" | "setOrigin" | "focus" | "restoreAll";

export interface EditorCallbacks {
  onTool: (t: Tool) => void;
  onSelectVariant: (v: SelectVariant) => void;
  onOpenFile: (f: File) => void;
  onExport: (fmt: string) => void;
  onTheme: (t: "dark" | "light") => void;
  onContext: (a: CtxAction) => void;
  onDimsVisible: (on: boolean) => void;
}

export interface SceneInfo { name: string; format: string; bytes: number; total: number; visible: number }

const VARIANTS: { id: SelectVariant; icon: string; label: string }[] = [
  { id: "box", icon: "ti-square-dashed", label: "Select Box" },
  { id: "circle", icon: "ti-circle-dashed", label: "Select Circle" },
  { id: "lasso", icon: "ti-lasso", label: "Select Lasso" },
];
const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "move", icon: "ti-arrows-move", label: "Move (whole scan)", key: "G" },
  { id: "rotate", icon: "ti-rotate-360", label: "Rotate about the object origin", key: "R" },
  { id: "scale", icon: "ti-arrows-maximize", label: "Scale about the object origin", key: "S" },
  { id: "origin", icon: "ti-focus-centered", label: "Move the object origin only (click the scan to set it)", key: "O" },
];

/**
 * The shell: full-screen viewport with floating glass UI (design.md) laid out like
 * Blender — a tool rail on the left (one Select tool with box / circle / lasso
 * variants behind a long-press flyout), a docked panel column on the right (import,
 * Transform, Dimensions, Info, history, Export), a hint strip at the bottom and the
 * navigation cube top-right. Everything is English except the import and history
 * sections, which the user reads in Japanese.
 */
export class Editor {
  readonly ui: HTMLElement;
  readonly stage: HTMLElement;
  readonly mounts: { intake: HTMLElement; transform: HTMLElement; history: HTMLElement; overlay: HTMLElement };
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private selBtn: HTMLButtonElement; private flyout: HTMLElement;
  private hint: HTMLElement; private msg: HTMLElement; private selPill: HTMLElement;
  private msgTimer = 0;
  private loader: HTMLElement;
  private rect: HTMLElement; private circle: HTMLElement; private lassoSvg: HTMLElement; private lasso: SVGPathElement;
  private ctx: HTMLElement;
  private numEl: HTMLElement;
  private dims: { w: HTMLElement; d: HTMLElement; h: HTMLElement; chk: HTMLInputElement };
  private dimLbls: HTMLElement[];
  private info: { name: HTMLElement; format: HTMLElement; size: HTMLElement; splats: HTMLElement; note: HTMLElement };
  private fmtSel: HTMLSelectElement;
  private orthoTag: HTMLElement;
  private filePick: HTMLInputElement;

  constructor(cb: EditorCallbacks, stage: HTMLElement, ui: HTMLElement) {
    this.ui = ui; this.stage = stage;
    ui.innerHTML = `
      <div id="topleft" class="glass">
        <span class="app-name">GSEditor</span>
        <span id="orthotag" class="tag">Persp</span>
        <button class="ico" id="themeBtn" title="Light / dark"><i class="ti ti-moon ic-moon"></i><i class="ti ti-sun ic-sun"></i></button>
      </div>

      <nav id="tools" class="glass">
        <div class="tgroup">
          <button class="tbtn" id="t-select" title="Select (W switches box / circle / lasso, hold for the list)"><i class="ti ti-square-dashed"></i><span class="tri"></span></button>
          <div id="flyout" class="glass hidden">${VARIANTS.map((v) => `<button class="tbtn" data-variant="${v.id}" title="${v.label}"><i class="ti ${v.icon}"></i></button>`).join("")}</div>
        </div>
        <div class="tsep"></div>
        <div class="tgroup">${TOOLS.map((t) => `<button class="tbtn" data-tool="${t.id}" title="${t.label} (${t.key})"><i class="ti ${t.icon}"></i></button>`).join("")}</div>
      </nav>

      <aside id="dock" class="glass">
        <section class="dsec" id="dsec-intake"><h3><i class="ti ti-chevron-down"></i>読み込み</h3><div class="dbody" id="dock-intake"></div></section>
        <section class="dsec" id="dsec-transform"><h3><i class="ti ti-chevron-down"></i>Transform <span class="dim">Blender axes (Z up)</span></h3><div class="dbody" id="dock-transform"></div></section>
        <section class="dsec" id="dsec-dims">
          <h3><i class="ti ti-chevron-down"></i>Dimensions <label class="chk" title="Draw the box and its sizes in the viewport"><input type="checkbox" id="dims-chk"> Show</label></h3>
          <div class="dbody">
            <div class="kv"><span>Width X</span><b id="dim-w">—</b><span>Depth Y</span><b id="dim-d">—</b><span>Height Z</span><b id="dim-h">—</b></div>
            <div class="note">Body of the scan, stray splats excluded</div>
          </div>
        </section>
        <section class="dsec" id="dsec-info">
          <h3><i class="ti ti-chevron-down"></i>Info</h3>
          <div class="dbody">
            <div class="kv"><span>File</span><b id="inf-name">—</b><span>Format</span><b id="inf-format">—</b><span>Size</span><b id="inf-size">—</b><span>Splats</span><b id="inf-splats">—</b></div>
            <div class="note" id="inf-note">Up to ~1M splats is comfortable in the browser; 3M+ gets heavy.</div>
          </div>
        </section>
        <section class="dsec" id="dsec-history"><h3><i class="ti ti-chevron-down"></i>編集履歴 <span class="dim">クリックで戻る</span></h3><div class="dbody" id="dock-history"></div></section>
        <section class="dsec" id="dsec-export">
          <div class="exp-row"><select id="exp-fmt"><option value="spz">.spz — small file</option><option value="ply">.ply — universal</option><option value="splat">.splat — base color only</option></select></div>
          <button class="cta big" id="exp-go" title="Save the scan with deletions, origin, rotation and scale baked in"><i class="ti ti-download"></i> Export</button>
        </section>
      </aside>

      <div id="status" class="glass"><span id="st-hint"></span><span id="st-msg"></span><span id="st-sel"></span></div>

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
          <hr>
          <button data-act="restoreAll"><i class="ti ti-refresh"></i>Restore All Deleted</button>
        </div>
        <div id="loader"><div class="ld-ring"></div><div class="ld-text">Loading…</div></div>
      </div>
      <input type="file" id="file-pick" accept=".ply,.spz,.splat,.ksplat,.sog" class="hidden">
    `;
    const q = <T extends HTMLElement>(id: string) => ui.querySelector("#" + id) as T;
    const ov = q("overlay");
    this.mounts = { intake: q("dock-intake"), transform: q("dock-transform"), history: q("dock-history"), overlay: ov };
    this.hint = q("st-hint"); this.msg = q("st-msg"); this.selPill = q("st-sel");
    this.loader = q("loader"); this.rect = q("selrect"); this.circle = q("selcircle");
    this.lassoSvg = q("lasso"); this.lasso = this.lassoSvg.querySelector("path") as SVGPathElement;
    this.ctx = q("ctxmenu"); this.numEl = q("numinput"); this.orthoTag = q("orthotag");
    this.fmtSel = q("exp-fmt"); this.filePick = q("file-pick");
    this.dims = { w: q("dim-w"), d: q("dim-d"), h: q("dim-h"), chk: q("dims-chk") };
    this.dimLbls = Array.from(ov.querySelectorAll(".dimlbl")) as HTMLElement[];
    this.info = { name: q("inf-name"), format: q("inf-format"), size: q("inf-size"), splats: q("inf-splats"), note: q("inf-note") };
    this.selBtn = q("t-select"); this.flyout = q("flyout");

    // tools
    for (const t of TOOLS) { const b = ui.querySelector(`[data-tool="${t.id}"]`) as HTMLButtonElement; this.toolBtns.set(t.id, b); b.onclick = () => cb.onTool(t.id); }
    // the Select tool: click = select tool; hold (or right-click) = the variant flyout
    let holdTimer = 0, held = false;
    const openFly = () => { this.flyout.classList.remove("hidden"); held = true; };
    const closeFly = () => this.flyout.classList.add("hidden");
    this.selBtn.addEventListener("pointerdown", (e) => { if (e.button === 2) { openFly(); return; } held = false; holdTimer = window.setTimeout(openFly, 320); });
    this.selBtn.addEventListener("pointerup", () => { window.clearTimeout(holdTimer); if (!held) cb.onTool("select"); });
    this.selBtn.addEventListener("pointerleave", () => window.clearTimeout(holdTimer));
    this.selBtn.addEventListener("contextmenu", (e) => e.preventDefault());
    this.flyout.querySelectorAll<HTMLButtonElement>("[data-variant]").forEach((b) => (b.onclick = () => { closeFly(); cb.onSelectVariant(b.dataset.variant as SelectVariant); cb.onTool("select"); }));
    document.addEventListener("pointerdown", (e) => { if (!this.flyout.contains(e.target as Node) && e.target !== this.selBtn && !this.selBtn.contains(e.target as Node)) closeFly(); }, { capture: true });
    // collapsible sections
    ui.querySelectorAll<HTMLElement>(".dsec h3").forEach((h) => (h.onclick = (e) => { if ((e.target as HTMLElement).closest("label,input")) return; h.parentElement!.classList.toggle("closed"); }));
    // files
    this.filePick.onchange = () => { const f = this.filePick.files?.[0]; if (f) cb.onOpenFile(f); this.filePick.value = ""; };
    window.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.code === "KeyO") { e.preventDefault(); this.filePick.click(); } });
    q<HTMLButtonElement>("exp-go").onclick = () => cb.onExport(this.fmtSel.value);
    this.dims.chk.onchange = () => cb.onDimsVisible(this.dims.chk.checked);
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
  setSelection(n: number) { this.selPill.textContent = n ? `${n.toLocaleString()} selected` : ""; }
  setLoading(b: boolean) { this.loader.classList.toggle("show", b); }
  setOrtho(b: boolean) { this.orthoTag.textContent = b ? "Ortho" : "Persp"; }
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
    if (!i) { this.info.name.textContent = "—"; this.info.format.textContent = "—"; this.info.size.textContent = "—"; this.info.splats.textContent = "—"; return; }
    this.info.name.textContent = i.name; this.info.name.title = i.name;
    this.info.format.textContent = i.format.toUpperCase();
    this.info.size.textContent = i.bytes ? `${(i.bytes / 1048576).toFixed(1)} MB` : "—";
    this.info.splats.textContent = i.visible === i.total ? i.total.toLocaleString() : `${i.visible.toLocaleString()} / ${i.total.toLocaleString()}`;
    this.info.note.textContent = i.total > 3_000_000 ? `${(i.total / 1e6).toFixed(1)}M splats: heavy in the browser — expect lag; thin the scan if you can.`
      : i.total > 1_000_000 ? `${(i.total / 1e6).toFixed(1)}M splats: workable, selection may take a moment.`
      : "Up to ~1M splats is comfortable in the browser; 3M+ gets heavy.";
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
    this.ctx.querySelectorAll<HTMLButtonElement>("[data-act=invert],[data-act=selectAll],[data-act=setOrigin],[data-act=focus],[data-act=restoreAll]").forEach((b) => (b.disabled = !hasScene));
    const r = this.stage.getBoundingClientRect();
    const w = this.ctx.offsetWidth, h = this.ctx.offsetHeight;
    this.ctx.style.left = `${Math.max(0, Math.min(x - r.left, r.width - w - 4))}px`;
    this.ctx.style.top = `${Math.max(0, Math.min(y - r.top, r.height - h - 4))}px`;
  }
  hideContextMenu() { this.ctx.classList.add("hidden"); }
}
