import * as THREE from "three";
import { PackedSplats } from "@sparkjsdev/spark";
import { centreHalves, halfTable } from "./half";
import type { VolDesc } from "./scanWorker";

/**
 * One loaded scan: the FULL splats (CPU only, never drawn when the scan is big), a
 * worker that owns every per-splat decision at full resolution (scanWorker.ts), and
 * the copy that is actually drawn.
 *
 * Big scans are drawn thinned ("Light"): the LIGHT_MAX splats that cover the most
 * (largest, most opaque — floaters included, which is what a cleanup needs to see),
 * each a little larger so the surface stays closed. Selecting, deleting, clipping and
 * exporting still act on every splat — the drawn copy only mirrors the state of the
 * splats it contains. Small scans (≤ LIGHT_MAX) are drawn whole, as before.
 */
export const LIGHT_MAX = 3_000_000;
export type SelectMode = "set" | "add" | "sub";
export type Shape =
  | { kind: "rect"; l: number; t: number; r: number; b: number }
  | { kind: "circles"; pts: number[]; r: number }
  | { kind: "lasso"; pts: number[] };
export type { VolDesc };
interface Delta { sel: number; hidden: number; clipped: number; changed: number; centroid: number[] | null; d: Uint32Array; ds: Uint8Array }

const HIDDEN = 1, CLIP = 2, SEL = 4;
const SEL_RGB = [1.0, 0.627, 0.157]; // Blender's selection orange
const SEL_MIX = 0.65;
const SH_WORDS: Record<number, number> = { 1: 2, 2: 4, 3: 4 };

/** Free a PackedSplats' GPU textures but keep its data (it may be drawn again later). */
function freeGpu(ps: PackedSplats) {
  const p = ps as any;
  p.target?.dispose(); p.target = null;
  p.source?.dispose(); p.source = null;
  for (const key in p.extra) { const t = p.extra[key]?.value; if (t?.isTexture) t.dispose(); }
  ps.needsUpdate = true;
}

export class ScanData {
  /** Pending-work callback for a "working…" note: true when an op runs longer than a moment. */
  static onBusy: ((busy: boolean) => void) | null = null;
  private static inflight = 0;
  private static busyTimer = 0;
  private static busyShown = false;

  /** How Light picks its splats, and how much it enlarges them (size × ratio^bumpExp). Dev knobs: ?thin=stride|area&bump=… */
  static thin: "stride" | "area" = "area";
  static bumpExp = 1 / 8;

  readonly n: number;
  /** Light: drawing a thinned subset (only offered when n > max). */
  light: boolean;
  /** Drawn index → full index; null when every splat is drawn. */
  private drawnIdx: Uint32Array | null = null;
  get drawnCount() { return this.drawnIdx ? this.drawnIdx.length : this.n; }
  /** About how many splats each drawn one stands for (1 = all drawn). */
  get ratio() { return this.n / this.drawnCount; }
  display!: PackedSplats;
  selected = 0; hidden = 0; clipped = 0;
  ready = false;
  private orig0!: Uint32Array; // drawn copy: original colour words
  private orig3!: Uint32Array; // drawn copy: original scale words (Light: already enlarged)
  private dst!: Uint8Array;    // drawn copy: state bits (mirror of the worker's)
  private centroid: number[] | null = null;
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  private last: Promise<unknown> = Promise.resolve();
  private selByte: number[];

  constructor(readonly full: PackedSplats, light: boolean, readonly max = LIGHT_MAX) {
    this.n = full.numSplats;
    this.light = light && this.n > max;
    this.worker = new Worker(new URL("./scanWorker.ts", import.meta.url), { type: "module" });
    this.worker.onmessage = (e) => {
      const { id, value, error } = e.data;
      const p = this.pending.get(id); if (!p) return;
      this.pending.delete(id);
      ScanData.done();
      if (error) p.rej(new Error(error)); else p.res(value);
    };
    const enc = full.splatEncoding ?? {};
    const lo = enc.rgbMin ?? 0, hi = enc.rgbMax ?? 1;
    this.selByte = SEL_RGB.map((v) => Math.max(0, Math.min(255, Math.round(((v - lo) / (hi - lo)) * 255))));
  }

