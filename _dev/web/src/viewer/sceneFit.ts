import * as THREE from "three";

/**
 * Pure geometry helpers for the whole-scene origin / orientation tools.
 * All inputs are flat xyz arrays in WORLD space (what the user sees), so the
 * results can be applied directly to the scene frame.
 */

/** Plain centroid of the points. */
export function centroid(points: Float32Array): THREE.Vector3 {
  const n = points.length / 3;
  const c = new THREE.Vector3();
  if (!n) return c;
  for (let i = 0; i < points.length; i += 3) { c.x += points[i]; c.y += points[i + 1]; c.z += points[i + 2]; }
  return c.multiplyScalar(1 / n);
}

/**
 * Height (Y) under which `pct` (0..1) of the points lie. A low percentile instead of the
 * minimum, so a few floaters below the floor do not drag the ground level down.
 */
export function percentileY(points: Float32Array, pct: number): number {
  const n = points.length / 3;
  if (!n) return 0;
  const ys = new Float32Array(n);
  for (let i = 0; i < n; i++) ys[i] = points[i * 3 + 1];
  ys.sort();
  const k = Math.min(n - 1, Math.max(0, Math.floor(n * pct)));
  return ys[k];
}

/** Eigenvector of the smallest eigenvalue of a symmetric 3x3 (row-major, 9 numbers). Jacobi rotations. */
export function smallestEigenvector(m: number[]): THREE.Vector3 {
  const a = m.slice();
  const v = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let sweep = 0; sweep < 24; sweep++) {
    const off = Math.abs(a[1]) + Math.abs(a[2]) + Math.abs(a[5]);
    if (off < 1e-12) break;
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]] as const) {
      const apq = a[p * 3 + q];
      if (Math.abs(apq) < 1e-15) continue;
      const app = a[p * 3 + p], aqq = a[q * 3 + q];
      const theta = (aqq - app) / (2 * apq);
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 3; k++) { // rotate rows/cols p,q of a
        const akp = a[k * 3 + p], akq = a[k * 3 + q];
        a[k * 3 + p] = c * akp - s * akq; a[k * 3 + q] = s * akp + c * akq;
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p * 3 + k], aqk = a[q * 3 + k];
        a[p * 3 + k] = c * apk - s * aqk; a[q * 3 + k] = s * apk + c * aqk;
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k * 3 + p], vkq = v[k * 3 + q];
        v[k * 3 + p] = c * vkp - s * vkq; v[k * 3 + q] = s * vkp + c * vkq;
      }
    }
  }
  const ev = [a[0], a[4], a[8]];
  let mi = 0; for (let i = 1; i < 3; i++) if (ev[i] < ev[mi]) mi = i;
  return new THREE.Vector3(v[mi], v[3 + mi], v[6 + mi]).normalize();
}

export interface PlaneFit { normal: THREE.Vector3; point: THREE.Vector3; inliers: number; }

/**
 * Estimate the ground plane of a scan with RANSAC + least-squares refinement.
 *  - candidates whose normal tilts more than `maxTiltDeg` from the current up axis are
 *    rejected (files are usually roughly upright already; this keeps walls from winning)
 *  - the biggest remaining plane wins (floors are normally the largest flat region)
 *  - the normal is oriented so that most points lie on its positive side (above the floor)
 * Deterministic: uses a fixed-seed PRNG so repeated clicks give the same answer.
 */
export function fitGroundPlane(points: Float32Array, up = new THREE.Vector3(0, 1, 0), opts: { iterations?: number; maxTiltDeg?: number; threshold?: number } = {}): PlaneFit | null {
  const n = points.length / 3;
  if (n < 30) return null;
  const box = new THREE.Box3();
  const tmp = new THREE.Vector3();
  for (let i = 0; i < n; i++) box.expandByPoint(tmp.set(points[i * 3], points[i * 3 + 1], points[i * 3 + 2]));
  const diag = box.getSize(new THREE.Vector3()).length() || 1;
  const thr = opts.threshold ?? diag * 0.006;
  const iters = opts.iterations ?? 500;
  const cosMax = Math.cos(((opts.maxTiltDeg ?? 50) * Math.PI) / 180);
  let seed = 12345;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const pick = () => Math.floor(rnd() * n) * 3;
  const upN = up.clone().normalize();

  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3(), nrm = new THREE.Vector3();
  let best: { n: THREE.Vector3; d: number; count: number } | null = null;
  for (let it = 0; it < iters; it++) {
    const i = pick(), j = pick(), k = pick();
    a.set(points[i], points[i + 1], points[i + 2]);
    b.set(points[j], points[j + 1], points[j + 2]).sub(a);
    c.set(points[k], points[k + 1], points[k + 2]).sub(a);
    nrm.crossVectors(b, c);
    if (nrm.lengthSq() < 1e-12) continue;
    nrm.normalize();
    if (Math.abs(nrm.dot(upN)) < cosMax) continue; // too far from horizontal
    const d = -nrm.dot(a);
    let count = 0;
    for (let p = 0; p < points.length; p += 3) {
      if (Math.abs(nrm.x * points[p] + nrm.y * points[p + 1] + nrm.z * points[p + 2] + d) < thr) count++;
    }
    if (!best || count > best.count) best = { n: nrm.clone(), d, count };
  }
  if (!best || best.count < Math.max(30, n * 0.02)) return null;

  // refine: least-squares plane through the inliers (PCA) — removes the 3-point sampling noise
  const cen = new THREE.Vector3(); let m = 0;
  for (let p = 0; p < points.length; p += 3) {
    if (Math.abs(best.n.x * points[p] + best.n.y * points[p + 1] + best.n.z * points[p + 2] + best.d) < thr) { cen.x += points[p]; cen.y += points[p + 1]; cen.z += points[p + 2]; m++; }
  }
  cen.multiplyScalar(1 / m);
  const cov = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let p = 0; p < points.length; p += 3) {
    if (Math.abs(best.n.x * points[p] + best.n.y * points[p + 1] + best.n.z * points[p + 2] + best.d) >= thr) continue;
    const dx = points[p] - cen.x, dy = points[p + 1] - cen.y, dz = points[p + 2] - cen.z;
    cov[0] += dx * dx; cov[1] += dx * dy; cov[2] += dx * dz;
    cov[4] += dy * dy; cov[5] += dy * dz; cov[8] += dz * dz;
  }
  cov[3] = cov[1]; cov[6] = cov[2]; cov[7] = cov[5];
  const normal = smallestEigenvector(cov);
  if (normal.dot(best.n) < 0) normal.negate();
  // orient toward the side with more points ("above the floor")
  let above = 0;
  for (let p = 0; p < points.length; p += 3) if (normal.x * (points[p] - cen.x) + normal.y * (points[p + 1] - cen.y) + normal.z * (points[p + 2] - cen.z) > 0) above++;
  if (above < n / 2) normal.negate();
  return { normal, point: cen, inliers: m };
}

/** Rotation that takes `from` onto `to` (both unit-ish); identity when already aligned. */
export function rotationBetween(from: THREE.Vector3, to: THREE.Vector3): THREE.Quaternion {
  return new THREE.Quaternion().setFromUnitVectors(from.clone().normalize(), to.clone().normalize());
}

/** Snap an angle (degrees) to the nearest multiple of `step`; `null` step = no snapping. */
export function snapDeg(deg: number, step: number | null): number {
  if (!step || step <= 0) return deg;
  return Math.round(deg / step) * step;
}
