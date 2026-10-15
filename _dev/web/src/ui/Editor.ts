import { IntakePanel } from "./IntakePanel";

export interface EditorCallbacks {
  onMode: (m: "orbit" | "fly") => void;
  onRecenter: () => void;
  onTheme: (t: "dark" | "light") => void;
  onExportGS: (fmt: string) => void;
  onLoadResult: (url: string, file: File) => void;
  onBusy: (busy: boolean) => void;
  onEditMode: (mode: "clean" | "none") => void;
  onUndo: () => void;
  onRedo: () => void;
  onRestoreAll: () => void;
  onRemoveNoise: (strength: number) => void;
  onAutoClean: () => void;
  onBrushSize: (px: number) => void;
  onTogglePanel: (which: "frame") => void;
}

export class Editor {
  private scenePill!: HTMLElement;
  private navBtns: HTMLButtonElement[] = [];
  private intake!: IntakePanel;
  /** Switch the paint mode from outside (e.g. when a pick mode starts). */
  setEditUI: (mode: "clean" | "none") => void = () => {};
  private console!: HTMLElement;
  private conText!: HTMLElement;
  private conBar!: HTMLElement;
  private thumb!: HTMLElement;
  private thumbImg!: HTMLImageElement;
  private prevThumbUrl: string | null = null;
  private loader!: HTMLElement;
  private lastPill = "";
  /** Host element for extra panels (scene-transform / history panels mount here). */
  readonly ui: HTMLElement;