  private static start() {
    if (ScanData.inflight++ === 0) ScanData.busyTimer = window.setTimeout(() => { ScanData.busyShown = true; ScanData.onBusy?.(true); }, 500);
  }
  private static done() {
    if (--ScanData.inflight > 0) return;
    window.clearTimeout(ScanData.busyTimer);
    if (ScanData.busyShown) { ScanData.busyShown = false; ScanData.onBusy?.(false); }
  }
  private call<T>(op: string, args?: unknown, transfer: Transferable[] = []): Promise<T> {
    const id = ++this.seq;
    ScanData.start();
    const p = new Promise<T>((res, rej) => this.pending.set(id, { res, rej }));
    this.worker.postMessage({ id, op, args }, transfer);
    this.last = p.catch(() => undefined);
    return p;
  }
  /** Resolves once everything sent so far has been processed (the worker runs in order). */
  idle() { return this.last; }

  /** Hand the centres to the worker and build the drawn copy. */
  async init() {
    this.drawnIdx = this.light ? this.pickDrawn() : null;
    const halves = centreHalves(this.full.packedArray!, this.n);
    await this.call("init", { halves, n: this.n, idx: this.drawnIdx }, [halves.buffer]);
    this.build(new Uint8Array(this.drawnCount));
    this.ready = true;
  }

  /**
   * Light ⇄ Full. Returns the new drawn copy; the caller swaps the mesh and then calls
   * `release(old)`. Selection, deletions and clipping carry over (they live in the worker).
   */
  async setLight(on: boolean): Promise<PackedSplats> {
    if (this.display === this.full) this.restorePristine();
    this.light = on && this.n > this.max;
    this.drawnIdx = this.light ? this.pickDrawn() : null;
    const states = await this.call<Uint8Array>("setDrawn", { idx: this.drawnIdx });
    this.build(states);
    return this.display;
  }

  /**
   * Which `max` splats to draw. "area": the ones that cover the most — opacity times the
   * two largest axes, all read straight from the log-encoded bytes, ranked with a
   * histogram (no sort over tens of millions). "stride": every k-th.
   */
  private pickDrawn(): Uint32Array {
    const n = this.n, m = Math.min(n, this.max), w = this.full.packedArray!;
    if (ScanData.thin === "stride") {
      const k = Math.ceil(n / m), out = new Uint32Array(Math.ceil(n / k));
      for (let j = 0; j < out.length; j++) out[j] = j * k;
      return out;
    }
    const enc = this.full.splatEncoding ?? {};
    const step = ((enc.lnScaleMax ?? 9) - (enc.lnScaleMin ?? -12)) / 254;
    const opT = new Int16Array(256);
    for (let o = 0; o < 256; o++) opT[o] = o === 0 ? -2000 : Math.round(Math.log(o / 255) / step);
    const key = new Uint16Array(n), hist = new Uint32Array(2048);
    for (let i = 0; i < n; i++) {
      const w3 = w[i * 4 + 3], a = w3 & 255, b = (w3 >>> 8) & 255, c = (w3 >>> 16) & 255;
      const kk = Math.max(0, Math.min(2047, a + b + c - Math.min(a, b, c) + opT[w[i * 4] >>> 24] + 1024));
      key[i] = kk; hist[kk]++;
    }
    let tb = 2047, acc = 0;
    while (tb > 0 && acc + hist[tb] < m) acc += hist[tb--];
    let room = m - acc; // how many of the threshold bin still fit
    const out = new Uint32Array(m); let q = 0;
    for (let i = 0; i < n && q < m; i++) { const kk = key[i]; if (kk > tb || (kk === tb && room-- > 0)) out[q++] = i; }
    return q === m ? out : out.slice(0, q);
  }
  /** Let go of a drawn copy that is no longer on screen. */
  release(old: PackedSplats) { if (old === this.full) freeGpu(old); else old.dispose(); }

