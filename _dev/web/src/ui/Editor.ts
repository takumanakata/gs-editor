export type Tool = "box" | "circle" | "lasso" | "move" | "rotate" | "scale" | "measure";
export type CtxAction = "delete" | "deselect" | "selectAll" | "focus";

export interface EditorCallbacks {
  onTool: (t: Tool) => void;
  onOpenFile: (f: File) => void;
  onExport: (fmt: string) => void;
  onRestoreAll: () => void;
  onTheme: (t: "dark" | "light") => void;
  onContext: (a: CtxAction) => void;
  onFrameAll: () => void;
  onDimsVisible: (on: boolean) => void;
  onMeasureApply: (realMeters: number) => void;
}

const TOOLS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: "box", icon: "ti-square-dashed", label: "範囲選択（箱）", key: "B" },
  { id: "circle", icon: "ti-circle-dashed", label: "範囲選択（丸・なぞる）", key: "C" },
  { id: "lasso", icon: "ti-lasso", label: "範囲選択（投げ縄）", key: "L" },
  { id: "move", icon: "ti-arrows-move", label: "移動（シーン全体）", key: "G" },
  { id: "rotate", icon: "ti-rotate-360", label: "回転（シーン全体・原点を中心に）", key: "R" },
  { id: "scale", icon: "ti-arrows-maximize", label: "スケール（シーン全体・原点を中心に）", key: "S" },
  { id: "measure", icon: "ti-ruler-measure", label: "メジャー（2点間の距離）", key: "M" },
];

/**
 * The shell, laid out like Blender: a header with the File menu, a tool column on the
 * left, the viewport in the middle, a fixed dock on the right (import / transform /
 * dimensions / history / export) and a status bar with the hints for the current tool.
 */
export class Editor {
  readonly ui: HTMLElement;
  readonly stage: HTMLElement;
  readonly mounts: { intake: HTMLElement; transform: HTMLElement; history: HTMLElement; overlay: HTMLElement };
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private hint: HTMLElement; private msg: HTMLElement; private pill: HTMLElement; private selPill: HTMLElement;
  private msgTimer = 0;
  private loader: HTMLElement;
  private rect: HTMLElement; private circle: HTMLElement; private lassoSvg: HTMLElement; private lasso: SVGPathElement;
  private ctx: HTMLElement;
  private numEl: HTMLElement;
  private dims: { w: HTMLElement; d: HTMLElement; h: HTMLElement; chk: HTMLInputElement; measured: HTMLElement; real: HTMLInputElement; box: HTMLElement };
  private fmtSel: HTMLSelectElement;
  private orthoTag: HTMLElement;
  private lastPill = "";
  private filePick: HTMLInputElement;

