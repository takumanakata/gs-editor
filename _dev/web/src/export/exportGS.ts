import * as THREE from "three";

/**
 * Baked GS export — the deliverable of this app.
 *
 * Everything the user did (erased splats, separated objects moved around, and the
 * whole-scene origin / orientation / scale) is written INTO the splat data, so the
 * file opens correctly in any viewer with no transform metadata.
 *
 * Two paths, same math:
 *  - bakeFile: re-read the ORIGINAL file with @playcanvas/splat-transform (full
 *    precision, keeps every SH band, rotates SH properly) and apply the transforms
 *    to its rows. Rows are matched to the viewer's splats by index, and that mapping
 *    is verified against a few reference positions before anything is written.
 *  - bakeFromSplats: fall back to the data Spark holds in memory (float32 centres,
 *    half-float colour/opacity/scale, base colour only) when the source cannot be
 *    re-read (huge files, unknown formats).
 *
 * "Parts" are groups of rows that share one transform: the main scene (visible rows)
 * plus one part per separated object. Matrices are given in the SOURCE FILE's
 * coordinate frame (the caller removes the viewer's OpenCV→Y-up flip).
 */
export type GsFormat = "ply" | "spz" | "splat";

export interface BakePart {
  /** Row indices (source order) belonging to this part; null = every row. */
  rows: Uint32Array | number[] | null;
  /** Transform to bake into these rows, in source-file coordinates. */
  matrix: THREE.Matrix4;
}

/** A few known splat positions (viewer's copy of the source) used to verify row order. */
export interface RefPoint { index: number; x: number; y: number; z: number; }

export class AlignmentError extends Error {}

const SH_C0 = 0.28209479177387814;
/** Reader options (only the LCC reader looks at these; defaults mirror the CLI). */
const READ_OPTIONS = { iterations: 10, lodSelect: [], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 };

type ST = typeof import("@playcanvas/splat-transform");
type PC = typeof import("playcanvas");
let libs: Promise<{ st: ST; pc: PC }> | null = null;
/** The converter + its math library are big; load them on first export only. */
function loadLibs() {
  if (!libs) libs = Promise.all([import("@playcanvas/splat-transform"), import("playcanvas")]).then(([st, pc]) => ({ st, pc }));
  return libs;
}

/** `m` (given in the viewer's frame) expressed between reader frame `Bin` and writer frame `Bout`: Bout⁻¹ · m · Bin. */
export function rebase(m: THREE.Matrix4, Bin: THREE.Matrix4, Bout: THREE.Matrix4): THREE.Matrix4 {
  return Bout.clone().invert().multiply(m).multiply(Bin);
}

/**
 * How Spark (this viewer and GSレイアウター) places each on-disk format relative to the
 * converter's PLY space: spark = basis · ply. PLY / .splat / .ksplat are read as-is; SPZ is read
 * without the spec's RUB→RDF flip, so it comes out turned 180° about X. Measured on the
 * bundled samples — see detectBasis, which re-checks the INPUT side on every export.
 */
export function sparkBasis(fmt: string): THREE.Matrix4 {
  return fmt === "spz" ? new THREE.Matrix4().makeRotationX(Math.PI) : new THREE.Matrix4();
}

/** Candidate axis conventions a reader may differ from Spark by (all proper rotations). */
const BASES: { name: string; m: THREE.Matrix4 }[] = [
  { name: "identity", m: new THREE.Matrix4() },
  { name: "x180", m: new THREE.Matrix4().makeRotationX(Math.PI) },
  { name: "y180", m: new THREE.Matrix4().makeRotationY(Math.PI) },
  { name: "z180", m: new THREE.Matrix4().makeRotationZ(Math.PI) },
];

/**
 * Find the basis change B with spark = B · table for the reference points, and make sure
 * the rows really correspond (same index → same splat). Throws AlignmentError otherwise.
 */
