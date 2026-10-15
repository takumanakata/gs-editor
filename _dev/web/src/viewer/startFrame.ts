import * as THREE from "three";

/**
 * The first view of a freshly loaded scan — SHARED between GSEditor and GSレイアウター.
 * This file is byte-identical in both repos (_dev/web/src/viewer/startFrame.ts); change
 * it in one and copy it to the other, never edit one side alone.
 *
 * The start pose is FIXED: the same place for every scan, like Blender's default
 * camera — on the +X/−Y/+Z diagonal (Blender axes), looking at the origin from a
 * little above. Density-based framing was tried twice and dropped: it put different
 * scans in unrelated places and the director could never predict where a file opens.
 * Scans are expected to be centred on the origin (that is GSEditor's job); the splat
 * bounds are still read for the scene SIZE, which scales the sway and the controls.
 */
export interface StartFrame { position: THREE.Vector3; target: THREE.Vector3; size: number; }

/** Readable splat set: Spark's PackedSplats / ExtSplats shape. */
export interface SplatSource {
  numSplats?: number;
  getNumSplats?: () => number;
  forEachSplat: (cb: (i: number, center: THREE.Vector3, scales: THREE.Vector3, quaternion: THREE.Quaternion, opacity: number, color: THREE.Color) => void) => void;
}

/** The reference lens both apps show a fresh scan with: 35 mm on a 36 mm-wide 16:9 frame. */
export const START_FOCAL_MM = 35;
export const START_SENSOR_W_MM = 36;
export const START_FRAME_AR = 16 / 9;
export function startVfovRad(): number { return 2 * Math.atan(START_SENSOR_W_MM / START_FRAME_AR / 2 / START_FOCAL_MM); }

/** Blender's default camera: location (7.36, −6.93, 4.96) Z-up → three.js Y-up (x, z, −y). */
export const START_POSITION = new THREE.Vector3(7.36, 4.96, 6.93);
export const START_TARGET = new THREE.Vector3(0, 0, 0);

function splatCount(s: SplatSource): number { return s.numSplats ?? s.getNumSplats?.() ?? 0; }

/** Local-space bounding box of the splat centres. */
export function splatBounds(splats: SplatSource): THREE.Box3 | null {
  const box = new THREE.Box3();
  splats.forEachSplat((_i, c) => { box.expandByPoint(c); });
  return box.isEmpty() ? null : box;
}

/**
 * Densest, "meatiest" region of the splats. Votes splats into a coarse voxel grid,
 * weighting tight/opaque splats heavily and big background sheets lightly, then returns
 * the LOCAL centroid + spread of the busiest neighbourhood. Two cheap passes.
 */
export function densestRegion(splats: SplatSource, box: THREE.Box3): { center: THREE.Vector3; radius: number } | null {
  const size = new THREE.Vector3().subVectors(box.max, box.min);
  if (size.x <= 0 || size.y <= 0 || size.z <= 0) return null;
  const N = 24;
  const grid = new Float32Array(N * N * N);
  const inv = new THREE.Vector3(N / size.x, N / size.y, N / size.z);
  const clampI = (v: number) => (v < 0 ? 0 : v >= N ? N - 1 : v);
  const total = splatCount(splats);
  const step = Math.max(1, Math.floor(total / 400000)); // cap ~400k samples per pass
  const w8 = (sx: number, sy: number, sz: number, op: number) => {
    const ms = (sx + sy + sz) / 3;
    return (op > 0 ? op : 1) / (1 + ms * ms); // tight + opaque splats vote most
  };
  let n = 0;
  splats.forEachSplat((_i, c, s, _q, op) => {
    if (n++ % step) return;
    const gx = clampI(Math.floor((c.x - box.min.x) * inv.x));
    const gy = clampI(Math.floor((c.y - box.min.y) * inv.y));
    const gz = clampI(Math.floor((c.z - box.min.z) * inv.z));
    grid[(gx * N + gy) * N + gz] += w8(s.x, s.y, s.z, op);
  });
  let max = -1, mi = 0;
  for (let k = 0; k < grid.length; k++) if (grid[k] > max) { max = grid[k]; mi = k; }
  if (max <= 0) return null;
  const mgz = mi % N, mgy = ((mi / N) | 0) % N, mgx = (mi / (N * N)) | 0;
  const sum = new THREE.Vector3(); let wsum = 0, sq = 0; n = 0;
  splats.forEachSplat((_i, c, s, _q, op) => {
    if (n++ % step) return;
    const gx = clampI(Math.floor((c.x - box.min.x) * inv.x));
    const gy = clampI(Math.floor((c.y - box.min.y) * inv.y));
    const gz = clampI(Math.floor((c.z - box.min.z) * inv.z));
    if (Math.abs(gx - mgx) <= 1 && Math.abs(gy - mgy) <= 1 && Math.abs(gz - mgz) <= 1) {
      const w = w8(s.x, s.y, s.z, op);
      sum.addScaledVector(c, w); wsum += w;
      sq += w * (c.x * c.x + c.y * c.y + c.z * c.z);
    }
  });
  if (wsum <= 0) return null;
  const meanLocal = sum.multiplyScalar(1 / wsum);
  const variance = Math.max(0, sq / wsum - meanLocal.lengthSq());
  const cell = Math.max(size.x, size.y, size.z) / N;
  return { center: meanLocal, radius: Math.sqrt(variance) * 1.4 + cell * 0.5 };
}

/**
 * The start pose for a loaded scan: always START_POSITION looking at START_TARGET.
 * `matrixWorld` is the mesh's world matrix at load (the OpenCV→Y-up flip); the bounds
 * are only used for the size. Returns null for an empty scan.
 */
export function computeStartFrame(splats: SplatSource, matrixWorld: THREE.Matrix4): StartFrame | null {
  const local = splatBounds(splats);
  if (!local) return null;
  const box = local.clone().applyMatrix4(matrixWorld);
  const sceneR = box.getBoundingSphere(new THREE.Sphere()).radius || 4;
  return { position: START_POSITION.clone(), target: START_TARGET.clone(), size: Math.max(sceneR * 0.4, 2) };
}
