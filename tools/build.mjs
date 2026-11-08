// Converts content/maps/<map>.bsp + VMT/VTF materials into web-ready assets (public/maps/<map>/*).
// Usage: node tools/build.mjs [map]   (default de_dust2)
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { loadModel, loadPhy, loadSkeleton, mul34 } from './mdl.mjs';
import { png, vtfToRgba } from './vtf.mjs';
import { cs2Texture } from './cs2tex.mjs';
import { readGameFile, modelBase, addBspPak } from './content.mjs';
import { writeGlb } from './glb.mjs';
import { writeSky } from './sky.mjs';
import { flatten, addSoundscapeScripts } from './soundscapes.mjs';
import { makeWorld, trace as traceWorld } from '../public/physics.js';
import { moverEntry } from '../public/movers.js';

const MAP = process.argv[2] || 'de_dust2';
const ROOT = path.resolve(import.meta.dirname, '..', '..', 'content');
const argOf = (flag) => { const i = process.argv.indexOf(flag); return i > 0 ? process.argv[i + 1] : null; };
const OUT = argOf('--out') ? path.resolve(argOf('--out')) : path.resolve(import.meta.dirname, '..', 'public', 'maps', MAP); // --out <dir>: write assets elsewhere
const GLB = argOf('--glb'); // --glb <file.glb>: also export the map (world + props, textured) as a glTF binary
fs.mkdirSync(path.join(OUT, 'tex'), { recursive: true });

// ---------- BSP lumps ----------
const BSP_FILE = argOf('--bsp') ?? path.join(ROOT, 'maps', MAP + '.bsp'); // --bsp <file>: another game's map, e.g. CS:GO's de_lake.bsp
const bsp = fs.readFileSync(BSP_FILE);
addBspPak(BSP_FILE); // custom models / sounds packed into the map itself (e.g. cs_agency's models/agency/*)
if (bsp.toString('latin1', 0, 4) !== 'VBSP') throw new Error('not a VBSP file');
const lump = (i) => {
  const o = bsp.readInt32LE(8 + i * 16), l = bsp.readInt32LE(12 + i * 16);
  if (bsp.readInt32LE(20 + i * 16)) throw new Error('compressed lump ' + i);
  return bsp.subarray(o, o + l);
};
const rec = (buf, size, fn) => Array.from({ length: buf.length / size }, (_, i) => fn(buf, i * size));
const planes = rec(lump(1), 20, (b, o) => ({ n: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)], d: b.readFloatLE(o + 12) }));
const texdata = rec(lump(2), 32, (b, o) => ({ name: b.readInt32LE(o + 12), w: b.readInt32LE(o + 16), h: b.readInt32LE(o + 20) }));
const verts = rec(lump(3), 12, (b, o) => [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)]);
const nodes = rec(lump(5), 32, (b, o) => ({ plane: b.readInt32LE(o), ch: [b.readInt32LE(o + 4), b.readInt32LE(o + 8)] }));
const texinfo = rec(lump(6), 72, (b, o) => ({
  tv: [0, 1].map((r) => [0, 1, 2, 3].map((c) => b.readFloatLE(o + r * 16 + c * 4))),
  lv: [0, 1].map((r) => [0, 1, 2, 3].map((c) => b.readFloatLE(o + 32 + r * 16 + c * 4))),
  flags: b.readInt32LE(o + 64), td: b.readInt32LE(o + 68),
}));
const HDR_ONLY = lump(8).length === 0; // CS:GO maps ship HDR lighting only (lumps 53 + 58 instead of 8 + 7)
const faces = rec(lump(HDR_ONLY ? 58 : 7), 56, (b, o) => ({
  plane: b.readUInt16LE(o), side: b.readUInt8(o + 2), firstEdge: b.readInt32LE(o + 4), numEdges: b.readInt16LE(o + 8), ti: b.readInt16LE(o + 10),
  disp: b.readInt16LE(o + 12), style0: b.readUInt8(o + 16), lightofs: b.readInt32LE(o + 20),
  lmMin: [b.readInt32LE(o + 28), b.readInt32LE(o + 32)], lmSize: [b.readInt32LE(o + 36), b.readInt32LE(o + 40)],
}));
const lighting = lump(HDR_ONLY ? 53 : 8);
const edges = rec(lump(12), 4, (b, o) => [b.readUInt16LE(o), b.readUInt16LE(o + 2)]);
const surfEdges = rec(lump(13), 4, (b, o) => b.readInt32LE(o));
const m0 = lump(14);
const model0 = { head: m0.readInt32LE(36), firstFace: m0.readInt32LE(40), numFaces: m0.readInt32LE(44) };
const numLeafs = nodes.reduce((m, n) => n.ch.reduce((m2, c) => (c < 0 ? Math.max(m2, -c) : m2), m), 0);
const leafSize = lump(10).length / numLeafs; // 56 (with ambient cube) or 32
if (leafSize !== 56 && leafSize !== 32) throw new Error('unexpected leaf size ' + leafSize);
const leafs = rec(lump(10), leafSize, (b, o) => ({ area: b.readUInt16LE(o + 6) & 511, mins: [0, 2, 4].map((k) => b.readInt16LE(o + 8 + k)), maxs: [0, 2, 4].map((k) => b.readInt16LE(o + 14 + k)), firstLF: b.readUInt16LE(o + 20), numLF: b.readUInt16LE(o + 22), firstLB: b.readUInt16LE(o + 24), numLB: b.readUInt16LE(o + 26), cube: leafSize === 56 ? Array.from({ length: 6 }, (_, k) => [b.readUInt8(o + 32 + k * 4), b.readUInt8(o + 33 + k * 4), b.readUInt8(o + 34 + k * 4), b.readInt8(o + 35 + k * 4)]) : null }));
const leafFaces = rec(lump(16), 2, (b, o) => b.readUInt16LE(o));
const leafBrushes = rec(lump(17), 2, (b, o) => b.readUInt16LE(o));
const brushes = rec(lump(18), 12, (b, o) => ({ first: b.readInt32LE(o), num: b.readInt32LE(o + 4), contents: b.readInt32LE(o + 8) }));
const sides = rec(lump(19), 8, (b, o) => ({ plane: b.readUInt16LE(o), ti: b.readInt16LE(o + 2) }));
const dispInfo = rec(lump(26), 176, (b, o) => ({ start: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)], vstart: b.readInt32LE(o + 12), power: b.readInt32LE(o + 20), face: b.readUInt16LE(o + 36) }));
const dispVerts = rec(lump(33), 20, (b, o) => ({ v: [b.readFloatLE(o), b.readFloatLE(o + 4), b.readFloatLE(o + 8)], dist: b.readFloatLE(o + 12) }));
const strData = lump(43), strTable = rec(lump(44), 4, (b, o) => b.readInt32LE(o));
const texName = (td) => { const s = strTable[texdata[td].name]; return strData.toString('latin1', s, strData.indexOf(0, s)).toLowerCase(); };
const entities = [...lump(0).toString('latin1').matchAll(/\{([^}]*)\}/g)].map((m) => Object.fromEntries([...m[1].matchAll(/"([^"]*)"\s+"([^"]*)"/g)].map((x) => [x[1], x[2]])));

// ---------- movers: doors and breakable glass (their state changes at runtime: public/movers.js) ----------
const DOORS = /^(func_door|func_door_rotating|prop_door_rotating)$/, BREAKABLES = /^(func_breakable|func_breakable_surf)$/;
const vecOf = (s, d = [0, 0, 0]) => (s ? s.split(' ').map(Number) : d);
const brushModel = (e) => { const m = lump(14), o = Number(e.model.slice(1)) * 48, f = (k) => m.readFloatLE(o + k * 4); return { mins: [f(0), f(1), f(2)], maxs: [f(3), f(4), f(5)], head: m.readInt32LE(o + 36), firstFace: m.readInt32LE(o + 40), numFaces: m.readInt32LE(o + 44) }; };
const moverEnts = entities.filter((e) => e.model && (DOORS.test(e.classname) || (BREAKABLES.test(e.classname) && (e.classname === 'func_breakable_surf' || Number(e.health) > 0))));
const moverFaces = new Set();
// handles / windows attached to a door (parentname) swing with it instead of being baked into the static world
const doorNames = new Set(entities.filter((e) => DOORS.test(e.classname) && e.targetname).map((e) => e.targetname));
for (const e of moverEnts) if (e.model.startsWith('*')) { const m = brushModel(e); for (let i = 0; i < m.numFaces; i++) moverFaces.add(m.firstFace + i); }