export function detectBasis(get: (i: number) => [number, number, number] | null, refs: RefPoint[]): THREE.Matrix4 {
  if (!refs.length) return new THREE.Matrix4();
  let scale = 0;
  for (const r of refs) scale = Math.max(scale, Math.abs(r.x), Math.abs(r.y), Math.abs(r.z));
  const tol = Math.max(1e-4, scale * 2e-3); // generous: compressed formats quantise positions
  const v = new THREE.Vector3();
  let best: { err: number; m: THREE.Matrix4 } | null = null;
  for (const b of BASES) {
    let err = 0, n = 0;
    for (const r of refs) {
      const p = get(r.index); if (!p) continue;
      v.set(p[0], p[1], p[2]).applyMatrix4(b.m);
      err += Math.max(Math.abs(v.x - r.x), Math.abs(v.y - r.y), Math.abs(v.z - r.z)); n++;
    }
    if (!n) continue;
    err /= n;
    if (!best || err < best.err) best = { err, m: b.m };
  }
  if (!best || best.err > tol) throw new AlignmentError(`row order mismatch (err ${best?.err})`);
  console.info(`[export] reader basis: ${BASES.find((b) => b.m === best!.m)?.name} (err ${best.err.toExponential(2)})`);
  return best.m.clone();
}

function toTransform(pc: PC, m: THREE.Matrix4) {
  const p = new THREE.Vector3(), q = new THREE.Quaternion(), s = new THREE.Vector3();
  m.decompose(p, q, s);
  const k = Math.cbrt(Math.abs(s.x * s.y * s.z)) || 1; // Gaussians only take a uniform scale
  return { translation: new pc.Vec3(p.x, p.y, p.z), rotation: new pc.Quat(q.x, q.y, q.z, q.w), scale: k, uniform: Math.abs(s.x - s.y) < 1e-3 && Math.abs(s.y - s.z) < 1e-3 };
}

/** Apply each part's matrix to its rows (positions, rotations, scales, SH) and merge into one table. */
async function applyParts(st: ST, pc: PC, table: InstanceType<ST["DataTable"]>, parts: BakePart[], Bin: THREE.Matrix4, Bout: THREE.Matrix4, log: (s: string) => void) {
  const out: InstanceType<ST["DataTable"]>[] = [];
  for (const part of parts) {
    const rows = part.rows == null ? null : (part.rows instanceof Uint32Array ? part.rows : Uint32Array.from(part.rows));
    if (rows && !rows.length) continue;
    const sub = rows ? table.clone({ rows }) : table;
    const trs = toTransform(pc, rebase(part.matrix, Bin, Bout));
    if (!trs.uniform) log("注意: 非均一スケールのオブジェクトは平均スケールで書き出します");
    // The table's `transform` maps raw rows → engine space; prefixing our TRS on the raw side
    // and converting back to PLY space makes the library bake it (incl. SH rotation) in place.
    const t = new st.Transform(trs.translation, trs.rotation, trs.scale);
    sub.transform = st.Transform.PLY.clone().mul(t);
    out.push(st.convertToSpace(sub, st.Transform.PLY, true));
  }
  if (!out.length) throw new Error("書き出す splat がありません");
  return out.length === 1 ? out[0] : st.combine(out);
}

