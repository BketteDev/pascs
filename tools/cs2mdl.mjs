// Native CS2 .vmdl_c loader (KV3 MDAT/DATA/PHYS + meshopt MBUF) for VMF prop recovery.
// Decimates high-poly CS2 meshes per drawCall so rebuilt map world.bin files stay compact (< 50 MB).
import path from 'path';
import { MeshoptDecoder } from '../node_modules/three/examples/jsm/libs/meshopt_decoder.module.js';
import { cs2Pak, lz4 } from './cs2tex.mjs';

await MeshoptDecoder.ready;

// shortcut: decimate CS2 props above MAX_TRIS by spatial+UV vertex clustering to keep world.bin < 50 MB for GitHub; override via CS2_PROP_CAP env var
const MAX_TRIS = Number(process.env.CS2_PROP_CAP) || 650;

function blocks(b) {
  const bc = b.readUInt32LE(12), tbl = 8 + b.readUInt32LE(8), m = new Map();
  for (let i = 0; i < bc; i++) {
    const o = tbl + i * 12;
    m.set(b.toString('latin1', o, o + 4), b.subarray(o + 4 + b.readInt32LE(o + 4), o + 4 + b.readInt32LE(o + 4) + b.readUInt32LE(o + 8)));
  }
  return m;
}

function lz4Into(src, sStart, sEnd, out, dStart, dEnd) {
  let s = sStart, d = dStart;
  while (s < sEnd && d < dEnd) {
    const t = src[s++]; let lit = t >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    src.copy(out, d, s, s + lit); s += lit; d += lit;
    if (s >= sEnd || d >= dEnd) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let ml = t & 15; if (ml === 15) { let b; do { b = src[s++]; ml += b; } while (b === 255); }
    ml += 4;
    for (let i = 0; i < ml; i++) { out[d] = out[d - off]; d++; }
  }
}

function readBlobs(blk, dec, compSz) {
  const nBlobs = blk.readUInt32LE(56), blobsU = blk.readUInt32LE(60);
  if (!nBlobs || !blobsU) return [];
  const em = dec.lastIndexOf(Buffer.from([0, 0xdd, 0xee, 0xff]));
  if (em < nBlobs * 4) return [];
  const us = Array.from({ length: nBlobs }, (_, j) => dec.readUInt32LE(em - nBlobs * 4 + j * 4));
  const tail = blk.subarray(72 + compSz);
  const out = Buffer.alloc(blobsU);
  const slices = [];
  if (dec.length - (em + 4) >= nBlobs * 2 && tail.length < blobsU) {
    const nCs = ((dec.length - (em + 4)) / 2) | 0;
    const cs = Array.from({ length: nCs }, (_, j) => dec.readUInt16LE(em + 4 + j * 2));
    let ci = 0, s = 0, d = 0;
    for (let j = 0; j < nBlobs; j++) {
      const dStart = d;
      let rem = us[j];
      while (rem > 0 && ci < nCs) {
        const subU = Math.min(16384, rem), subC = cs[ci++];
        lz4Into(tail, s, s + subC, out, d, d + subU);
        s += subC; d += subU; rem -= subU;
      }
      slices.push(out.subarray(dStart, d));
    }
  } else {
    const raw = tail.length === blobsU ? tail : lz4(tail, blobsU);
    for (let j = 0, d = 0; j < nBlobs; j++) { slices.push(raw.subarray(d, d + us[j])); d += us[j]; }
  }
  return slices;
}