// ---------- 3D skybox: the distant scenery lives in its own BSP area around sky_camera ----------
const pointLeaf = (p) => { let c = model0.head; while (c >= 0) { const n = nodes[c], pl = planes[n.plane]; c = n.ch[pl.n[0] * p[0] + pl.n[1] * p[1] + pl.n[2] * p[2] - pl.d >= 0 ? 0 : 1]; } return -1 - c; };
const skyCam = entities.find((e) => e.classname === 'sky_camera');
const skyOrigin = skyCam?.origin.split(' ').map(Number), skyScale = Number(skyCam?.scale ?? 16);
const skyArea = skyCam ? leafs[pointLeaf(skyOrigin)].area : -1;
// Scenery parts can sit in leaves of other areas, so the sky region is the bounding box of the sky area's leaves.
const skyBox = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
if (skyCam) for (const l of leafs) if (l.area === skyArea) for (let k = 0; k < 3; k++) { skyBox[0][k] = Math.min(skyBox[0][k], l.mins[k]); skyBox[1][k] = Math.max(skyBox[1][k], l.maxs[k]); }
const inSky = (p) => !!skyCam && p.every((v, k) => v >= skyBox[0][k] - 1 && v <= skyBox[1][k] + 1);
const skyFaces = new Set();
if (skyCam) faces.forEach((f, fi) => {
  for (let e = 0; e < f.numEdges; e++) { const se = surfEdges[f.firstEdge + e]; if (!inSky(verts[se >= 0 ? edges[se][0] : edges[-se][1]])) return; }
  skyFaces.add(fi);
});

// ---------- collision brushes: only those reachable from the world model ----------
const SOLID_MASK = 0x1 | 0x2 | 0x8 | 0x10000; // solid, window, grate, playerclip
const worldBrushes = new Set();
(function walk(c) {
  if (c >= 0) return nodes[c].ch.forEach(walk);
  const l = leafs[-1 - c];
  for (let i = 0; i < l.numLB; i++) worldBrushes.add(leafBrushes[l.firstLB + i]);
})(model0.head);
// Collision entry = [minx,miny,minz,maxx,maxy,maxz, (nx,ny,nz,d)*]. Brushes carrying a displacement side are replaced by
// per-triangle prisms (Source does the same: displacements collide, their flat brush does not).
const bounds = (pts) => [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a]))).concat([0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a]))));
function brushVerts(pl) { // vertices = intersections of plane triples that satisfy every plane
  const pts = [];
  for (let i = 0; i < pl.length; i++) for (let j = i + 1; j < pl.length; j++) for (let k = j + 1; k < pl.length; k++) {
    const [a, b, c] = [pl[i], pl[j], pl[k]], bc = cross(b, c), det = dot3(a, bc);
    if (Math.abs(det) < 1e-6) continue;
    const ca = cross(c, a), ab = cross(a, b);
    const p = [0, 1, 2].map((t) => (a[3] * bc[t] + b[3] * ca[t] + c[3] * ab[t]) / det);
    if (pl.every((q) => dot3(q, p) - q[3] <= 1)) pts.push(p);
  }
  return pts;
}
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function dot3(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
const collision = [], playerOnly = [], skyBrushIdx = [], surfOf = []; // surfOf[i] = footstep surface of collision[i]
const SURFACES = ['concrete', 'sand', 'tile', 'wood', 'metal', 'gravel', 'grass', 'glass'];
const surfaceOfName = (n) => /glass|window/.test(n) ? 'glass' : /tile|marble/.test(n) ? 'tile' : /wood|crate|plank|door|barrel/.test(n) ? 'wood' : /metal|grate|vent|pipe|tank/.test(n) ? 'metal' : /gravel/.test(n) ? 'gravel' : /grass|plant|foliage/.test(n) ? 'grass' : /sand|dirt|ground|desert|dust\/.*(floor|road)|rock|mud/.test(n) ? 'sand' : 'concrete';
const pushCol = (entry, surface = 'concrete') => { collision.push(entry); surfOf.push(Math.max(SURFACES.indexOf(surface), 0)); }; let DISPBRUSH = 0;
// Brush sides carry no usable dispinfo in these maps, so a displacement brush is found geometrically:
// all four corners of a displaced face are vertices of that brush.
const dispFaceCorners = faces.map((f, i) => ({ f, i })).filter(({ f }) => f.disp >= 0).map(({ f }) => Array.from({ length: f.numEdges }, (_, e) => { const se = surfEdges[f.firstEdge + e]; return verts[se >= 0 ? edges[se][0] : edges[-se][1]]; }));
for (const i of worldBrushes) {
  const br = brushes[i];
  if (!(br.contents & SOLID_MASK)) continue;
  const pl = [];
  for (let s = 0; s < br.num; s++) { const p = planes[sides[br.first + s].plane]; pl.push([...p.n, p.d]); }
  const pts = brushVerts(pl);
  if (!pts.length) continue;
  if (dispFaceCorners.some((c) => c.every((v) => pts.some((p) => Math.hypot(p[0] - v[0], p[1] - v[1], p[2] - v[2]) < 1)))) { DISPBRUSH++; continue; }
  // bullets stop only at solid/window; grates and player-clip brushes block movement only
  const entry = [...bounds(pts), ...pl.flat()];
  if (!(br.contents & 0x3)) { playerOnly.push(entry); continue; }
  if (Array.from({ length: br.num }, (_, k) => texinfo[sides[br.first + k].ti].flags).some((fl) => fl & 0x6)) skyBrushIdx.push(collision.length); // sky box walls stop movement but not sunlight
  const top = Array.from({ length: br.num }, (_, k) => sides[br.first + k]).sort((x, y) => planes[y.plane].n[2] - planes[x.plane].n[2])[0];
  pushCol(entry, planes[top.plane].n[2] > 0.5 ? surfaceOfName(texName(texinfo[top.ti].td)) : 'concrete');
}
// A convex piece's own face planes are not enough for box sweeps: the Minkowski sum with the player's AABB also has facets from
// the world axes and from edge x axis (what VBSP adds as "bevels" to brushes). Emit them as slab pairs around the piece.
function convexEntry(points, facePlanes, edgeList) {
  const planes = [...facePlanes];
  const add = (n, pts) => {
    const l = Math.hypot(...n); if (l < 1e-4) return;
    const u = n.map((v) => v / l), d = pts.map((p) => dot3(u, p));
    planes.push([...u, Math.max(...d)], [...u.map((v) => -v), -Math.min(...d)]);
  };
  for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    add(ax, points);
    for (const [p, q] of edgeList) add(cross(sub(q, p), ax), points);
  }
  const seen = new Set(), flat = [];
  for (const pl of planes) { const k = pl.map((v) => Math.round(v * 500)).join(','); if (!seen.has(k)) { seen.add(k); flat.push(...pl); } }
  return [...bounds(points), ...flat];
}

function addTri(a, b, c, surface) { // displaced triangle -> raw triangle entry; the client builds the exact box-sweep volume (see physics.js)
  if (Math.hypot(...cross(sub(b, a), sub(c, a))) < 1e-3) return;
  const bb = bounds([a, b, c]);
  pushCol([bb[0] - 16, bb[1] - 16, bb[2] - 16, bb[3] + 16, bb[4] + 16, bb[5] + 16, ...a, ...b, ...c], surface); // padded by the prism thickness
}