/** antimatter15 .splat: 32 bytes per gaussian (pos f32x3, scale f32x3, rgba u8x4, rot u8x4 as w,x,y,z). */
export function encodeSplat(cols: { x: Float32Array; y: Float32Array; z: Float32Array; s0: Float32Array; s1: Float32Array; s2: Float32Array; r: Float32Array; g: Float32Array; b: Float32Array; op: Float32Array; q0: Float32Array; q1: Float32Array; q2: Float32Array; q3: Float32Array }, n: number): Uint8Array {
  const buf = new ArrayBuffer(n * 32);
  const dv = new DataView(buf);
  const u8 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  for (let i = 0; i < n; i++) {
    const o = i * 32;
    dv.setFloat32(o, cols.x[i], true); dv.setFloat32(o + 4, cols.y[i], true); dv.setFloat32(o + 8, cols.z[i], true);
    dv.setFloat32(o + 12, Math.exp(cols.s0[i]), true); dv.setFloat32(o + 16, Math.exp(cols.s1[i]), true); dv.setFloat32(o + 20, Math.exp(cols.s2[i]), true);
    dv.setUint8(o + 24, u8((0.5 + SH_C0 * cols.r[i]) * 255)); dv.setUint8(o + 25, u8((0.5 + SH_C0 * cols.g[i]) * 255)); dv.setUint8(o + 26, u8((0.5 + SH_C0 * cols.b[i]) * 255));
    dv.setUint8(o + 27, u8((1 / (1 + Math.exp(-cols.op[i]))) * 255));
    const w = cols.q0[i], x = cols.q1[i], y = cols.q2[i], z = cols.q3[i];
    const len = Math.hypot(w, x, y, z) || 1;
    dv.setUint8(o + 28, u8((w / len) * 128 + 128)); dv.setUint8(o + 29, u8((x / len) * 128 + 128)); dv.setUint8(o + 30, u8((y / len) * 128 + 128)); dv.setUint8(o + 31, u8((z / len) * 128 + 128));
  }
  return new Uint8Array(buf);
}

async function writeTable(st: ST, table: InstanceType<ST["DataTable"]>, fmt: GsFormat, outName: string): Promise<Uint8Array> {
  const fs = new st.MemoryFileSystem();
  if (fmt === "ply") {
    await st.writePly({ filename: outName, plyData: { comments: ["generated by GSEditor"], elements: [{ name: "vertex", dataTable: table }] } }, fs);
    return fs.results.get(outName)!;
  }
  if (fmt === "spz") {
    await st.writeSpz({ filename: outName, dataTable: table, version: 3 }, fs); // v3 = gzip container; Spark (and most viewers) cannot read v4 yet
    return fs.results.get(outName)!;
  }
  const t = st.convertToSpace(table, st.Transform.PLY);
  const col = (n: string) => { const c = t.getColumnByName(n); if (!c) throw new Error(`.splat 書き出しに必要な列がありません: ${n}`); return c.data as Float32Array; };
  return encodeSplat({ x: col("x"), y: col("y"), z: col("z"), s0: col("scale_0"), s1: col("scale_1"), s2: col("scale_2"), r: col("f_dc_0"), g: col("f_dc_1"), b: col("f_dc_2"), op: col("opacity"), q0: col("rot_0"), q1: col("rot_1"), q2: col("rot_2"), q3: col("rot_3") }, t.numRows);
}

const MIME = "application/octet-stream";

/**
 * Full-fidelity path: re-read the source bytes, verify row order against `refs`, bake, write.
 * Throws AlignmentError when the reader's row order does not match the viewer's.
 */
export async function bakeFile(data: Uint8Array, filename: string, parts: BakePart[], refs: RefPoint[], fmt: GsFormat, outName: string, log: (s: string) => void = () => {}): Promise<Blob> {
  const { st, pc } = await loadLibs();
  const rfs = new st.MemoryReadFileSystem();
  rfs.set(filename, data);
  const tables = await st.readFile({ filename, inputFormat: st.getInputFormat(filename), options: READ_OPTIONS, params: [], fileSystem: rfs });
  let table = tables.length === 1 ? tables[0] : st.combine(tables);
  table = st.convertToSpace(table, st.Transform.PLY, true); // make sure raw rows are in PLY space
  const X = table.getColumnByName("x")?.data, Y = table.getColumnByName("y")?.data, Z = table.getColumnByName("z")?.data;
  if (!X || !Y || !Z) throw new Error("位置列がありません");
  const Bin = detectBasis((i) => (i < table.numRows ? [X[i], Y[i], Z[i]] : null), refs);
  const baked = await applyParts(st, pc, table, parts, Bin, sparkBasis(fmt), log);
  return new Blob([await writeTable(st, baked, fmt, outName) as BlobPart], { type: MIME });
}

