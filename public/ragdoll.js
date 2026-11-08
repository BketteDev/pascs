// Death ragdolls for ValveBiped player models.
// One verlet particle per ragdoll bone (the same 15 bones CS:S's .phy ragdolls use), stick constraints along the
// skeleton plus torso cross-braces, world collision through the hull trace, and the killing bullet's impulse.
// Bone orientations are rebuilt each frame from the particles; non-ragdoll bones (fingers etc.) ride on their parent.
// shortcut: no joint angle limits (knees/elbows can over-bend); upgrade by reading the .phy "ragdollconstraint" ranges.

const B = (n) => 'ValveBiped.Bip01_' + n;
// bone -> { parent ragdoll bone, aim child, secondary axis [from, to] (gives twist), radius }
const RIG = {
  [B('Pelvis')]: { aim: B('Spine2'), side: [B('R_Thigh'), B('L_Thigh')], r: 7 },
  [B('Spine2')]: { parent: B('Pelvis'), aim: B('Head1'), side: [B('R_UpperArm'), B('L_UpperArm')], r: 7 },
  [B('Head1')]: { parent: B('Spine2'), follow: B('Spine2'), r: 6 },
  [B('L_UpperArm')]: { parent: B('Spine2'), aim: B('L_Forearm'), side: [B('L_Forearm'), B('L_Hand')], r: 3.5 },
  [B('L_Forearm')]: { parent: B('L_UpperArm'), aim: B('L_Hand'), side: [B('L_UpperArm'), B('L_Forearm')], r: 3 },
  [B('L_Hand')]: { parent: B('L_Forearm'), follow: B('L_Forearm'), r: 2.5 },
  [B('R_UpperArm')]: { parent: B('Spine2'), aim: B('R_Forearm'), side: [B('R_Forearm'), B('R_Hand')], r: 3.5 },
  [B('R_Forearm')]: { parent: B('R_UpperArm'), aim: B('R_Hand'), side: [B('R_UpperArm'), B('R_Forearm')], r: 3 },
  [B('R_Hand')]: { parent: B('R_Forearm'), follow: B('R_Forearm'), r: 2.5 },
  [B('L_Thigh')]: { parent: B('Pelvis'), aim: B('L_Calf'), side: [B('L_Calf'), B('L_Foot')], r: 4.5 },
  [B('L_Calf')]: { parent: B('L_Thigh'), aim: B('L_Foot'), side: [B('L_Thigh'), B('L_Calf')], r: 4 },
  [B('L_Foot')]: { parent: B('L_Calf'), follow: B('L_Calf'), r: 3 },
  [B('R_Thigh')]: { parent: B('Pelvis'), aim: B('R_Calf'), side: [B('R_Calf'), B('R_Foot')], r: 4.5 },
  [B('R_Calf')]: { parent: B('R_Thigh'), aim: B('R_Foot'), side: [B('R_Thigh'), B('R_Calf')], r: 4 },
  [B('R_Foot')]: { parent: B('R_Calf'), follow: B('R_Calf'), r: 3 },
};
// keep the torso a rigid-ish block
const BRACES = [[B('Pelvis'), B('L_UpperArm')], [B('Pelvis'), B('R_UpperArm')], [B('Spine2'), B('L_Thigh')], [B('Spine2'), B('R_Thigh')],
  [B('L_Thigh'), B('R_Thigh')], [B('L_UpperArm'), B('R_UpperArm')], [B('Head1'), B('L_UpperArm')], [B('Head1'), B('R_UpperArm')], [B('Pelvis'), B('Head1')]];
