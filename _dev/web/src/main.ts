import * as THREE from "three";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import "@tabler/icons-webfont/dist/tabler-icons.min.css";
import "./style.css";
import { Scene } from "./viewer/Scene";
import { SplatScene } from "./viewer/SplatScene";
import { NavControls, type ViewName } from "./viewer/NavControls";
import { ViewCube } from "./viewer/ViewCube";
import { SplatEditor, type SelectMode } from "./viewer/SplatEditor";
import { SceneFrame, type FrameJSON } from "./viewer/SceneFrame";
import { History } from "./viewer/History";
import { HistoryPanel } from "./ui/HistoryPanel";
import { startVfovRad } from "./viewer/startFrame";
import { Editor, type SelectVariant, type Tool } from "./ui/Editor";
import { IntakePanel } from "./ui/IntakePanel";
import { TransformPanel } from "./ui/TransformPanel";
import { AXIS_TO_THREE, toBlender } from "./ui/blenderAxes";
import { AlignmentError, bakeFile, bakeFromSplats, downloadBlob, type BakePart, type GsFormat } from "./export/exportGS";

declare global { interface Window { __gseditor_ready?: boolean; } }

type Axis = "x" | "y" | "z";
const GIZMO_TOOLS: Tool[] = ["move", "rotate", "scale", "origin"];
const VARIANT_ORDER: SelectVariant[] = ["box", "circle", "lasso"];

const HINTS: Record<string, string> = {
  box: "LMB drag: box select (Shift add, Ctrl subtract)   MMB: orbit   Shift+MMB: pan   Wheel: zoom   X: delete   W: next select tool   RMB: menu",
  circle: "LMB drag: paint select (Ctrl subtract)   [ ]: radius   MMB: orbit   Shift+MMB: pan   X: delete   W: next select tool",
  lasso: "LMB drag: lasso select (Shift add, Ctrl subtract)   MMB: orbit   Shift+MMB: pan   X: delete   W: next select tool",
  move: "Drag the handles   X / Y / Z: lock an axis   Type a number, Enter   Ctrl: snap   Alt+G: clear   Esc: back to select",
  rotate: "Drag a ring (rotates about the object origin)   X / Y / Z: lock an axis   Type degrees, Enter   Ctrl: 5° steps   Alt+R: clear",
  scale: "Drag a handle (scales about the object origin)   Type a factor, Enter   Ctrl: snap   Alt+S: clear",
  origin: "Drag the handles: move the object origin only   LMB on the scan: set the origin there   Esc: back to select",
};

