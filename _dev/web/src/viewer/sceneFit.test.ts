import { describe, it, expect } from "vitest";
import * as THREE from "three";
import { fitGroundPlane, percentileY, rotationBetween, smallestEigenvector, snapDeg, centroid } from "./sceneFit";

function makeScene(tiltDeg: number, floorY = 0): Float32Array {
  // a 10x10 floor (dense) + a 3x3 wall (sparser) + a few floaters, then tilted about X
  const pts: number[] = [];
  let seed = 7; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  for (let i = 0; i < 4000; i++) pts.push(rnd() * 10 - 5, floorY + (rnd() - 0.5) * 0.02, rnd() * 10 - 5);
  for (let i = 0; i < 1200; i++) pts.push(rnd() * 3 - 1.5, floorY + rnd() * 3, -5);
  for (let i = 0; i < 20; i++) pts.push(rnd() * 10 - 5, floorY - 1 - rnd(), rnd() * 10 - 5); // floaters below the floor
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (tiltDeg * Math.PI) / 180);
  const out = new Float32Array(pts.length);
  const v = new THREE.Vector3();
  for (let i = 0; i < pts.length; i += 3) { v.set(pts[i], pts[i + 1], pts[i + 2]).applyQuaternion(q); out[i] = v.x; out[i + 1] = v.y; out[i + 2] = v.z; }
  return out;
}

describe("fitGroundPlane", () => {
  it("finds the floor of a tilted scene and points the normal up", () => {
    const tilt = 20;
    const pts = makeScene(tilt);
    const fit = fitGroundPlane(pts);
    expect(fit).not.toBeNull();
    const expected = new THREE.Vector3(0, 1, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), (tilt * Math.PI) / 180);
    expect(fit!.normal.dot(expected)).toBeGreaterThan(0.999);
    // rotating by rotationBetween(normal, +Y) levels the scene
    const q = rotationBetween(fit!.normal, new THREE.Vector3(0, 1, 0));
    const n2 = fit!.normal.clone().applyQuaternion(q);
    expect(n2.y).toBeGreaterThan(0.999);
  });
  it("returns null for too few points", () => {
    expect(fitGroundPlane(new Float32Array(9))).toBeNull();
  });
});

describe("percentileY", () => {
  it("ignores floaters below the floor", () => {
    const pts = makeScene(0, 1.5);
    const y = percentileY(pts, 0.02);
    expect(Math.abs(y - 1.5)).toBeLessThan(0.05);
  });
});

describe("smallestEigenvector", () => {
  it("returns the flat axis of a thin slab", () => {
    // covariance of points spread in X and Z, flat in Y
    const v = smallestEigenvector([10, 0, 0, 0, 0.01, 0, 0, 0, 7]);
    expect(Math.abs(v.y)).toBeGreaterThan(0.999);
  });
});

describe("snapDeg / centroid", () => {
  it("snaps to the step and passes through when disabled", () => {
    expect(snapDeg(47, 45)).toBe(45);
    expect(snapDeg(47, 5)).toBe(45);
    expect(snapDeg(47, 15)).toBe(45);
    expect(snapDeg(-100, 90)).toBe(-90);
    expect(snapDeg(47, null)).toBe(47);
  });
  it("centroid is the plain mean", () => {
    const c = centroid(new Float32Array([0, 0, 0, 2, 4, 6]));
    expect([c.x, c.y, c.z]).toEqual([1, 2, 3]);
  });
});
