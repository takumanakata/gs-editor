import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
import "./style.css";
import { Scene } from "./viewer/Scene";
import { SplatScene } from "./viewer/SplatScene";
import { NavControls, type ViewName } from "./viewer/NavControls";
import { ViewCube } from "./viewer/ViewCube";
import { SplatEditor, type SelectMode } from "./viewer/SplatEditor";
import { SceneFrame, type FrameState } from "./viewer/SceneFrame";
import { History } from "./viewer/History";
import { HistoryPanel } from "./ui/HistoryPanel";
import { startVfovRad } from "./viewer/startFrame";
import { Editor, type Tool } from "./ui/Editor";
import { IntakePanel } from "./ui/IntakePanel";
import { TransformPanel } from "./ui/TransformPanel";
import { AXIS_TO_THREE, toBlender } from "./ui/blenderAxes";
import { AlignmentError, bakeFile, bakeFromSplats, downloadBlob, type BakePart, type GsFormat } from "./export/exportGS";

declare global { interface Window { __gseditor_ready?: boolean; } }

type Axis = "x" | "y" | "z";
const TRANSFORM_TOOLS: Tool[] = ["move", "rotate", "scale"];
const SELECT_TOOLS: Tool[] = ["box", "circle", "lasso"];

const HINTS: Record<Tool, string> = {
  box: "左ドラッグ: 範囲選択（Shift: 追加 / Ctrl: 除外）  中ドラッグ: 回転  Shift+中: 移動  ホイール: 前後  X: 選択を削除  右クリック: メニュー",
  circle: "左ドラッグ: なぞって選択（Ctrl: 除外）  [ ]: 丸の大きさ  中ドラッグ: 回転  X: 選択を削除",
  lasso: "左ドラッグ: 囲んで選択（Shift: 追加 / Ctrl: 除外）  中ドラッグ: 回転  X: 選択を削除",
  move: "ハンドルをドラッグ  X / Y / Z: 軸を固定  数値を打って Enter  Ctrl: 刻み  Esc: 戻る",
  rotate: "リングをドラッグ（原点を中心に回る）  X / Y / Z: 軸を固定  数値を打って Enter  Ctrl: 5° 刻み  Esc: 戻る",
  scale: "ハンドルをドラッグ（原点を中心に）  数値を打って Enter（倍率）  Ctrl: 刻み  Esc: 戻る",
  measure: "2点をクリックすると距離が出ます  Esc: 戻る",
};

