// Minimal Source model loader: .mdl (v44-49) + .vvd + .dx90.vtx -> static triangle meshes (LOD 0, body group 0, skin 0 by default).
import fs from 'fs';

/**
 * @param {string} base path without extension, e.g. ".../models/props/de_dust/du_crate_64x64"
 * @param {number} skin skin family index
 * @returns {{hullMin:number[], hullMax:number[], meshes:{material:string, cd:string[], pos:number[], nrm:number[], uv:number[]}[]}}
 */
export function loadModel(base, skin = 0) {
  const mdl = fs.readFileSync(base + '.mdl'), vvd = fs.readFileSync(base + '.vvd'), vtx = fs.readFileSync(base + '.dx90.vtx');
  if (mdl.toString('latin1', 0, 4) !== 'IDST' || vvd.toString('latin1', 0, 4) !== 'IDSV') throw new Error('bad model files ' + base);
  const str = (o) => mdl.toString('latin1', o, mdl.indexOf(0, o));
  const v49 = mdl.readInt32LE(4) >= 49, SG_SIZE = v49 ? 33 : 25, STRIP_SIZE = v49 ? 35 : 27; // CS:GO (MDL 49) VTX headers carry topology fields
  const f3 = (b, o) => [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)];

  // textures + search dirs + skin table
  const [numTex, texIdx, numCd, cdIdx, numSkinRef, numSkinFam, skinIdx, numBody, bodyIdx] = Array.from({ length: 9 }, (_, i) => mdl.readInt32LE(204 + i * 4));
  const texNames = Array.from({ length: numTex }, (_, i) => str(texIdx + i * 64 + mdl.readInt32LE(texIdx + i * 64)));
  const cd = Array.from({ length: numCd }, (_, i) => str(mdl.readInt32LE(cdIdx + i * 4)).replace(/\\/g, '/'));
  const fam = Math.min(skin, numSkinFam - 1);
  const skinRef = Array.from({ length: numSkinRef }, (_, i) => mdl.readInt16LE(skinIdx + (fam * numSkinRef + i) * 2));

  // VVD vertices with LOD0 fixups applied
  const numFixups = vvd.readInt32LE(48), fixTable = vvd.readInt32LE(52), vertStart = vvd.readInt32LE(56);
  const rawVerts = [];
  const readVert = (i) => {
    const o = vertStart + i * 48, nb = vvd.readUInt8(o + 15);
    const bw = [0, 1, 2, 3].map((k) => (k < nb && k < 3 ? vvd.readFloatLE(o + k * 4) : 0)), bi = [0, 1, 2, 3].map((k) => (k < nb && k < 3 ? vvd.readUInt8(o + 12 + k) : 0));
    return { p: f3(vvd, o + 16), n: f3(vvd, o + 28), uv: [vvd.readFloatLE(o + 40), vvd.readFloatLE(o + 44)], bw, bi };
  };
  if (numFixups === 0) for (let i = 0; i < vvd.readInt32LE(16); i++) rawVerts.push(readVert(i)); // numLODVertexes[0]
  else for (let k = 0; k < numFixups; k++) {
    const lod = vvd.readInt32LE(fixTable + k * 12), src = vvd.readInt32LE(fixTable + k * 12 + 4), n = vvd.readInt32LE(fixTable + k * 12 + 8);
    if (lod >= 0) for (let i = 0; i < n; i++) rawVerts.push(readVert(src + i));
  }

  // walk mdl body parts/models/meshes (body group 0) in lockstep with the vtx hierarchy
  const meshes = [];
  const bodyOff = vtx.readInt32LE(32);
  for (let bp = 0; bp < Math.min(numBody, 1 << 8); bp++) {
    const bpo = bodyIdx + bp * 16, nModels = mdl.readInt32LE(bpo + 4), modelIdx = mdl.readInt32LE(bpo + 12);
    if (nModels < 1) continue;
    const mo = bpo + modelIdx; // model 0 of this body part
    const numMeshes = mdl.readInt32LE(mo + 72), meshIdx = mdl.readInt32LE(mo + 76), modelVertStart = mdl.readInt32LE(mo + 84) / 48;
    const vbp = bodyOff + bp * 8, vmodel = vbp + vtx.readInt32LE(vbp + 4);       // vtx model 0
    const vlod = vmodel + vtx.readInt32LE(vmodel + 4);                            // lod 0
    const vMeshBase = vlod + vtx.readInt32LE(vlod + 4);
    for (let m = 0; m < numMeshes; m++) {
      const mmo = mo + meshIdx + m * 116, matRef = mdl.readInt32LE(mmo), vertOffset = mdl.readInt32LE(mmo + 12);
      const vm = vMeshBase + m * 9, nGroups = vtx.readInt32LE(vm), groupOff = vm + vtx.readInt32LE(vm + 4);
      const mesh = { material: texNames[skinRef[matRef]] ?? texNames[0], cd, pos: [], nrm: [], uv: [], bw: [], bi: [] };
      for (let g = 0; g < nGroups; g++) {
        const sg = groupOff + g * SG_SIZE;
        const nVerts = vtx.readInt32LE(sg), vertO = sg + vtx.readInt32LE(sg + 4), nIdx = vtx.readInt32LE(sg + 8), idxO = sg + vtx.readInt32LE(sg + 12);
        const nStrips = vtx.readInt32LE(sg + 16), stripO = sg + vtx.readInt32LE(sg + 20);
        const gv = Array.from({ length: nVerts }, (_, i) => vtx.readUInt16LE(vertO + i * 9 + 4)); // origMeshVertID
        const gi = Array.from({ length: nIdx }, (_, i) => vtx.readUInt16LE(idxO + i * 2));
        for (let s = 0; s < nStrips; s++) {
          const so = stripO + s * STRIP_SIZE, sn = vtx.readInt32LE(so), si = vtx.readInt32LE(so + 4), flags = vtx.readUInt8(so + 18);
          const tris = [];
          if (flags & 1) for (let i = 0; i + 2 < sn; i += 3) tris.push([gi[si + i], gi[si + i + 1], gi[si + i + 2]]);
          else for (let i = 0; i + 2 < sn; i++) tris.push(i & 1 ? [gi[si + i + 1], gi[si + i], gi[si + i + 2]] : [gi[si + i], gi[si + i + 1], gi[si + i + 2]]);
          for (const t of tris) for (const k of t) {
            const v = rawVerts[modelVertStart + vertOffset + gv[k]];
            if (!v) throw new Error('vertex index out of range in ' + base);
            mesh.pos.push(...v.p); mesh.nrm.push(...v.n); mesh.uv.push(...v.uv); mesh.bw.push(...v.bw); mesh.bi.push(...v.bi);
          }
        }
      }
      // Fix winding using the stored normals (majority vote per mesh).
      let agree = 0, total = 0;
      for (let t = 0; t < mesh.pos.length; t += 9) {
        const a = mesh.pos.slice(t, t + 3), b = mesh.pos.slice(t + 3, t + 6), c = mesh.pos.slice(t + 6, t + 9);
        const u = b.map((x, i) => x - a[i]), w = c.map((x, i) => x - a[i]);
        const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
        const d = n[0] * mesh.nrm[t] + n[1] * mesh.nrm[t + 1] + n[2] * mesh.nrm[t + 2];
        if (d !== 0) { total++; if (d > 0) agree++; }
      }
      if (total && agree < total / 2) { // swap vertices 2 and 3 of every triangle in all attributes
        for (const [arr, n] of [[mesh.pos, 3], [mesh.nrm, 3], [mesh.uv, 2], [mesh.bw, 4], [mesh.bi, 4]]) for (let t = 0; t < arr.length; t += 3 * n) {
          const b = arr.slice(t + n, t + 2 * n), c = arr.slice(t + 2 * n, t + 3 * n);
          arr.splice(t + n, 2 * n, ...c, ...b);
        }
      }
      if (mesh.pos.length) meshes.push(mesh);
    }
  }
  return { hullMin: f3(mdl, 104), hullMax: f3(mdl, 116), meshes };
}

