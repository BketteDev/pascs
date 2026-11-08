// Converts a decompiled Source map (.vmf) to GLB: brush geometry (plane clipping + displacements) and prop_static models.
// Usage: node tools/vmf-export.mjs <map.vmf> <out.glb>
// Textures/models are looked up in the CS:S content (CS:GO shares many material and model names); anything missing becomes a flat colour.
// Algorithm references: Source-Asset-Viewer/vmf.js (same brush/displacement conventions).
import fs from 'fs';
import path from 'path';
import { writeGlb } from './glb.mjs';
import { loadModel } from './mdl.mjs';
import { readGameFile, modelBase } from './content.mjs';
import { png, vtfToRgba } from './vtf.mjs';

const CONTENT = path.resolve(import.meta.dirname, '..', '..', 'content', 'css_content');

// ---------- VMF text -> tree ----------
function parseVmf(text) {
  const root = { name: 'root', props: new Map(), kids: [] }, stack = [root];
  let pending = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '{') { const node = { name: pending, props: new Map(), kids: [] }; stack.at(-1).kids.push(node); stack.push(node); pending = null; }
    else if (line === '}') stack.pop();
    else if (line[0] === '"') { const m = line.match(/^"([^"]*)"\s+"(.*)"$/); if (m) stack.at(-1).props.set(m[1], m[2]); }
    else pending = line;
  }
  return root;
}

// ---------- vector helpers ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
const nums = (s) => s.replace(/[()\[\]]/g, ' ').trim().split(/\s+/).map(Number);

// ---------- brush -> polygons ----------
function parseSides(solid) {
  const sides = solid.kids.filter((k) => k.name === 'side').map((sd) => {
    const p = nums(sd.props.get('plane'));
    const pts = [[p[0], p[1], p[2]], [p[3], p[4], p[5]], [p[6], p[7], p[8]]];
    return { pts, material: (sd.props.get('material') ?? '').toLowerCase(), u: sd.props.get('uaxis'), v: sd.props.get('vaxis'), disp: sd.kids.find((k) => k.name === 'dispinfo') };
  });
  const all = sides.flatMap((s) => s.pts), c = mul(all.reduce((a, p) => add(a, p), [0, 0, 0]), 1 / (all.length || 1));
  for (const s of sides) { // outward normal: the brush centre lies behind every plane
    let n = norm(cross(sub(s.pts[2], s.pts[0]), sub(s.pts[1], s.pts[0])));
    if (dot(n, sub(c, s.pts[0])) > 0) n = mul(n, -1);
    s.n = n; s.d = dot(n, s.pts[0]);
  }
  return sides;
}
function clip(poly, n, d) { // keep n.x <= d (Sutherland-Hodgman)
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], da = dot(n, a) - d, db = dot(n, b) - d;
    if (da <= 0.01) out.push(a);
    if ((da < -0.01 && db > 0.01) || (da > 0.01 && db < -0.01)) out.push(lerp(a, b, da / (da - db)));
  }
  return out;
}
function sidePolygon(sides, i) { // CCW seen from outside the brush
  const s = sides[i], ref = Math.abs(s.n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const ax = norm(cross(s.n, ref)), ay = cross(s.n, ax), o = mul(s.n, s.d), R = 65536;
  let poly = [add(add(o, mul(ax, -R)), mul(ay, -R)), add(add(o, mul(ax, R)), mul(ay, -R)), add(add(o, mul(ax, R)), mul(ay, R)), add(add(o, mul(ax, -R)), mul(ay, R))];
  for (let j = 0; j < sides.length && poly.length > 2; j++) if (j !== i) poly = clip(poly, sides[j].n, sides[j].d);
  // dedupe near-identical points
  return poly.filter((p, k) => len(sub(p, poly[(k + 1) % poly.length])) > 0.02);
}

// ---------- materials ----------
const SKIP = /^(tools\/|toolsnodraw)/;
const texCache = new Map();
function material(name) { // -> { png, w, h, alpha } or null
  if (texCache.has(name)) return texCache.get(name);
  let out = null;
  try {
    let vmt = readGameFile('materials/' + name + '.vmt'); // CS:S, the map's pak (addBspPak), CS:GO
    for (let guard = 0; vmt && guard < 3; guard++) { // patch materials name their base material
      const text = vmt.toString('latin1').toLowerCase(), inc = text.match(/"include"\s+"([^"]+)"/)?.[1];
      if (!inc || /\$basetexture/.test(text)) break;
      vmt = readGameFile(inc.replace(/\\/g, '/'));
    }
    if (vmt) {
      let t = vmt.toString('latin1').toLowerCase().replace(/\\/g, '/');
      const base = t.match(/"?\$basetexture"?\s+"?([^"\s]+)"?/)?.[1];
      const vtfData = base && readGameFile('materials/' + base + '.vtf');
      if (vtfData) {
        const { W, H, rgba } = vtfToRgba(vtfData);
        const alpha = /\$alphatest\W+1/.test(t) ? 'MASK' : /\$translucent\W+1/.test(t) ? 'BLEND' : 'OPAQUE';
        let data = rgba, ch = 4;
        if (alpha === 'OPAQUE') { ch = 3; data = Buffer.alloc(W * H * 3); for (let i = 0; i < W * H; i++) rgba.copy(data, i * 3, i * 4, i * 4 + 3); }
        out = { png: png(W, H, ch, data), w: W, h: H, alpha };
      }
    }
  } catch { out = null; }
  texCache.set(name, out);
  return out;
}
const hashColor = (name) => { let h = 2166136261; for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619); const r = (h >>> 0) & 255, g = (h >>> 8) & 255, b = (h >>> 16) & 255; return [0.35 + r / 640, 0.35 + g / 640, 0.35 + b / 640, 1]; };
const GLASS = /glass|window/;

