import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { bakeFile, bakeFromSplats, detectBasis, AlignmentError, encodeSplat } from "./exportGS";

const NAMES = ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"];

/** Build a small 3DGS .ply in memory: 4 splats on the X axis at x = 0,1,2,3 with identity rotation. */
async function makePly(withSh = false): Promise<Uint8Array> {
  const st = await import("@playcanvas/splat-transform");
  const n = 4;
  const cols = NAMES.map((name) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      if (name === "x") a[i] = i;
      else if (name === "rot_0") a[i] = 1;
      else if (name.startsWith("scale")) a[i] = Math.log(0.1);
      else if (name === "opacity") a[i] = 2;
      else if (name === "f_dc_0") a[i] = 0.5;
    }
    return new st.Column(name, a);
  });
  if (withSh) for (let k = 0; k < 9; k++) cols.push(new st.Column(`f_rest_${k}`, new Float32Array(n).fill(k === 0 ? 0.3 : 0)));
  const table = new st.DataTable(cols, st.Transform.PLY);
  const fs = new st.MemoryFileSystem();
  await st.writePly({ filename: "src.ply", plyData: { comments: [], elements: [{ name: "vertex", dataTable: table }] } }, fs);
  return fs.results.get("src.ply")!;
}

async function readBack(blob: Blob, name: string) {
  const st = await import("@playcanvas/splat-transform");
  const rfs = new st.MemoryReadFileSystem();
  rfs.set(name, new Uint8Array(await blob.arrayBuffer()));
  const [t] = await st.readFile({ filename: name, inputFormat: st.getInputFormat(name), options: { iterations: 10, lodSelect: [], unbundled: false, lodChunkCount: 512, lodChunkExtent: 16 }, params: [], fileSystem: rfs });
  const col = (c: string) => Array.from(t.getColumnByName(c)!.data as Float32Array);
  return { t, col };
}

const refsFor = (xs: number[]) => xs.map((x, i) => ({ index: i, x, y: 0, z: 0 }));

describe("bakeFile", () => {
  it("bakes a translation + rotation + scale into positions, rotations and scales", async () => {
    const src = await makePly();
    const m = new THREE.Matrix4().compose(new THREE.Vector3(0, 0, 5), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), Math.PI / 2), new THREE.Vector3(2, 2, 2));
    const blob = await bakeFile(src, "src.ply", [{ rows: null, matrix: m }], refsFor([0, 1, 2, 3]), "ply", "out.ply");
    const { t, col } = await readBack(blob, "out.ply");
    expect(t.numRows).toBe(4);
    // (x,0,0) → scale 2 → rotate 90° about Z → (0, 2x, 0) → +5 z
    expect(col("x").map((v) => +v.toFixed(4))).toEqual([0, 0, 0, 0]);
    expect(col("y").map((v) => +v.toFixed(4))).toEqual([0, 2, 4, 6]);
    expect(col("z").map((v) => +v.toFixed(4))).toEqual([5, 5, 5, 5]);
    expect(col("scale_0").map((v) => +v.toFixed(4))).toEqual(Array(4).fill(+Math.log(0.2).toFixed(4)));
    expect(col("rot_0").map((v) => +v.toFixed(4))).toEqual(Array(4).fill(+Math.SQRT1_2.toFixed(4)));
    expect(col("rot_3").map((v) => +v.toFixed(4))).toEqual(Array(4).fill(+Math.SQRT1_2.toFixed(4)));
  });

  it("keeps only the requested rows and gives each part its own transform", async () => {
    const src = await makePly();
    const main = { rows: new Uint32Array([0, 1]), matrix: new THREE.Matrix4() }; // row 2 erased
    const obj = { rows: new Uint32Array([3]), matrix: new THREE.Matrix4().makeTranslation(0, 10, 0) };
    const blob = await bakeFile(src, "src.ply", [main, obj], refsFor([0, 1, 2, 3]), "ply", "out.ply");
    const { t, col } = await readBack(blob, "out.ply");
    expect(t.numRows).toBe(3);
    expect(col("x")).toEqual([0, 1, 3]);
    expect(col("y")).toEqual([0, 0, 10]);
  });

  it("rotates spherical-harmonic bands along with the splats", async () => {
    const src = await makePly(true);
    const m = new THREE.Matrix4().makeRotationZ(Math.PI / 2);
    const blob = await bakeFile(src, "src.ply", [{ rows: null, matrix: m }], refsFor([0, 1, 2, 3]), "ply", "out.ply");
    const { col } = await readBack(blob, "out.ply");
    // band-1 coefficient 0 (the "y" lobe) moves into another lobe after a 90° turn about Z
    expect(Math.abs(col("f_rest_0")[0])).toBeLessThan(1e-3);
    const moved = Math.abs(col("f_rest_1")[0]) + Math.abs(col("f_rest_2")[0]);
    expect(moved).toBeGreaterThan(0.29);
  });

  it("refuses when the viewer's row order does not match the file", async () => {
    const src = await makePly();
    await expect(bakeFile(src, "src.ply", [{ rows: null, matrix: new THREE.Matrix4() }], refsFor([3, 2, 1, 0]), "ply", "out.ply")).rejects.toBeInstanceOf(AlignmentError);
  });

  it("writes .splat that reads back with the baked positions", async () => {
    const src = await makePly();
    const m = new THREE.Matrix4().makeTranslation(1, 2, 3);
    const blob = await bakeFile(src, "src.ply", [{ rows: null, matrix: m }], refsFor([0, 1, 2, 3]), "splat", "out.splat");
    const { t, col } = await readBack(blob, "out.splat");
    expect(t.numRows).toBe(4);
    expect(col("x").map((v) => +v.toFixed(2))).toEqual([1, 2, 3, 4]);
    expect(col("y").map((v) => +v.toFixed(2))).toEqual([2, 2, 2, 2]);
    expect(col("z").map((v) => +v.toFixed(2))).toEqual([3, 3, 3, 3]);
  });

  it("writes .spz in the frame Spark reads it (180° about X relative to PLY space), gzip v3", async () => {
    const src = await makePly();
    const m = new THREE.Matrix4().makeTranslation(1, 2, 3);
    const blob = await bakeFile(src, "src.ply", [{ rows: null, matrix: m }], refsFor([0, 1, 2, 3]), "spz", "out.spz");
    const head = new Uint8Array(await blob.slice(0, 2).arrayBuffer());
    expect([head[0], head[1]]).toEqual([0x1f, 0x8b]);
    const { t, col } = await readBack(blob, "out.spz");
    expect(t.numRows).toBe(4);
    // Spark shows an SPZ turned 180° about X versus the same PLY, so the baked result is written pre-turned
    expect(col("x").map((v) => +v.toFixed(2))).toEqual([1, 2, 3, 4]);
    expect(col("y").map((v) => +v.toFixed(2))).toEqual([-2, -2, -2, -2]);
    expect(col("z").map((v) => +v.toFixed(2))).toEqual([-3, -3, -3, -3]);
  });

  it("round-trips: the same file format in and out leaves untouched rows unchanged", async () => {
    const src = await makePly();
    const blob = await bakeFile(src, "src.ply", [{ rows: null, matrix: new THREE.Matrix4() }], refsFor([0, 1, 2, 3]), "ply", "out.ply");
    const { col } = await readBack(blob, "out.ply");
    expect(col("x")).toEqual([0, 1, 2, 3]);
    expect(col("y")).toEqual([0, 0, 0, 0]);
  });
});