/**
 * Collision model (.phy): list of convex pieces, each {points, planes:[[nx,ny,nz,d]...], edges:[[p,q]...]} in model space (Source units).
 * Havok/IVP stores meters with (x, z, -y) axes: hl = (x, z, -y) / 0.0254 (a proper rotation).
 */
export function loadPhy(file) {
  const b = fs.readFileSync(file);
  const headerSize = b.readInt32LE(0), solidCount = b.readInt32LE(8);
  const pieces = [];
  let s = headerSize;
  for (let sol = 0; sol < solidCount; sol++) {
    const size = b.readInt32LE(s), cs = s + 4 + 28; // compact surface starts after the 32-byte legacy+compact headers
    if (b.toString('latin1', s + 4, s + 8) !== 'VPHY') break;
    const root = cs + b.readInt32LE(cs + 32);
    const visit = (n) => {
      const right = b.readInt32LE(n);
      if (right === 0) { ledge(n + b.readInt32LE(n + 4)); return; }
      visit(n + 28); visit(n + right); // left child directly follows the node, right child by offset
    };
    const ledge = (l) => {
      const pointBase = l + b.readInt32LE(l), nTri = b.readInt16LE(l + 12);
      const used = new Set(), tris = [];
      for (let t = 0; t < nTri; t++) {
        const to = l + 16 + t * 16, idx = [0, 1, 2].map((e) => b.readUInt16LE(to + 4 + e * 4));
        tris.push(idx); idx.forEach((i) => used.add(i));
      }
      const pt = (i) => { const o = pointBase + i * 16, x = b.readFloatLE(o), y = b.readFloatLE(o + 4), z = b.readFloatLE(o + 8); return [x / 0.0254, z / 0.0254, -y / 0.0254]; };
      const points = [...used].map(pt), c = [0, 1, 2].map((a) => points.reduce((m, p) => m + p[a], 0) / points.length);
      const planes = [];
      for (const [i0, i1, i2] of tris) {
        const p0 = pt(i0), p1 = pt(i1), p2 = pt(i2), u = p1.map((v, k) => v - p0[k]), w = p2.map((v, k) => v - p0[k]);
        let n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]; const len = Math.hypot(...n);
        if (len < 1e-6) continue;
        n = n.map((v) => v / len);
        let d = n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2];
        if (n[0] * c[0] + n[1] * c[1] + n[2] * c[2] > d) { n = n.map((v) => -v); d = -d; } // outward = away from the piece's centre
        if (!planes.some((q) => Math.abs(q[0] - n[0]) + Math.abs(q[1] - n[1]) + Math.abs(q[2] - n[2]) < 1e-3 && Math.abs(q[3] - d) < 0.05)) planes.push([...n, d]);
      }
      const key = new Map(), edgesOut = [];
      for (const [i0, i1, i2] of tris) for (const [a, b] of [[i0, i1], [i1, i2], [i2, i0]]) {
        const k = a < b ? a + ',' + b : b + ',' + a;
        if (!key.has(k)) { key.set(k, 1); edgesOut.push([pt(a), pt(b)]); }
      }
      pieces.push({ points, planes, edges: edgesOut });
    };
    visit(root);
    s += 4 + size;
  }
  return pieces;
}