/** One source file per object, each with its own baked transform; all combined into one output. */
export interface FileSource { data: Uint8Array; filename: string; parts: BakePart[]; refs: RefPoint[] }
export async function bakeFiles(sources: FileSource[], fmt: GsFormat, outName: string, log: (s: string) => void = () => {}): Promise<Blob> {
  const { st, pc } = await loadLibs();
  const baked: InstanceType<ST["DataTable"]>[] = [];
  for (const src of sources) {
    const rfs = new st.MemoryReadFileSystem();
    rfs.set(src.filename, src.data);
    const tables = await st.readFile({ filename: src.filename, inputFormat: st.getInputFormat(src.filename), options: READ_OPTIONS, params: [], fileSystem: rfs });
    let table = tables.length === 1 ? tables[0] : st.combine(tables);
    table = st.convertToSpace(table, st.Transform.PLY, true);
    const X = table.getColumnByName("x")?.data, Y = table.getColumnByName("y")?.data, Z = table.getColumnByName("z")?.data;
    if (!X || !Y || !Z) throw new Error("位置列がありません");
    const Bin = detectBasis((i) => (i < table.numRows ? [X[i], Y[i], Z[i]] : null), src.refs);
    baked.push(await applyParts(st, pc, table, src.parts, Bin, sparkBasis(fmt), log));
  }
  if (!baked.length) throw new Error("書き出す splat がありません");
  const table = baked.length === 1 ? baked[0] : st.combine(baked);
  return new Blob([await writeTable(st, table, fmt, outName) as BlobPart], { type: MIME });
}

export interface SplatSource {
  /** Spark PackedSplats-like: getNumSplats(), getSplat(i) → {center, scales, quaternion, opacity, color}. */
  packed: any;
  rows: Uint32Array | number[] | null;
  matrix: THREE.Matrix4;
}

/** Fallback path: build the table from the viewer's in-memory splats (base colour only). */
export async function bakeFromSplats(sources: SplatSource[], fmt: GsFormat, outName: string, log: (s: string) => void = () => {}): Promise<Blob> {
  const { st, pc } = await loadLibs();
  const names = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];
  const parts: BakePart[] = [];
  const tables: InstanceType<ST["DataTable"]>[] = [];
  const logit = (a: number) => { const c = Math.min(1 - 1e-4, Math.max(1e-4, a)); return Math.log(c / (1 - c)); };
  for (const src of sources) {
    const total = src.packed.getNumSplats();
    const rows = src.rows ? Array.from(src.rows) : Array.from({ length: total }, (_, i) => i);
    if (!rows.length) continue;
    const cols = names.map(() => new Float32Array(rows.length));
    rows.forEach((idx, k) => {
      const s = src.packed.getSplat(idx);
      cols[0][k] = s.center.x; cols[1][k] = s.center.y; cols[2][k] = s.center.z;
      cols[3][k] = (s.color.r - 0.5) / SH_C0; cols[4][k] = (s.color.g - 0.5) / SH_C0; cols[5][k] = (s.color.b - 0.5) / SH_C0;
      cols[6][k] = logit(s.opacity);
      cols[7][k] = Math.log(Math.max(1e-9, s.scales.x)); cols[8][k] = Math.log(Math.max(1e-9, s.scales.y)); cols[9][k] = Math.log(Math.max(1e-9, s.scales.z));
      cols[10][k] = s.quaternion.w; cols[11][k] = s.quaternion.x; cols[12][k] = s.quaternion.y; cols[13][k] = s.quaternion.z;
    });
    tables.push(new st.DataTable(names.map((n, i) => new st.Column(n, cols[i])), st.Transform.PLY));
    parts.push({ rows: null, matrix: src.matrix });
  }
  if (!tables.length) throw new Error("書き出す splat がありません");
  const baked: InstanceType<ST["DataTable"]>[] = [];
  // the table IS the viewer's frame here (built from Spark's data), so the input basis is identity
  for (let i = 0; i < tables.length; i++) baked.push(await applyParts(st, pc, tables[i], [parts[i]], new THREE.Matrix4(), sparkBasis(fmt), log));
  const table = baked.length === 1 ? baked[0] : st.combine(baked);
  return new Blob([await writeTable(st, table, fmt, outName) as BlobPart], { type: MIME });
}

/** Trigger a browser download of a blob. */
export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a"); a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