  private build(states: Uint8Array) {
    const idx = this.drawnIdx, m = this.drawnCount;
    const src = this.full.packedArray!;
    let ps: PackedSplats;
    if (!idx) {
      ps = this.full;
    } else {
      const enc = this.full.splatEncoding ?? {};
      ps = new PackedSplats({ maxSplats: m, splatEncoding: { ...enc } });
      const dst = ps.ensureSplats(m);
      // thinning leaves gaps: enlarge each kept splat a little (scales are log-encoded bytes)
      const step = ((enc.lnScaleMax ?? 9) - (enc.lnScaleMin ?? -12)) / 254;
      const bump = Math.round((Math.log(this.ratio) * ScanData.bumpExp) / step);
      const up = (b: number) => (b === 0 ? 0 : Math.min(255, b + bump));
      for (let j = 0; j < m; j++) {
        const s = idx[j] * 4, d = j * 4, w3 = src[s + 3];
        dst[d] = src[s]; dst[d + 1] = src[s + 1]; dst[d + 2] = src[s + 2];
        dst[d + 3] = ((w3 & 0xff000000) | (up((w3 >>> 16) & 255) << 16) | (up((w3 >>> 8) & 255) << 8) | up(w3 & 255)) >>> 0;
      }
      for (const L of [1, 2, 3]) {
        const sa = this.full.extra["sh" + L] as Uint32Array | undefined; if (!sa) continue;
        const w = SH_WORDS[L], da = ps.ensureSplatsSh(L, m);
        for (let j = 0; j < m; j++) { const s = idx[j] * w, d = j * w; for (let q = 0; q < w; q++) da[d + q] = sa[s + q]; }
      }
      ps.numSplats = m;
    }
    this.display = ps;
    const words = ps.packedArray!;
    this.orig0 = new Uint32Array(m); this.orig3 = new Uint32Array(m); this.dst = new Uint8Array(m);
    for (let j = 0; j < m; j++) { this.orig0[j] = words[j * 4]; this.orig3[j] = words[j * 4 + 3]; }
    for (let j = 0; j < m; j++) if (states[j]) this.paint(j, states[j]);
    ps.needsUpdate = true;
  }
  /** Put the untouched words back into the full set (it was being drawn and tinted). */
  private restorePristine() {
    const words = this.full.packedArray!;
    for (let j = 0; j < this.orig0.length; j++) { words[j * 4] = this.orig0[j]; words[j * 4 + 3] = this.orig3[j]; }
  }
  private paint(j: number, st: number) {
    this.dst[j] = st;
    const w = this.display.packedArray!;
    w[j * 4 + 3] = st & (HIDDEN | CLIP) ? (this.orig3[j] & 0xff000000) >>> 0 : this.orig3[j];
    if (st & SEL) {
      const o = this.orig0[j], s = this.selByte;
      const mix = (b: number, t: number) => Math.round(b + (t - b) * SEL_MIX);
      w[j * 4] = ((o & 0xff000000) | (mix((o >>> 16) & 255, s[2]) << 16) | (mix((o >>> 8) & 255, s[1]) << 8) | mix(o & 255, s[0])) >>> 0;
    } else w[j * 4] = this.orig0[j];
  }
  private apply(r: Delta) {
    this.selected = r.sel; this.hidden = r.hidden; this.clipped = r.clipped; this.centroid = r.centroid;
    // same as paint(), inlined: this runs on the page for up to millions of drawn splats
    const w = this.display.packedArray!, o0 = this.orig0, o3 = this.orig3, dst = this.dst, [s0, s1, s2] = this.selByte, a = SEL_MIX;
    const d = r.d, ds = r.ds;
    for (let q = 0; q < d.length; q++) {
      const j = d[q], st = ds[q], b = j * 4;
      dst[j] = st;
      w[b + 3] = st & (HIDDEN | CLIP) ? (o3[j] & 0xff000000) >>> 0 : o3[j];
      if (st & SEL) {
        const o = o0[j], cr = o & 255, cg = (o >>> 8) & 255, cb = (o >>> 16) & 255;
        w[b] = ((o & 0xff000000) | (((cb + (s2 - cb) * a + 0.5) | 0) << 16) | (((cg + (s1 - cg) * a + 0.5) | 0) << 8) | ((cr + (s0 - cr) * a + 0.5) | 0)) >>> 0;
      } else w[b] = o0[j];
    }
    if (d.length) this.display.needsUpdate = true;
    return r;
  }