// ---------------------------------------------------------------------------------------------------------------
// Skeletal animation (studio v44-48): bones + sequences decoded and baked to per-frame skinning matrices.
// Matrices are Source 3x4 row-major [r00 r01 r02 tx, r10 r11 r12 ty, r20 r21 r22 tz] = boneToWorld * poseToBone.

const f16 = (h) => { // IEEE half -> float
  const s = h & 0x8000 ? -1 : 1, e = (h >> 10) & 31, m = h & 1023;
  return e === 0 ? s * m * 2 ** -24 : e === 31 ? (m ? NaN : s * Infinity) : s * (1 + m / 1024) * 2 ** (e - 15);
};
const eulerQuat = ([x, y, z]) => { // Source AngleQuaternion(RadianEuler)
  const sr = Math.sin(x / 2), cr = Math.cos(x / 2), sp = Math.sin(y / 2), cp = Math.cos(y / 2), sy = Math.sin(z / 2), cy = Math.cos(z / 2);
  return [sr * cp * cy - cr * sp * sy, cr * sp * cy + sr * cp * sy, cr * cp * sy - sr * sp * cy, cr * cp * cy + sr * sp * sy];
};
const quatMatrix = ([x, y, z, w], [px, py, pz]) => [
  1 - 2 * y * y - 2 * z * z, 2 * x * y - 2 * w * z, 2 * x * z + 2 * w * y, px,
  2 * x * y + 2 * w * z, 1 - 2 * x * x - 2 * z * z, 2 * y * z - 2 * w * x, py,
  2 * x * z - 2 * w * y, 2 * y * z + 2 * w * x, 1 - 2 * x * x - 2 * y * y, pz,
];
export const mul34 = (a, b) => { // 3x4 * 3x4 (implicit last row 0 0 0 1)
  const o = new Array(12);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c];
    o[r * 4 + 3] = a[r * 4] * b[3] + a[r * 4 + 1] * b[7] + a[r * 4 + 2] * b[11] + a[r * 4 + 3];
  }
  return o;
};

