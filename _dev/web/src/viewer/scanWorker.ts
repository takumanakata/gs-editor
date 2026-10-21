/**
 * Every per-splat loop of one scan, off the main thread, at FULL resolution.
 *
 * The page draws a thinned copy of a big scan (a chosen subset, see ScanData); this
 * worker keeps the truth for all n splats — selection, deletion, clip — so what gets
 * deleted and exported is decided on every splat, not on what happens to be drawn.
 * Each reply carries the changes for the drawn splats (full index i → drawn index
 * dmap[i], or i itself when everything is drawn) so the page can tint / hide just those.
 *
 * Messages run one at a time in arrival order, so the page may fire several and only
 * await the last.
 */
import { halfTable } from "./half";

const HIDDEN = 1, CLIP = 2, SEL = 4;
const OFF = -32768; // projection sentinel: behind the camera, off far out, or not shown

let n = 0;
let idx: Uint32Array | null = null;  // drawn index → full index (null: all drawn, same order)
let dmap: Int32Array | null = null;  // full index → drawn index, −1 if not drawn
let c: Uint16Array;      // 3n centre halves (file space)
let st: Uint8Array;      // n state bits
let sx: Int16Array | null = null, sy: Int16Array | null = null; // last projection (pixels)
const H = halfTable();
let selCount = 0, hidCount = 0, clipCount = 0;
let sumX = 0, sumY = 0, sumZ = 0; // centroid of the selection (file space)
let mark: Uint8Array;    // drawn indices touched by the current op
let touched: number[] = [];

type Shape =
  | { kind: "rect"; l: number; t: number; r: number; b: number }
  | { kind: "circles"; pts: number[]; r: number }
  | { kind: "lasso"; pts: number[] };
type Mode = "set" | "add" | "sub";
export interface VolDesc { kind: "box" | "sphere"; cx: number; cy: number; cz: number; sx: number; sy: number; sz: number; r: number; inside: boolean }

const touch = (i: number) => {
  const j = dmap ? dmap[i] : i;
  if (j < 0) return;
  if (!mark[j]) { mark[j] = 1; touched.push(j); }
};
function setDrawn(list: Uint32Array | null) {
  idx = list; dmap = null;
  if (list) { dmap = new Int32Array(n).fill(-1); for (let j = 0; j < list.length; j++) dmap[list[j]] = j; }
  mark = new Uint8Array(list ? list.length : n); touched = [];
}
const setSel = (i: number, on: boolean) => {
  const was = (st[i] & SEL) !== 0;
  if (was === on) return false;
  const j = i * 3, x = H[c[j]], y = H[c[j + 1]], z = H[c[j + 2]];
  if (on) { st[i] |= SEL; selCount++; sumX += x; sumY += y; sumZ += z; }
  else { st[i] &= ~SEL; selCount--; sumX -= x; sumY -= y; sumZ -= z; }
  touch(i);
  return true;
};
/** The reply after any state change: counts, centroid, and the drawn splats that changed. */
function delta(changed = 0) {
  const d = new Uint32Array(touched.length), ds = new Uint8Array(touched.length);
  for (let q = 0; q < touched.length; q++) { const j = touched[q]; d[q] = j; ds[q] = st[idx ? idx[j] : j]; mark[j] = 0; }
  touched = [];
  if (!selCount) { sumX = sumY = sumZ = 0; } // drift guard
  return {
    value: { sel: selCount, hidden: hidCount, clipped: clipCount, changed, centroid: selCount ? [sumX / selCount, sumY / selCount, sumZ / selCount] : null, d, ds },
    transfer: [d.buffer, ds.buffer],
  };
}

function project(m: number[], w: number, h: number) {
  if (!sx || sx.length !== n) { sx = new Int16Array(n); sy = new Int16Array(n); }
  const [a0, a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11, a12, a13, a14, a15] = m; // column-major
  const X = sx, Y = sy!;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    if (st[i] & (HIDDEN | CLIP)) { X[i] = OFF; continue; }
    const x = H[c[j]], y = H[c[j + 1]], z = H[c[j + 2]];
    const cw = a3 * x + a7 * y + a11 * z + a15;
    if (cw <= 0) { X[i] = OFF; continue; }
    const cz = (a2 * x + a6 * y + a10 * z + a14) / cw;
    if (cz < -1 || cz > 1) { X[i] = OFF; continue; }
    const px = ((a0 * x + a4 * y + a8 * z + a12) / cw * 0.5 + 0.5) * w;
    const py = (-(a1 * x + a5 * y + a9 * z + a13) / cw * 0.5 + 0.5) * h;
    if (px < -30000 || px > 30000 || py < -30000 || py > 30000) { X[i] = OFF; continue; }
    X[i] = px; Y[i] = py;
  }
}