function kv3(blk, withBlobs = false) {
  if (!blk || blk.length < 72 || blk.toString('latin1', 1, 4) !== '3VK') return null;
  if (blk[0] !== 4 && blk[0] !== 0x20) return null; // KV3 v4
  const meth = blk.readUInt32LE(20), n1 = blk.readUInt32LE(28), n4 = blk.readUInt32LE(32), n8 = blk.readUInt32LE(36);
  const uncompSz = blk.readUInt32LE(48), compSz = blk.readUInt32LE(52);
  const dec = meth === 0 ? blk.subarray(72, 72 + uncompSz) : lz4(blk.subarray(72, 72 + compSz), uncompSz);
  const blobs = withBlobs ? readBlobs(blk, dec, compSz) : [];
  let i1 = 0, i4 = Math.ceil(n1 / 4) * 4, i8 = Math.ceil((i4 + n4 * 4) / 8) * 8, pStr = i8 + n8 * 8, bi = 0;
  const nStr = dec.readUInt32LE(i4); i4 += 4;
  const strings = [];
  for (let i = 0; i < nStr; i++) { const z = dec.indexOf(0, pStr); strings.push(dec.toString('utf8', pStr, z)); pStr = z + 1; }
  let iType = pStr;
  const u8 = () => dec[i1++];
  const s32 = () => { const v = dec.readInt32LE(i4); i4 += 4; return v; };
  const u32 = () => { const v = dec.readUInt32LE(i4); i4 += 4; return v; };
  const f32 = () => { const v = dec.readFloatLE(i4); i4 += 4; return v; };
  const s64 = () => { const v = Number(dec.readBigInt64LE(i8)); i8 += 8; return v; };
  const u64 = () => { const v = Number(dec.readBigUInt64LE(i8)); i8 += 8; return v; };
  const f64 = () => { const v = dec.readDoubleLE(i8); i8 += 8; return v; };
  const readStr = () => { const idx = s32(); return idx < 0 ? '' : strings[idx]; };
  const readType = () => { let t = dec[iType++]; if (t & 0x80) { t &= 0x7f; iType++; } return t; };
  const readVal = (forced = null) => {
    const t = forced ?? readType();
    switch (t) {
      case 1: return null;
      case 7: return blobs[bi++] ?? null;
      case 2: return u8() !== 0;
      case 3: return s64();
      case 4: return u64();
      case 5: return f64();
      case 6: return readStr();
      case 8: { const n = u32(); return Array.from({ length: n }, () => readVal()); }
      case 9: { const n = u32(), oo = {}; for (let j = 0; j < n; j++) oo[readStr()] = readVal(); return oo; }
      case 10: { const n = u32(), sub = readType(); return Array.from({ length: n }, () => readVal(sub)); }
      case 11: return s32();
      case 12: return u32();
      case 13: return true;
      case 14: return false;
      case 15: return 0;
      case 16: return 1;
      case 17: return 0.0;
      case 18: return 1.0;
      case 19: return f32();
      case 23: return u8();
      case 24: { const n = u8(), sub = readType(); return Array.from({ length: n }, () => readVal(sub)); }
      default: throw new Error(`Unsupported KV3 type ${t}`);
    }
  };
  return readVal();
}

function f16(h) {
  const s = (h & 0x8000) ? -1 : 1, e = (h >> 10) & 0x1f, m = h & 0x3ff;
  if (e === 0) return s * (m / 1024) * 2 ** -14;
  if (e === 31) return m ? NaN : s * Infinity;
  return s * (1 + m / 1024) * 2 ** (e - 15);
}