/** Bones, attachments and sequences of a .mdl. */
export function loadSkeleton(file) {
  const b = fs.readFileSync(file);
  const I = (o) => b.readInt32LE(o), F = (o) => b.readFloatLE(o), str = (o) => b.toString('latin1', o, b.indexOf(0, o));
  const v3 = (o) => [F(o), F(o + 4), F(o + 8)];
  const bones = Array.from({ length: I(156) }, (_, i) => {
    const o = I(160) + i * 216;
    return { name: str(o + I(o)), parent: I(o + 4), pos: v3(o + 32), quat: [F(o + 44), F(o + 48), F(o + 52), F(o + 56)], rot: v3(o + 60), posscale: v3(o + 72), rotscale: v3(o + 84), poseToBone: Array.from({ length: 12 }, (_, k) => F(o + 96 + k * 4)) };
  });
  const attachments = Array.from({ length: I(240) }, (_, i) => {
    const o = I(244) + i * 92;
    return { name: str(o + I(o)), bone: I(o + 8), local: Array.from({ length: 12 }, (_, k) => F(o + 12 + k * 4)) };
  });
  const anims = Array.from({ length: I(180) }, (_, i) => {
    const o = I(184) + i * 100;
    if (I(o + 52) !== 0) throw new Error('external animation blocks are not supported');
    return { o, name: str(o + I(o + 4)), fps: F(o + 8), loop: !!(I(o + 12) & 1), delta: !!(I(o + 12) & 4), frames: I(o + 16), animindex: I(o + 56), sectionindex: I(o + 80), sectionframes: I(o + 84) };
  });
  const sequences = Array.from({ length: I(188) }, (_, i) => {
    const o = I(192) + i * 212;
    const blends = I(o + 56), group = [I(o + 68), I(o + 72)], param = [I(o + 76), I(o + 80)], wl = I(o + 156);
    return {
      name: str(o + I(o + 4)), activity: str(o + I(o + 8)), flags: I(o + 12), anim: b.readInt16LE(o + I(o + 60)),
      blends: Array.from({ length: group[0] * group[1] || blends }, (_, k) => b.readInt16LE(o + I(o + 60) + k * 2)), group, param,
      weights: wl ? Array.from({ length: bones.length }, (_, k) => F(o + wl + k * 4)) : null,
      // layers Source plays under / over this sequence (mstudioautolayer_t): the aim matrix, hand position... seq = index in this file
      autolayers: Array.from({ length: I(o + 148) }, (_, k) => { const a = o + I(o + 152) + k * 24; return { seq: b.readInt16LE(a), pose: b.readInt16LE(a + 2), flags: I(a + 4), start: F(a + 8), peak: F(a + 12), tail: F(a + 16), end: F(a + 20) }; }),
    };
  });
  const poseParams = Array.from({ length: I(300) }, (_, i) => { const o = I(304) + i * 20; return { name: str(o + I(o)), start: F(o + 8), end: F(o + 12) }; });
  const hitboxes = (() => { // hitbox set 0: { bone, group, min, max } in bone space
    if (!I(172)) return [];
    const set = I(176), n = I(set + 4), idx = set + I(set + 8);
    return Array.from({ length: n }, (_, i) => { const o = idx + i * 68; return { bone: I(o), group: I(o + 4), min: v3(o + 8), max: v3(o + 20) }; });
  })();
  const includes = Array.from({ length: I(336) }, (_, i) => { const o = I(340) + i * 8; return str(o + I(o + 4)); });

  // value stream (mstudioanimvalue_t): runs of {valid, total} headers followed by `valid` shorts
  const animValue = (p, frame) => {
    let k = frame;
    while (b.readUInt8(p + 1) <= k) { k -= b.readUInt8(p + 1); p += (b.readUInt8(p) + 1) * 2; if (b.readUInt8(p + 1) === 0) return 0; }
    const valid = b.readUInt8(p);
    return b.readInt16LE(p + 2 * (valid > k ? k + 1 : valid));
  };
  // local pos/quat of every bone at one frame
  function pose(anim, frame) {
    let base = anim.o + anim.animindex, f = frame;
    if (anim.sectionframes) { const s = Math.floor(frame / anim.sectionframes); base = anim.o + I(anim.o + anim.sectionindex + s * 8 + 4); f = frame - s * anim.sectionframes; }
    const dl = anim.delta; // delta animations (aim matrix, gestures) store offsets: no bone rest pose underneath
    const out = bones.map((bn) => (dl ? { pos: [0, 0, 0], quat: [0, 0, 0, 1] } : { pos: bn.pos, quat: bn.quat }));
    for (let p = base; ;) {
      const bone = b.readUInt8(p), flags = b.readUInt8(p + 1), next = b.readInt16LE(p + 2), d = p + 4, bn = bones[bone];
      if (bn) {
        let quat = dl ? [0, 0, 0, 1] : bn.quat, pos = dl ? [0, 0, 0] : bn.pos;
        if (flags & 0x02) { // Quaternion48
          const x = (b.readUInt16LE(d) - 32768) / 32768, y = (b.readUInt16LE(d + 2) - 32768) / 32768, zw = b.readUInt16LE(d + 4);
          const z = ((zw & 0x7fff) - 16384) / 16384, w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
          quat = [x, y, z, zw & 0x8000 ? -w : w];
        } else if (flags & 0x20) { // Quaternion64
          const lo = b.readUInt32LE(d), hi = b.readUInt32LE(d + 4), big = BigInt(lo) | (BigInt(hi) << 32n);
          const c = (s) => (Number((big >> BigInt(s)) & 0x1fffffn) - 1048576) / 1048576.5;
          const x = c(0), y = c(21), z = c(42), w = Math.sqrt(Math.max(0, 1 - x * x - y * y - z * z));
          quat = [x, y, z, hi & 0x80000000 ? -w : w];
        } else if (flags & 0x08) { // animated euler
          quat = eulerQuat([0, 1, 2].map((k) => { const off = b.readInt16LE(d + k * 2); return (dl ? 0 : bn.rot[k]) + (off ? animValue(d + off, f) * bn.rotscale[k] : 0); }));
        }
        if (flags & 0x01) { // Vector48
          const q = d + (flags & 0x02 ? 6 : 0) + (flags & 0x20 ? 8 : 0);
          pos = [f16(b.readUInt16LE(q)), f16(b.readUInt16LE(q + 2)), f16(b.readUInt16LE(q + 4))];
        } else if (flags & 0x04) { // animated position
          const q = d + (flags & 0x08 ? 6 : 0);
          pos = [0, 1, 2].map((k) => { const off = b.readInt16LE(q + k * 2); return (dl ? 0 : bn.pos[k]) + (off ? animValue(q + off, f) * bn.posscale[k] : 0); });
        }
        out[bone] = { pos, quat };
      }
      if (!next) break;
      p += next;
    }
    return out;
  }
  // bone -> model space matrices for a frame
  function boneToWorld(anim, frame) {
    const local = pose(anim, frame), world = [];
    bones.forEach((bn, i) => { const m = quatMatrix(local[i].quat, local[i].pos); world[i] = bn.parent >= 0 ? mul34(world[bn.parent], m) : m; });
    return world;
  }
  return { bones, attachments, anims, sequences, poseParams, hitboxes, includes, pose, boneToWorld };
}

/** Bake every sequence: frames of skinning matrices (bones*12 floats) + attachment 0 origin per frame. */
export function bakeSequences(sk) {
  return sk.sequences.map((seq) => {
    const anim = sk.anims[seq.anim];
    const skin = [], attach = [];
    for (let fr = 0; fr < anim.frames; fr++) {
      const w = sk.boneToWorld(anim, fr);
      w.forEach((m, i) => skin.push(...mul34(m, sk.bones[i].poseToBone)));
      const at = sk.attachments[0];
      if (at) { const m = mul34(w[at.bone], at.local); attach.push(m[3], m[7], m[11]); }
    }
    return { name: seq.name, activity: seq.activity, fps: anim.fps, frames: anim.frames, loop: anim.loop, skin, attach };
  });
}