function inside(shape: Shape): (x: number, y: number) => boolean {
  if (shape.kind === "rect") { const { l, t, r, b } = shape; return (x, y) => x >= l && x <= r && y >= t && y <= b; }
  if (shape.kind === "circles") {
    const p = shape.pts, r2 = shape.r * shape.r;
    return (x, y) => { for (let q = 0; q < p.length; q += 2) { const dx = x - p[q], dy = y - p[q + 1]; if (dx * dx + dy * dy <= r2) return true; } return false; };
  }
  const p = shape.pts;
  let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
  for (let q = 0; q < p.length; q += 2) { minx = Math.min(minx, p[q]); maxx = Math.max(maxx, p[q]); miny = Math.min(miny, p[q + 1]); maxy = Math.max(maxy, p[q + 1]); }
  return (x, y) => {
    if (x < minx || x > maxx || y < miny || y > maxy) return false;
    let inn = false;
    for (let a = 0, b = p.length - 2; a < p.length; b = a, a += 2) {
      const ax = p[a], ay = p[a + 1], bx = p[b], by = p[b + 1];
      if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inn = !inn;
    }
    return inn;
  };
}
/** Bounding box of a shape in pixels — most splats fail this cheap test first. */
function bounds(shape: Shape): [number, number, number, number] {
  if (shape.kind === "rect") return [shape.l, shape.t, shape.r, shape.b];
  const p = shape.pts, pad = shape.kind === "circles" ? shape.r : 0;
  let l = Infinity, t = Infinity, r = -Infinity, b = -Infinity;
  for (let q = 0; q < p.length; q += 2) { l = Math.min(l, p[q]); r = Math.max(r, p[q]); t = Math.min(t, p[q + 1]); b = Math.max(b, p[q + 1]); }
  return [l - pad, t - pad, r + pad, b + pad];
}

function select(shape: Shape, mode: Mode) {
  if (!sx) return delta();
  const exact = shape.kind === "rect" ? null : inside(shape), [l, t, r, b] = bounds(shape);
  const X = sx, Y = sy!, want = mode !== "sub";
  let changed = 0;
  // hot loop: no calls unless a splat is inside the shape's box or its state has to change
  for (let i = 0; i < n; i++) {
    const x = X[i], s = st[i];
    let inn = false;
    if (x !== OFF && !(s & (HIDDEN | CLIP)) && x >= l && x <= r) { const y = Y[i]; inn = y >= t && y <= b && (!exact || exact(x, y)); }
    const on = (s & SEL) !== 0;
    if (mode === "set") { if (inn !== on) { setSel(i, inn); changed++; } }
    else if (inn && on !== want) { setSel(i, want); changed++; }
  }
  return delta(changed);
}

function clip(m: number[], vols: VolDesc[]) {
  let changed = 0;
  const [e0, e1, e2, , e4, e5, e6, , e8, e9, e10, , e12, e13, e14] = m;
  for (let i = 0, j = 0; i < n; i++, j += 3) {
    let out = false;
    if (vols.length) {
      const x = H[c[j]], y = H[c[j + 1]], z = H[c[j + 2]];
      const wx = e0 * x + e4 * y + e8 * z + e12, wy = e1 * x + e5 * y + e9 * z + e13, wz = e2 * x + e6 * y + e10 * z + e14;
      for (const v of vols) {
        let inn: boolean;
        if (v.kind === "box") inn = Math.abs(wx - v.cx) <= v.sx / 2 && Math.abs(wy - v.cy) <= v.sy / 2 && Math.abs(wz - v.cz) <= v.sz / 2;
        else { const dx = wx - v.cx, dy = wy - v.cy, dz = wz - v.cz; inn = dx * dx + dy * dy + dz * dz <= v.r * v.r; }
        if (v.inside ? !inn : inn) { out = true; break; }
      }
    }
    const was = (st[i] & CLIP) !== 0;
    if (was === out) continue;
    if (out) { st[i] |= CLIP; clipCount++; setSel(i, false); } else { st[i] &= ~CLIP; clipCount--; }
    touch(i); changed++;
  }
  return delta(changed);
}

function hideIdx(idx: Uint32Array | number[], on: boolean) {
  for (const i of idx) {
    const was = (st[i] & HIDDEN) !== 0;
    if (was === on) continue;
    if (on) { setSel(i, false); st[i] |= HIDDEN; hidCount++; } else { st[i] &= ~HIDDEN; hidCount--; }
    touch(i);
  }
}