  // ── gestures ──
  /** Project every shown splat with this camera (once per gesture; the camera holds still meanwhile). */
  project(camera: THREE.Camera, world: THREE.Matrix4, w: number, h: number) {
    const m = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(world);
    return this.call<boolean>("project", { m: Array.from(m.elements), w, h });
  }
  async select(shape: Shape, mode: SelectMode) { return this.apply(await this.call<Delta>("select", { shape, mode })); }
  hit(x: number, y: number, r: number) { return this.call<boolean>("hit", { x, y, r }); }
  async selectAll() { this.apply(await this.call<Delta>("selectAll")); }
  async deselectAll() { this.apply(await this.call<Delta>("deselectAll")); }
  async invert() { this.apply(await this.call<Delta>("invert")); }
  /** Delete the selection. Returns the undo batch (full indices). */
  async hideSelected(): Promise<Uint32Array> { const r = await this.call<Delta & { batch: Uint32Array }>("hideSelected"); this.apply(r); return r.batch; }
  async hide(batch: Uint32Array) { this.apply(await this.call<Delta>("hide", { batch })); }
  async restore(batch: Uint32Array) { this.apply(await this.call<Delta>("restore", { batch })); }
  /** Re-evaluate the clip volumes (world space). Resolves true if anything changed. */
  async clip(world: THREE.Matrix4, vols: VolDesc[]) { const r = this.apply(await this.call<Delta>("clip", { m: Array.from(world.elements), vols })); return r.changed > 0; }

  // ── reads ──
  /** Up to maxN shown centres in WORLD space (for the dimensions). */
  async sample(world: THREE.Matrix4, maxN: number) {
    const pts = await this.call<Float32Array>("sample", { maxN });
    const v = new THREE.Vector3();
    for (let i = 0; i < pts.length; i += 3) { v.set(pts[i], pts[i + 1], pts[i + 2]).applyMatrix4(world); pts[i] = v.x; pts[i + 1] = v.y; pts[i + 2] = v.z; }
    return pts;
  }
  exportRows() { return this.call<Uint32Array>("exportRows"); }
  refPoints(count: number) { return this.call<{ index: number; x: number; y: number; z: number }[]>("refPoints", { count }); }
  /** World-space centroid of the selection (orbit pivot), from the last reply. */
  selectionCenter(world: THREE.Matrix4) { return this.centroid ? new THREE.Vector3(this.centroid[0], this.centroid[1], this.centroid[2]).applyMatrix4(world) : null; }

  /**
   * Surface pick on the DRAWN splats (orbit pivot, focus, origin): the nearest one inside
   * a thin cone around the ray, over an even sample of at most ~400k.
   */
  pickRay(ray: THREE.Ray, world: THREE.Matrix4, tanThr = 0.006): THREE.Vector3 | null {
    if (!this.ready) return null;
    const words = this.display.packedArray!, H = halfTable(), m = this.dst.length;
    const inv = world.clone().invert();
    const o = ray.origin.clone().applyMatrix4(inv);
    const d = ray.direction.clone().transformDirection(inv);
    const step = Math.max(1, Math.ceil(m / 400000)), thr2 = tanThr * tanThr;
    let bestT = Infinity, bx = 0, by = 0, bz = 0, found = false;
    for (let j = 0; j < m; j += step) {
      if (this.dst[j] & (HIDDEN | CLIP)) continue;
      const w1 = words[j * 4 + 1];
      const x = H[w1 & 0xffff], y = H[w1 >>> 16], z = H[words[j * 4 + 2] & 0xffff];
      const vx = x - o.x, vy = y - o.y, vz = z - o.z;
      const t = vx * d.x + vy * d.y + vz * d.z;
      if (t <= 1e-4 || t >= bestT) continue;
      if (vx * vx + vy * vy + vz * vz - t * t < thr2 * t * t) { bestT = t; bx = x; by = y; bz = z; found = true; }
    }
    return found ? new THREE.Vector3(bx, by, bz).applyMatrix4(world) : null;
  }

  /** Run `fn` with the full set's words untouched (no tint, no hidden scales) — for the fallback export. */
  async withPristine<T>(fn: () => Promise<T>): Promise<T> {
    if (this.display !== this.full) return fn();
    const words = this.full.packedArray!, m = this.orig0.length;
    const save0 = new Uint32Array(m), save3 = new Uint32Array(m);
    for (let j = 0; j < m; j++) { save0[j] = words[j * 4]; save3[j] = words[j * 4 + 3]; }
    this.restorePristine();
    try { return await fn(); }
    finally { for (let j = 0; j < m; j++) { words[j * 4] = save0[j]; words[j * 4 + 3] = save3[j]; } this.full.needsUpdate = true; }
  }

  dispose() {
    this.worker.terminate();
    for (const p of this.pending.values()) { ScanData.done(); p.rej(new Error("disposed")); }
    this.pending.clear();
    if (this.display && this.display !== this.full) this.display.dispose();
    this.full.dispose();
  }
}