async function boot() {
  const stage = document.getElementById("stage")!;
  const view = document.getElementById("view")!;
  const ui = document.getElementById("ui")!;
  document.getElementById("app")!.appendChild(ui); // the shell's parts are grid items beside the stage, not inside it
  const scene = new Scene(view);
  const cam = scene.camera;
  cam.fov = THREE.MathUtils.radToDeg(startVfovRad()); cam.updateProjectionMatrix(); // same lens as the Layouter's first picture
  const nav = new NavControls(cam, scene.renderer.domElement);
  const frame = new SceneFrame(scene.scene);          // the whole-scene transform: the splat mesh lives under frame.root
  const splat = new SplatScene(scene.renderer, scene.scene, frame.root);
  const splatEdit = new SplatEditor();
  const history = new History();
  const dom = scene.renderer.domElement;

  // ── UI shell ──
  let tool: Tool = "box";
  const editor = new Editor({
    onTool: (t) => setTool(t),
    onOpenFile: (f) => intake.handleFiles([f]),
    onExport: (fmt) => void exportGS(fmt as GsFormat),
    onRestoreAll: () => restoreAll(),
    onTheme: (t) => scene.setBackground(t === "light" ? 0xd9dad4 : 0x0e110d),
    onContext: (a) => {
      if (a === "delete") deleteSelection();
      else if (a === "deselect") { splatEdit.deselectAll(); syncSelection(); }
      else if (a === "selectAll") { splatEdit.selectAll(); syncSelection(); }
      else if (a === "focus") { const p = pickAt(ctxAt.x, ctxAt.y); if (p) nav.focusOn(p); }
    },
    onFrameAll: () => frameAll(),
    onDimsVisible: (on) => setDimsVisible(on),
    onMeasureApply: (real) => {
      if (measurePts.length < 2) return;
      const d = measurePts[0].distanceTo(measurePts[1]); if (!(d > 0)) return;
      frameOp(`2点間の距離で大きさ指定 (${real} m)`, () => frame.scaleBy(real / d));
      clearMeasure(); editor.setMessage(`大きさを合わせました（×${(real / d).toFixed(4)}）`);
    },
  }, stage, ui);
  const intake = new IntakePanel(editor.mounts.intake, (url, file) => loadGS(url, file.name, file), (t) => editor.setMessage(t));
  stage.addEventListener("dragover", (e) => e.preventDefault());
  stage.addEventListener("drop", (e) => { e.preventDefault(); const files = Array.from(e.dataTransfer?.files ?? []); if (files.length) intake.handleFiles(files); });

  // ── view cube / axis views / ortho ──
  const viewCube = new ViewCube(stage, (v) => viewFrom(v), (phase, x, y) => nav.syntheticDrag(phase, x, y));
  const setOrtho = (on: boolean) => { scene.setOrtho(on); editor.setOrtho(on); };
  const viewFrom = (v: ViewName) => { nav.viewFrom(v); setOrtho(true); };
  nav.onRotateStart = () => setOrtho(false);   // Blender's auto-perspective: orbiting leaves the axis view

  // ── transform gizmo (move / rotate / scale the whole scene through a proxy at the world origin) ──
  const gizmo = new TransformControls(cam, dom);
  scene.scene.add(gizmo.getHelper());
  gizmo.getHelper().traverse((o) => o.layers.set(1));
  const tcRay = (gizmo as any).getRaycaster ? (gizmo as any).getRaycaster() : (gizmo as any)._raycaster;
  if (tcRay?.layers) tcRay.layers.enable(1);
  gizmo.size = 0.9;
  gizmo.detach();
  const pivot = new THREE.Object3D(); pivot.name = "scenePivot"; scene.scene.add(pivot);
  let pivotStart: { q: THREE.Quaternion; p: THREE.Vector3; state: FrameState } | null = null;
  gizmo.addEventListener("dragging-changed", (e) => {
    const on = !!(e as any).value;
    nav.setGizmoDragging(on);
    if (gizmo.object !== pivot) return;
    if (on) pivotStart = { q: frame.root.quaternion.clone(), p: frame.root.position.clone(), state: frame.toJSON() };
    else {
      if (pivotStart) recordFrameStep(pivotStart.state, frame.toJSON());
      pivotStart = null; pivot.position.set(0, 0, 0); pivot.quaternion.identity(); pivot.scale.setScalar(1);
    }
  });
  gizmo.addEventListener("objectChange", () => {
    if (gizmo.object !== pivot || !pivotStart) return;
    if (gizmo.mode === "rotate") frame.setWorld(pivot.quaternion.clone().multiply(pivotStart.q), pivotStart.p.clone().applyQuaternion(pivot.quaternion));
    else if (gizmo.mode === "translate") frame.setPosition(pivotStart.p.clone().add(pivot.position));
    else { // scale: the handle that moved sets the uniform factor
      const s = pivot.scale, k = [s.x, s.y, s.z].reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1);
      if (k > 0) frame.setScale(pivotStart.state.scale * k);
    }
  });
  // Ctrl = snapping (Blender)
  const setSnap = (on: boolean) => { gizmo.setTranslationSnap(on ? 0.1 : null); gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(5) : null); gizmo.setScaleSnap(on ? 0.1 : null); };
  window.addEventListener("keydown", (e) => { if (e.key === "Control") setSnap(true); });
  window.addEventListener("keyup", (e) => { if (e.key === "Control") setSnap(false); });
  window.addEventListener("blur", () => setSnap(false));
  // while the gizmo is attached, keep orbit (middle) available but let its handles win the left button
  let axisLock: Axis | null = null;
  const applyAxisLock = () => {
    const show = axisLock ? AXIS_TO_THREE[axisLock].show : null;
    gizmo.showX = !show || show === "x"; gizmo.showY = !show || show === "y"; gizmo.showZ = !show || show === "z";
  };

  // ── tools ──
  function setTool(t: Tool) {
    if (tool !== t) { cancelNumeric(); axisLock = null; }
    tool = t;
    editor.setTool(t); editor.setHint(HINTS[t]);
    if (TRANSFORM_TOOLS.includes(t)) { gizmo.setMode(t === "move" ? "translate" : t === "rotate" ? "rotate" : "scale"); gizmo.attach(pivot); applyAxisLock(); }
    else gizmo.detach();
    if (t !== "measure") clearMeasure();
    editor.hideCircle(); editor.hideRect(); editor.hideLasso();
  }

  // ── picking (surface under the cursor, for the orbit pivot / measure / focus) ──
  const ray = new THREE.Raycaster(); const ndc = new THREE.Vector2();
  const viewRect = () => dom.getBoundingClientRect();
  const pickAt = (clientX: number, clientY: number) => {
    const m = splat.current; if (!m || !splatEdit.ready) return null;
    const r = viewRect();
    ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, scene.activeCamera);
    return splatEdit.pickRay(ray.ray, m.matrixWorld);
  };
  nav.pivotProvider = (x, y) => { const m = splat.current; return (m && splatEdit.selectionCenter(m.matrixWorld)) || pickAt(x, y); };

  // ── selection gestures (left button) ──
  type Gesture = { kind: "box" | "lasso" | "circle"; x0: number; y0: number; mode: SelectMode; pts: { x: number; y: number }[]; moved: boolean; id: number };
  let gesture: Gesture | null = null;
  let circleR = 40;
  const local = (e: PointerEvent) => { const r = viewRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const modeOf = (e: PointerEvent): SelectMode => (e.ctrlKey ? "sub" : e.shiftKey ? "add" : "set");
  const projectNow = () => { const m = splat.current; const r = viewRect(); if (m) splatEdit.project(scene.activeCamera, r.width, r.height, m.matrixWorld); };
  const syncSelection = () => editor.setSelection(splatEdit.selectedCount);
  dom.addEventListener("pointerdown", (e) => {
    editor.hideContextMenu();
    if (e.button !== 0 || nav.isBlocked()) return;
    if (TRANSFORM_TOOLS.includes(tool)) { if ((gizmo as any).axis == null) clickToDeselect(e); return; }
    if (tool === "measure") { measureClick(e); return; }
    if (!splat.current) return;
    const p = local(e);
    projectNow();
    gesture = { kind: tool as "box" | "lasso" | "circle", x0: p.x, y0: p.y, mode: modeOf(e), pts: [p], moved: false, id: e.pointerId };
    dom.setPointerCapture(e.pointerId);
    if (gesture.kind === "circle") { splatEdit.selectCircle(p.x, p.y, circleR, e.ctrlKey ? "sub" : "add"); syncSelection(); }
    e.preventDefault();
  });
  dom.addEventListener("pointermove", (e) => {
    if (tool === "circle" && !nav.isBlocked()) { const p = local(e); editor.showCircle(p.x, p.y, circleR); }
    if (!gesture) return;
    const p = local(e);
    if (!gesture.moved && Math.hypot(p.x - gesture.x0, p.y - gesture.y0) < 3) return;
    gesture.moved = true;
    if (gesture.kind === "box") editor.showRect(gesture.x0, gesture.y0, p.x, p.y);
    else if (gesture.kind === "lasso") { gesture.pts.push(p); editor.showLasso(gesture.pts); }
    else { splatEdit.selectCircle(p.x, p.y, circleR, e.ctrlKey ? "sub" : "add"); syncSelection(); }
  });
  const endGesture = (e: PointerEvent) => {
    const g = gesture; if (!g) return; gesture = null;
    const p = local(e);
    if (g.kind === "box") { if (g.moved) splatEdit.selectRect(g.x0, g.y0, p.x, p.y, g.mode); else if (g.mode === "set") splatEdit.deselectAll(); }
    else if (g.kind === "lasso") { if (g.moved && g.pts.length >= 3) splatEdit.selectLasso(g.pts, g.mode); else if (!g.moved && g.mode === "set") splatEdit.deselectAll(); }
    editor.hideRect(); editor.hideLasso();
    syncSelection();
  };
  dom.addEventListener("pointerup", endGesture);
  dom.addEventListener("pointercancel", endGesture);
  dom.addEventListener("pointerleave", () => { if (tool === "circle") editor.hideCircle(); });
  let clickDown: { x: number; y: number } | null = null;
  const clickToDeselect = (e: PointerEvent) => {
    clickDown = { x: e.clientX, y: e.clientY };
    const up = (u: PointerEvent) => {
      dom.removeEventListener("pointerup", up);
      if (clickDown && Math.hypot(u.clientX - clickDown.x, u.clientY - clickDown.y) < 4 && !gizmo.dragging) { splatEdit.deselectAll(); syncSelection(); }
      clickDown = null;
    };
    dom.addEventListener("pointerup", up);
  };
  dom.addEventListener("dblclick", (e) => { const p = pickAt(e.clientX, e.clientY); if (p) nav.focusOn(p); });
  // right click → context menu
  let ctxAt = { x: 0, y: 0 };
  dom.addEventListener("contextmenu", (e) => { e.preventDefault(); ctxAt = { x: e.clientX, y: e.clientY }; if (splat.current) editor.showContextMenu(e.clientX, e.clientY, splatEdit.selectedCount > 0); });

  // ── delete / restore ──
  function deleteSelection() {
    const sel = splatEdit.selectedIndices();
    if (!sel.length) { editor.setMessage("選択されている粒がありません"); return; }
    const batch = splatEdit.hide(sel); splat.prepare(scene.activeCamera);
    history.push({ label: `削除 (${batch.length.toLocaleString()} 粒)`, undo: () => { splatEdit.restore(batch); splat.prepare(scene.activeCamera); scheduleDims(); }, redo: () => { splatEdit.hide(batch); splat.prepare(scene.activeCamera); scheduleDims(); } });
    syncSelection(); scheduleDims();
    editor.setMessage(`削除: ${batch.length.toLocaleString()} 粒（Ctrl+Z で戻せます）`);
  }
  function restoreAll() {
    const batch = splatEdit.hiddenIndices();
    if (!batch.length) { editor.setMessage("消したものはありません"); return; }
    splatEdit.restore(batch); splat.prepare(scene.activeCamera);
    history.push({ label: `全部表示に戻す (${batch.length.toLocaleString()} 粒)`, undo: () => { splatEdit.hide(batch); splat.prepare(scene.activeCamera); scheduleDims(); }, redo: () => { splatEdit.restore(batch); splat.prepare(scene.activeCamera); scheduleDims(); } });
    scheduleDims();
    editor.setMessage(`消したものを全部戻しました: ${batch.length.toLocaleString()} 粒`);
  }

  // ── history ──
  const histPanel = new HistoryPanel(editor.mounts.history, (i) => { history.goTo(i); editor.setMessage(i === 0 ? "読み込んだ状態に戻しました" : `履歴: 「${history.currentLabel}」まで`); });
  history.setOnChange(() => histPanel.render(history));
  histPanel.render(history);
  const undo = () => { const l = history.currentLabel; if (history.undo()) editor.setMessage(`元に戻しました: ${l}`); };
  const redo = () => { if (history.redo()) editor.setMessage(`やり直しました: ${history.currentLabel}`); };
  /** A scene-transform step, labelled with the Blender numbers the panel shows. */
  function recordFrameStep(before: FrameState, after: FrameState, label?: string) {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (!label) {
      const b = toBlender(before), a = toBlender(after), ax = ["X", "Y", "Z"];
      label = Math.abs(a.scale - b.scale) > 1e-9 ? `大きさ ×${(a.scale / b.scale).toFixed(3)}`
        : a.rotDeg.some((v, i) => Math.abs(v - b.rotDeg[i]) > 1e-6) ? `回転 ${a.rotDeg.map((v, i) => (Math.abs(v - b.rotDeg[i]) > 1e-6 ? `${ax[i]} ${v.toFixed(1)}°` : "")).filter(Boolean).join(" ")}`
        : `位置 ${a.pos.map((v, i) => (Math.abs(v - b.pos[i]) > 1e-9 ? `${ax[i]} ${v.toFixed(3)} m` : "")).filter(Boolean).join(" ")}`;
    }
    history.push({ label, undo: () => frame.fromJSON(before), redo: () => frame.fromJSON(after) });
  }
  const frameOp = (label: string | undefined, op: () => void) => { const before = frame.toJSON(); op(); recordFrameStep(before, frame.toJSON(), label); };

  // ── transform panel (dock) ──
  let fieldBefore: FrameState | null = null;
  const panel = new TransformPanel(editor.mounts.transform, {
    onState: (s, commit) => {
      if (!fieldBefore) fieldBefore = frame.toJSON();
      const cur = frame.state;
      if (s.rotDeg.some((v, i) => Math.abs(v - cur.rotDeg[i]) > 1e-6)) frame.setRotationDeg(s.rotDeg[0], s.rotDeg[1], s.rotDeg[2]);
      else if (Math.abs(s.scale - cur.scale) > 1e-9) frame.setScale(s.scale);
      else frame.setPosition(new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]));
      if (commit) { const b = fieldBefore; fieldBefore = null; recordFrameStep(b, frame.toJSON()); }
    },
    onReset: () => { frameOp("リセット", () => frame.reset()); editor.setMessage("原点・向き・大きさを読み込んだ状態に戻しました"); },
  });
  frame.setOnChange(() => { panel.setState(frame.state); scheduleSidecarSave(); scheduleDims(); });

  // ── numeric input (G X 1.5 ⏎ …) ──
  let numText = "";
  const numLabel = () => {
    const t = tool === "move" ? "移動" : tool === "rotate" ? "回転" : "大きさ";
    const ax = axisLock ? axisLock.toUpperCase() : tool === "scale" ? "" : tool === "move" ? "X" : "Z";
    const unit = tool === "move" ? " m" : tool === "rotate" ? "°" : " ×";
    return `${t} ${ax}: ${numText || "…"}${unit}`;
  };
  const showNumeric = () => editor.setNumInput(TRANSFORM_TOOLS.includes(tool) && (numText || axisLock) ? numLabel() : null);
  const cancelNumeric = () => { numText = ""; editor.setNumInput(null); };
  const applyNumeric = () => {
    const v = parseFloat(numText); cancelNumeric();
    if (!isFinite(v)) return;
    const axis: Axis = axisLock ?? (tool === "move" ? "x" : "z");
    const a = AXIS_TO_THREE[axis];
    if (tool === "move") frameOp(undefined, () => frame.translateWorld(a.v.clone().multiplyScalar(v)));
    else if (tool === "rotate") frameOp(undefined, () => frame.rotateWorld(new THREE.Quaternion().setFromAxisAngle(a.v, THREE.MathUtils.degToRad(v))));
    else if (tool === "scale" && v > 0) frameOp(undefined, () => frame.scaleBy(v));
  };

  // ── measure ──
  const measurePts: THREE.Vector3[] = [];
  const marker = () => { const m = new THREE.Mesh(new THREE.SphereGeometry(1, 14, 10), new THREE.MeshBasicMaterial({ color: 0xe8c07a, depthTest: false })); m.layers.set(1); m.renderOrder = 999; m.visible = false; scene.scene.add(m); return m; };
  const markers = [marker(), marker()];
  const measureLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]), new THREE.LineBasicMaterial({ color: 0xe8c07a, depthTest: false }));
  measureLine.layers.set(1); measureLine.renderOrder = 999; measureLine.visible = false; scene.scene.add(measureLine);
  const clearMeasure = () => { measurePts.length = 0; markers.forEach((k) => (k.visible = false)); measureLine.visible = false; editor.setMeasured(null); };
  const measureClick = (e: PointerEvent) => {
    const p = pickAt(e.clientX, e.clientY);
    if (!p) { editor.setMessage("そこには何もありません。粒の上をクリックしてください"); return; }
    if (measurePts.length >= 2) clearMeasure();
    measurePts.push(p);
    const k = markers[measurePts.length - 1]; k.position.copy(p); k.scale.setScalar(Math.max(0.01, cam.position.distanceTo(p) * 0.006)); k.visible = true;
    if (measurePts.length === 2) { measureLine.geometry.setFromPoints(measurePts); measureLine.visible = true; editor.setMeasured(measurePts[0].distanceTo(measurePts[1])); }
    else editor.setMessage("もう1点クリック");
  };

  // ── dimensions (the body's box, outliers excluded) ──
  const dimsBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffa028, transparent: true, opacity: 0.8, depthTest: false }));
  dimsBox.layers.set(1); dimsBox.renderOrder = 997; dimsBox.visible = false; scene.scene.add(dimsBox);
  let dimsTimer = 0, dimsOn = false;
  let lastBox: THREE.Box3 | null = null;
  const scheduleDims = () => { window.clearTimeout(dimsTimer); dimsTimer = window.setTimeout(computeDims, 180); };
  function computeDims() {
    const m = splat.current;
    if (!m || !splatEdit.ready) { editor.setDims(null); lastBox = null; return; }
    m.updateMatrixWorld(true);
    const pts = splatEdit.sampleCenters(m.matrixWorld, 60000);
    const n = pts.length / 3;
    if (n < 10) { editor.setDims(null); lastBox = null; return; }
    const lo = new THREE.Vector3(), hi = new THREE.Vector3();
    const col = new Float32Array(n);
    for (let a = 0; a < 3; a++) {
      for (let i = 0; i < n; i++) col[i] = pts[i * 3 + a];
      col.sort();
      lo.setComponent(a, col[Math.floor(n * 0.02)]); hi.setComponent(a, col[Math.min(n - 1, Math.floor(n * 0.98))]);
    }
    lastBox = new THREE.Box3(lo, hi);
    const size = lastBox.getSize(new THREE.Vector3()), c = lastBox.getCenter(new THREE.Vector3());
    editor.setDims({ w: size.x, d: size.z, h: size.y });   // Blender: X width, Y depth (three −Z), Z height (three Y)
    dimsBox.position.copy(c); dimsBox.scale.copy(size);
    dimsBox.visible = dimsOn;
  }
  function setDimsVisible(on: boolean) { dimsOn = on; dimsBox.visible = on && !!lastBox; }

  // ── keyboard ──
  const isTyping = (e: Event) => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
  window.addEventListener("keydown", (e) => {
    if (isTyping(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === "KeyZ") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && e.code === "KeyY") { e.preventDefault(); redo(); return; }
    if (ctrl || (e.altKey && e.code !== "KeyA")) return;
    const inTransform = TRANSFORM_TOOLS.includes(tool);
    // numeric entry while a transform tool is active
    if (inTransform && /^(Digit\d|Numpad\d|Period|NumpadDecimal|Minus|NumpadSubtract)$/.test(e.code) && !(e.code === "Numpad5" && !numText)) {
      const ch = e.code === "Period" || e.code === "NumpadDecimal" ? "." : e.code === "Minus" || e.code === "NumpadSubtract" ? "-" : e.code.slice(-1);
      numText += ch; showNumeric(); e.preventDefault(); return;
    }
    if (inTransform && e.code === "Backspace" && numText) { numText = numText.slice(0, -1); showNumeric(); return; }
    if (inTransform && e.code === "Enter" && numText) { applyNumeric(); return; }
    if (inTransform && /^Key[XYZ]$/.test(e.code)) { const a = e.code.slice(-1).toLowerCase() as Axis; axisLock = axisLock === a ? null : a; applyAxisLock(); showNumeric(); return; }
    switch (e.code) {
      case "Escape":
        editor.hideContextMenu();
        if (numText) cancelNumeric();
        else if (axisLock) { axisLock = null; applyAxisLock(); showNumeric(); }
        else if (tool !== "box") setTool("box");
        else { splatEdit.deselectAll(); syncSelection(); }
        return;
      case "KeyB": setTool("box"); return;
      case "KeyC": setTool("circle"); return;
      case "KeyL": setTool("lasso"); return;
      case "KeyG": setTool("move"); return;
      case "KeyR": setTool("rotate"); return;
      case "KeyS": setTool("scale"); return;
      case "KeyM": setTool("measure"); return;
      case "KeyA": if (e.altKey) splatEdit.deselectAll(); else splatEdit.selectAll(); syncSelection(); return;
      case "KeyX": case "Delete": deleteSelection(); return;
      case "BracketLeft": circleR = Math.max(6, circleR / 1.2); return;
      case "BracketRight": circleR = Math.min(400, circleR * 1.2); return;
      case "Home": frameAll(); return;
      case "Numpad1": viewFrom(e.shiftKey ? "back" : "front"); return;
      case "Numpad3": viewFrom(e.shiftKey ? "left" : "right"); return;
      case "Numpad7": viewFrom(e.shiftKey ? "bottom" : "top"); return;
      case "Numpad5": setOrtho(!scene.isOrtho); return;
    }
    if (!inTransform) { // top-row digits stand in for the numpad (laptops)
      if (e.code === "Digit1") viewFrom(e.shiftKey ? "back" : "front");
      else if (e.code === "Digit3") viewFrom(e.shiftKey ? "left" : "right");
      else if (e.code === "Digit7") viewFrom(e.shiftKey ? "bottom" : "top");
      else if (e.code === "Digit5") setOrtho(!scene.isOrtho);
    }
  });
  // Ctrl+numpad = the opposite side (Blender); handled here because the main handler bails on Ctrl
  window.addEventListener("keydown", (e) => {
    if (isTyping(e) || !e.ctrlKey) return;
    if (e.code === "Numpad1") viewFrom("back"); else if (e.code === "Numpad3") viewFrom("left"); else if (e.code === "Numpad7") viewFrom("bottom");
  });

  // ── sidecar: remember the un-baked transform per file (localStorage) ──
  let source: { url: string; file?: File; name: string } | null = null;
  const sidecarKey = () => (source ? `gseditor-frame:${source.name}:${source.file?.size ?? "url"}` : null);
  let sidecarTimer = 0, sidecarReady = false;
  function scheduleSidecarSave() {
    if (!sidecarReady) return;
    window.clearTimeout(sidecarTimer);
    sidecarTimer = window.setTimeout(() => { const key = sidecarKey(); if (!key) return; try { localStorage.setItem(key, JSON.stringify(frame.toJSON())); } catch { /* ignore */ } }, 500);
  }
  function restoreSidecar() {
    const key = sidecarKey(); if (!key) return;
    let state: any = null;
    try { const s = localStorage.getItem(key); if (s) state = JSON.parse(s); } catch { /* ignore */ }
    if (state && frame.fromJSON(state) && !frame.isIdentity()) editor.setMessage("前回の原点・向き・大きさを復元しました（リセットで元に戻せます）", 6000);
  }

  // ── export ──
  const FILE_FLIP_INV = new THREE.Matrix4().makeRotationFromQuaternion(SplatScene.FILE_FLIP.clone().invert());
  async function exportGS(fmt: GsFormat) {
    const main = splat.current;
    if (!main || !source) { editor.setMessage("書き出すシーンがありません"); return; }
    const base = source.name.replace(/\.[^.]+$/, "").replace(/_fixed$/, "") || "scene";
    const outName = `${base}_fixed.${fmt}`;
    editor.setMessage(`書き出し中… ${outName}`, 0);
    editor.setLoading(true);
    const log = (t: string) => editor.setMessage(t, 0);
    try {
      main.updateMatrixWorld(true);
      const part: BakePart = { rows: splatEdit.visibleIndices(), matrix: FILE_FLIP_INV.clone().multiply(main.matrixWorld) };
      let blob: Blob;
      try {
        const data = source.file ? new Uint8Array(await source.file.arrayBuffer()) : new Uint8Array(await (await fetch(source.url)).arrayBuffer());
        blob = await bakeFile(data, source.name, [part], splatEdit.refPoints(64), fmt, outName, log);
      } catch (e) {
        console.warn("full-quality export failed, using viewer data:", e);
        editor.setMessage(e instanceof AlignmentError ? "元ファイルと並び順が一致しないため、表示データから書き出します（基本色のみ）" : `元ファイルを読み直せないため、表示データから書き出します（基本色のみ）`, 0);
        blob = await bakeFromSplats([{ packed: main.packedSplats, rows: part.rows, matrix: part.matrix }], fmt, outName, log);
      }
      downloadBlob(blob, outName);
      const s = toBlender(frame.state);
      editor.setMessage(`書き出し完了: ${outName}（${(blob.size / 1048576).toFixed(1)} MB） 位置 ${s.pos.map((v) => v.toFixed(2)).join(", ")} / 回転 ${s.rotDeg.map((v) => v.toFixed(1)).join(", ")}° / ×${s.scale.toFixed(3)} を焼き込み済み`, 10000);
    } catch (e) {
      console.error(e);
      editor.setMessage(`書き出しに失敗しました: ${e}`, 0);
    } finally { editor.setLoading(false); }
  }

  // ── load ──
  let sceneName = "no scene";
  function frameStart() {
    const f = splat.startFrame; if (!f) return;
    frame.root.updateMatrixWorld(true);
    const m = frame.root.matrixWorld;
    nav.setStart(f.position.clone().applyMatrix4(m), f.target.clone().applyMatrix4(m), f.size * frame.root.scale.x);
  }
  function frameAll() {
    const b = lastBox ?? splat.getBoundsWorld(); if (!b) return;
    nav.frameBox(b);
  }
  async function loadGS(url: string, name: string, file?: File) {
    editor.setLoading(true); gizmo.detach(); setTool("box"); clearMeasure();
    sidecarReady = false;
    splat.clear(); frame.reset(); history.clear();
    source = { url, file, name };
    try {
      await splat.load(url); sceneName = name;
      if (splat.current) splatEdit.analyze(splat.current);
      restoreSidecar();
      frameStart(); setOrtho(false);
      computeDims();
      syncSelection();
    } catch (e) {
      console.warn("GS load failed:", e);
      editor.setMessage(`読み込めませんでした: ${name}（壊れているか、未対応の形式です: .ply / .spz / .splat / .ksplat）`, 0);
    } finally {
      sidecarReady = true;
      editor.setLoading(false);
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
  }

  setTool("box");
  const wanted = import.meta.env.DEV ? new URLSearchParams(location.search).get("gs") : null;
  if (wanted) { const startUrl = `/${wanted.replace(/^\/+/, "")}`; await loadGS(startUrl, decodeURIComponent(startUrl.split("/").pop() || "scene")); }
  else editor.setMessage("GS ファイル (.ply / .spz / .splat / .ksplat) を右の枠か画面にドラッグ＆ドロップ、または ファイル → 開く", 0);

  scene.onUpdate((dt) => {
    nav.update(dt);
    scene.syncOrtho(nav.getTarget());
    (gizmo as any).camera = scene.activeCamera;
    splat.prepare(scene.activeCamera);
    viewCube.update(cam);
    editor.setScene(sceneName, splat.splatCount);
  });
  scene.start();

  if (import.meta.env.DEV) {
    (window as any).__pl = { scene, splat, nav, editor, gizmo, cam, splatEdit, frame, panel, history, exportGS, setTool, viewFrom, loadGS, THREE, bakeFromSplats, bakeFile, FILE_FLIP_INV, get tool() { return tool; }, get source() { return source; } };
  }
  window.__gseditor_ready = true;
}

boot();