describe("detectBasis", () => {
  it("recognises a reader that flips Y and Z (180° about X)", () => {
    const get = (i: number): [number, number, number] => [i, -1, -2];
    const refs = [0, 1, 2].map((i) => ({ index: i, x: i, y: 1, z: 2 }));
    const B = detectBasis(get, refs);
    const v = new THREE.Vector3(0, -1, -2).applyMatrix4(B);
    expect([v.x, +v.y.toFixed(6), +v.z.toFixed(6)]).toEqual([0, 1, 2]);
  });
});

describe("bakeFromSplats", () => {
  it("builds a table from in-memory splats and bakes the matrix", async () => {
    const splats = [0, 1, 2].map((i) => ({ center: new THREE.Vector3(i, 0, 0), scales: new THREE.Vector3(0.1, 0.1, 0.1), quaternion: new THREE.Quaternion(), opacity: 0.8, color: new THREE.Color(0.6, 0.5, 0.4) }));
    const packed = { getNumSplats: () => 3, getSplat: (i: number) => splats[i] };
    const blob = await bakeFromSplats([{ packed, rows: new Uint32Array([0, 2]), matrix: new THREE.Matrix4().makeTranslation(0, 0, 1) }], "ply", "out.ply");
    const { t, col } = await readBack(blob, "out.ply");
    expect(t.numRows).toBe(2);
    expect(col("x")).toEqual([0, 2]);
    expect(col("z")).toEqual([1, 1]);
    expect(col("f_dc_0").map((v) => +(0.5 + 0.28209479177387814 * v).toFixed(3))).toEqual([0.6, 0.6]);
  });
});

describe("encodeSplat", () => {
  it("writes 32 bytes per gaussian", () => {
    const f = (v: number) => new Float32Array([v]);
    const out = encodeSplat({ x: f(1), y: f(2), z: f(3), s0: f(0), s1: f(0), s2: f(0), r: f(0), g: f(0), b: f(0), op: f(0), q0: f(1), q1: f(0), q2: f(0), q3: f(0) }, 1);
    expect(out.length).toBe(32);
    expect(new Float32Array(out.buffer, 0, 3)).toEqual(new Float32Array([1, 2, 3]));
    expect(out[27]).toBe(128); // sigmoid(0) = 0.5
    expect(out[28]).toBe(255); // w = 1 → 128+128 clamped
  });
});