  constructor(private cb: EditorCallbacks, view: HTMLElement, ui: HTMLElement) {
    this.ui = ui;
    ui.innerHTML = `
      <div id="rail" class="glass">
        <button class="ico" id="r-clean" title="消しゴム（ペンで塗って削除）"><i class="ti ti-eraser"></i></button>
        <div class="rail-sep"></div>
        <button class="ico" id="r-frame" title="原点と向き（シーン全体の原点・水平・大きさを直す）"><i class="ti ti-axis-x"></i></button>
      </div>

      <div id="cleanbar" class="glass">
        <button class="cb-btn" id="cb-autoclean"><i class="ti ti-wand"></i> おまかせクリーンアップ</button>
        <span class="cb-sep"></span>
        <span class="cb-hint"><i class="ti ti-eraser"></i> ペンで塗って削除</span>
        <label class="cb-lbl">太さ</label><input id="cb-brush" type="range" min="8" max="140" step="2" value="28" title="ペンの太さ">
        <span class="cb-sep"></span>
        <button class="cb-btn" id="cb-noise"><i class="ti ti-sparkles"></i> 浮遊ノイズ除去</button>
        <input id="cb-noise-str" type="range" min="5" max="600" step="5" value="40" title="除去強度（大きいほど強く消す）">
        <span class="cb-sep"></span>
        <button class="ico" id="cb-undo" title="元に戻す (Ctrl+Z)"><i class="ti ti-arrow-back-up"></i></button>
        <button class="ico" id="cb-redo" title="やり直す (Ctrl+Shift+Z)"><i class="ti ti-arrow-forward-up"></i></button>
        <button class="ico" id="cb-all" title="消したものを全部表示に戻す"><i class="ti ti-refresh"></i></button>
      </div>

      <div id="topbar" class="glass">
        <span id="scenePill" style="color:var(--tx-dim);font-size:12px;">no scene</span>
        <span class="ld" id="topLoad"><i class="ti ti-folder-open"></i> GS を読み込む…</span>
      </div>

      <div id="navmode" class="glass">
        <button class="ico on" data-nav="orbit" title="周回 (左ドラッグ=周回 / 右ドラッグ=移動 / ホイール=ズーム / ダブルクリックで寄る)"><i class="ti ti-pointer"></i></button>
        <button class="ico" data-nav="fly" title="ドローン移動 (WASDで自動切替 / マウスで視点 / ホイールで速度 / Escで解除)"><i class="ti ti-drone"></i></button>
        <button class="ico" id="c-recenter" title="ビューを戻す"><i class="ti ti-focus-2"></i></button>
      </div>

      <div id="themeToggle" class="glass"><button class="ico" id="themeBtn" title="ライト / ダーク 切替" aria-label="テーマ切替"><i class="ti ti-moon ic-moon"></i><i class="ti ti-sun ic-sun"></i></button></div>

      <div id="actionbar" class="glass">
        <button class="cta" id="a-export"><i class="ti ti-download"></i> 書き出し</button>
      </div>
      <div id="exportmenu" class="glass">
        <div class="exp-head">GSを書き出し</div>
        <div class="exp-gs">
          <span class="exp-note">掃除と、原点・向き・大きさの修正をすべて反映したファイルを保存します</span>
          <div class="exp-gs-row">
            <select id="exp-fmt"><option value="ply">.ply</option><option value="spz">.spz</option><option value="splat">.splat</option></select>
            <button class="exp-go" id="x-gs">保存</button>
          </div>
        </div>
      </div>

      <div id="crosshair"></div>
      <div id="lockhint"><i class="ti ti-mouse"></i> 視点ロック中 — <b>Esc</b>で解除 / ホイールで速度</div>

      <div id="loader"><div class="ld-ring"></div><div class="ld-text">準備中…</div></div>

      <div id="topleft">
        <div id="console">
          <div id="con-bar"></div>
          <div id="con-text"></div>
        </div>
        <div id="thumb"><img id="thumb-img" alt="入力画像"></div>
      </div>

      <div id="orb"><span class="dot"></span><button class="ico" id="o-help" title="ヘルプ"><i class="ti ti-help"></i></button></div>

      <div id="panel-bake" class="panel glass">
        <h3><i class="ti ti-folder-open"></i> 読み込み</h3>
        <div id="bakemount"></div>
      </div>
    `;

    this.scenePill = ui.querySelector("#scenePill")!;

    this.navBtns = Array.from(ui.querySelectorAll("#navmode [data-nav]")) as HTMLButtonElement[];
    this.navBtns.forEach((b) => (b.onclick = () => cb.onMode(b.dataset.nav as "orbit" | "fly")));

    const bakeP = ui.querySelector("#panel-bake") as HTMLElement;
    const toggleBake = () => bakeP.classList.toggle("open");
    (ui.querySelector("#topLoad") as HTMLElement).onclick = toggleBake;
    (ui.querySelector("#r-frame") as HTMLButtonElement).onclick = () => cb.onTogglePanel("frame");
    // paint mode: 消しゴム (paint → delete)
    const cleanBtn = ui.querySelector("#r-clean") as HTMLButtonElement;
    const cleanBar = ui.querySelector("#cleanbar") as HTMLElement;
    let editMode: "clean" | "none" = "none";
    this.setEditUI = (mode) => {
      if (mode === editMode) return;
      editMode = mode;
      cleanBtn.classList.toggle("on", mode === "clean");
      cleanBar.classList.toggle("show", mode === "clean");
      cb.onEditMode(mode);
    };
    cleanBtn.onclick = () => this.setEditUI(editMode === "clean" ? "none" : "clean");
    (ui.querySelector("#cb-undo") as HTMLButtonElement).onclick = () => cb.onUndo();
    (ui.querySelector("#cb-redo") as HTMLButtonElement).onclick = () => cb.onRedo();
    (ui.querySelector("#cb-all") as HTMLButtonElement).onclick = () => cb.onRestoreAll();
    const noiseStr = ui.querySelector("#cb-noise-str") as HTMLInputElement;
    (ui.querySelector("#cb-noise") as HTMLButtonElement).onclick = () => cb.onRemoveNoise(+noiseStr.value);
    (ui.querySelector("#cb-autoclean") as HTMLButtonElement).onclick = () => cb.onAutoClean();
    const cbBrush = ui.querySelector("#cb-brush") as HTMLInputElement;
    cbBrush.oninput = () => cb.onBrushSize(+cbBrush.value);

    // export lives behind a popover so a stray click can't fire it by accident
    const expMenu = ui.querySelector("#exportmenu") as HTMLElement;
    const expFmt = ui.querySelector("#exp-fmt") as HTMLSelectElement;
    const closeExp = () => expMenu.classList.remove("open");
    (ui.querySelector("#a-export") as HTMLButtonElement).onclick = (e) => { e.stopPropagation(); expMenu.classList.toggle("open"); };
    expMenu.addEventListener("click", (e) => e.stopPropagation());
    document.addEventListener("click", () => closeExp()); // click anywhere else closes it
    (ui.querySelector("#x-gs") as HTMLButtonElement).onclick = () => { cb.onExportGS(expFmt.value); closeExp(); };
    (ui.querySelector("#c-recenter") as HTMLButtonElement).onclick = () => cb.onRecenter();

    // theme toggle (design.md: data-theme + localStorage; dark is the app default)
    const TKEY = "gseditor-theme";
    const applyTheme = (t: string) => { document.documentElement.dataset.theme = t; try { localStorage.setItem(TKEY, t); } catch { /* ignore */ } cb.onTheme(t as "dark" | "light"); };
    let saved: string | null = null;
    try { saved = localStorage.getItem(TKEY); } catch { /* ignore */ }
    applyTheme(saved || "dark");
    (ui.querySelector("#themeBtn") as HTMLButtonElement).onclick = () => applyTheme(document.documentElement.dataset.theme === "light" ? "dark" : "light");

    this.console = ui.querySelector("#console") as HTMLElement;
    this.conText = ui.querySelector("#con-text") as HTMLElement;
    this.conBar = ui.querySelector("#con-bar") as HTMLElement;
    this.thumb = ui.querySelector("#thumb") as HTMLElement;
    this.thumbImg = ui.querySelector("#thumb-img") as HTMLImageElement;
    this.loader = ui.querySelector("#loader") as HTMLElement;
    this.intake = new IntakePanel(ui.querySelector("#bakemount") as HTMLElement, cb.onLoadResult, (t) => this.setConsole(t));

    view.addEventListener("dragover", (e) => e.preventDefault());
    view.addEventListener("drop", (e) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer?.files ?? []); if (!files.length) return;
      this.intake.handleFiles(files);
    });

    // keyboard: Esc leaves the eraser; Ctrl+Z / Ctrl+Shift+Z (Ctrl+Y) walk the edit history
    window.addEventListener("keydown", (e) => {
      const t = e.target as HTMLElement | null; // typing in a field → no shortcuts
      if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
      if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); if (e.shiftKey) cb.onRedo(); else cb.onUndo(); }
      else if ((e.ctrlKey || e.metaKey) && e.code === "KeyY") { e.preventDefault(); cb.onRedo(); }
      else if (e.code === "Escape") { if (cleanBtn.classList.contains("on")) this.setEditUI("none"); }
    });
  }

  /** Show the intake panel (load a GS file). */
  openIntake() { (this.ui.querySelector("#panel-bake") as HTMLElement).classList.add("open"); }

  /** Centre-of-view loading animation. */
  setLoading(b: boolean) { this.loader.classList.toggle("show", b); }

  /** Reflect the active nav mode in the bottom-right cluster (WASD auto-fly / Esc auto-orbit). */
  setNavMode(m: "orbit" | "fly") { this.navBtns.forEach((b) => b.classList.toggle("on", b.dataset.nav === m)); }
  setScene(name: string, splats: number) {
    const t = `${name} · ${splats.toLocaleString()} splats`;
    if (t !== this.lastPill) { this.lastPill = t; this.scenePill.textContent = t; } // called every frame: touch the DOM only on change
  }

  /** Floating top-left console — newest line on top, older lines below (rises upward). */
  setConsole(text: string) {
    const t = (text || "").trim();
    if (!t) { this.console.classList.remove("show"); this.conText.textContent = ""; return; }
    this.conText.textContent = t.split("\n").reverse().join("\n"); // newest first (top)
    this.console.classList.add("show");
    this.conText.scrollTop = 0; // newest is at the top
  }

  /** Show a small preview of the dropped still (top-left; slides below the console when it appears). */
  setThumb(url: string | null) {
    if (this.prevThumbUrl) { URL.revokeObjectURL(this.prevThumbUrl); this.prevThumbUrl = null; }
    if (!url) { this.thumb.classList.remove("show"); this.thumbImg.removeAttribute("src"); return; }
    this.prevThumbUrl = url;
    this.thumbImg.src = url;
    this.thumb.classList.add("show");
  }

  /** Drive the load bar pinned to the console's top edge (null = hide). */
  setProgress(pct: number | null) {
    if (pct == null) { this.conBar.classList.remove("show"); this.conBar.style.width = "0%"; return; }
    this.conBar.classList.add("show");
    this.conBar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
  }
}