// ---------- output buckets ----------
const parts = new Map(); // key -> { name, material, pos, uv }
function bucket(name, ref) {
  if (!parts.has(name)) {
    const mat = material(name.replace(/^prop:/, '')), glass = GLASS.test(name); // prop buckets are 'prop:<material>'
    parts.set(name, { name, texW: mat?.w ?? 512, texH: mat?.h ?? 512, pos: [], uv: [], material: { name, color: glass && !mat ? [0.6, 0.8, 0.9, 0.35] : hashColor(name), png: mat?.png, alpha: mat?.alpha ?? (glass && !mat ? 'BLEND' : 'OPAQUE'), doubleSided: !!mat && mat.alpha !== 'OPAQUE' } });
  }
  return parts.get(name);
}
function emitTri(b, tri, uvAxes) {
  for (const p of tri) {
    b.pos.push(...p);
    if (uvAxes) {
      const [ua, va] = uvAxes;
      b.uv.push((dot(p, ua.slice(0, 3)) / ua[4] + ua[3]) / b.texW, (dot(p, va.slice(0, 3)) / va[4] + va[3]) / b.texH);
    } else b.uv.push(0, 0);
  }
}
const parseAxis = (s) => { const m = s.match(/\[([^\]]*)\]\s*([-\d.e]+)/); const v = m[1].trim().split(/\s+/).map(Number); return [v[0], v[1], v[2], v[3], Number(m[2]) || 0.25]; };

// ---------- displacement ----------
const rowsOf = (node, key, perRow) => {
  const grid = node?.kids.find((k) => k.name === key); if (!grid) return null;
  return [...grid.props.entries()].filter(([k]) => /^row\d+$/.test(k)).sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3))).map(([, v]) => { const n = v.trim().split(/\s+/).map(Number), out = []; for (let i = 0; i < n.length; i += perRow) out.push(n.slice(i, i + perRow)); return out; });
};
function emitDisplacement(b, poly, side, uvAxes) {
  const disp = side.disp, power = Number(disp.props.get('power')), N = (1 << power) + 1;
  if (poly.length !== 4) return false;
  const start = nums(disp.props.get('startposition')), cw = [...poly].reverse(); // Source orders face corners clockwise
  const s = cw.reduce((best, p, i) => (len(sub(p, start)) < len(sub(cw[best], start)) ? i : best), 0), c = [0, 1, 2, 3].map((i) => cw[(s + i) % 4]);
  const normals = rowsOf(disp, 'normals', 3), dist = rowsOf(disp, 'distances', 1), offs = rowsOf(disp, 'offsets', 3);
  const P = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const flat = lerp(lerp(c[0], c[1], y / (N - 1)), lerp(c[3], c[2], y / (N - 1)), x / (N - 1));
    let p = flat;
    if (normals && dist) p = add(p, mul(normals[y][x], dist[y][x][0]));
    if (offs) p = add(p, offs[y][x]);
    P.push({ p, flat });
  }
  const face = (i, j, k) => { // CCW relative to the plane normal
    const a = P[i].flat, bb = P[j].flat, cc = P[k].flat, n = cross(sub(bb, a), sub(cc, a));
    const tri = dot(n, side.n) >= 0 ? [i, j, k] : [i, k, j];
    emitTri(b, tri.map((q) => P[q].p), uvAxes); // uv from displaced position is fine for untextured/stretched use
  };
  for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) { const a = y * N + x, bb = a + 1, d = a + N, e = d + 1; face(a, bb, e); face(a, e, d); }
  return true;
}

