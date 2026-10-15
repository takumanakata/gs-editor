import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
import "./style.css";
import { Scene } from "./viewer/Scene";
import { SplatScene } from "./viewer/SplatScene";
import { NavControls } from "./viewer/NavControls";
import { SplatEditor } from "./viewer/SplatEditor";
import { SceneFrame, type FrameState } from "./viewer/SceneFrame";
import { History } from "./viewer/History";
import { HistoryPanel } from "./ui/HistoryPanel";
import { centroid, fitGroundPlane, percentileY, rotationBetween } from "./viewer/sceneFit";
import { startVfovRad } from "./viewer/startFrame";
import { Editor } from "./ui/Editor";
import { TransformPanel, type SceneGizmo } from "./ui/TransformPanel";
import { AlignmentError, bakeFile, bakeFromSplats, downloadBlob, type BakePart, type GsFormat } from "./export/exportGS";

declare global { interface Window { __gseditor_ready?: boolean; } }

async function boot() {
  const view = document.getElementById("view")!;
  const ui = document.getElementById("ui")!;
  const scene = new Scene(view);
  const freeCam = scene.camera;
  // Same lens as GSレイアウター's default (35 mm on a 36 mm-wide 16:9 frame), so the first
  // picture of a file matches between the two apps.
  freeCam.fov = THREE.MathUtils.radToDeg(startVfovRad()); freeCam.updateProjectionMatrix();
  const nav = new NavControls(freeCam, scene.renderer.domElement);
  const frame = new SceneFrame(scene.scene); // whole-scene transform: the splat mesh lives under frame.root
  const splat = new SplatScene(scene.renderer, scene.scene, frame.root);
  const splatEdit = new SplatEditor();
  const history = new History(); // one list for erases and scene-transform steps

  // transform gizmo: moves / rotates the WHOLE scene through `pivot`, a proxy at the world origin
  const dom = scene.renderer.domElement;
  const gizmo = new TransformControls(freeCam, dom);
  scene.scene.add(gizmo.getHelper());
  gizmo.getHelper().traverse((o) => o.layers.set(1)); // guide layer
  // ...but TransformControls' own raycaster must also look at layer 1, else handles aren't grabbable.
  const tcRay = (gizmo as any).getRaycaster ? (gizmo as any).getRaycaster() : (gizmo as any)._raycaster;
  if (tcRay?.layers) tcRay.layers.enable(1);
  gizmo.addEventListener("dragging-changed", (e) => nav.setGizmoDragging((e as any).value));
  gizmo.setMode("rotate");
  gizmo.detach(); // nothing attached at start

  // "primary mode" = the Ray is live (hover ring, double-click-to-fly, orbit-around-cursor).
  // The scene gizmo turns the Ray off so it can't steal input; Esc / empty-click returns to primary mode.
  let rayEnabled = true;
  const deselect = () => { gizmo.detach(); panel.setGizmo(null); rayEnabled = true; nav.setOrbitEnabled(true); }; // restore orbit (handle-hover may have disabled it)

  const pivot = new THREE.Object3D(); pivot.name = "scenePivot"; scene.scene.add(pivot);
  let pivotStart: { q: THREE.Quaternion; p: THREE.Vector3; state: FrameState } | null = null;
  gizmo.addEventListener("dragging-changed", (e) => {
    if (gizmo.object !== pivot) return;
    if ((e as any).value) pivotStart = { q: frame.root.quaternion.clone(), p: frame.root.position.clone(), state: frame.toJSON() };
    else {
      if (pivotStart) recordFrameStep(gizmo.mode === "rotate" ? "ドラッグで回す" : "ドラッグで動かす", pivotStart.state, frame.toJSON());
      pivotStart = null; pivot.position.set(0, 0, 0); pivot.quaternion.identity(); pivot.scale.setScalar(1);
    }
  });
  gizmo.addEventListener("objectChange", () => {
    if (gizmo.object !== pivot || !pivotStart) return;
    if (gizmo.mode === "rotate") frame.setWorld(pivot.quaternion.clone().multiply(pivotStart.q), pivotStart.p.clone().applyQuaternion(pivot.quaternion));
    else if (gizmo.mode === "translate") frame.setPosition(pivotStart.p.clone().add(pivot.position));
  });
  const setSceneGizmo = (mode: SceneGizmo) => {
    if (!mode) { if (gizmo.object === pivot) deselect(); return; }
    gizmo.setMode(mode); gizmo.attach(pivot);
    rayEnabled = false; ring.visible = false; panel.setGizmo(mode); setPickMode("none");
  };

  // ── click handling: picking (origin / measure) or deselect ──
  type PickMode = "none" | "origin" | "measure";
  let pickMode: PickMode = "none";
  const measurePts: THREE.Vector3[] = [];
  const marker = (c: number) => { const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshBasicMaterial({ color: c, depthTest: false })); m.layers.set(1); m.renderOrder = 999; m.visible = false; scene.scene.add(m); return m; };
  const markers = [marker(0xe8c07a), marker(0xe8c07a)];
  const measureLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xe8c07a, depthTest: false }));
  measureLine.layers.set(1); measureLine.renderOrder = 999; measureLine.visible = false; scene.scene.add(measureLine);
  const hint = document.createElement("div"); hint.className = "measure-hint glass"; // attached once the Editor has built the UI (it replaces ui.innerHTML)
  const showHint = (t: string | null) => { hint.textContent = t || ""; hint.classList.toggle("show", !!t); };
  const setPickMode = (m: PickMode) => {
    pickMode = m;
    panel.setPicking(m === "origin"); panel.setMeasuring(m === "measure");
    if (m !== "measure") { measurePts.length = 0; markers.forEach((k) => (k.visible = false)); measureLine.visible = false; }
    if (m !== "none") { if (gizmo.object) deselect(); setEditMode("none"); editor.setEditUI("none"); }
    showHint(m === "origin" ? "原点にしたい場所をクリック（Esc で中止）" : m === "measure" ? `距離を測る2点をクリック（${measurePts.length}/2・Esc で中止）` : null);
  };

  // true while the user is typing in a field — shortcuts must not fire
  const isTyping = (e: Event) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable);
  };
  const ndc = new THREE.Vector2();
  let down: { x: number; y: number } | null = null;
  dom.addEventListener("pointerdown", (e) => { if (e.button === 0 && !nav.isLocked()) down = { x: e.clientX, y: e.clientY }; });
  dom.addEventListener("pointerup", (e) => {
    const d = down; down = null;
    if (e.button !== 0 || !d || nav.isLocked()) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4 || gizmo.dragging) return; // drag, not a click
    if (editMode !== "none") return; // painting
    if (pickMode !== "none") {
      const p = pickAt(e.clientX, e.clientY);
      if (!p) { showHint("そこには何もありません。splat の上をクリックしてください"); return; }
      if (pickMode === "origin") { moveOriginTo(p); setPickMode("none"); editor.setConsole("原点を移動しました"); }
      else {
        measurePts.push(p);
        const k = markers[measurePts.length - 1]; k.position.copy(p); k.scale.setScalar(Math.max(0.01, freeCam.position.distanceTo(p) * 0.008)); k.visible = true;
        if (measurePts.length === 2) {
          measureLine.geometry.setFromPoints(measurePts); measureLine.visible = true;
          const dist = measurePts[0].distanceTo(measurePts[1]);
          panel.setMeasured(dist); panel.toggle(true); showHint(null); pickMode = "none"; panel.setMeasuring(false);
        } else showHint(`距離を測る2点をクリック（1/2・Esc で中止）`);
      }
      return;
    }
    if (gizmo.object) { deselect(); nav.relock(); } // empty click → back to primary mode (Ray on); also re-grabs look if flying
  });

  // hover ring on the splat surface + double-click to fly there
  const splatRay = new THREE.Raycaster();
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.6, 0.78, 40),
    new THREE.MeshBasicMaterial({ color: 0xcfe0bd, transparent: true, opacity: 0.85, depthTest: false, side: THREE.DoubleSide }),
  );
  ring.layers.set(1); ring.renderOrder = 999; ring.visible = false;
  scene.scene.add(ring);
  // Picking goes through SplatEditor's subsampled centres (a few ms) instead of Spark's
  // full raycast (hundreds of ms on big scans); Spark is only the fallback before analyze().
  const pickRay = () => { const m = splat.current; return splatEdit.ready && m ? splatEdit.pickRay(splatRay.ray, m.matrixWorld) : splat.pick(splatRay); };
  const pickAt = (clientX: number, clientY: number) => {
    const r = dom.getBoundingClientRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    splatRay.setFromCamera(ndc, freeCam);
    return pickRay();
  };
  const pickCenter = () => { ndc.set(0, 0); splatRay.setFromCamera(ndc, freeCam); return pickRay(); };
  let hoverAt = 0;
  const showRing = (p: THREE.Vector3 | null) => {
    if (p) { ring.position.copy(p); ring.lookAt(freeCam.position); ring.scale.setScalar(Math.max(0.4, freeCam.position.distanceTo(p) * 0.03)); ring.visible = true; }
    else ring.visible = false;
  };
  dom.addEventListener("pointermove", (e) => {
    if (!rayEnabled || nav.isLocked()) { ring.visible = false; return; } // off while the gizmo is active / locked
    if (e.buttons) return; // orbiting / panning: no hover work at all, the ring just stays put
    const now = performance.now(); if (now - hoverAt < 50) return; hoverAt = now;
    showRing(pickAt(e.clientX, e.clientY));
  });
  // Fill-rate is the other bottleneck: render at 0.6× while the camera moves and snap
  // back the moment it settles (same trick as GSレイアウター).
  let moveTimer = 0;
  const nudge = () => { scene.setMoving(true); window.clearTimeout(moveTimer); moveTimer = window.setTimeout(() => scene.setMoving(false), 220); };
  dom.addEventListener("pointerdown", nudge, { passive: true });
  dom.addEventListener("wheel", nudge, { passive: true });
  dom.addEventListener("pointermove", (e) => { if (e.buttons && editMode === "none") nudge(); }, { passive: true });
  window.addEventListener("keydown", (e) => { if (/^Key[WASDQE]$/.test(e.code) && !isTyping(e)) nudge(); });
  dom.addEventListener("dblclick", (e) => {
    if (!rayEnabled || pickMode !== "none") return;
    const p = nav.isLocked() ? pickCenter() : pickAt(e.clientX, e.clientY); // locked: fly toward the crosshair
    if (p) nav.focusOn(p);
  });
  // rotate-drag (left or middle): pivot around the surface under the cursor (no view jump).
  // Skip when the cursor is over a gizmo handle, so dragging the gizmo isn't hijacked.
  dom.addEventListener("pointerdown", (e) => {
    if (e.button === 0 && nav.getMode() === "orbit" && (gizmo as any).axis == null) {
      const p = pickAt(e.clientX, e.clientY); if (p) nav.setPivot(p);
    }
  });
  // while the gizmo is attached, free the left button for it by disabling orbit
  // whenever the cursor hovers one of its handles (TransformControls sets .axis on hover).
  dom.addEventListener("pointermove", () => {
    if (gizmo.object && nav.getMode() === "orbit") nav.setOrbitEnabled((gizmo as any).axis == null);
  });
  // Esc: cancel picking, or leave gizmo-editing → return to primary (Ray) mode
  window.addEventListener("keydown", (e) => {
    if (e.code !== "Escape" || nav.isLocked()) return;
    if (pickMode !== "none") setPickMode("none");
    else if (gizmo.object) deselect();
  });
  // crosshair + cursor state follow the pointer-lock
  nav.setOnLock((locked) => document.body.classList.toggle("locked", locked));

  // ── source of the loaded GS (for the full-quality export + the sidecar) ──
  let source: { url: string; file?: File; name: string } | null = null;

  let editor: Editor;
  editor = new Editor(
    {
      onMode: (m) => (m === "fly" ? nav.engage() : nav.setMode(m)),
      onRecenter: () => nav.recenter(),
      onTheme: (t) => scene.setBackground(t === "light" ? 0xe9eae6 : 0x0e110d),
      onLoadResult: (url, file) => loadGS(url, file.name, file),
      onBusy: (b) => setBusy(b),
      onEditMode: (m) => setEditMode(m),
      onUndo: () => { const l = history.currentLabel; if (history.undo()) editor.setConsole(`元に戻しました: ${l}`); },
      onRedo: () => { if (history.redo()) editor.setConsole(`やり直しました: ${history.currentLabel}`); },
      onRestoreAll: () => {
        const batch = splatEdit.hiddenIndices();
        if (!batch.length) { editor.setConsole("消したものはありません"); return; }
        splatEdit.restore(batch); splat.prepare(freeCam);
        history.push({ label: `全部表示に戻す (${batch.length.toLocaleString()} 粒)`, undo: () => { splatEdit.hide(batch); splat.prepare(freeCam); }, redo: () => { splatEdit.restore(batch); splat.prepare(freeCam); } });
        editor.setConsole(`消したものを全部表示に戻しました: ${batch.length.toLocaleString()} splats`);
      },
      onRemoveNoise: (strength) => { const b = splatEdit.removeFloaters(strength); recordErase(`浮遊ノイズ除去 (${b.length.toLocaleString()} 粒)`, b); editor.setConsole(`浮遊ノイズ除去: ${b.length.toLocaleString()} splats（Ctrl+Z で取り消し）`); },
      onAutoClean: () => { const b = splatEdit.autoClean(0.4); recordErase(`おまかせクリーンアップ (${b.length.toLocaleString()} 粒)`, b); editor.setConsole(`おまかせクリーンアップ: ${b.length.toLocaleString()} splats 除去（強ければ再度 / Ctrl+Z で取り消し）`); },
      onBrushSize: (px) => { brushRadius = px; },
      onExportGS: (fmt) => exportGS(fmt as GsFormat),
      onTogglePanel: (which) => { if (which === "frame") panel.toggle(); },
    },
    view, ui,
  );
  ui.appendChild(hint);
  nav.setOnMode((m) => editor.setNavMode(m)); // auto WASD→fly / Esc→orbit reflect in the UI

  // ── 編集履歴 ────────────────────────────────────────────────────────────
  const histPanel = new HistoryPanel(editor.ui, (i) => { history.goTo(i); editor.setConsole(i === 0 ? "読み込んだ状態に戻しました" : `履歴: 「${history.currentLabel}」まで`); });
  history.setOnChange(() => histPanel.render(history));
  histPanel.render(history);
  /** An erase that already happened → one history step (undo = show the batch again). */
  const recordErase = (label: string, batch: number[]) => {
    splat.prepare(freeCam);
    if (!batch.length) return;
    history.push({ label, undo: () => { splatEdit.restore(batch); splat.prepare(freeCam); }, redo: () => { splatEdit.hide(batch); splat.prepare(freeCam); } });
  };
  /**
   * A scene-transform step: before/after states (tiny) plus how the view followed it, so
   * undo moves the camera back too and the scene does not jump on screen.
   */
  const recordFrameStep = (label: string, before: FrameState, after: FrameState, view?: { d?: THREE.Vector3; k?: number }) => {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    const d = view?.d?.clone(), k = view?.k;
    const follow = (dir: 1 | -1) => { if (d) nav.shiftView(d.clone().multiplyScalar(dir)); if (k) nav.scaleView(dir > 0 ? k : 1 / k, new THREE.Vector3()); };
    history.push({ label, undo: () => { frame.fromJSON(before); follow(-1); }, redo: () => { frame.fromJSON(after); follow(1); } });
  };
  /** Run a transform operation and record it (the op reports any camera follow it applied). */
  const frameOp = (label: string, op: () => { d?: THREE.Vector3; k?: number } | void) => {
    const before = frame.toJSON();
    const view = op() || undefined;
    recordFrameStep(label, before, frame.toJSON(), view);
  };

  // ── 原点と向き panel ──────────────────────────────────────────────────────
  /** Visible splat centres in WORLD space, for the fitting tools. */
  const worldPoints = (maxN = 80000): Float32Array => {
    const main = splat.current;
    if (!main) return new Float32Array(0);
    main.updateMatrixWorld(true);
    return splatEdit.sampleCenters(main.matrixWorld, maxN);
  };
  /** Move the scene so world point `p` becomes the origin; the camera follows, so only the axes appear to jump. */
  const moveOriginTo = (p: THREE.Vector3, label = "原点をクリックで指定") => frameOp(label, () => { const d = p.clone().negate(); frame.translateWorld(d); nav.shiftView(d); return { d }; });
  const panel = new TransformPanel(editor.ui, {
    onAutoOrigin: () => {
      const dense = splat.densestRegion();
      const pts = worldPoints(40000);
      const c = dense ? dense.center : pts.length ? centroid(pts) : null;
      if (!c) { editor.setConsole("シーンがありません"); return; }
      moveOriginTo(c, "原点を自動で合わせる"); editor.setConsole("原点を密度の中心に合わせました");
    },
    onPickOrigin: () => setPickMode(pickMode === "origin" ? "none" : "origin"),
    onFloor: () => {
      const pts = worldPoints();
      if (!pts.length) return;
      const y = percentileY(pts, 0.02); // ignore the few floaters below the real floor
      frameOp("床に接地 (Y=0)", () => { const d = new THREE.Vector3(0, -y, 0); frame.translateWorld(d); nav.shiftView(d); return { d }; });
      editor.setConsole(`床を Y=0 に接地しました（${y >= 0 ? "-" : "+"}${Math.abs(y).toFixed(3)} m）`);
    },
    onAutoLevel: () => {
      const pts = worldPoints();
      const fit = fitGroundPlane(pts);
      if (!fit) { editor.setConsole("床面が見つかりません（上下反転してから試すか、手動で回してください）"); return; }
      const tilt = (Math.acos(Math.min(1, Math.abs(fit.normal.y))) * 180) / Math.PI;
      frameOp(`自動で水平に (${tilt.toFixed(1)}°)`, () => frame.rotateWorld(rotationBetween(fit.normal, new THREE.Vector3(0, 1, 0))));
      editor.setConsole(`水平にしました（傾き ${tilt.toFixed(1)}° を補正 / 床面 ${fit.inliers.toLocaleString()} 点）。次は「床に接地」`);
    },
    onFlip: (axis) => {
      frameOp(axis === "x" ? "上下反転" : "前後反転", () => frame.rotateWorld(new THREE.Quaternion().setFromAxisAngle(axis === "x" ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0), Math.PI)));
      editor.setConsole(axis === "x" ? "上下を反転しました" : "前後を反転しました");
    },
    onReset: () => { frameOp("リセット", () => frame.reset()); editor.setConsole("原点・向き・大きさをリセットしました"); },
    onFields: (s, commit) => {
      // live edits (typing) apply immediately; the history step is recorded once, on commit
      if (!fieldBefore) fieldBefore = frame.toJSON();
      const cur = frame.state;
      const rotChanged = s.rotDeg.some((v, i) => Math.abs(v - cur.rotDeg[i]) > 1e-6);
      if (rotChanged) frame.setRotationDeg(s.rotDeg[0], s.rotDeg[1], s.rotDeg[2]); // about the world origin
      else frame.setPosition(new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]));
      let k = 1;
      if (Math.abs(s.scale - cur.scale) > 1e-9) { k = s.scale / cur.scale; applyScale(k); }
      if (commit) {
        const after = frame.toJSON(), b = fieldBefore; fieldBefore = null;
        const axes = ["X", "Y", "Z"];
        const label = Math.abs(after.scale - b.scale) > 1e-9 ? `大きさ ×${(after.scale / b.scale).toFixed(3)}`
          : after.rotDeg.some((v, i) => Math.abs(v - b.rotDeg[i]) > 1e-6) ? `回転 ${after.rotDeg.map((v, i) => Math.abs(v - b.rotDeg[i]) > 1e-6 ? `${axes[i]} ${v.toFixed(1)}°` : "").filter(Boolean).join(" ")}`
          : `位置 ${after.pos.map((v, i) => Math.abs(v - b.pos[i]) > 1e-9 ? `${axes[i]} ${v.toFixed(3)} m` : "").filter(Boolean).join(" ")}`;
        recordFrameStep(label, b, after, { k: after.scale / b.scale });
      }
    },
    onSnap: (step) => gizmo.setRotationSnap(step ? THREE.MathUtils.degToRad(step) : null),
    onGizmo: (mode) => setSceneGizmo(mode),
    onMeasure: () => setPickMode(pickMode === "measure" ? "none" : "measure"),
    onMeasureApply: (real) => {
      if (measurePts.length < 2) return;
      const d = measurePts[0].distanceTo(measurePts[1]); if (!(d > 0)) return;
      frameOp(`2点間の距離で大きさ指定 (${real} m)`, () => { applyScale(real / d); return { k: real / d }; });
      panel.setMeasured(null); setPickMode("none");
      editor.setConsole(`大きさを合わせました（×${(real / d).toFixed(4)}）`);
    },
    onGuides: (g, a) => scene.setGuides(g, a),
  });
  let fieldBefore: FrameState | null = null; // state before the first live field edit of a typing session
  /** Uniform scale about the world origin; the view scales with it so nothing moves on screen (the grid changes). */
  const applyScale = (k: number) => { if (!(k > 0) || !isFinite(k)) return; frame.scaleBy(k); nav.scaleView(k, new THREE.Vector3()); };
  frame.setOnChange(() => { panel.setState(frame.state); scheduleSidecarSave(); });
  // Shift while dragging the scene gizmo = no snapping
  window.addEventListener("keydown", (e) => { if (e.key === "Shift" && gizmo.object === pivot) gizmo.setRotationSnap(null); });
  window.addEventListener("keyup", (e) => { if (e.key === "Shift" && gizmo.object === pivot) gizmo.setRotationSnap(panel.snapStep ? THREE.MathUtils.degToRad(panel.snapStep) : null); });
  // G / R = move / rotate the scene with the gizmo (toggle)
  window.addEventListener("keydown", (e) => {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey || nav.isLocked()) return;
    if (e.code === "KeyG") setSceneGizmo(gizmo.object === pivot && gizmo.mode === "translate" ? null : "translate");
    else if (e.code === "KeyR") setSceneGizmo(gizmo.object === pivot && gizmo.mode === "rotate" ? null : "rotate");
  });

  // ── sidecar: remember the un-baked transform per file (localStorage, keyed by name + size) ──
  const sidecarKey = () => (source ? `gseditor-frame:${source.name}:${source.file?.size ?? "url"}` : null);
  let sidecarTimer = 0, sidecarReady = false;
  function scheduleSidecarSave() {
    if (!sidecarReady) return;
    window.clearTimeout(sidecarTimer);
    sidecarTimer = window.setTimeout(() => {
      const key = sidecarKey(); if (!key) return;
      const state = frame.toJSON();
      try { localStorage.setItem(key, JSON.stringify(state)); } catch { /* ignore */ }
    }, 500);
  }
  async function restoreSidecar() {
    let state: any = null;
    const key = sidecarKey();
    if (key) { try { const s = localStorage.getItem(key); if (s) state = JSON.parse(s); } catch { /* ignore */ } }
    if (state && frame.fromJSON(state) && !frame.isIdentity()) {
      frameStart(); // frame the corrected scene, not the raw file
      editor.setConsole("前回の原点・向き・大きさを復元しました（リセットで元に戻せます）");
    }
  }

  // ── baked GS export ──────────────────────────────────────────────────────
  const FILE_FLIP_INV = new THREE.Matrix4().makeRotationFromQuaternion(SplatScene.FILE_FLIP.clone().invert());
  async function exportGS(fmt: GsFormat) {
    const main = splat.current;
    if (!main || !source) { editor.setConsole("書き出すシーンがありません"); return; }
    const base = source.name.replace(/\.[^.]+$/, "").replace(/_fixed$/, "") || "scene"; // re-exporting a fixed file does not stack suffixes
    const outName = `${base}_fixed.${fmt}`;
    editor.setConsole(`書き出し中… ${outName}（大きなファイルは時間がかかります）`);
    editor.setLoading(true);
    const log = (t: string) => editor.setConsole(t);
    try {
      // matrix in SOURCE-FILE coordinates: undo the viewer's OpenCV flip, keep the user's correction
      main.updateMatrixWorld(true);
      const part: BakePart = { rows: splatEdit.visibleIndices(), matrix: FILE_FLIP_INV.clone().multiply(main.matrixWorld) };
      let blob: Blob;
      try {
        const data = source.file ? new Uint8Array(await source.file.arrayBuffer()) : new Uint8Array(await (await fetch(source.url)).arrayBuffer());
        blob = await bakeFile(data, source.name, [part], splatEdit.refPoints(64), fmt, outName, log);
      } catch (e) {
        // the original could not be re-read (row order differs / too big) → bake from the viewer's own copy
        console.warn("full-quality export failed, using viewer data:", e);
        editor.setConsole(e instanceof AlignmentError ? "元ファイルと並び順が一致しないため、表示データから書き出します（基本色のみ）" : `元ファイルを読み直せないため、表示データから書き出します（基本色のみ）\n${e}`);
        blob = await bakeFromSplats([{ packed: main.packedSplats, rows: part.rows, matrix: part.matrix }], fmt, outName, log);
      }
      downloadBlob(blob, outName);
      const s = frame.state;
      editor.setConsole(`書き出し完了: ${outName}（${(blob.size / 1048576).toFixed(1)} MB）\n位置 ${s.pos.map((v) => v.toFixed(2)).join(", ")} / 回転 ${s.rotDeg.map((v) => v.toFixed(1)).join(", ")}° / 倍率 ${s.scale.toFixed(3)} を焼き込み済み`);
    } catch (e) {
      console.error(e);
      editor.setConsole(`書き出しに失敗しました: ${e}`);
    } finally { editor.setLoading(false); }
  }

  // ── eraser: PAINT a brush in the 3D view; splats under it are hidden ──
  let editMode: "clean" | "none" = "none";
  let brushRadius = 28; // screen-space px
  let painting = false;
  const brush = document.createElement("div"); brush.id = "brush"; brush.style.display = "none";
  ui.appendChild(brush);
  function setEditMode(m: "clean" | "none") {
    editMode = m;
    nav.setBoxSelecting(m !== "none"); // free the left button for painting
    if (m === "none") { painting = false; brush.style.display = "none"; }
    else if (pickMode !== "none") setPickMode("none");
  }
  const moveBrush = (clientX: number, clientY: number) => {
    const r = dom.getBoundingClientRect();
    brush.style.display = "block";
    brush.style.left = `${clientX - r.left}px`; brush.style.top = `${clientY - r.top}px`;
    brush.style.width = brush.style.height = `${brushRadius * 2}px`;
  };
  const paintAt = (clientX: number, clientY: number) => {
    const r = dom.getBoundingClientRect();
    splatEdit.paintErase(clientX - r.left, clientY - r.top, brushRadius); splat.prepare(freeCam);
  };
  dom.addEventListener("pointerdown", (e) => {
    if (editMode === "none" || e.button !== 0 || nav.isLocked()) return;
    const r = dom.getBoundingClientRect();
    splatEdit.beginStroke(freeCam, r.width, r.height, splat.current?.matrixWorld);
    painting = true; moveBrush(e.clientX, e.clientY); paintAt(e.clientX, e.clientY);
  });
  window.addEventListener("pointermove", (e) => {
    if (editMode === "none" || nav.isLocked()) { brush.style.display = "none"; return; }
    moveBrush(e.clientX, e.clientY);
    if (painting) paintAt(e.clientX, e.clientY);
  });
  window.addEventListener("pointerup", () => {
    if (!painting) return; painting = false;
    const arr = splatEdit.endStroke();
    recordErase(`ブラシで消去 (${arr.length.toLocaleString()} 粒)`, arr);
    if (arr.length) editor.setConsole(`削除: ${arr.length.toLocaleString()} splats（Ctrl+Z で取り消し）`);
  });
  window.addEventListener("keydown", (e) => {
    if (editMode !== "none" && e.code === "KeyZ" && !e.ctrlKey && !e.metaKey && !isTyping(e)) history.undo();
  });
  // hold Shift to momentarily use the eraser (only in orbit with nothing selected; Shift is the fly speed-boost otherwise)
  let shiftPrev: "clean" | "none" | null = null;
  window.addEventListener("keydown", (e) => {
    if (e.key === "Shift" && shiftPrev === null && nav.getMode() === "orbit" && !nav.isLocked() && !gizmo.object && pickMode === "none" && !isTyping(e)) {
      shiftPrev = editMode; setEditMode("clean");
    }
  });
  window.addEventListener("keyup", (e) => { if (e.key === "Shift" && shiftPrev !== null) { setEditMode(shiftPrev); shiftPrev = null; } });

  let sceneName = "no scene";
  const nameOf = (url: string) => { try { return decodeURIComponent(url.split("?")[0].split("/").pop() || "scene"); } catch { return "scene"; } };
  /** First view: the rule shared with GSレイアウター (startFrame.ts), applied through the current scene transform. */
  function frameStart() {
    const f = splat.startFrame;
    if (!f) return;
    frame.root.updateMatrixWorld(true);
    const m = frame.root.matrixWorld; // identity on load; a restored sidecar transform moves the view with the scene
    const pos = f.position.clone().applyMatrix4(m), tgt = f.target.clone().applyMatrix4(m);
    nav.setStart(pos, tgt, f.size * frame.root.scale.x);
  }

  // busy = a new GS is incoming: wipe the old scene immediately + show the centre loader
  function setBusy(b: boolean) { if (b) { deselect(); setPickMode("none"); splat.clear(); } editor.setLoading(b); }

  async function loadGS(url: string, name: string, file?: File) {
    setBusy(true);
    sidecarReady = false;
    frame.reset(); // a new file starts un-corrected (its own sidecar may restore a previous session below)
    history.clear();
    source = { url, file, name };
    try {
      await splat.load(url); sceneName = name; frameStart();
      if (splat.current) splatEdit.analyze(splat.current); // index splats for the cleanup tools
      await restoreSidecar();
    }
    catch (e) {
      console.warn("GS load failed:", e);
      editor.setConsole(`GSの読み込みに失敗しました: ${name}\nファイルが壊れているか、未対応の形式かもしれません (.ply / .spz / .splat / .ksplat)`);
    }
    finally {
      sidecarReady = true;
      setBusy(false);
      if (url.startsWith("blob:")) URL.revokeObjectURL(url); // free dropped-file memory (the File itself stays for export)
    }
  }

  // Start on the intake panel (drop target). In local dev, ?gs=<file in 01_Assets> opens
  // that scene directly (01_Assets is Vite's publicDir and is not part of the repo).
  const wanted = import.meta.env.DEV ? new URLSearchParams(location.search).get("gs") : null;
  if (wanted) { const startUrl = `/${wanted.replace(/^\/+/, "")}`; await loadGS(startUrl, nameOf(startUrl)); }
  else { editor.openIntake(); editor.setConsole("GS ファイル (.ply / .spz / .splat / .ksplat) をここにドラッグ＆ドロップするか、上の「読み込む…」から選んでください"); }

  let lockRingT = 0;
  scene.onUpdate((dt) => {
    nav.update(dt);
    if (rayEnabled && nav.isLocked()) { // crosshair ring on the splat surface ahead
      lockRingT += dt; if (lockRingT > 0.08) { lockRingT = 0; showRing(pickCenter()); }
    }
    splat.prepare(freeCam); // sort splats once per frame
    editor.setScene(sceneName, splat.splatCount);
  });
  scene.start();

  if (import.meta.env.DEV) {
    (window as any).__pl = { scene, splat, nav, editor, gizmo, freeCam, splatEdit, frame, panel, history, exportGS, THREE };
  }
  window.__gseditor_ready = true;
}

boot();