function decodeMbuf(mb) {
  const vbEl = mb.readUInt32LE(16), vbSz = mb.readUInt32LE(20);
  const attrOff = 24 + mb.readUInt32LE(24), attrCnt = mb.readUInt32LE(28);
  const vbDataOff = 32 + mb.readUInt32LE(32), vbDataSz = mb.readUInt32LE(36);
  const srcV = mb.subarray(vbDataOff, vbDataOff + vbDataSz);
  const vb = new Uint8Array(vbEl * vbSz);
  if (vbDataSz < vb.length && (srcV[0] & 0xf0) === 0xa0) MeshoptDecoder.decodeVertexBuffer(vb, vbEl, vbSz, srcV);
  else vb.set(srcV);

  const ibOff = 8 + mb.readUInt32LE(8);
  const ibEl = mb.readUInt32LE(ibOff), ibElSz = mb.readUInt32LE(ibOff + 4);
  const ibDataOff = ibOff + 16 + mb.readUInt32LE(ibOff + 16), ibDataSz = mb.readUInt32LE(ibOff + 20);
  const srcI = mb.subarray(ibDataOff, ibDataOff + ibDataSz);
  const ib = new Uint8Array(ibEl * ibElSz);
  if (ibDataSz < ib.length && (srcI[0] & 0xf0) === 0xe0) MeshoptDecoder.decodeIndexBuffer(ib, ibEl, ibElSz, srcI);
  else ib.set(srcI);

  let posAttr = null, uvAttr = null;
  for (let a = 0; a < attrCnt; a++) {
    const ao = attrOff + a * 56, z = mb.indexOf(0, ao);
    const name = mb.toString('latin1', ao, z >= ao && z < ao + 32 ? z : ao + 32);
    const si = mb.readUInt32LE(ao + 32), fmt = mb.readUInt32LE(ao + 36), off = mb.readUInt32LE(ao + 40);
    if (name === 'POSITION' && si === 0) posAttr = { fmt, off };
    else if (name === 'TEXCOORD' && si === 0) uvAttr = { fmt, off };
  }
  const dvV = new DataView(vb.buffer), dvI = new DataView(ib.buffer);
  const pos = new Float32Array(vbEl * 3), uv = new Float32Array(vbEl * 2);
  for (let i = 0; i < vbEl; i++) {
    const o = i * vbSz;
    if (posAttr?.fmt === 6) {
      pos[i * 3] = dvV.getFloat32(o + posAttr.off, true);
      pos[i * 3 + 1] = dvV.getFloat32(o + posAttr.off + 4, true);
      pos[i * 3 + 2] = dvV.getFloat32(o + posAttr.off + 8, true);
    }
    if (uvAttr) {
      const uo = o + uvAttr.off;
      if (uvAttr.fmt === 37) { uv[i * 2] = dvV.getInt16(uo, true) / 32767; uv[i * 2 + 1] = dvV.getInt16(uo + 2, true) / 32767; }
      else if (uvAttr.fmt === 34) { uv[i * 2] = f16(dvV.getUint16(uo, true)); uv[i * 2 + 1] = f16(dvV.getUint16(uo + 2, true)); }
      else if (uvAttr.fmt === 16) { uv[i * 2] = dvV.getFloat32(uo, true); uv[i * 2 + 1] = dvV.getFloat32(uo + 4, true); }
    }
  }
  const idx = new Uint32Array(ibEl);
  if (ibElSz === 2) for (let i = 0; i < ibEl; i++) idx[i] = dvI.getUint16(i * 2, true);
  else for (let i = 0; i < ibEl; i++) idx[i] = dvI.getUint32(i * 4, true);
  return { pos, uv, idx };
}

function boxPiece(lo, hi) {
  const points = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
  const planes = [[1, 0, 0, hi[0]], [-1, 0, 0, -lo[0]], [0, 1, 0, hi[1]], [0, -1, 0, -lo[1]], [0, 0, 1, hi[2]], [0, 0, -1, -lo[2]]];
  const edges = [];
  for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) if (!((i >> k) & 1)) edges.push([points[i], points[i | (1 << k)]]);
  return { points, planes, edges };
}

function decimateDrawCalls(calls, { pos, uv, idx }, hullMin, hullMax, cap) {
  const totalRaw = calls.reduce((s, c) => s + ((c.count / 3) | 0), 0);
  const gridSteps = totalRaw <= cap ? [0] : [40, 30, 22, 16, 12, 9, 7];
  const span = Math.max(hullMax[0] - hullMin[0], hullMax[1] - hullMin[1], hullMax[2] - hullMin[2], 1e-3);
  let best = null;
  for (const k of gridSteps) {
    const meshes = [];
    let tris = 0;
    const cell = k ? span / k : 0;
    for (const c of calls) {
      const mPos = [], mUv = [];
      if (!k) {
        for (let i = c.start; i < c.start + c.count; i++) {
          const vi = c.base + idx[i];
          mPos.push(pos[vi * 3], pos[vi * 3 + 1], pos[vi * 3 + 2]);
          mUv.push(uv[vi * 2], uv[vi * 2 + 1]);
        }
        tris += (c.count / 3) | 0;
      } else {
        const rep = new Map(), rawTris = [];
        for (let t = c.start; t + 2 < c.start + c.count; t += 3) {
          const triKeys = [];
          for (let j = 0; j < 3; j++) {
            const vi = c.base + idx[t + j];
            const x = pos[vi * 3], y = pos[vi * 3 + 1], z = pos[vi * 3 + 2], u = uv[vi * 2], v = uv[vi * 2 + 1];
            const gx = Math.round((x - hullMin[0]) / cell);
            const gy = Math.round((y - hullMin[1]) / cell);
            const gz = Math.round((z - hullMin[2]) / cell);
            // Bucket by coarse UV cell too so folded/seamed UVs never stretch across the atlas
            const ck = `${gx},${gy},${gz},${Math.round(u * 4)},${Math.round(v * 4)}`;
            let acc = rep.get(ck);
            if (!acc) { acc = [0, 0, 0, 0, 0, 0]; rep.set(ck, acc); }
            acc[0] += x; acc[1] += y; acc[2] += z; acc[3] += u; acc[4] += v; acc[5]++;
            triKeys.push(ck);
          }
          if (triKeys[0] === triKeys[1] || triKeys[1] === triKeys[2] || triKeys[2] === triKeys[0]) continue;
          rawTris.push(triKeys);
        }
        for (const triKeys of rawTris) {
          for (const ck of triKeys) {
            const a = rep.get(ck), n = a[5];
            mPos.push(a[0] / n, a[1] / n, a[2] / n);
            mUv.push(a[3] / n, a[4] / n);
          }
          tris++;
        }
      }
      if (mPos.length) meshes.push({ material: c.mat, cd: [], pos: mPos, nrm: [], uv: mUv });
    }
    best = meshes;
    if (tris <= cap) break;
  }
  return best ?? [];
}