// ---------- solids ----------
let brushCount = 0, dispCount = 0, skipped = 0;
function emitSolid(solid) {
  const sides = parseSides(solid);
  if (sides.length < 4) return;
  brushCount++;
  sides.forEach((side, i) => {
    if (SKIP.test(side.material) || !side.material) { skipped++; return; }
    const poly = sidePolygon(sides, i);
    if (poly.length < 3) return;
    const b = bucket(side.material), uvAxes = side.u && side.v ? [parseAxis(side.u), parseAxis(side.v)] : null;
    if (side.disp) { dispCount++; if (emitDisplacement(b, poly, side, uvAxes)) return; }
    // fan triangulation; the polygon is counter-clockwise seen from outside
    for (let k = 1; k < poly.length - 1; k++) emitTri(b, [poly[0], poly[k], poly[k + 1]], uvAxes);
  });
}

// ---------- props ----------
const rotation = ([pitch, yaw, roll]) => {
  const d = Math.PI / 180, sp = Math.sin(pitch * d), cp = Math.cos(pitch * d), sy = Math.sin(yaw * d), cy = Math.cos(yaw * d), sr = Math.sin(roll * d), cr = Math.cos(roll * d);
  return [[cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy], [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy], [-sp, sr * cp, cr * cp]];
};
const applyM = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const models = new Map();
let propsPlaced = 0; const propsMissing = new Set();
function emitProp(ent) {
  const model = (ent.props.get('model') ?? '').replace(/\\/g, '/').toLowerCase();
  if (!model.endsWith('.mdl')) return;
  if (!models.has(model)) { try { models.set(model, loadModel(modelBase(model), Number(ent.props.get('skin') ?? 0))); } catch { models.set(model, null); } }
  const m = models.get(model);
  if (!m) { propsMissing.add(model); return; }
  propsPlaced++;
  const o = nums(ent.props.get('origin') ?? '0 0 0'), M = rotation(nums(ent.props.get('angles') ?? '0 0 0'));
  for (const mesh of m.meshes) {
    const matName = ((mesh.cd[0] ?? '') + mesh.material).replace(/\\/g, '/').toLowerCase();
    const found = mesh.cd.map((c) => (c + mesh.material).replace(/\\/g, '/').toLowerCase()).find((n) => material(n)) ?? matName;
    const b = bucket('prop:' + found);
    b.name = 'prop:' + found; b.texW = b.texH = 1; // model UVs are already 0..1
    for (let i = 0; i < mesh.pos.length; i += 3) b.pos.push(...add(applyM(M, mesh.pos.slice(i, i + 3)), o));
    b.uv.push(...mesh.uv);
  }
}

// ---------- main ----------
export { parseVmf, parseSides, sidePolygon, emitSolid, emitProp, parts, SKIP };
if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
const [vmfFile, outFile] = process.argv.slice(2);
if (!vmfFile || !outFile) { console.log('usage: node tools/vmf-export.mjs <map.vmf> <out.glb>'); process.exit(1); }
const tree = parseVmf(fs.readFileSync(vmfFile, 'latin1'));
for (const node of tree.kids) {
  if (node.name === 'world') node.kids.filter((k) => k.name === 'solid').forEach(emitSolid);
  else if (node.name === 'entity') {
    const cls = node.props.get('classname') ?? '';
    if (/^prop_(static|dynamic|physics|detail)/.test(cls)) emitProp(node);
    else if (!/^(trigger_|func_buyzone|func_bomb_target|func_hostage_rescue|func_areaportal|func_occluder|func_clip|func_nav|func_precipitation)/.test(cls)) node.kids.filter((k) => k.name === 'solid').forEach(emitSolid);
  }
}
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
const r = writeGlb(path.resolve(outFile), { name: path.basename(vmfFile, '.vmf'), parts: [...parts.values()] });
const textured = [...parts.values()].filter((p) => p.material.png).length;
console.log(`${path.basename(vmfFile)}: ${brushCount} brushes (${dispCount} displacements), ${propsPlaced} props (${propsMissing.size} models not in content), ${r.tris} triangles, ${textured}/${r.parts} textured meshes, ${(r.bytes / 1e6).toFixed(1)} MB`);
}