const GRAVITY = 800, DAMP = 0.997, ITER = 8, SLEEP = 4;

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
const pos = (M, i) => [M[i + 3], M[i + 7], M[i + 11]];
// orthonormal frame (columns x, y, z) from an aim vector and a secondary vector; null if they are parallel
const frame = (a, s) => { const x = norm(a), zc = cross(x, s); if (len(zc) < 1e-3 * len(s)) return null; const z = norm(zc), y = cross(z, x); return [x, y, z]; };
const rotBetween = (F0, F1) => { // R = F1 * F0^T as 3x3 row-major
  const R = new Array(9);
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) R[r * 3 + c] = F1[0][r] * F0[0][c] + F1[1][r] * F0[1][c] + F1[2][r] * F0[2][c];
  return R;
};
const minimalRot = (a, b) => { // rotation taking direction a onto b (Rodrigues)
  a = norm(a); b = norm(b);
  const v = cross(a, b), c = a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (c < -0.9999) return [-1, 0, 0, 0, -1, 0, 0, 0, 1];
  const k = 1 / (1 + c);
  return [v[0] * v[0] * k + c, v[0] * v[1] * k - v[2], v[0] * v[2] * k + v[1], v[1] * v[0] * k + v[2], v[1] * v[1] * k + c, v[1] * v[2] * k - v[0], v[2] * v[0] * k - v[1], v[2] * v[1] * k + v[0], v[2] * v[2] * k + c];
};

/**
 * @param bones model skeleton (parent-first order) ; W world-space 3x4 matrices of every bone at the moment of death
 * @param hitBone bone index the bullet hit ; dir unit shot direction ; trace(from, to, mins, maxs) -> hull trace
 */
export function createRagdoll(bones, W, hitBone, dir, trace, force = 1) { // force: how hard the killing blow hits (1 = rifle)
  const index = new Map(bones.map((b, i) => [b.name, i]));
  const parts = Object.keys(RIG).filter((n) => index.has(n)).map((name) => ({ name, bone: index.get(name), rig: RIG[name] }));
  const pi = new Map(parts.map((p, k) => [p.name, k]));
  const P = parts.map((p) => pos(W, p.bone * 12));
  // the ragdoll part nearest the hit bone (walk up the skeleton) takes the full impulse
  let h = hitBone; while (h >= 0 && !parts.some((p) => p.bone === h)) h = bones[h].parent;
  const dt0 = 1 / 66;
  // punched back: the whole body is thrown away from the shooter (flat along the ground) and the hit part, the chest, goes hardest so the torso
  // leads and the legs trail, which also makes the body spin a little as it flies
  const flat = norm([dir[0], dir[1], 0]); // projected along the floor, not up
  const prev = P.map((p, k) => { const hit = parts[k].bone === h, s = (hit ? 660 : parts[k].name.includes("Pelvis") || parts[k].name.includes("Spine") ? 510 : 400) * force; return [p[0] - flat[0] * s * dt0, p[1] - flat[1] * s * dt0, p[2] - 25 * dt0]; });
  const sticks = [];
  const stick = (a, b) => { const i = pi.get(a), j = pi.get(b); if (i !== undefined && j !== undefined) sticks.push([i, j, len(sub(P[i], P[j]))]); };
  parts.forEach((p) => p.rig.parent && stick(p.name, p.rig.parent));
  BRACES.forEach(([a, b]) => stick(a, b));
  // rest data for rebuilding orientations
  const rest = parts.map((p) => {
    const R0 = [W[p.bone * 12], W[p.bone * 12 + 1], W[p.bone * 12 + 2], W[p.bone * 12 + 4], W[p.bone * 12 + 5], W[p.bone * 12 + 6], W[p.bone * 12 + 8], W[p.bone * 12 + 9], W[p.bone * 12 + 10]];
    return { R0 };
  });
  // every other bone keeps its local transform relative to its parent
  const local = bones.map((b, i) => {
    if (b.parent < 0) return null;
    const pm = b.parent * 12, m = i * 12, out = new Array(12);
    const d = [W[m + 3] - W[pm + 3], W[m + 7] - W[pm + 7], W[m + 11] - W[pm + 11]];
    for (let r = 0; r < 3; r++) { // inv(parent) * child for rigid transforms: R^T * [R_c | t_c - t_p]
      for (let c = 0; c < 3; c++) out[r * 4 + c] = W[pm + r] * W[m + c] + W[pm + 4 + r] * W[m + 4 + c] + W[pm + 8 + r] * W[m + 8 + c];
      out[r * 4 + 3] = W[pm + r] * d[0] + W[pm + 4 + r] * d[1] + W[pm + 8 + r] * d[2];
    }
    return out;
  });
  const P0 = P.map((p) => [...p]);
  return { parts, pi, P, prev, sticks, rest, local, P0, time: 0, trace };
}