const ops: Record<string, (a: any) => { value: any; transfer?: Transferable[] } | any> = {
  init(a: { halves: Uint16Array; n: number; idx: Uint32Array | null }) {
    c = a.halves; n = a.n; st = new Uint8Array(n);
    selCount = hidCount = clipCount = 0; sumX = sumY = sumZ = 0; sx = sy = null;
    setDrawn(a.idx);
    return true;
  },
  /** Change which splats are drawn; returns the state of every drawn splat. */
  setDrawn(a: { idx: Uint32Array | null }) {
    setDrawn(a.idx);
    const m = idx ? idx.length : n, s = new Uint8Array(m);
    for (let j = 0; j < m; j++) s[j] = st[idx ? idx[j] : j];
    return { value: s, transfer: [s.buffer] };
  },
  project(a: { m: number[]; w: number; h: number }) { project(a.m, a.w, a.h); return true; },
  select(a: { shape: Shape; mode: Mode }) { return select(a.shape, a.mode); },
  hit(a: { x: number; y: number; r: number }) {
    if (!sx) return false;
    const r2 = a.r * a.r, X = sx, Y = sy!;
    for (let i = 0; i < n; i++) { const x = X[i]; if (x === OFF || st[i] & (HIDDEN | CLIP)) continue; const dx = x - a.x, dy = Y[i] - a.y; if (dx * dx + dy * dy <= r2) return true; }
    return false;
  },
  selectAll() { for (let i = 0; i < n; i++) if (!(st[i] & (HIDDEN | CLIP))) setSel(i, true); return delta(); },
  deselectAll() { if (selCount) for (let i = 0; i < n; i++) if (st[i] & SEL) setSel(i, false); return delta(); },
  invert() { for (let i = 0; i < n; i++) if (!(st[i] & (HIDDEN | CLIP))) setSel(i, !(st[i] & SEL)); return delta(); },
  /** Delete the selection; the reply's `batch` is the undo record (full indices). */
  hideSelected() {
    const out = new Uint32Array(selCount); let q = 0;
    for (let i = 0; i < n && q < out.length; i++) if (st[i] & SEL) out[q++] = i;
    hideIdx(out, true);
    const r = delta();
    return { value: { ...r.value, batch: out }, transfer: [...r.transfer, out.buffer] }; // nothing kept here: the page's history owns it
  },
  hide(a: { batch: Uint32Array }) { hideIdx(a.batch, true); return delta(); },
  restore(a: { batch: Uint32Array }) { hideIdx(a.batch, false); return delta(); },
  clip(a: { m: number[]; vols: VolDesc[] }) { return clip(a.m, a.vols); },
  /** Up to maxN shown centres (file space), evenly spread — for the dimensions. */
  sample(a: { maxN: number }) {
    let v = 0; for (let i = 0; i < n; i++) if (!(st[i] & (HIDDEN | CLIP))) v++;
    const step = Math.max(1, Math.ceil(v / a.maxN));
    const out = new Float32Array(Math.ceil(v / step) * 3); let o = 0, seen = 0;
    for (let i = 0, j = 0; i < n; i++, j += 3) {
      if (st[i] & (HIDDEN | CLIP)) continue;
      if (seen++ % step) continue;
      out[o++] = H[c[j]]; out[o++] = H[c[j + 1]]; out[o++] = H[c[j + 2]];
    }
    const res = out.slice(0, o);
    return { value: res, transfer: [res.buffer] };
  },
  /** Rows the export keeps: every splat not deleted (clip volumes are a view aid only). */
  exportRows() {
    const out = new Uint32Array(n - hidCount); let q = 0;
    for (let i = 0; i < n; i++) if (!(st[i] & HIDDEN)) out[q++] = i;
    return { value: out, transfer: [out.buffer] };
  },
  refPoints(a: { count: number }) {
    const out: { index: number; x: number; y: number; z: number }[] = [];
    const step = Math.max(1, Math.floor(n / a.count));
    for (let i = 0; i < n && out.length < a.count; i += step) out.push({ index: i, x: H[c[i * 3]], y: H[c[i * 3 + 1]], z: H[c[i * 3 + 2]] });
    return out;
  },
};

const ctx = self as unknown as { postMessage(m: unknown, t?: Transferable[]): void; onmessage: ((e: MessageEvent) => void) | null };
ctx.onmessage = (e: MessageEvent) => {
  const { id, op, args } = e.data as { id: number; op: string; args: any };
  try {
    const r = ops[op](args);
    if (r && typeof r === "object" && "value" in r && !ArrayBuffer.isView(r)) ctx.postMessage({ id, value: r.value }, r.transfer ?? []);
    else ctx.postMessage({ id, value: r });
  } catch (err) {
    ctx.postMessage({ id, error: String((err as Error)?.stack || err) });
  }
};