const normVmdl = (rel) => rel.trim().replace(/\\/g, '/').toLowerCase().replace(/\.mdl$/, '.vmdl_c');
// shortcut: basename fallback matches CS:GO models relocated under CS2 map folders for common prop families; widen if needed
const SAFE_BASE = /^(?:park_fence|railing|stair_railing|fence|tree|mall_tree|urban_bush|bush|hedge|bucket|plasticbucket|traffic_cone|trafficcone|phone_booth|hotel_rooftop|hotel_pipe|curb|chimney|chair|table|bench|trash|crate|barrel|door|lamp|light)/;
let byBase = null;
function cs2BaseIndex() {
  if (byBase) return byBase;
  byBase = new Map();
  for (const k of cs2Pak().entries.keys()) {
    if (!k.endsWith('.vmdl_c')) continue;
    const b = k.slice(k.lastIndexOf('/') + 1, -7);
    if (!byBase.has(b)) byBase.set(b, k);
  }
  return byBase;
}
export function findCs2Model(rel) {
  const key = normVmdl(rel), pak = cs2Pak();
  if (pak.entries.has(key)) return key;
  const base = key.slice(key.lastIndexOf('/') + 1, -7);
  return SAFE_BASE.test(base) ? cs2BaseIndex().get(base) ?? null : null;
}

export function hasCs2Model(rel) {
  return !!findCs2Model(rel);
}