export function stepRagdoll(rd, dt) {
  if (rd.time > SLEEP) return; // settled: freeze to save work
  rd.time += dt;
  const steps = Math.max(1, Math.ceil(dt / (1 / 66)));
  const h = Math.min(dt, 0.1) / steps;
  for (let s = 0; s < steps; s++) {
    const before = rd.P.map((p) => [...p]);
    rd.P.forEach((p, k) => { // verlet integrate + sweep against the world
      const r = rd.parts[k].rig.r, q = rd.prev[k];
      const v = [(p[0] - q[0]) * DAMP, (p[1] - q[1]) * DAMP, (p[2] - q[2]) * DAMP - GRAVITY * h * h];
      const to = [p[0] + v[0], p[1] + v[1], p[2] + v[2]];
      const t = rd.trace(p, to, [-r, -r, -r], [r, r, r]);
      rd.prev[k] = [...p];
      if (t.fraction < 1 && t.normal) { // contact: keep the end point, kill most of the tangential speed (friction)
        const n = t.normal, vn = v[0] * n[0] + v[1] * n[1] + v[2] * n[2], vt = [v[0] - n[0] * vn, v[1] - n[1] * vn, v[2] - n[2] * vn];
        p[0] = t.end[0]; p[1] = t.end[1]; p[2] = t.end[2];
        const keep = rd.time < 0.35 ? 0.9 : 0.4; // just after the blow the body skims along the floor, then drags to a stop
        rd.prev[k] = [p[0] - vt[0] * keep, p[1] - vt[1] * keep, p[2] - vt[2] * keep];
      } else if (!t.startSolid) { p[0] = to[0]; p[1] = to[1]; p[2] = to[2]; }
    });
    for (let it = 0; it < ITER; it++) for (const [i, j, L] of rd.sticks) {
      const a = rd.P[i], b = rd.P[j], d = sub(b, a), l = len(d) || 1e-6, k = ((l - L) / l) * 0.5;
      for (let c = 0; c < 3; c++) { a[c] += d[c] * k; b[c] -= d[c] * k; }
    }
    rd.P.forEach((p, k) => { // constraints must not push a part into a wall
      const r = rd.parts[k].rig.r, t = rd.trace(before[k], p, [-r, -r, -r], [r, r, r]);
      if (t.fraction < 1 && !t.startSolid) { p[0] = t.end[0]; p[1] = t.end[1]; p[2] = t.end[2]; }
    });
  }
}

/** Writes world-space 3x4 matrices for every bone into W. */
export function ragdollPose(rd, bones, W) {
  const delta = new Map(); // ragdoll bone -> rotation since death
  for (const [k, p] of rd.parts.entries()) {
    let R;
    if (p.rig.follow) R = delta.get(p.rig.follow);
    else {
      const a = rd.pi.get(p.rig.aim), s = p.rig.side.map((n) => rd.pi.get(n));
      const a0 = sub(rd.P0[a], rd.P0[k]), a1 = sub(rd.P[a], rd.P[k]);
      const F0 = frame(a0, sub(rd.P0[s[1]], rd.P0[s[0]])), F1 = frame(a1, sub(rd.P[s[1]], rd.P[s[0]]));
      R = F0 && F1 ? rotBetween(F0, F1) : minimalRot(a0, a1);
    }
    delta.set(p.name, R);
    const R0 = rd.rest[k].R0, o = p.bone * 12;
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) W[o + r * 4 + c] = R[r * 3] * R0[c] + R[r * 3 + 1] * R0[3 + c] + R[r * 3 + 2] * R0[6 + c];
    W[o + 3] = rd.P[k][0]; W[o + 7] = rd.P[k][1]; W[o + 11] = rd.P[k][2];
  }
  const simulated = new Set(rd.parts.map((p) => p.bone));
  bones.forEach((b, i) => { // the rest follow their parents rigidly
    if (simulated.has(i) || b.parent < 0) return;
    const L = rd.local[i], pm = b.parent * 12, o = i * 12;
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) W[o + r * 4 + c] = W[pm + r * 4] * L[c] + W[pm + r * 4 + 1] * L[4 + c] + W[pm + r * 4 + 2] * L[8 + c];
      W[o + r * 4 + 3] = W[pm + r * 4] * L[3] + W[pm + r * 4 + 1] * L[7] + W[pm + r * 4 + 2] * L[11] + W[pm + r * 4 + 3];
    }
  });
}