// ---------- lightmap atlas (shelf packed, 1px replicated border) ----------
const AW = 2048;
const lmRects = new Map(); // face index -> {x,y}
let AH;
{
  const order = faces.map((f, i) => i).filter((i) => ((i >= model0.firstFace && i < model0.firstFace + model0.numFaces) || moverFaces.has(i)) && faces[i].lightofs >= 0 && faces[i].style0 === 0)
    .sort((a, b) => faces[b].lmSize[1] - faces[a].lmSize[1]);
  let x = 1, y = 1, rowH = 0; // (0,0) reserved: fully lit texel for faces without lightmap
  for (const i of order) {
    const w = faces[i].lmSize[0] + 1, h = faces[i].lmSize[1] + 1;
    if (x + w + 1 > AW) { x = 1; y += rowH + 2; rowH = 0; }
    lmRects.set(i, { x, y }); x += w + 2; rowH = Math.max(rowH, h);
  }
  AH = y + rowH + 2;
}
const atlas = Buffer.alloc(AW * AH * 3, 255);
// Lightmap texel = ColorRGBExp32 -> linear light c*2^e/255 (1.0 = white). Stored like the engine's LDR lightmaps: gamma-encoded with
// 2.0 linear mapping to 255, and the shader multiplies by 2 again (mat_overbright), so sunlit surfaces can be brighter than their texture.
// CS:GO's HDR lightmaps are shown through auto-exposure: sunlit ground there is ~1.0 where CS:S maps sit at 2-3. Expose them so the
// brightest up-facing faces (85th percentile, at face centres) land where Inferno's do.
const EXPOSURE = (() => {
  if (!HDR_ONLY) return 1;
  const v = [];
  for (const f of faces) {
    const n = planes[f.plane].n[2] * (f.side ? -1 : 1), w = f.lmSize[0] + 1, h = f.lmSize[1] + 1;
    if (f.lightofs < 0 || n < 0.95 || w < 3 || h < 3) continue;
    const c = f.lightofs + ((h >> 1) * w + (w >> 1)) * 4;
    v.push(((lighting[c] * 0.3 + lighting[c + 1] * 0.59 + lighting[c + 2] * 0.11) * 2 ** lighting.readInt8(c + 3)) / 255);
  }
  v.sort((a, b) => a - b);
  return v.length ? Math.min(Math.max(2.3 / v[Math.floor(v.length * 0.85)], 1), 4) : 1;
})();
if (EXPOSURE !== 1) console.log('HDR lightmaps exposed x' + EXPOSURE.toFixed(2));
const linearLight = (c, e) => (c * 2 ** e * EXPOSURE) / 255;
const encodeLight = (lin) => Math.min(1, Math.pow(Math.max(lin, 0), 1 / 2.2) / 2); // lin 1.0 -> 0.5; the shader's x2 brings it back, up to 4.6 linear of headroom
const gamma = (c, e) => Math.min(255, Math.round(255 * encodeLight(linearLight(c, e))));
for (const [i, r] of lmRects) {
  const f = faces[i], w = f.lmSize[0] + 1, h = f.lmSize[1] + 1;
  for (let py = -1; py <= h; py++) for (let px = -1; px <= w; px++) {
    const sx = Math.min(w - 1, Math.max(0, px)), sy = Math.min(h - 1, Math.max(0, py));
    const s = f.lightofs + (sy * w + sx) * 4, e = lighting.readInt8(s + 3), d = ((r.y + py) * AW + r.x + px) * 3;
    for (let k = 0; k < 3; k++) atlas[d + k] = gamma(lighting[s + k], e);
  }
}

// ---------- geometry grouped by texture ----------
const SKIP_FLAGS = 0x2 | 0x4 | 0x40 | 0x80 | 0x100 | 0x200; // sky, trigger, nodraw, hint, skip
const groups = new Map(), skyGroups = new Map();
const sub = (a, b) => a.map((v, i) => v - b[i]);
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);

function emit(fi, tri, pts, into = null) { // pts: [{p (displaced / placed), flat (texture space)}]; into: a mover's own groups
  const f = faces[fi], ti = texinfo[f.ti], td = texdata[ti.td], name = texName(ti.td);
  const map = into ?? (skyFaces.has(fi) ? skyGroups : groups);
  let g = map.get(name);
  if (!g) map.set(name, (g = { name, pos: [], uv: [], lm: [] }));
  const r = lmRects.get(fi);
  for (const k of tri) {
    const { p, flat } = pts[k];
    g.pos.push(...p);
    g.uv.push((dot3(flat, ti.tv[0]) + ti.tv[0][3]) / td.w, (dot3(flat, ti.tv[1]) + ti.tv[1][3]) / td.h);
    if (r) {
      // displacements store their lightmap over the (2^power+1)^2 vertex grid; brush faces use the planar lightmap vectors
      const lu = pts[k].grid ? 0.5 + pts[k].grid[0] * f.lmSize[0] : dot3(flat, ti.lv[0]) + ti.lv[0][3] - f.lmMin[0] + 0.5;
      const lv = pts[k].grid ? 0.5 + pts[k].grid[1] * f.lmSize[1] : dot3(flat, ti.lv[1]) + ti.lv[1][3] - f.lmMin[1] + 0.5;
      g.lm.push((r.x + lu) / AW, (r.y + lv) / AH);
    } else g.lm.push(0.5 / AW, 0.5 / AH);
  }
}
// Source stores faces clockwise; make triangles CCW relative to the face plane normal.
const orient = (tri, pts, n) => {
  const a = pts[tri[0]].flat, b = pts[tri[1]].flat, c = pts[tri[2]].flat;
  const u = sub(b, a), v = sub(c, a), x = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  return dot3(x, n) >= 0 ? tri : [tri[0], tri[2], tri[1]];
};

for (let fi = model0.firstFace; fi < model0.firstFace + model0.numFaces; fi++) {
  const f = faces[fi], ti = texinfo[f.ti];
  if (ti.flags & SKIP_FLAGS) continue;
  const poly = [];
  for (let e = 0; e < f.numEdges; e++) { const se = surfEdges[f.firstEdge + e]; poly.push(verts[se >= 0 ? edges[se][0] : edges[-se][1]]); }
  // Source polygons are clockwise seen from the front, so the front normal is minus the (CCW) Newell normal.
  const n = [0, 1, 2].map((a) => -poly.reduce((s, p, i) => { const q = poly[(i + 1) % poly.length], b = (a + 1) % 3, c = (a + 2) % 3; return s + (p[b] - q[b]) * (p[c] + q[c]); }, 0));
  if (f.disp < 0) {
    const pts = poly.map((p) => ({ p, flat: p }));
    for (let k = 1; k < poly.length - 1; k++) emit(fi, orient([0, k, k + 1], pts, n), pts);
  } else {
    const di = dispInfo.find((d) => d.face === fi), N = (1 << di.power) + 1;
    const s = poly.reduce((best, p, i) => (Math.hypot(...sub(p, di.start)) < Math.hypot(...sub(poly[best], di.start)) ? i : best), 0);
    const c = [0, 1, 2, 3].map((i) => poly[(s + i) % 4]);
    const pts = [];
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      // Verified against neighbouring displacements' shared edges: grid x runs c0->c3, y runs c0->c1.
      const flat = lerp(lerp(c[0], c[1], y / (N - 1)), lerp(c[3], c[2], y / (N - 1)), x / (N - 1));
      const dv = dispVerts[di.vstart + y * N + x];
      pts.push({ flat, grid: [x / (N - 1), y / (N - 1)], p: flat.map((v, i) => v + dv.v[i] * dv.dist) });
    }
    for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) {
      const a = y * N + x, b = a + 1, d = a + N, e = d + 1;
      for (const t of [[a, b, e], [a, e, d]]) { const o = orient(t, pts, n); emit(fi, o, pts); if (!skyFaces.has(fi)) addTri(...o.map((k) => pts[k].p), surfaceOfName(texName(ti.td))); }
    }
  }
}