  constructor(cb: EditorCallbacks, stage: HTMLElement, ui: HTMLElement) {
    this.ui = ui; this.stage = stage;
    ui.innerHTML = `
      <header id="hdr">
        <div class="menu" id="filemenu">
          <button class="mbtn" id="file-btn">ファイル</button>
          <div class="mlist" id="file-list">
            <button data-act="open"><i class="ti ti-folder-open"></i>開く…<kbd>Ctrl+O</kbd></button>
            <hr>
            <button data-act="export-spz"><i class="ti ti-download"></i>書き出し .spz<kbd>小さい</kbd></button>
            <button data-act="export-ply"><i class="ti ti-download"></i>書き出し .ply<kbd>汎用</kbd></button>
            <button data-act="export-splat"><i class="ti ti-download"></i>書き出し .splat<kbd>基本色のみ</kbd></button>
            <hr>
            <button data-act="restore-all"><i class="ti ti-refresh"></i>消したものを全部戻す</button>
            <button data-act="frame-all"><i class="ti ti-focus-2"></i>全体を表示<kbd>Home</kbd></button>
          </div>
        </div>
        <span class="hdr-title">GSEditor</span>
        <span class="hdr-sp"></span>
        <span id="orthotag" class="hdr-tag">透視</span>
        <button class="ico" id="themeBtn" title="ライト / ダーク"><i class="ti ti-moon ic-moon"></i><i class="ti ti-sun ic-sun"></i></button>
      </header>

      <nav id="tools">
        ${TOOLS.map((t, i) => `${i === 3 || i === 6 ? '<div class="tsep"></div>' : ""}<button class="tbtn" data-tool="${t.id}" title="${t.label}（${t.key}）"><i class="ti ${t.icon}"></i></button>`).join("")}
      </nav>

      <aside id="dock">
        <section class="dsec" id="dsec-intake"><h3><i class="ti ti-folder-open"></i> 読み込み</h3><div id="dock-intake"></div></section>
        <section class="dsec" id="dsec-transform">
          <h3><i class="ti ti-axis-x"></i> 原点と向き <span class="dim">Blender と同じ Z-up の数値</span></h3>
          <div id="dock-transform"></div>
        </section>
        <section class="dsec" id="dsec-dims">
          <h3><i class="ti ti-dimensions"></i> 寸法 <label class="chk"><input type="checkbox" id="dims-chk"> ビューに表示</label></h3>
          <div class="dims-grid"><span>幅 X</span><b id="dim-w">—</b><span>奥行 Y</span><b id="dim-d">—</b><span>高さ Z</span><b id="dim-h">—</b></div>
          <div class="dim-note">外れた粒を除いた本体のおよその大きさ</div>
          <div id="measure-box" class="hidden">
            <div class="dim-row">計測 <b id="measured">—</b></div>
            <div class="dim-row">この長さを <input id="real-m" type="number" step="0.01" min="0.001" placeholder="m"> m に <button class="sbtn" id="real-go">適用</button></div>
          </div>
        </section>
        <section class="dsec grow" id="dsec-history"><h3><i class="ti ti-history"></i> 編集履歴 <span class="dim">クリックで戻る</span></h3><div id="dock-history"></div></section>
        <section class="dsec" id="dsec-export">
          <div class="exp-row"><select id="exp-fmt"><option value="spz">.spz（小さい）</option><option value="ply">.ply（汎用）</option><option value="splat">.splat（基本色のみ）</option></select></div>
          <button class="cta big" id="exp-go"><i class="ti ti-download"></i> 書き出し</button>
          <div class="dim-note">消した粒と、原点・向き・大きさの修正を焼き込んだファイルを保存します</div>
        </section>
      </aside>

      <footer id="status"><span id="st-hint"></span><span id="st-msg"></span><span id="st-sel"></span><span id="st-pill">no scene</span></footer>
      <input type="file" id="file-pick" accept=".ply,.spz,.splat,.ksplat,.sog" class="hidden">
    `;
    // overlays live in the stage (over the canvas, under the dock)
    const ov = document.createElement("div"); ov.id = "overlay";
    ov.innerHTML = `
      <div id="selrect" class="hidden"></div>
      <div id="selcircle" class="hidden"></div>
      <svg id="lasso" class="hidden"><path d=""></path></svg>
      <div id="numinput" class="hidden"></div>
      <div id="ctxmenu" class="hidden">
        <button data-act="delete"><i class="ti ti-trash"></i>選択を削除<kbd>X</kbd></button>
        <button data-act="deselect"><i class="ti ti-square-off"></i>選択を解除<kbd>Alt+A</kbd></button>
        <button data-act="selectAll"><i class="ti ti-square-check"></i>すべて選択<kbd>A</kbd></button>
        <hr>
        <button data-act="focus"><i class="ti ti-zoom-in-area"></i>ここへ寄る</button>
      </div>
      <div id="loader"><div class="ld-ring"></div><div class="ld-text">読み込み中…</div></div>
    `;
    stage.appendChild(ov);

    const q = <T extends HTMLElement>(id: string) => (ui.querySelector("#" + id) || ov.querySelector("#" + id)) as T;
    this.mounts = { intake: q("dock-intake"), transform: q("dock-transform"), history: q("dock-history"), overlay: ov };
    this.hint = q("st-hint"); this.msg = q("st-msg"); this.pill = q("st-pill"); this.selPill = q("st-sel");
    this.loader = q("loader"); this.rect = q("selrect"); this.circle = q("selcircle");
    this.lassoSvg = q("lasso"); this.lasso = this.lassoSvg.querySelector("path") as SVGPathElement;
    this.ctx = q("ctxmenu"); this.numEl = q("numinput"); this.orthoTag = q("orthotag");
    this.fmtSel = q("exp-fmt"); this.filePick = q("file-pick");
    this.dims = { w: q("dim-w"), d: q("dim-d"), h: q("dim-h"), chk: q("dims-chk"), measured: q("measured"), real: q("real-m"), box: q("measure-box") };

    for (const t of TOOLS) {
      const b = ui.querySelector(`[data-tool="${t.id}"]`) as HTMLButtonElement;
      this.toolBtns.set(t.id, b);
      b.onclick = () => cb.onTool(t.id);
    }
    const fm = q("filemenu"), fl = q("file-list");
    q<HTMLButtonElement>("file-btn").onclick = (e) => { e.stopPropagation(); fm.classList.toggle("open"); };
    document.addEventListener("click", () => fm.classList.remove("open"));
    fl.addEventListener("click", (e) => {
      const b = (e.target as HTMLElement).closest("button") as HTMLButtonElement | null; if (!b) return;
      fm.classList.remove("open");
      const a = b.dataset.act!;
      if (a === "open") this.filePick.click();
      else if (a.startsWith("export-")) cb.onExport(a.slice(7));
      else if (a === "restore-all") cb.onRestoreAll();
      else if (a === "frame-all") cb.onFrameAll();
    });
    this.filePick.onchange = () => { const f = this.filePick.files?.[0]; if (f) cb.onOpenFile(f); this.filePick.value = ""; };
    q<HTMLButtonElement>("exp-go").onclick = () => cb.onExport(this.fmtSel.value);
    this.dims.chk.onchange = () => cb.onDimsVisible(this.dims.chk.checked);
    const applyReal = () => { const v = parseFloat(this.dims.real.value); if (v > 0) cb.onMeasureApply(v); };
    q<HTMLButtonElement>("real-go").onclick = applyReal;
    this.dims.real.onkeydown = (e) => { e.stopPropagation(); if (e.key === "Enter") applyReal(); };
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
    window.addEventListener("keydown", (e) => { if ((e.ctrlKey || e.metaKey) && e.code === "KeyO") { e.preventDefault(); this.filePick.click(); } });
  }