export function loadCs2Model(rel, skin = 0, cap = MAX_TRIS) {
  if (/foliage|curb|railing|fence|ladder|grate|arch/.test(rel)) cap = Infinity; // Keep thin surfaces and alpha-card UVs intact.
  const key = findCs2Model(rel), pak = cs2Pak();
  if (!key) return null;
  const bl = blocks(pak.read(key));
  const mdat = kv3(bl.get('MDAT')), mbuf = bl.get('MBUF');
  if (!mdat || !mbuf) return null;
  const data = bl.has('DATA') ? kv3(bl.get('DATA')) : null;
  const phys = bl.has('PHYS') ? kv3(bl.get('PHYS'), true) : null;

  const skinMap = new Map();
  const mg = data?.m_materialGroups;
  if (skin > 0 && Array.isArray(mg) && mg[0]?.m_materials && mg[skin]?.m_materials) {
    const a = mg[0].m_materials, b = mg[skin].m_materials;
    for (let i = 0; i < a.length && i < b.length; i++) skinMap.set(a[i], b[i]);
  }

  const so = mdat.m_sceneObjects?.[0];
  if (!so?.m_drawCalls?.length) return null;
  const hullMin = so.m_vMinBounds ?? [-8, -8, -8], hullMax = so.m_vMaxBounds ?? [8, 8, 8];
  const calls = [];
  for (const dc of so.m_drawCalls) {
    if ((dc.m_nPrimitiveType !== 5 && dc.m_nPrimitiveType !== 'RENDER_PRIM_TRIANGLES') || !dc.m_nIndexCount) continue;
    const rawMat = skinMap.get(dc.m_material) ?? dc.m_material ?? '';
    const mat = String(rawMat).replace(/\\/g, '/').toLowerCase().replace(/^materials\//, '').replace(/\.vmat$/, '');
    calls.push({ mat, base: dc.m_nBaseVertex ?? 0, start: dc.m_nStartIndex ?? 0, count: dc.m_nIndexCount });
  }
  if (!calls.length) return null;

  const decoded = decodeMbuf(mbuf);
  const meshes = decimateDrawCalls(calls, decoded, hullMin, hullMax, cap);
  if (!meshes.length) return null;

  const hulls = phys?.m_parts?.[0]?.m_rnShape?.m_hulls;
  let phy = null;
  if (Array.isArray(hulls) && hulls.length) {
    const attrs = phys?.m_collisionAttributes ?? [];
    phy = [];
    for (const hu of hulls) {
      const grp = attrs[hu?.m_nCollisionAttributeIndex]?.m_CollisionGroupString ?? 'default';
      if (/debris|trigger|non_solid/i.test(grp)) continue;
      const h = hu?.m_Hull;
      const vBuf = h?.m_VertexPositions ?? h?.m_Vertices;
      if (Buffer.isBuffer(vBuf) && Buffer.isBuffer(h?.m_Planes) && vBuf.length >= 48 && vBuf.length % 12 === 0 && h.m_Planes.length >= 64 && h.m_Planes.length % 16 === 0) {
        const points = []; for (let i = 0; i < vBuf.length; i += 12) points.push([vBuf.readFloatLE(i), vBuf.readFloatLE(i + 4), vBuf.readFloatLE(i + 8)]);
        const planes = []; for (let i = 0; i < h.m_Planes.length; i += 16) planes.push([h.m_Planes.readFloatLE(i), h.m_Planes.readFloatLE(i + 4), h.m_Planes.readFloatLE(i + 8), h.m_Planes.readFloatLE(i + 12)]);
        const edges = [];
        if (Buffer.isBuffer(h.m_Edges)) {
          const ne = (h.m_Edges.length / 4) | 0;
          for (let i = 0; i < ne; i++) {
            const twin = h.m_Edges[i * 4 + 1], v0 = h.m_Edges[i * 4 + 2], v1 = twin < ne ? h.m_Edges[twin * 4 + 2] : 255;
            if (i < twin && v0 < points.length && v1 < points.length) edges.push([points[v0], points[v1]]);
          }
        }
        phy.push({ points, planes, edges });
      } else {
        const b = h?.m_Bounds;
        if (b?.m_vMinBounds && b?.m_vMaxBounds) phy.push(boxPiece(b.m_vMinBounds, b.m_vMaxBounds));
      }
    }
    if (!phy.length) phy = null;
  }
  return { hullMin, hullMax, meshes, phy };
}

// Self-check when run directly: node tools/cs2mdl.mjs
if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
  const { default: assert } = await import('node:assert/strict');
  const checks = [
    ['models/props/de_aztec/aztec_scaffolding_system_02.mdl', true],
    ['models/props/de_mirage/wall_arch_a1.mdl', true],
    ['models/props/de_mirage/rusted_fence_a.mdl', true],
    ['models/props_interiors/tv.mdl', true],
    ['models/props/de_mirage/bomb_site_tarp.mdl', true],
    ['models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001.mdl', true],
  ];
  for (const [m, expectMesh] of checks) {
    assert(hasCs2Model(m), `missing in pak01: ${m}`);
    const r = loadCs2Model(m);
    assert(r && (!expectMesh || r.meshes.length > 0), `failed decode: ${m}`);
    for (const ms of r.meshes) {
      assert(ms.pos.length > 0 && ms.pos.length % 9 === 0, `bad pos len in ${m}`);
      assert(ms.uv.length * 3 === ms.pos.length * 2, `bad uv len in ${m}`);
      for (const x of ms.pos) assert(Number.isFinite(x), `NaN pos in ${m}`);
      for (const u of ms.uv) assert(Number.isFinite(u), `NaN uv in ${m}`);
    }
  }
  assert(loadCs2Model('models/props/de_aztec/aztec_scaffolding_system_02.mdl')?.phy?.length >= 1, 'scaffolding missing PHYS hull');
  const rampPhy = loadCs2Model('models/props/de_nuke/hr_nuke/nuke_industrial_props/nuke_industrial_ramp_001.mdl')?.phy;
  assert(rampPhy?.length === 5 && rampPhy[3].planes.some((p) => Math.abs(p[0]) > 0.2 && Math.abs(p[2]) > 0.8), 'ramp missing sloped PHYS hull');
  console.log('cs2mdl self-check: OK', checks.length, 'models verified');
}