// ---------- VMT / VTF -> PNG ----------
const matDir = path.join(ROOT, 'css_content', 'materials');
// Maps embed custom materials (e.g. WVT patch vmts) in a zip lump; read its central directory.
const pak = new Map();
{
  const z = lump(40), eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
  for (let n = z.readUInt16LE(eocd + 10), p = z.readUInt32LE(eocd + 16); n-- > 0; p += 46 + z.readUInt16LE(p + 28) + z.readUInt16LE(p + 30) + z.readUInt16LE(p + 32)) {
    const name = z.toString('latin1', p + 46, p + 46 + z.readUInt16LE(p + 28)).toLowerCase(), lo = z.readUInt32LE(p + 42);
    const data = z.subarray(lo + 30 + z.readUInt16LE(lo + 26) + z.readUInt16LE(lo + 28), lo + 30 + z.readUInt16LE(lo + 26) + z.readUInt16LE(lo + 28) + z.readUInt32LE(p + 20));
    pak.set(name, z.readUInt16LE(p + 10) === 8 ? zlib.inflateRawSync(data) : data);
  }
}
const readFile = (rel) => pak.get('materials/' + rel.toLowerCase()) ?? readGameFile('materials/' + rel); // the map's own files, then CS:S, then CS:GO
const readVmt = (name) => {
  const buf = readFile(name + '.vmt');
  if (!buf) return null;
  const t = buf.toString('latin1').toLowerCase();
  const get = (k) => t.match(new RegExp('"?\\$' + k + '"?\\s+"?([^"\\s]+)"?'))?.[1];
  // glass with a cubemap reflection ($envmap): Source's dark facade glass gets its look from it; the client mirrors the sky at this tint
  const tint = t.match(/\$envmaptint"?\s+"?\[\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/);
  const env = /\$envmap"?\s/.test(t) && /\$surfaceprop"?\s+"?glass/.test(t) ? (tint ? tint.slice(1, 4).map(Number) : [1, 1, 1]) : null;
  return { env, base: get('basetexture')?.replace(/\\/g, '/').replace(/\.vtf$/, ''), alphatest: get('alphatest') === '1', translucent: get('translucent') === '1', include: t.match(/"include"\s+"([^"]+)"/)?.[1] };
};
const bins = [];
let binLen = 0;
const missing = [];
const texFile = (n) => n.replace(/[\/\\]/g, '__') + '.png';
const texCache = new Map(); // material name -> {tex, alpha}
function materialTexture(name, aliases = []) { // writes the PNG once; returns {tex, alpha}
  if (texCache.has(name)) return texCache.get(name);
  // WVT patch materials are named <base>_<x>_<y>_<z>; fall back to the base material if the patch is missing.
  let vmt = [name, ...aliases, name.replace(/^maps\/[^/]+\//, '').replace(/_-?\d+_-?\d+_-?\d+$/, '')].reduce((v, n) => v ?? readVmt(n), null), guard = 0;
  while (vmt && !vmt.base && vmt.include && guard++ < 3) vmt = readVmt(vmt.include.replace(/^materials\//, '').replace(/\.vmt$/, ''));
  const out = { tex: null, alpha: 0 };
  if (vmt?.base) {
    const vtf = readFile(vmt.base + '.vtf');
    if (vtf) {
      try {
        const { W, H, rgba } = vtfToRgba(vtf);
        out.alpha = vmt.alphatest ? 1 : vmt.translucent ? 2 : 0;
        if (vmt.env) out.env = vmt.env;
        let data = rgba, ch = 4;
        if (!out.alpha) { ch = 3; data = Buffer.alloc(W * H * 3); for (let i = 0; i < W * H; i++) rgba.copy(data, i * 3, i * 4, i * 4 + 3); }
        fs.writeFileSync(path.join(OUT, 'tex', texFile(name)), png(W, H, ch, data));
        out.tex = texFile(name);
      } catch (e) { missing.push(name + ' (' + e.message + ')'); }
    } else missing.push(name + ' (no vtf ' + vmt.base + ')');
  } else missing.push(name + ' (no vmt)');
  if (!out.tex) Object.assign(out, stand_in(name)); // the content pack lacks some HL2 / CS:S materials: never leave surfaces white
  texCache.set(name, out);
  return out;
}
// Stand-in for a material whose texture is not in the content: a sibling variant of the same family (stonewall017b -> stonewall017a),
// else a flat colour picked from the material's folder / name. Glass and water stay translucent.
const SEE_THROUGH = /glass|window|tree|leaf|fence|grate|wire|vine|foliage|plant|bush|grass|weed/;
function stand_in(name) {
  const cs2 = cs2Texture(name); // the same texture from the Counter-Strike 2 install, when it still ships it
  if (cs2) { const file = texFile(name); fs.writeFileSync(path.join(OUT, 'tex', file), cs2.png); missing.push(name + ' -> CS2'); return { tex: file, alpha: cs2.alpha > 0.02 && SEE_THROUGH.test(name) ? 1 : 0 }; }
  const base = name.replace(/^maps\/[^/]+\//, '').replace(/_-?\d+_-?\d+_-?\d+$/, ''), dir = path.dirname(base), stem = path.basename(base).replace(/^inf/, '').replace(/(?<=\d)[a-z](_.*)?$/, '');
  try {
    const hits = fs.readdirSync(path.join(matDir, dir)).filter((f) => f.endsWith('.vtf') && f.replace(/^inf/, '').startsWith(stem) && !/_(ref|normal|bump)/.test(f));
    for (const f of hits) {
      const r = materialTexture(dir + '/' + f.slice(0, -4)); // recursion is safe: an existing vtf resolves without stand-in
      if (r.tex) { missing.push(name + ' -> ' + dir + '/' + f); return { tex: r.tex, alpha: r.alpha }; }
    }
  } catch { /* no such folder */ }
  const water = /water|liquid/.test(name), glass = /glass/.test(name);
  if (/dev_waterbeneath|tools\//.test(name)) return { tex: null, alpha: 0 };
  const [r, g, b, a] = water ? [60, 105, 125, 170] : glass ? [150, 185, 200, 70]
    : /plaster|ceiling/.test(name) ? [208, 190, 156, 255] : /stone|brick|arch/.test(name) ? [168, 150, 124, 255] : /wood/.test(name) ? [128, 96, 64, 255]
    : /tile/.test(name) ? [176, 164, 140, 255] : /concrete/.test(name) ? [150, 148, 142, 255] : /metal/.test(name) ? [104, 106, 110, 255]
    : /rock/.test(name) ? [130, 118, 100, 255] : /nature|dirt|sand|ground/.test(name) ? [150, 120, 80, 255] : [160, 150, 135, 255];
  const file = texFile('flat_' + [r, g, b, a].join('_')), data = Buffer.alloc(16 * 4);
  for (let i = 0; i < 16; i++) data.set([r, g, b, a], i * 4);
  fs.writeFileSync(path.join(OUT, 'tex', file), png(4, 4, 4, data));
  return { tex: file, alpha: a < 255 ? 2 : 0 };
}
function emitGroups(map, attrs, getTex = (g) => materialTexture(g.name)) { // -> manifest entries; appends float arrays to the shared .bin
  const list = [];
  for (const g of map.values()) {
    const entry = { name: g.name, ...getTex(g), count: g.pos.length / 3 };
    for (const k of attrs) { entry[k] = binLen; const a = new Float32Array(g[k]); bins.push(Buffer.from(a.buffer)); binLen += a.byteLength; }
    list.push(entry);
  }
  return list;
}

// ---------- props: static_prop game lump + prop_physics entities -> baked world-space meshes ----------
const modelCache = new Map();
// Rigged models (doors hang off a rotated root bone, the agency chopper is posed by its DefaultAnim) are drawn in that pose: every vertex
// skinned by its first bone at frame 0 of the sequence (static props have one identity bone, so they come out unchanged).
function posed(md, base, seqName) {
  let sk; try { sk = loadSkeleton(base + '.mdl'); } catch { return md; }
  if (!sk.anims.length) return md;
  const seq = sk.sequences.find((q) => q.name.toLowerCase() === seqName.toLowerCase()) ?? sk.sequences[0];
  const W = sk.boneToWorld(sk.anims[seq?.anim ?? 0] ?? sk.anims[0], 0), S = W.map((m, i) => mul34(m, sk.bones[i].poseToBone));
  const xf = (a, i, m, t) => { const v = [a[i], a[i + 1], a[i + 2]]; for (let r = 0; r < 3; r++) a[i + r] = m[r * 4] * v[0] + m[r * 4 + 1] * v[1] + m[r * 4 + 2] * v[2] + t * m[r * 4 + 3]; };
  for (const mesh of md.meshes) for (let i = 0; i < mesh.pos.length; i += 3) { const m = S[mesh.bi[(i / 3) * 4]]; if (m) { xf(mesh.pos, i, m, 1); xf(mesh.nrm, i, m, 0); } }
  return alignToHull(md);
}
// shortcut: some animations live where the decoder can't read them (CS:GO's chopper: its rest pose stands on its tail); the header hull
// still has the real orientation, so when the mesh box is far off it, turn the mesh by the 90-degree rotation that fits. Upgrade: decode those anims.
let aligned = 0;
function alignToHull(md) {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const mesh of md.meshes) for (let i = 0; i < mesh.pos.length; i++) { lo[i % 3] = Math.min(lo[i % 3], mesh.pos[i]); hi[i % 3] = Math.max(hi[i % 3], mesh.pos[i]); }
  const err = (a, b) => [0, 1, 2].reduce((t, k) => t + Math.abs(a[0][k] - md.hullMin[k]) + Math.abs(a[1][k] - md.hullMax[k]), 0);
  const size = [0, 1, 2].reduce((t, k) => t + md.hullMax[k] - md.hullMin[k], 0);
  if (!(size > 0) || err([lo, hi]) < size * 0.25) return md;
  let best = null;
  for (const perm of [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]]) for (let sg = 0; sg < 8; sg++) { // axis-aligned rotations (+ mirror checks below)
    const s = [sg & 1 ? -1 : 1, sg & 2 ? -1 : 1, sg & 4 ? -1 : 1], f = (v) => perm.map((p, k) => v[p] * s[k]);
    const a = f(lo), b = f(hi), box = [[0, 1, 2].map((k) => Math.min(a[k], b[k])), [0, 1, 2].map((k) => Math.max(a[k], b[k]))];
    const det = Math.sign(s[0] * s[1] * s[2]) * ([[0, 1, 2], [1, 2, 0], [2, 0, 1]].some((q) => q.join() === perm.join()) ? 1 : -1);
    if (det > 0 && (!best || err(box) < best[0])) best = [err(box), f];
  }
  if (best[0] < size * 0.1) aligned++;
  if (best[0] < size * 0.1) for (const mesh of md.meshes) for (const arr of [mesh.pos, mesh.nrm]) for (let i = 0; i < arr.length; i += 3) arr.splice(i, 3, ...best[1](arr.slice(i, i + 3)));
  return md;
}
const getModel = (name, skin, seq = '') => {
  const key = name + '#' + skin + '#' + seq;
  if (!modelCache.has(key)) {
    try { const base = modelBase(name); if (!base) throw new Error('not in CS:S or CS:GO'); modelCache.set(key, posed(loadModel(base, skin), base, seq)); }
    catch (e) { missing.push(name + ' (model: ' + e.message.split('\n')[0] + ')'); modelCache.set(key, null); }
  }
  return modelCache.get(key);
};
const phyCache = new Map();
const getPhy = (name) => {
  if (!phyCache.has(name)) {
    try { phyCache.set(name, loadPhy(modelBase(name) + '.phy')); } catch { phyCache.set(name, null); }
  }
  return phyCache.get(name);
};
const rotation = ([pitch, yaw, roll]) => { // Source AngleMatrix
  const d = Math.PI / 180, sp = Math.sin(pitch * d), cp = Math.cos(pitch * d), sy = Math.sin(yaw * d), cy = Math.cos(yaw * d), sr = Math.sin(roll * d), cr = Math.cos(roll * d);
  return [[cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy], [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy], [-sp, sr * cp, cr * cp]];
};
const apply = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const propList = [];
{ // static props: game lump 'sprp' (stored byte-reversed as 'prps'); file offsets are absolute
  const gl = lump(35), lumpBase = bsp.readInt32LE(8 + 35 * 16);
  for (let i = 0, n = gl.readInt32LE(0); i < n; i++) {
    const o = 4 + i * 16;
    if (gl.toString('latin1', o, o + 4) !== 'prps') continue;
    const end = gl.readInt32LE(o + 8) - lumpBase + gl.readInt32LE(o + 12);
    let q = gl.readInt32LE(o + 8) - lumpBase;
    const nd = gl.readInt32LE(q); q += 4;
    const dict = Array.from({ length: nd }, (_, k) => gl.toString('latin1', q + k * 128, q + k * 128 + 128).split('\0')[0]); q += nd * 128;
    q += 4 + gl.readInt32LE(q) * 2; // leaf list (unused)
    const ns = gl.readInt32LE(q); q += 4;
    const size = (end - q) / ns;
    for (let k = 0; k < ns; k++) {
      const r = q + k * size;
      if (gl.readUInt8(r + 31) & 4) continue; // STATIC_PROP_NO_DRAW
      propList.push({ model: dict[gl.readUInt16LE(r + 24)], o: [gl.readFloatLE(r), gl.readFloatLE(r + 4), gl.readFloatLE(r + 8)], a: [gl.readFloatLE(r + 12), gl.readFloatLE(r + 16), gl.readFloatLE(r + 20)], solid: gl.readUInt8(r + 30), skin: gl.readInt32LE(r + 32) });
    }
  }
}
for (const e of entities) { // physics props placed as entities (rendered static for now)
  if (!/^prop_(physics|dynamic)/.test(e.classname) || !e.model || doorNames.has(e.parentname)) continue; // door handles go with their door (movers)
  propList.push({ model: e.model, o: e.origin.split(' ').map(Number), a: (e.angles ?? '0 0 0').split(' ').map(Number), solid: Number(e.solid ?? 6), skin: Number(e.skin ?? 0), seq: e.DefaultAnim ?? '' }); // solid 0: decoration (fans, banners, the hovering chopper)
}
// ---------- baked prop lighting ----------
// Calibrate the sun from the lightmaps themselves: up-facing faces in sunlight vs in shade give direct and ambient levels (linear, 1.0 = white).
const lm = { sunlit: [0, 0, 0], shade: [0, 0, 0] };
{
  const samples = [];
  for (const [i, r] of lmRects) {
    const f = faces[i], n = planes[f.plane].n;
    if (Math.abs(n[2]) < 0.95 || (f.side ? -n[2] : n[2]) < 0 || f.lmSize[0] < 2 || f.lmSize[1] < 2) continue;
    const w = f.lmSize[0] + 1, h = f.lmSize[1] + 1, cx = f.lightofs + (Math.floor(h / 2) * w + Math.floor(w / 2)) * 4;
    const c = [0, 1, 2].map((k) => linearLight(lighting[cx + k], lighting.readInt8(cx + 3)));
    if (c[0] + c[1] + c[2] > 0.03) samples.push(c); // unlit faces (under water, sealed off) would drag the shade level to black
  }
  samples.sort((a, b) => a[0] + a[1] + a[2] - (b[0] + b[1] + b[2]));
  const avg = (arr) => [0, 1, 2].map((k) => arr.reduce((t, c) => t + c[k], 0) / Math.max(arr.length, 1));
  const n = samples.length;
  lm.shade = avg(samples.slice(Math.floor(n * 0.1), Math.floor(n * 0.3)));
  lm.sunlit = avg(samples.slice(Math.floor(n * 0.8), Math.floor(n * 0.95)));
}
const sunInfo = sunOf(entities.find((e) => e.classname === 'light_environment'));
const sunDirV = sunInfo?.dir ?? [0.3, 0.3, 0.9];
const directLin = [0, 1, 2].map((k) => Math.max(lm.sunlit[k] - lm.shade[k], 0) / Math.max(sunDirV[2], 0.3)); // light of the sun on a surface facing it
const sunBlockers = makeWorld(collision.filter((_, i) => !skyBrushIdx.includes(i)));
function propLight(origin, vis) { // -> (normal) => [r,g,b] encoded like the lightmap
  // props are often placed inside walls (solid leaf, empty cube): probe outwards for the nearest real leaf
  const valid = (l) => l.cube && l.cube.some((c) => c[0] || c[1] || c[2]);
  let leaf = leafs[pointLeaf(origin)];
  for (let r = 8; !valid(leaf) && r <= 96; r += 8) for (const d of [[0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, -1]]) {
    const l = leafs[pointLeaf([origin[0] + d[0] * r, origin[1] + d[1] * r, origin[2] + d[2] * r])];
    if (valid(l)) { leaf = l; break; }
  }
  const cube = valid(leaf) ? leaf.cube.map(([r, g, b, e]) => [r, g, b].map((c) => linearLight(c, e))) : Array(6).fill(lm.shade);
  return (n) => [0, 1, 2].map((c) => {
    let lin = 0;
    for (let a = 0; a < 3; a++) lin += n[a] * n[a] * cube[a * 2 + (n[a] < 0 ? 1 : 0)][c];
    const ndl = Math.max(n[0] * sunDirV[0] + n[1] * sunDirV[1] + n[2] * sunDirV[2], 0);
    return encodeLight(lin + directLin[c] * ndl * vis);
  });
}
const propGroups = new Map(), skyPropGroups = new Map();
let propCount = 0;
for (const pr of propList) {
  const m = getModel(pr.model, pr.skin, pr.seq);
  if (!m) continue;
  propCount++;
  const sky = inSky(pr.o), target = sky ? skyPropGroups : propGroups, M = rotation(pr.a);
  // sun visibility from the prop's centre (sky walls excluded), then per-vertex ambient cube + sun
  const centre = [pr.o[0], pr.o[1], pr.o[2] + Math.max((m.hullMax[2] + m.hullMin[2]) / 2, 8)];
  const vis = sky ? 1 : traceWorld(sunBlockers, centre, [centre[0] + sunDirV[0] * 6000, centre[1] + sunDirV[1] * 6000, centre[2] + sunDirV[2] * 6000], [0, 0, 0], [0, 0, 0]).fraction === 1 ? 1 : 0;
  const light = sky ? () => [0.8, 0.8, 0.8] : propLight(pr.o, vis);
  for (const mesh of m.meshes) {
    const key = mesh.cd.join('|') + '|' + mesh.material;
    let g = target.get(key);
    if (!g) target.set(key, (g = { name: key, aliases: mesh.cd.map((c) => c + mesh.material), pos: [], nrm: [], uv: [], col: [] }));
    for (let i = 0; i < mesh.pos.length; i += 3) {
      g.pos.push(...apply(M, mesh.pos.slice(i, i + 3)).map((v, k) => v + pr.o[k]));
      const nv = apply(M, mesh.nrm.slice(i, i + 3));
      g.nrm.push(...nv);
      g.col.push(...light(nv));
    }
    for (const u of mesh.uv) g.uv.push(u); // no spread: a big model overflows the call stack
  }
  if (!sky && pr.solid) { // collision: exact convex pieces from the model's .phy (solid 6), else its hull as an oriented box (solid 2-4)
    const place = (pts) => pts.map((q) => apply(M, q).map((v, k) => v + pr.o[k]));
    const phy = pr.solid === 6 ? getPhy(pr.model) : null;
    if (phy) {
      for (const piece of phy) {
        const faces = piece.planes.map(([nx, ny, nz, d]) => { const n = apply(M, [nx, ny, nz]); return [...n, d + dot3(n, pr.o)]; });
        pushCol(convexEntry(place(piece.points), faces, piece.edges.map(([p, q]) => place([p, q]))), surfaceOfName(pr.model.toLowerCase()));
      }
    } else if (pr.solid >= 2 && pr.solid <= 4) {
      const lo = m.hullMin, hi = m.hullMax;
      const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
      const edgePairs = []; for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) if (!((i >> k) & 1)) edgePairs.push([corners[i], corners[i | (1 << k)]]);
      const faces = []; for (let a = 0; a < 3; a++) for (const sgn of [1, -1]) { const ax = [0, 0, 0]; ax[a] = sgn; const n = apply(M, ax); faces.push([...n, dot3(n, place([corners.find((c) => c[a] === (sgn > 0 ? hi[a] : lo[a]))])[0])]); }
      pushCol(convexEntry(place(corners), faces, edgePairs.map(([p, q]) => place([p, q]))), surfaceOfName(pr.model.toLowerCase()));
    }
  }
}
const movers = [];
for (const e of moverEnts) {
  const brush = e.model.startsWith('*'), door = DOORS.test(e.classname), flags = Number(e.spawnflags ?? 0);
  const origin = vecOf(e.origin), M = rotation(vecOf(e.angles)), place = (q) => apply(M, q).map((v, k) => v + origin[k]);
  const def = { cls: e.classname, name: e.targetname ?? '', slave: e.slavename ?? '', parentName: e.parentname ?? '', pivot: origin, pieces: [], entries: [], groups: [], props: [] };
  let surface = 'wood';
  if (door) {
    const prop = e.classname === 'prop_door_rotating';
    def.kind = 'door'; def.locked = !!(flags & 2048);
    // doors no player can use are driven by map logic in Source: here they open by themselves when someone comes close
    def.use = prop ? !!(flags & (8192 | 32768)) || !flags : !!(flags & (256 | 1024));
    if (e.classname === 'func_door') {
      const [pt, yw] = vecOf(e.movedir).map((a) => (a * Math.PI) / 180), dir = [Math.cos(pt) * Math.cos(yw), Math.cos(pt) * Math.sin(yw), -Math.sin(pt)];
      const m = brushModel(e), size = [0, 1, 2].map((k) => m.maxs[k] - m.mins[k]);
      def.slide = dir; def.dist = Math.max(Math.abs(dot3(dir, size)) - Number(e.lip ?? 0), 0); def.speed = Number(e.speed ?? 100);
    } else { def.dist = Number(e.distance ?? 90); def.speed = Number(e.speed ?? 100); def.oneWay = !prop && flags & 16 ? (flags & 2 ? -1 : 1) : 0; }
    surface = /metal/.test(e.model) ? 'metal' : 'wood';
  } else {
    def.kind = 'break'; def.breakable = true; def.health = e.classname === 'func_breakable_surf' ? 1 : Number(e.health);
    def.glass = e.classname === 'func_breakable_surf' || Number(e.material ?? 0) === 0;
    surface = def.glass ? 'glass' : ['glass', 'wood', 'metal', 'concrete', 'concrete', 'concrete', 'concrete', 'concrete'][Number(e.material)] ?? 'wood';
  }
  def.surface = surface;
  if (Number(e.rendermode ?? 0) && Number(e.renderamt ?? 255) < 255) def.opacity = Number(e.renderamt) / 255; // e.g. cs_agency's panes: rendermode 2, renderamt 150
  if (brush) {
    const m = brushModel(e), into = new Map();
    for (let fi = m.firstFace; fi < m.firstFace + m.numFaces; fi++) {
      const f = faces[fi], ti = texinfo[f.ti];
      if (ti.flags & SKIP_FLAGS || f.disp >= 0) continue;
      const poly = [];
      for (let k = 0; k < f.numEdges; k++) { const se = surfEdges[f.firstEdge + k]; poly.push(verts[se >= 0 ? edges[se][0] : edges[-se][1]]); }
      const n = [0, 1, 2].map((a) => -poly.reduce((t, p, i) => { const q = poly[(i + 1) % poly.length], b = (a + 1) % 3, c = (a + 2) % 3; return t + (p[b] - q[b]) * (p[c] + q[c]); }, 0));
      const pts = poly.map((p) => ({ p: place(p), flat: p }));
      for (let k = 1; k < poly.length - 1; k++) emit(fi, orient([0, k, k + 1], pts, n), pts, into);
    }
    def.groupMap = into;
    const own = new Set();
    (function walk(c) { if (c >= 0) return nodes[c].ch.forEach(walk); const l = leafs[-1 - c]; for (let i = 0; i < l.numLB; i++) own.add(leafBrushes[l.firstLB + i]); })(m.head);
    for (const i of own) {
      const br = brushes[i];
      if (!(br.contents & 0x3)) continue;
      const pl = []; for (let k = 0; k < br.num; k++) { const q = planes[sides[br.first + k].plane]; pl.push([...q.n, q.d]); }
      const local = brushVerts(pl);
      if (!local.length) continue;
      def.pieces.push({ pts: local.map(place), planes: pl.map(([nx, ny, nz, d]) => { const nn = apply(M, [nx, ny, nz]); return [...nn, d + dot3(nn, origin)]; }) });
    }
  } else { // prop_door_rotating: the model, lit like a prop; collision = its hull box
    const md = getModel(e.model, Number(e.skin ?? 0));
    if (!md) continue;
    const mid = [origin[0], origin[1], origin[2] + (md.hullMax[2] + md.hullMin[2]) / 2], sunVis = traceWorld(sunBlockers, mid, mid.map((v, k) => v + sunDirV[k] * 6000), [0, 0, 0], [0, 0, 0]).fraction === 1 ? 1 : 0;
    const light = propLight(origin, sunVis), into = new Map();
    for (const mesh of md.meshes) {
      const key = mesh.cd.join('|') + '|' + mesh.material;
      let g = into.get(key);
      if (!g) into.set(key, (g = { name: key, aliases: mesh.cd.map((c) => c + mesh.material), pos: [], nrm: [], uv: [], col: [] }));
      for (let i = 0; i < mesh.pos.length; i += 3) { g.pos.push(...place(mesh.pos.slice(i, i + 3))); const nv = apply(M, mesh.nrm.slice(i, i + 3)); g.nrm.push(...nv); g.col.push(...light(nv)); }
      for (const u of mesh.uv) g.uv.push(u); // no spread: a big model overflows the call stack
    }
    def.propMap = into;
    const lo = md.hullMin, hi = md.hullMax, corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
    const pl = []; for (let a = 0; a < 3; a++) for (const sg of [1, -1]) { const ax = [0, 0, 0]; ax[a] = sg; const nn = apply(M, ax); pl.push([...nn, dot3(nn, place(sg > 0 ? hi : lo))]); }
    def.pieces.push({ pts: corners.map(place), planes: pl });
  }
  if (!def.pieces.length) continue;
  // the grid needs every cell the mover can ever reach: its bounds over the whole swing / slide
  const all = def.pieces.flatMap((pc) => pc.pts), reach = [];
  if (door && !def.slide) for (let a = -def.dist; a <= def.dist + 0.01; a += Math.max(def.dist / 12, 1)) { const r = (a * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r); for (const p of all) { const x = p[0] - origin[0], y = p[1] - origin[1]; reach.push([origin[0] + x * c - y * sn, origin[1] + x * sn + y * c, p[2]]); } }
  else if (door) for (const p of all) reach.push(p, p.map((v, k) => v + def.slide[k] * def.dist));
  else reach.push(...all);
  const swept = bounds(reach);
  for (const pc of def.pieces) { const en = Array.from(moverEntry(pc, (q) => q, (q) => q)); en.splice(0, 6, ...swept); def.entries.push(collision.length); pushCol(en, surface); }
  const c = bounds(all); def.center = [0, 1, 2].map((k) => (c[k] + c[k + 3]) / 2);
  movers.push(def);
}
// attachments: breakables parented to a door turn with it (their grid bounds must cover the swing); handle props join the door's mesh
const swing = (door, pts) => { const out = []; for (let a = -door.dist; a <= door.dist + 0.01; a += Math.max(door.dist / 12, 1)) { const r = (a * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r), h = door.pivot; for (const p of pts) { const x = p[0] - h[0], y = p[1] - h[1]; out.push([h[0] + x * c - y * sn, h[1] + x * sn + y * c, p[2]]); } } return out; };
for (const m of movers) {
  const parent = m.kind === 'door' || !m.parentName ? -1 : movers.findIndex((d) => d.kind === 'door' && !d.slide && d.name === m.parentName);
  if (parent < 0) continue;
  m.parent = parent;
  const swept = bounds(swing(movers[parent], m.pieces.flatMap((pc) => pc.pts)));
  for (const idx of m.entries) collision[idx].splice(0, 6, ...swept);
}
for (const e of entities) {
  const parent = e.parentname && /^prop_(physics|dynamic)/.test(e.classname) && e.model ? movers.find((d) => d.kind === 'door' && d.name === e.parentname) : null;
  const md = parent && getModel(e.model, Number(e.skin ?? 0));
  if (!md) continue;
  const o = vecOf(e.origin), M = rotation(vecOf(e.angles)), light = propLight(o, 0);
  parent.propMap ??= new Map();
  for (const mesh of md.meshes) {
    const key = mesh.cd.join('|') + '|' + mesh.material;
    let g = parent.propMap.get(key);
    if (!g) parent.propMap.set(key, (g = { name: key, aliases: mesh.cd.map((c) => c + mesh.material), pos: [], nrm: [], uv: [], col: [] }));
    for (let i = 0; i < mesh.pos.length; i += 3) { g.pos.push(...apply(M, mesh.pos.slice(i, i + 3)).map((v, k) => v + o[k])); const nv = apply(M, mesh.nrm.slice(i, i + 3)); g.nrm.push(...nv); g.col.push(...light(nv)); }
    for (const u of mesh.uv) g.uv.push(u);
  }
}
console.log(`movers: ${movers.filter((m) => m.kind === 'door').length} doors, ${movers.filter((m) => m.kind === 'break').length} breakables, ${movers.filter((m) => m.parent >= 0).length} attached to doors`);
const propTex = (g) => materialTexture(g.aliases[0], g.aliases);
const manifestGroups = emitGroups(groups, ['pos', 'uv', 'lm']);
const skyManifest = emitGroups(skyGroups, ['pos', 'uv', 'lm']);
const propManifest = emitGroups(propGroups, ['pos', 'nrm', 'uv', 'col'], propTex);
const skyPropManifest = emitGroups(skyPropGroups, ['pos', 'nrm', 'uv', 'col'], propTex);
for (const m of movers) {
  if (m.groupMap) m.groups = emitGroups(m.groupMap, ['pos', 'uv', 'lm']);
  if (m.propMap) m.props = emitGroups(m.propMap, ['pos', 'nrm', 'uv', 'col'], propTex);
  delete m.groupMap; delete m.propMap;
}
// Skybox faces (opaque RGB PNGs); the client lays them out as a cube map.
const skyName = entities[0].skyname;
for (const f of writeSky(skyName, OUT)) missing.push(`skybox ${skyName}${f} (replaced by de_dust2's)`);
// loading screen art: the map's radar overview and the CS:S logo
fs.mkdirSync(path.join(OUT, '..', 'ui'), { recursive: true });
for (const [src, dst, dir] of [[`overviews/${MAP}`, 'overview', OUT], ['vgui/gfx/vgui/cs_logo', 'cs_logo', path.join(OUT, '..', '..', 'ui')]]) {
  const vtf = readFile(src + '.vtf');
  if (!vtf) { missing.push(src + ' (ui art)'); continue; }
  const { W, H, rgba } = vtfToRgba(vtf);
  fs.writeFileSync(path.join(dir, dst + '.png'), png(W, H, 4, rgba));
}
if (GLB) {
  const pngOf = (r) => (r.tex ? fs.readFileSync(path.join(OUT, 'tex', r.tex)) : null);
  const part = (g, r) => ({ name: g.name, material: { name: g.name, color: [0.6, 0.6, 0.6, 1], png: pngOf(r), alpha: ['OPAQUE', 'MASK', 'BLEND'][r.alpha], doubleSided: r.alpha > 0 }, pos: g.pos, uv: g.uv });
  const parts = [...groups.values()].map((g) => part(g, materialTexture(g.name)));
  for (const g of propGroups.values()) parts.push(part({ ...g, name: 'prop:' + g.name }, propTex(g)));
  fs.mkdirSync(path.dirname(path.resolve(GLB)), { recursive: true });
  const r = writeGlb(path.resolve(GLB), { name: MAP, parts });
  console.log(`glb ${MAP}: ${r.tris} triangles, ${r.parts} meshes, ${r.materials} materials, ${(r.bytes / 1e6).toFixed(1)} MB -> ${GLB}`);
}
fs.writeFileSync(path.join(OUT, 'world.bin'), Buffer.concat(bins));
fs.writeFileSync(path.join(OUT, 'lightmap.png'), png(AW, AH, 3, atlas));
// radar placement from CS:S resource/overviews/<map>.txt (that folder isn't in the content dump, so the values live here)
const OVERVIEWS = { de_dust2: { pos_x: -2476, pos_y: 3239, scale: 4.4 }, de_inferno: { pos_x: -2087, pos_y: 3870, scale: 4.9 }, cs_office: { pos_x: -1838, pos_y: 1858, scale: 4.1 },
  de_lake: { pos_x: -3540.9, pos_y: 244.9, scale: 12.245 }, de_nuke: { pos_x: -3453, pos_y: 2887, scale: 7 }, cs_agency: { pos_x: -2947, pos_y: 2492, scale: 5 } }; // de_lake: matches its generated overview.png
const fogOf = (e) => (e && e.fogenable === '1' ? { color: e.fogcolor.split(' ').map((v) => Number(v) / 255), start: Number(e.fogstart), end: Number(e.fogend), max: Number(e.fogmaxdensity ?? 1) } : null);
function sunOf(e) {
  if (!e) return null;
  const pitch = (Number(e.pitch ?? e.angles.split(' ')[0]) * Math.PI) / 180, yaw = (Number(e.angles.split(' ')[1]) * Math.PI) / 180;
  const rgb = (k) => { const v = e[k].split(' ').map(Number); const m = Math.max(v[0], v[1], v[2]); return v.slice(0, 3).map((c) => c / m); }
  // light_environment pitch is negative when shining down; store the direction *towards* the sun
  return { dir: [-Math.cos(-pitch) * Math.cos(yaw), -Math.cos(-pitch) * Math.sin(yaw), Math.sin(-pitch)], color: rgb('_light'), ambient: rgb('_ambient') };
};
const spawn = (cls) => entities.filter((e) => e.classname === cls).map((e) => ({ o: e.origin.split(' ').map(Number), yaw: Number(e.angles?.split(' ')[1] || 0) }));
// bombsites: func_bomb_target brush models (lump 14: mins, maxs, origin, ... 48 bytes each); the centre is where bots defend / attack
const modelLump = lump(14);
const sites = entities.filter((e) => e.classname === 'func_bomb_target' && /^\*\d+$/.test(e.model ?? '')).map((e) => {
  const o = Number(e.model.slice(1)) * 48, f = (k) => modelLump.readFloatLE(o + k * 4);
  return { name: e.targetname ?? '', o: [(f(0) + f(3)) / 2, (f(1) + f(4)) / 2, (f(2) + f(5)) / 2], min: [f(0), f(1), f(2)], max: [f(3), f(4), f(5)] };
});
console.log('bombsites', JSON.stringify(sites));
// hostage rescue maps: the hostages (hostage_entity) and the rescue zones (func_hostage_rescue brushes, or info_hostage_rescue points)
const boundsOf = (e) => { const o = Number(e.model.slice(1)) * 48, f = (k) => modelLump.readFloatLE(o + k * 4); return { min: [f(0), f(1), f(2)], max: [f(3), f(4), f(5)] }; };
const hostages = entities.filter((e) => (e.classname === 'hostage_entity' || e.classname === 'info_hostage_spawn')).map((e) => ({ o: e.origin.split(' ').map(Number), yaw: Number(e.angles?.split(' ')[1] || 0) }));
const rescue = [
  ...entities.filter((e) => e.classname === 'func_hostage_rescue' && /^\*\d+$/.test(e.model ?? '')).map(boundsOf),
  ...entities.filter((e) => e.classname === 'info_hostage_rescue').map((e) => { const o = e.origin.split(' ').map(Number); return { min: [o[0] - 128, o[1] - 128, o[2] - 64], max: [o[0] + 128, o[1] + 128, o[2] + 128] }; }),
];
if (hostages.length) console.log('hostages', hostages.length, 'rescue zones', JSON.stringify(rescue));
// trigger_hurt volumes (death pits off the edge of rooftops, fires): bounds + damage per half second, as Source applies it
const hurt = entities.filter((e) => e.classname === 'trigger_hurt' && /^\*\d+$/.test(e.model ?? '')).map((e) => { const b = boundsOf(e), o = vecOf(e.origin); return { min: b.min.map((v, k) => v + o[k]), max: b.max.map((v, k) => v + o[k]), damage: Number(e.damage ?? 10) }; });
// ---------- ambience: soundscape zones (env_soundscape) + looping ambient_generic sounds; their files go to public/sound ----------
addSoundscapeScripts(...['txt', 'vsc'].map((x) => `scripts/soundscapes_${MAP}.${x}`)); // a map's own script, if it ships one
const byName = new Map(entities.filter((e) => e.targetname && e.origin).map((e) => [e.targetname, vecOf(e.origin)]));
const scapeOf = (e) => (e.classname === 'env_soundscape_proxy' ? entities.find((m) => m.targetname === e.mainsoundscapename)?.soundscape : e.soundscape);
const scapes = {}, soundFiles = new Set();
const zones = entities.filter((e) => /^env_soundscape(_proxy|_triggerable)?$/.test(e.classname) && e.origin && scapeOf(e)).map((e) => {
  const name = scapeOf(e).toLowerCase();
  if (!(name in scapes)) scapes[name] = flatten(name);
  return { o: vecOf(e.origin), r: Number(e.radius ?? 128), name, pos: Array.from({ length: 8 }, (_, k) => byName.get(e['position' + k]) ?? null) };
});
const ambients = entities.filter((e) => e.classname === 'ambient_generic' && /\.(wav|mp3)$/i.test(e.message ?? '') && !(Number(e.spawnflags ?? 0) & (16 | 32)))
  .map((e) => ({ wave: e.message.replace(/^[\^)(#*@<>!?$&~`+%]+/, '').replace(/\\/g, '/').toLowerCase(), o: vecOf(e.origin), volume: Number(e.health ?? 10) / 10, reach: Number(e.radius ?? 1250), everywhere: Number(e.spawnflags ?? 0) & 1 }));
for (const list of Object.values(scapes)) for (const el of list) el.waves.forEach((w) => soundFiles.add(w));
for (const a of ambients) soundFiles.add(a.wave);
let copied = 0;
for (const w of soundFiles) {
  const data = readGameFile('sound/' + w), dst = path.join(OUT, '..', '..', 'sound', w);
  if (!data) { missing.push('sound/' + w); continue; }
  if (!fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, data); copied++; }
}
for (const list of Object.values(scapes)) for (const el of list) el.waves = el.waves.filter((w) => !missing.includes('sound/' + w));
console.log(`ambience: ${zones.length} soundscape zones, ${Object.keys(scapes).length} soundscapes, ${ambients.length} ambient loops, ${soundFiles.size} sounds (${copied} new)`);
fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify({ sites, hostages, rescue, hurt, ambience: { zones, scapes, ambients },
  groups: manifestGroups, props: propManifest, collision, playerOnly, movers,
  sky: skyCam ? { origin: skyOrigin, scale: skyScale, groups: skyManifest, props: skyPropManifest } : null,
  spawns: { ct: spawn('info_player_counterterrorist'), t: spawn('info_player_terrorist') },
  // Source linear fog (env_fog_controller for the world, sky_camera's own fog for the 3D skybox) and the sun (light_environment)
  fog: fogOf(entities.find((e) => e.classname === 'env_fog_controller')),
  skyFog: fogOf(skyCam),
  sun: sunInfo,
  light: { ambient: lm.shade, direct: directLin, sunDir: sunDirV }, // linear; for dynamic objects (players)
  skyBrushIdx, surfaces: SURFACES, surfOf,
  overview: OVERVIEWS[MAP] ?? null,
  mode: argOf('--mode') === 'wingman' ? { name: 'Wingman', teamSize: 2, roundTime: 90, sites: 1 } : null, // --mode wingman: 2v2, 90 s rounds, one bombsite
}));
console.log(`displacement brushes replaced by triangle collision: ${DISPBRUSH}`);
console.log(`models turned to fit their hull: ${aligned}`);
console.log(`props: ${propCount} placed, ${propManifest.length} materials, sky: ${skyManifest.length} materials + ${skyPropManifest.length} prop materials`);
console.log(`${MAP}: ${manifestGroups.length} materials, ${manifestGroups.reduce((s, g) => s + g.count, 0) / 3 | 0} tris, ${collision.length} brushes, lightmap ${AW}x${AH}, ${lmRects.size} lit faces`);
if (missing.length) console.log('untextured (' + missing.length + '):\n  ' + missing.join('\n  '));
