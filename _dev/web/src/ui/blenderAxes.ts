import * as THREE from "three";
import type { FrameState } from "../viewer/SceneFrame";

/**
 * The viewer is three.js (Y up); every number the user sees is Blender (Z up), so what
 * the panel says matches what the Blender add-on imports. Mapping (same as the
 * Layouter's cameraBar.ts): Blender = M · three with M = +90° about X,
 * (x, y, z)_three → (x, −z, y)_Blender.
 */
const M = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
const MI = M.clone().invert();

export type V3 = [number, number, number];

export const toBlenderPos = (p: V3): V3 => [p[0], -p[2], p[1]];
export const fromBlenderPos = (p: V3): V3 => [p[0], p[2], -p[1]];

/** three.js XYZ Euler (degrees) → Blender XYZ Euler (degrees). */
export function toBlenderRot(deg: V3): V3 {
  const r = (v: number) => (v * Math.PI) / 180;
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(r(deg[0]), r(deg[1]), r(deg[2]), "XYZ"));
  const qb = M.clone().multiply(q).multiply(MI);
  const e = new THREE.Euler().setFromQuaternion(qb, "XYZ");
  const d = (v: number) => +((v * 180) / Math.PI).toFixed(4);
  return [d(e.x), d(e.y), d(e.z)];
}

/** Blender XYZ Euler (degrees) → three.js XYZ Euler (degrees). */
export function fromBlenderRot(deg: V3): V3 {
  const r = (v: number) => (v * Math.PI) / 180;
  const qb = new THREE.Quaternion().setFromEuler(new THREE.Euler(r(deg[0]), r(deg[1]), r(deg[2]), "XYZ"));
  const q = MI.clone().multiply(qb).multiply(M);
  const e = new THREE.Euler().setFromQuaternion(q, "XYZ");
  const d = (v: number) => +((v * 180) / Math.PI).toFixed(4);
  return [d(e.x), d(e.y), d(e.z)];
}

/** The whole-scene transform as Blender numbers. */
export interface BlenderState { pos: V3; rotDeg: V3; scale: number }
export const toBlender = (s: FrameState): BlenderState => ({ pos: toBlenderPos(s.pos), rotDeg: toBlenderRot(s.rotDeg), scale: s.scale });
export const fromBlender = (b: BlenderState): FrameState => ({ pos: fromBlenderPos(b.pos), rotDeg: fromBlenderRot(b.rotDeg), scale: b.scale });

/** Which three.js axis a Blender axis letter means (for G X / R Y constraints). */
export const AXIS_TO_THREE: Record<"x" | "y" | "z", { v: THREE.Vector3; sign: number; show: "x" | "y" | "z" }> = {
  x: { v: new THREE.Vector3(1, 0, 0), sign: 1, show: "x" },
  y: { v: new THREE.Vector3(0, 0, -1), sign: -1, show: "z" },
  z: { v: new THREE.Vector3(0, 1, 0), sign: 1, show: "y" },
};