  setTool(t: Tool) { for (const [id, b] of this.toolBtns) b.classList.toggle("on", id === t); }
  setHint(text: string) { this.hint.textContent = text; }
  /** A transient message in the status bar (ms = 0 keeps it until the next message). */
  setMessage(text: string, ms = 4000) {
    window.clearTimeout(this.msgTimer);
    this.msg.textContent = text; this.msg.classList.add("show");
    if (ms > 0) this.msgTimer = window.setTimeout(() => this.msg.classList.remove("show"), ms);
  }
  setScene(name: string, splats: number) {
    const t = splats ? `${name} · ${splats.toLocaleString()} 粒` : "no scene";
    if (t !== this.lastPill) { this.lastPill = t; this.pill.textContent = t; }
  }
  setSelection(n: number) { this.selPill.textContent = n ? `選択 ${n.toLocaleString()} 粒` : ""; }
  setLoading(b: boolean) { this.loader.classList.toggle("show", b); }
  setOrtho(b: boolean) { this.orthoTag.textContent = b ? "平行投影" : "透視"; }
  setDims(d: { w: number; d: number; h: number } | null) {
    const f = (v: number) => `${v.toFixed(2)} m`;
    this.dims.w.textContent = d ? f(d.w) : "—"; this.dims.d.textContent = d ? f(d.d) : "—"; this.dims.h.textContent = d ? f(d.h) : "—";
  }
  setMeasured(m: number | null) {
    this.dims.box.classList.toggle("hidden", m == null);
    if (m != null) { this.dims.measured.textContent = `${m.toFixed(3)} m`; this.dims.real.value = ""; }
  }
  get exportFormat() { return this.fmtSel.value; }

  // ── selection overlays (viewport pixel coords) ──
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
  showContextMenu(x: number, y: number, hasSelection: boolean) {
    this.ctx.classList.remove("hidden");
    this.ctx.querySelectorAll<HTMLButtonElement>("[data-act=delete],[data-act=deselect]").forEach((b) => (b.disabled = !hasSelection));
    const r = this.stage.getBoundingClientRect();
    const w = this.ctx.offsetWidth, h = this.ctx.offsetHeight;
    this.ctx.style.left = `${Math.max(0, Math.min(x - r.left, r.width - w - 4))}px`;
    this.ctx.style.top = `${Math.max(0, Math.min(y - r.top, r.height - h - 4))}px`;
  }
  hideContextMenu() { this.ctx.classList.add("hidden"); }
}