async function boot() {
  const stage = document.getElementById("stage")!;
  const view = document.getElementById("view")!;
  const ui = document.getElementById("ui")!;
  const scene = new Scene(view);
  const cam = scene.camera;
  cam.fov = THREE.MathUtils.radToDeg(startVfovRad()); cam.updateProjectionMatrix(); // same lens as the Layouter's first picture
  const nav = new NavControls(cam, scene.renderer.domElement);
  const frame = new SceneFrame(scene.scene);          // the scan as an object: root transform + its own origin
  const splat = new SplatScene(scene.renderer, scene.scene, frame.root);
  const splatEdit = new SplatEditor();
  const history = new History();
  const dom = scene.renderer.domElement;

  // ── UI shell ──
  let tool: Tool = "select";
  let variant: SelectVariant = "box";
  const editor = new Editor({
    onTool: (t) => setTool(t),
    onSelectVariant: (v) => { variant = v; setTool("select"); },
    onOpenFile: (f) => intake.handleFiles([f]),
    onExport: (fmt) => void exportGS(fmt as GsFormat),
    onTheme: (t) => scene.setBackground(t === "light" ? 0xd9dad4 : 0x0e110d),
    onContext: (a) => {
      if (a === "delete") deleteSelection();
      else if (a === "invert") { splatEdit.invertSelection(); syncSelection(); }
      else if (a === "deselect") { splatEdit.deselectAll(); syncSelection(); }
      else if (a === "selectAll") { splatEdit.selectAll(); syncSelection(); }
      else if (a === "focus") { const p = pickAt(ctxAt.x, ctxAt.y); if (p) nav.focusOn(p); }
      else if (a === "setOrigin") { const p = pickAt(ctxAt.x, ctxAt.y); if (p) setOriginAt(p); else editor.setMessage("Nothing under the cursor — right-click on the scan"); }
      else if (a === "restoreAll") restoreAll();
    },
    onDimsVisible: (on) => setDimsVisible(on),
  }, stage, ui);
  const intake = new IntakePanel(editor.mounts.intake, (url, file) => loadGS(url, file.name, file), (t) => editor.setMessage(t));
  stage.addEventListener("dragover", (e) => e.preventDefault());
  stage.addEventListener("drop", (e) => { e.preventDefault(); const files = Array.from(e.dataTransfer?.files ?? []); if (files.length) intake.handleFiles(files); });

  // ── view cube / axis views / ortho / guides ──
  const viewCube = new ViewCube(stage, (v) => viewFrom(v), (phase, x, y) => nav.syntheticDrag(phase, x, y));
  const setOrtho = (on: boolean) => { scene.setOrtho(on); editor.setOrtho(on); };
  const viewFrom = (v: ViewName) => {
    nav.viewFrom(v); setOrtho(true);
    scene.setViewMode(v === "top" || v === "bottom" ? "top" : v === "front" || v === "back" ? "front" : "side");
  };
  nav.onRotateStart = () => { setOrtho(false); scene.setViewMode("persp"); };   // Blender's auto-perspective
  scene.setViewMode("persp");

  // ── gizmo: a proxy at the object origin; move / rotate / scale the scan, or move the origin alone ──
  const gizmo = new TransformControls(cam, dom);
  scene.scene.add(gizmo.getHelper());
  gizmo.getHelper().traverse((o) => o.layers.set(1));
  const tcRay = (gizmo as any).getRaycaster ? (gizmo as any).getRaycaster() : (gizmo as any)._raycaster;
  if (tcRay?.layers) tcRay.layers.enable(1);
  gizmo.size = 0.9;
  gizmo.detach();
  const proxy = new THREE.Object3D(); proxy.name = "originProxy"; scene.scene.add(proxy);
  let drag: { state: FrameJSON; lastP: THREE.Vector3; lastQ: THREE.Quaternion; lastS: THREE.Vector3 } | null = null;
  const syncProxy = () => { if (!gizmo.dragging) { proxy.position.copy(frame.worldPivot()); proxy.quaternion.identity(); proxy.scale.setScalar(1); } };
  gizmo.addEventListener("dragging-changed", (e) => {
    const on = !!(e as any).value;
    nav.setGizmoDragging(on);
    if (on) drag = { state: frame.toJSON(), lastP: proxy.position.clone(), lastQ: proxy.quaternion.clone(), lastS: proxy.scale.clone() };
    else { if (drag) recordFrameStep(drag.state, frame.toJSON(), tool === "origin" ? "原点を移動" : undefined); drag = null; syncProxy(); }
  });
  gizmo.addEventListener("objectChange", () => {
    if (!drag) return;
    if (gizmo.mode === "translate") {
      const d = proxy.position.clone().sub(drag.lastP); drag.lastP.copy(proxy.position);
      if (tool === "origin") frame.movePivotWorld(d); else frame.translateWorld(d);
    } else if (gizmo.mode === "rotate") {
      const dq = proxy.quaternion.clone().multiply(drag.lastQ.clone().invert()); drag.lastQ.copy(proxy.quaternion);
      frame.rotateAboutPivot(dq);
    } else {
      const s = proxy.scale, l = drag.lastS;
      const ks = [s.x / l.x, s.y / l.y, s.z / l.z];
      const k = ks.reduce((a, b) => (Math.abs(b - 1) > Math.abs(a - 1) ? b : a), 1);
      drag.lastS.copy(s);
      if (k > 0 && isFinite(k)) frame.scaleAboutPivot(k);
    }
  });
  const setSnap = (on: boolean) => { gizmo.setTranslationSnap(on ? 0.1 : null); gizmo.setRotationSnap(on ? THREE.MathUtils.degToRad(5) : null); gizmo.setScaleSnap(on ? 0.1 : null); };
  window.addEventListener("keydown", (e) => { if (e.key === "Control") setSnap(true); });
  window.addEventListener("keyup", (e) => { if (e.key === "Control") setSnap(false); });
  window.addEventListener("blur", () => setSnap(false));
  let axisLock: Axis | null = null;
  const applyAxisLock = () => {
    const show = axisLock ? AXIS_TO_THREE[axisLock].show : null;
    gizmo.showX = !show || show === "x"; gizmo.showY = !show || show === "y"; gizmo.showZ = !show || show === "z";
  };

  // ── tools ──
  function setTool(t: Tool) {
    if (tool !== t) { cancelNumeric(); axisLock = null; }
    tool = t;
    editor.setTool(t, variant); editor.setHint(HINTS[t === "select" ? variant : t]);
    if (GIZMO_TOOLS.includes(t) && splat.current) { gizmo.setMode(t === "rotate" ? "rotate" : t === "scale" ? "scale" : "translate"); gizmo.attach(proxy); applyAxisLock(); syncProxy(); }
    else gizmo.detach();
    editor.hideCircle(); editor.hideRect(); editor.hideLasso();
  }
  const cycleSelect = () => { if (tool !== "select") setTool("select"); else { variant = VARIANT_ORDER[(VARIANT_ORDER.indexOf(variant) + 1) % VARIANT_ORDER.length]; setTool("select"); } };

  // ── picking (surface under the cursor) ──
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
  type Gesture = { kind: SelectVariant; x0: number; y0: number; mode: SelectMode; pts: { x: number; y: number }[]; moved: boolean };
  let gesture: Gesture | null = null;
  let circleR = 40;
  const local = (e: PointerEvent) => { const r = viewRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const modeOf = (e: PointerEvent): SelectMode => (e.ctrlKey ? "sub" : e.shiftKey ? "add" : "set");
  const projectNow = () => { const m = splat.current; const r = viewRect(); if (m) splatEdit.project(scene.activeCamera, r.width, r.height, m.matrixWorld); };
  const syncSelection = () => { editor.setSelection(splatEdit.selectedCount); };
  let clickDown: { x: number; y: number } | null = null;
  dom.addEventListener("pointerdown", (e) => {
    editor.hideContextMenu();
    if (e.button !== 0 || nav.isBlocked() || !splat.current) return;
    if (GIZMO_TOOLS.includes(tool)) { if ((gizmo as any).axis == null) clickDown = { x: e.clientX, y: e.clientY }; return; }
    const p = local(e);
    projectNow();
    gesture = { kind: variant, x0: p.x, y0: p.y, mode: modeOf(e), pts: [p], moved: false };
    try { dom.setPointerCapture(e.pointerId); } catch { /* synthetic pointer */ }
    if (gesture.kind === "circle") { splatEdit.selectCircle(p.x, p.y, circleR, e.ctrlKey ? "sub" : "add"); syncSelection(); }
    e.preventDefault();
  });
  dom.addEventListener("pointermove", (e) => {
    if (tool === "select" && variant === "circle" && !nav.isBlocked()) { const p = local(e); editor.showCircle(p.x, p.y, circleR); }
    if (!gesture) return;
    const p = local(e);
    if (!gesture.moved && Math.hypot(p.x - gesture.x0, p.y - gesture.y0) < 3) return;
    gesture.moved = true;
    if (gesture.kind === "box") editor.showRect(gesture.x0, gesture.y0, p.x, p.y);
    else if (gesture.kind === "lasso") { gesture.pts.push(p); editor.showLasso(gesture.pts); }
    else { splatEdit.selectCircle(p.x, p.y, circleR, e.ctrlKey ? "sub" : "add"); syncSelection(); }
  });
  const endGesture = (e: PointerEvent) => {
    if (clickDown) { // a plain click with a gizmo tool: set the origin (origin tool) or deselect
      const c = clickDown; clickDown = null;
      if (Math.hypot(e.clientX - c.x, e.clientY - c.y) < 4 && !gizmo.dragging) {
        if (tool === "origin") { const p = pickAt(e.clientX, e.clientY); if (p) setOriginAt(p); }
        else { splatEdit.deselectAll(); syncSelection(); }
      }
    }
    const g = gesture; if (!g) return; gesture = null;
    const p = local(e);
    if (g.kind === "box") { if (g.moved) splatEdit.selectRect(g.x0, g.y0, p.x, p.y, g.mode); else if (g.mode === "set") splatEdit.deselectAll(); }
    else if (g.kind === "lasso") { if (g.moved && g.pts.length >= 3) splatEdit.selectLasso(g.pts, g.mode); else if (!g.moved && g.mode === "set") splatEdit.deselectAll(); }
    editor.hideRect(); editor.hideLasso();
    syncSelection();
  };
  dom.addEventListener("pointerup", endGesture);
  dom.addEventListener("pointercancel", endGesture);
  dom.addEventListener("pointerleave", () => editor.hideCircle());
  dom.addEventListener("dblclick", (e) => { const p = pickAt(e.clientX, e.clientY); if (p) nav.focusOn(p); });
  let ctxAt = { x: 0, y: 0 };
  dom.addEventListener("contextmenu", (e) => { e.preventDefault(); ctxAt = { x: e.clientX, y: e.clientY }; editor.showContextMenu(e.clientX, e.clientY, splatEdit.selectedCount > 0, !!splat.current); });

  // ── delete / restore ──
  function deleteSelection() {
    const sel = splatEdit.selectedIndices();
    if (!sel.length) { editor.setMessage("Nothing selected"); return; }
    const batch = splatEdit.hide(sel); splat.prepare(scene.activeCamera);
    history.push({ label: `削除 (${batch.length.toLocaleString()} 粒)`, undo: () => { splatEdit.restore(batch); afterEdit(); }, redo: () => { splatEdit.hide(batch); afterEdit(); } });
    afterEdit();
    editor.setMessage(`Deleted ${batch.length.toLocaleString()} splats (Ctrl+Z to undo)`);
  }
  function restoreAll() {
    const batch = splatEdit.hiddenIndices();
    if (!batch.length) { editor.setMessage("Nothing has been deleted"); return; }
    splatEdit.restore(batch);
    history.push({ label: `全部表示に戻す (${batch.length.toLocaleString()} 粒)`, undo: () => { splatEdit.hide(batch); afterEdit(); }, redo: () => { splatEdit.restore(batch); afterEdit(); } });
    afterEdit();
    editor.setMessage(`Restored ${batch.length.toLocaleString()} splats`);
  }
  const afterEdit = () => { splat.prepare(scene.activeCamera); syncSelection(); scheduleDims(); updateInfo(); };

  // ── history ──
  const histPanel = new HistoryPanel(editor.mounts.history, (i) => { history.goTo(i); editor.setMessage(i === 0 ? "Back to the loaded state" : `History: up to "${history.currentLabel}"`); });
  history.setOnChange(() => histPanel.render(history));
  histPanel.render(history);
  const undo = () => { const l = history.currentLabel; if (history.undo()) editor.setMessage(`Undo: ${l}`); };
  const redo = () => { if (history.redo()) editor.setMessage(`Redo: ${history.currentLabel}`); };
  /** A scene-transform step (labels in Japanese like the rest of the history, numbers in Blender terms). */
  function recordFrameStep(before: FrameJSON, after: FrameJSON, label?: string) {
    if (JSON.stringify(before) === JSON.stringify(after)) return;
    if (!label) {
      const stateOf = (j: FrameJSON) => { const save = frame.toJSON(); frame.fromJSON(j); const s = toBlender(frame.state); frame.fromJSON(save); return s; };
      const b = stateOf(before), a = stateOf(after), ax = ["X", "Y", "Z"];
      label = Math.abs(a.scale - b.scale) > 1e-9 ? `大きさ ×${(a.scale / b.scale).toFixed(3)}`
        : a.rotDeg.some((v, i) => Math.abs(v - b.rotDeg[i]) > 1e-6) ? `回転 ${a.rotDeg.map((v, i) => (Math.abs(v - b.rotDeg[i]) > 1e-6 ? `${ax[i]} ${v.toFixed(1)}°` : "")).filter(Boolean).join(" ")}`
        : a.pos.some((v, i) => Math.abs(v - b.pos[i]) > 1e-9) ? `位置 ${a.pos.map((v, i) => (Math.abs(v - b.pos[i]) > 1e-9 ? `${ax[i]} ${v.toFixed(3)} m` : "")).filter(Boolean).join(" ")}`
        : "原点を移動";
    }
    history.push({ label, undo: () => frame.fromJSON(before), redo: () => frame.fromJSON(after) });
  }
  const frameOp = (label: string | undefined, op: () => void) => { const before = frame.toJSON(); op(); recordFrameStep(before, frame.toJSON(), label); };
  const setOriginAt = (p: THREE.Vector3) => { frameOp("原点を設定", () => frame.setPivotWorld(p)); editor.setMessage("Object origin set — Alt+G puts it on the world origin"); };

  // ── transform panel (dock) ──
  let fieldBefore: FrameJSON | null = null;
  const panel = new TransformPanel(editor.mounts.transform, {
    onState: (s, commit) => {
      if (!fieldBefore) fieldBefore = frame.toJSON();
      const cur = frame.state;
      if (s.rotDeg.some((v, i) => Math.abs(v - cur.rotDeg[i]) > 1e-6)) frame.setRotationDeg(s.rotDeg[0], s.rotDeg[1], s.rotDeg[2]);
      else if (Math.abs(s.scale - cur.scale) > 1e-9) frame.setScale(s.scale);
      else frame.setLocationWorld(new THREE.Vector3(s.pos[0], s.pos[1], s.pos[2]));
      if (commit) { const b = fieldBefore; fieldBefore = null; recordFrameStep(b, frame.toJSON()); }
    },
    onClear: (what) => clearTransform(what),
    onReset: () => { frameOp("リセット", () => frame.reset()); editor.setMessage("Transform reset to the file as loaded"); },
  });
  const clearTransform = (what: "location" | "rotation" | "scale") => {
    if (!splat.current) return;
    if (what === "location") frameOp("位置をクリア", () => frame.clearLocation());
    else if (what === "rotation") frameOp("回転をクリア", () => frame.clearRotation());
    else frameOp("大きさをクリア", () => frame.clearScale());
  };
  frame.setOnChange(() => { panel.setState(frame.state); scheduleSidecarSave(); scheduleDims(); syncProxy(); });

  // ── numeric input (G X 1.5 ⏎ …) ──
  let numText = "";
  const numLabel = () => {
    const t = tool === "move" ? "Move" : tool === "rotate" ? "Rotate" : tool === "scale" ? "Scale" : "Move origin";
    const ax = axisLock ? axisLock.toUpperCase() : tool === "scale" ? "" : tool === "rotate" ? "Z" : "X";
    const unit = tool === "rotate" ? "°" : tool === "scale" ? " ×" : " m";
    return `${t} ${ax}: ${numText || "…"}${unit}`;
  };
  const showNumeric = () => editor.setNumInput(GIZMO_TOOLS.includes(tool) && (numText || axisLock) ? numLabel() : null);
  const cancelNumeric = () => { numText = ""; editor.setNumInput(null); };
  const applyNumeric = () => {
    const v = parseFloat(numText); cancelNumeric();
    if (!isFinite(v)) return;
    const axis: Axis = axisLock ?? (tool === "rotate" ? "z" : "x");
    const a = AXIS_TO_THREE[axis];
    if (tool === "move") frameOp(undefined, () => frame.translateWorld(a.v.clone().multiplyScalar(v)));
    else if (tool === "origin") frameOp("原点を移動", () => frame.movePivotWorld(a.v.clone().multiplyScalar(v)));
    else if (tool === "rotate") frameOp(undefined, () => frame.rotateAboutPivot(new THREE.Quaternion().setFromAxisAngle(a.v, THREE.MathUtils.degToRad(v))));
    else if (tool === "scale" && v > 0) frameOp(undefined, () => frame.scaleAboutPivot(v));
  };

  // ── dimensions (the body's box, outliers excluded) + labels in the viewport ──
  const dimsBox = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffa028, transparent: true, opacity: 0.8, depthTest: false }));
  dimsBox.layers.set(1); dimsBox.renderOrder = 997; dimsBox.visible = false; scene.scene.add(dimsBox);
  let dimsTimer = 0, dimsOn = false, lastBox: THREE.Box3 | null = null;
  const scheduleDims = () => { window.clearTimeout(dimsTimer); dimsTimer = window.setTimeout(computeDims, 180); };
  function computeDims() {
    const m = splat.current;
    if (!m || !splatEdit.ready) { editor.setDims(null); lastBox = null; dimsBox.visible = false; return; }
    m.updateMatrixWorld(true);
    const pts = splatEdit.sampleCenters(m.matrixWorld, 60000);
    const n = pts.length / 3;
    if (n < 10) { editor.setDims(null); lastBox = null; dimsBox.visible = false; return; }
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
  function setDimsVisible(on: boolean) { dimsOn = on; dimsBox.visible = on && !!lastBox; if (!on) editor.setDimLabels([null, null, null]); }
  const tmpV = new THREE.Vector3();
  function updateDimLabels() {
    if (!dimsOn || !lastBox) return;
    const b = lastBox, r = viewRect();
    const camPos = scene.activeCamera.position;
    // edge midpoints on the side of the box nearest the camera, so labels sit in front
    const nx = camPos.x > (b.min.x + b.max.x) / 2 ? b.max.x : b.min.x;
    const nz = camPos.z > (b.min.z + b.max.z) / 2 ? b.max.z : b.min.z;
    const size = b.getSize(new THREE.Vector3());
    const pts = [
      { p: new THREE.Vector3((b.min.x + b.max.x) / 2, b.min.y, nz), text: `W ${size.x.toFixed(2)} m` },
      { p: new THREE.Vector3(nx, b.min.y, (b.min.z + b.max.z) / 2), text: `D ${size.z.toFixed(2)} m` },
      { p: new THREE.Vector3(nx, (b.min.y + b.max.y) / 2, nz), text: `H ${size.y.toFixed(2)} m` },
    ];
    editor.setDimLabels(pts.map(({ p, text }) => {
      tmpV.copy(p).project(scene.activeCamera);
      if (tmpV.z < -1 || tmpV.z > 1) return null;
      return { x: (tmpV.x * 0.5 + 0.5) * r.width, y: (-tmpV.y * 0.5 + 0.5) * r.height, text };
    }));
  }

  // ── info ──
  const updateInfo = () => {
    if (!source) { editor.setInfo(null); return; }
    editor.setInfo({ name: source.name, format: (source.name.split(".").pop() || "").toLowerCase(), bytes: source.file?.size ?? 0, total: splatEdit.count, visible: splatEdit.count - splatEdit.hiddenCount });
  };

  // ── keyboard ──
  const isTyping = (e: Event) => { const t = e.target as HTMLElement | null; return !!t && (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA" || t.isContentEditable); };
  window.addEventListener("keydown", (e) => {
    if (isTyping(e)) return;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ctrl && e.code === "KeyZ") { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (ctrl && e.code === "KeyY") { e.preventDefault(); redo(); return; }
    if (ctrl && e.code === "KeyI") { e.preventDefault(); splatEdit.invertSelection(); syncSelection(); return; }
    if (ctrl && e.code === "Numpad1") { viewFrom("back"); return; }
    if (ctrl && e.code === "Numpad3") { viewFrom("left"); return; }
    if (ctrl && e.code === "Numpad7") { viewFrom("bottom"); return; }
    if (ctrl) return;
    if (e.altKey) {
      if (e.code === "KeyA") { splatEdit.deselectAll(); syncSelection(); e.preventDefault(); }
      else if (e.code === "KeyG") { clearTransform("location"); e.preventDefault(); }
      else if (e.code === "KeyR") { clearTransform("rotation"); e.preventDefault(); }
      else if (e.code === "KeyS") { clearTransform("scale"); e.preventDefault(); }
      return;
    }
    const inGizmo = GIZMO_TOOLS.includes(tool);
    if (inGizmo && /^(Digit\d|Numpad\d|Period|NumpadDecimal|Minus|NumpadSubtract)$/.test(e.code)) {
      const ch = e.code === "Period" || e.code === "NumpadDecimal" ? "." : e.code === "Minus" || e.code === "NumpadSubtract" ? "-" : e.code.slice(-1);
      numText += ch; showNumeric(); e.preventDefault(); return;
    }
    if (inGizmo && e.code === "Backspace" && numText) { numText = numText.slice(0, -1); showNumeric(); return; }
    if (inGizmo && e.code === "Enter" && numText) { applyNumeric(); return; }
    if (inGizmo && /^Key[XYZ]$/.test(e.code)) { const a = e.code.slice(-1).toLowerCase() as Axis; axisLock = axisLock === a ? null : a; applyAxisLock(); showNumeric(); return; }
    switch (e.code) {
      case "Escape":
        editor.hideContextMenu();
        if (numText) cancelNumeric();
        else if (axisLock) { axisLock = null; applyAxisLock(); showNumeric(); }
        else if (tool !== "select") setTool("select");
        else { splatEdit.deselectAll(); syncSelection(); }
        return;
      case "KeyW": cycleSelect(); return;
      case "KeyB": variant = "box"; setTool("select"); return;
      case "KeyC": variant = "circle"; setTool("select"); return;
      case "KeyL": variant = "lasso"; setTool("select"); return;
      case "KeyG": setTool("move"); return;
      case "KeyR": setTool("rotate"); return;
      case "KeyS": setTool("scale"); return;
      case "KeyO": setTool("origin"); return;
      case "KeyA": splatEdit.selectAll(); syncSelection(); return;
      case "KeyX": case "Delete": deleteSelection(); return;
      case "BracketLeft": circleR = Math.max(6, circleR / 1.2); return;
      case "BracketRight": circleR = Math.min(400, circleR * 1.2); return;
      case "Home": frameAll(); return;
      case "Numpad1": viewFrom(e.shiftKey ? "back" : "front"); return;
      case "Numpad3": viewFrom(e.shiftKey ? "left" : "right"); return;
      case "Numpad7": viewFrom(e.shiftKey ? "bottom" : "top"); return;
      case "Numpad5": setOrtho(!scene.isOrtho); return;
    }
    if (!inGizmo) { // top-row digits stand in for the numpad (laptops)
      if (e.code === "Digit1") viewFrom(e.shiftKey ? "back" : "front");
      else if (e.code === "Digit3") viewFrom(e.shiftKey ? "left" : "right");
      else if (e.code === "Digit7") viewFrom(e.shiftKey ? "bottom" : "top");
      else if (e.code === "Digit5") setOrtho(!scene.isOrtho);
    }
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
    if (state && frame.fromJSON(state) && !frame.isIdentity()) editor.setMessage("Restored the previous origin / rotation / scale for this file (Reset undoes it)", 6000);
  }

  // ── export ──
  const FILE_FLIP_INV = new THREE.Matrix4().makeRotationFromQuaternion(SplatScene.FILE_FLIP.clone().invert());
  async function exportGS(fmt: GsFormat) {
    const main = splat.current;
    if (!main || !source) { editor.setMessage("Nothing to export"); return; }
    const base = source.name.replace(/\.[^.]+$/, "").replace(/_fixed$/, "") || "scene";
    const outName = `${base}_fixed.${fmt}`;
    editor.setMessage(`Exporting ${outName}…`, 0);
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
        editor.setMessage(e instanceof AlignmentError ? "Row order differs from the source: exporting the viewer data (base color only)" : "Could not re-read the source: exporting the viewer data (base color only)", 0);
        blob = await bakeFromSplats([{ packed: main.packedSplats, rows: part.rows, matrix: part.matrix }], fmt, outName, log);
      }
      downloadBlob(blob, outName);
      const s = toBlender(frame.state);
      editor.setMessage(`Exported ${outName} (${(blob.size / 1048576).toFixed(1)} MB) — location ${s.pos.map((v) => v.toFixed(2)).join(", ")} / rotation ${s.rotDeg.map((v) => v.toFixed(1)).join(", ")}° / ×${s.scale.toFixed(3)} baked in`, 10000);
    } catch (e) {
      console.error(e);
      editor.setMessage(`Export failed: ${e}`, 0);
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
  function frameAll() { const b = lastBox ?? splat.getBoundsWorld(); if (b) nav.frameBox(b); }
  async function loadGS(url: string, name: string, file?: File) {
    editor.setLoading(true); gizmo.detach(); setTool("select");
    sidecarReady = false;
    splat.clear(); frame.reset(); history.clear();
    source = { url, file, name };
    try {
      await splat.load(url); sceneName = name;
      if (splat.current) splatEdit.analyze(splat.current);
      restoreSidecar();
      frameStart(); setOrtho(false); scene.setViewMode("persp");
      scene.objOrigin.visible = true;
      computeDims(); syncSelection(); updateInfo();
    } catch (e) {
      console.warn("GS load failed:", e);
      editor.setMessage(`Could not load ${name} (damaged, or not a supported format: .ply / .spz / .splat / .ksplat)`, 0);
    } finally {
      sidecarReady = true;
      editor.setLoading(false);
      if (url.startsWith("blob:")) URL.revokeObjectURL(url);
    }
  }

  setTool("select");
  const wanted = import.meta.env.DEV ? new URLSearchParams(location.search).get("gs") : null;
  if (wanted) { const startUrl = `/${wanted.replace(/^\/+/, "")}`; await loadGS(startUrl, decodeURIComponent(startUrl.split("/").pop() || "scene")); }
  else editor.setMessage("Drop a GS file (.ply / .spz / .splat / .ksplat) anywhere, or use ファイルを選択 on the right", 0);

  scene.onUpdate((dt) => {
    nav.update(dt);
    scene.syncOrtho(nav.getTarget());
    (gizmo as any).camera = scene.activeCamera;
    if (splat.current) { scene.objOrigin.position.copy(frame.worldPivot()); syncProxy(); }
    splat.prepare(scene.activeCamera);
    viewCube.update(cam);
    updateDimLabels();
  });
  scene.start();

  if (import.meta.env.DEV) {
    (window as any).__pl = { scene, splat, nav, editor, gizmo, cam, splatEdit, frame, panel, history, exportGS, setTool, viewFrom, loadGS, THREE, bakeFromSplats, bakeFile, FILE_FLIP_INV, get tool() { return tool; }, get variant() { return variant; }, get source() { return source; }, get sceneName() { return sceneName; } };
  }
  window.__gseditor_ready = true;
}

boot();
