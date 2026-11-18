// Builds a web map (public/maps/<name>/) from a decompiled Source map (.vmf), e.g. the CS:GO maps in reference/decompiled-csgo-maps.
// Usage: node tools/vmf-build.mjs <map.vmf> <name> [--mode wingman]
// A VMF has no compiled lighting and CS:GO textures are mostly absent from the CS:S content, so this build: bakes simple face-direction
// shading (top / sides / underside) into a tiny lightmap, replaces missing textures with a deterministic CS:S texture of the same family
// (wood/ plaster/ stone/ ...), takes collision from the brushes (player clips become player-only), and draws a radar from brush footprints.
import fs from 'fs';
import path from 'path';
import { parseVmf, parseSides, sidePolygon, emitSolid, emitProp, parts } from './vmf-export.mjs';
import { loadPhy } from './mdl.mjs';
import { png, vtfToRgba } from './vtf.mjs';
import { cs2Texture } from './cs2tex.mjs';
import { addBspPak, CSGO, readGameFile } from './content.mjs';
import { writeSky } from './sky.mjs';
import { moverEntry } from '../public/movers.js';
import { makeWorld, trace } from '../public/physics.js';
import { loadOrBuildNav } from '../server/nav.mjs';
import { promoteMapWindows } from './promote-windows.mjs';

const [vmfFile, MAP] = process.argv.slice(2);
if (!vmfFile || !MAP) { console.log('usage: node tools/vmf-build.mjs <map.vmf> <name> [--mode wingman]'); process.exit(1); }
// the compiled map in the CS:GO install or local CS:S maps carries embedded textures/models in its pak lump
if (fs.existsSync(`${CSGO}/maps/${MAP}.bsp`)) console.log(`${MAP}: ${addBspPak(`${CSGO}/maps/${MAP}.bsp`)} files from the CS:GO map's pak`);
const cssMaps = path.resolve(import.meta.dirname, '..', '..', 'content', 'maps');
if (fs.existsSync(cssMaps)) {
  const bsps = fs.readdirSync(cssMaps).filter((f) => f.endsWith('.bsp')).sort((a, b) => (a === MAP + '.bsp' ? -1 : b === MAP + '.bsp' ? 1 : a.localeCompare(b)));
  for (const f of bsps) addBspPak(path.join(cssMaps, f));
}
const mode = process.argv.includes('--mode') ? process.argv[process.argv.indexOf('--mode') + 1] : null;
const ROOT = path.resolve(import.meta.dirname, '..', '..', 'content', 'css_content', 'materials');
const OUT = path.resolve(import.meta.dirname, '..', 'public', 'maps', MAP);
fs.mkdirSync(path.join(OUT, 'tex'), { recursive: true }); fs.mkdirSync(path.join(OUT, 'sky'), { recursive: true });
const SURFACES = ['concrete', 'sand', 'tile', 'wood', 'metal', 'gravel', 'grass', 'glass']; // same table as build.mjs
const tree = parseVmf(fs.readFileSync(vmfFile, 'latin1'));
const ents = tree.kids.filter((k) => k.name === 'entity'), worldNode = tree.kids.find((k) => k.name === 'world');
const cls = (e) => e.props.get('classname') ?? '';
const vec = (s) => (s ?? '0 0 0').trim().split(/\s+/).map(Number);

// ---------- visual geometry + props (shared with the GLB exporter) ----------
const SOLID_ENTS = /^(func_detail|func_wall|func_brush)$/;
const MOVER_DOORS = /^(func_door|func_door_rotating)$/;
const MOVER_BREAKABLES = /^(func_breakable|func_breakable_surf)$/;
const solids = [...worldNode.kids.filter((k) => k.name === 'solid').map((s) => ({ s, ent: worldNode, noCol: false }))];
for (const e of ents) {
  if (!SOLID_ENTS.test(cls(e))) continue;
  if (cls(e) === 'func_brush' && e.props.get('StartDisabled') === '1') continue; // e.g. disabled Wingman blockers
  const noCol = cls(e) === 'func_brush' && e.props.get('Solidity') === '1'; // Never Solid
  for (const s of e.kids.filter((k) => k.name === 'solid')) solids.push({ s, ent: e, noCol });
}
// The 3D-skybox scenery (distant city, hills) lives in the same VMF around sky_camera inside a sealed toolsskybox box: find that box in 3D so playable geometry nearby is never culled.
const skyCam = ents.find((e) => cls(e) === 'sky_camera'), skyAt = skyCam ? vec(skyCam.props.get('origin')) : null;
const solidBox = (s) => { const sd = parseSides(s), pts = sd.flatMap((_, i) => sidePolygon(sd, i) ?? []); if (!pts.length) return null; return { sd, lo: [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a]))), hi: [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a]))) }; };
const solidCentre = (s) => { const b = solidBox(s); return b ? [0, 1, 2].map((a) => (b.lo[a] + b.hi[a]) / 2) : [0, 0, 0]; };
const skyBounds = (() => {
  if (!skyAt) return null;
  let lo = [-Infinity, -Infinity, -Infinity], hi = [Infinity, Infinity, Infinity];
  for (const s of worldNode.kids.filter((k) => k.name === 'solid')) {
    const b = solidBox(s); if (!b || !b.sd.some((x) => /toolsskybox/i.test(x.material))) continue;
    const inXY = skyAt[0] >= b.lo[0] && skyAt[0] <= b.hi[0] && skyAt[1] >= b.lo[1] && skyAt[1] <= b.hi[1];
    const inXZ = skyAt[0] >= b.lo[0] && skyAt[0] <= b.hi[0] && skyAt[2] >= b.lo[2] && skyAt[2] <= b.hi[2];
    const inYZ = skyAt[1] >= b.lo[1] && skyAt[1] <= b.hi[1] && skyAt[2] >= b.lo[2] && skyAt[2] <= b.hi[2];
    if (inYZ && b.hi[0] < skyAt[0]) lo[0] = Math.max(lo[0], b.lo[0]); if (inYZ && b.lo[0] > skyAt[0]) hi[0] = Math.min(hi[0], b.hi[0]);
    if (inXZ && b.hi[1] < skyAt[1]) lo[1] = Math.max(lo[1], b.lo[1]); if (inXZ && b.lo[1] > skyAt[1]) hi[1] = Math.min(hi[1], b.hi[1]);
    if (inXY && b.hi[2] < skyAt[2]) lo[2] = Math.max(lo[2], b.lo[2]); if (inXY && b.lo[2] > skyAt[2]) hi[2] = Math.min(hi[2], b.hi[2]);
  }
  return { lo: lo.map((v, a) => (Number.isFinite(v) ? v - 64 : skyAt[a] - 1500)), hi: hi.map((v, a) => (Number.isFinite(v) ? v + 64 : skyAt[a] + 1500)) };
})();
const inSky = (c) => skyBounds && c[0] >= skyBounds.lo[0] && c[0] <= skyBounds.hi[0] && c[1] >= skyBounds.lo[1] && c[1] <= skyBounds.hi[1] && c[2] >= skyBounds.lo[2] && c[2] <= skyBounds.hi[2];
for (let i = solids.length - 1; i >= 0; i--) if (inSky(solidCentre(solids[i].s))) solids.splice(i, 1);
const sub3 = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const applyM3 = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const bounds3 = (pts) => [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a]))).concat([0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a]))));
// Same VBSP Minkowski bevel planes as build.mjs so box sweeps don't snag or protrude on angled corners.
function convexEntry(points, facePlanes, edgeList) {
  const planes = [...facePlanes];
  const add = (n, pts) => {
    const l = Math.hypot(...n); if (l < 1e-4) return;
    const u = n.map((v) => v / l), d = pts.map((p) => dot3(u, p));
    planes.push([...u, Math.max(...d)], [...u.map((v) => -v), -Math.min(...d)]);
  };
  for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
    add(ax, points);
    for (const [p, q] of edgeList) add(cross3(sub3(q, p), ax), points);
  }
  const seen = new Set(), flat = [];
  for (const pl of planes) { const k = pl.map((v) => Math.round(v * 500)).join(','); if (!seen.has(k)) { seen.add(k); flat.push(...pl); } }
  return [...bounds3(points), ...flat];
}
const phyCache = new Map();
const getPhy = (base) => {
  if (!phyCache.has(base)) {
    let p = null;
    if (fs.existsSync(base + '.phy')) { try { p = loadPhy(base + '.phy'); } catch { p = null; } }
    phyCache.set(base, p);
  }
  return phyCache.get(base);
};
const dispTris = new Map(); // displacement brushes: their collision is the displaced triangles, not the flat brush
for (const { s } of solids) {
  const sd = parseSides(s), dispSide = sd.find((x) => x.disp);
  const before = dispSide ? new Map([...parts].map(([k, v]) => [k, v.pos.length])) : null;
  emitSolid(s);
  if (dispSide) {
    const tris = [];
    for (const [k, v] of parts) for (let i = before.get(k) ?? 0; i < v.pos.length; i += 9) tris.push(v.pos.slice(i, i + 9).map((c) => Math.round(c * 10) / 10));
    dispTris.set(s, { tris, mat: dispSide.material ?? '' });
  }
}

// ---------- collision brushes + placed props ----------
const collision = [], playerOnly = [], skyBrushIdx = [], surfOf = [];
const surfaceOf = (m) => SURFACES.indexOf(/glass|window/.test(m) ? 'glass' : /wood|crate|plank|barrel/.test(m) ? 'wood' : /grass|blendgrass/.test(m) ? 'grass' : /sand/.test(m) ? 'sand' : /dirt|mud|gravel|nature/.test(m) ? 'gravel' : /metal/.test(m) ? 'metal' : /tile/.test(m) ? 'tile' : 'concrete');
const footprints = [];
let skippedBrushes = 0, propCols = 0;
for (const e of ents) {
  if (!/^prop_(static|dynamic|physics|detail)/.test(cls(e)) || inSky(vec(e.props.get('origin')))) continue;
  const placed = emitProp(e);
  if (!placed || !placed.solid) continue;
  const { m, model, base, o, M, scale = 1, solid } = placed;
  const place = (pts) => pts.map((q) => applyM3(M, scale === 1 ? q : q.map((v) => v * scale)).map((v, k) => v + o[k]));
  const phy = solid === 6 ? (m.phy ?? (base ? getPhy(base) : null)) : null;
  const surf = surfaceOf(model);
  if (phy?.length) {
    for (const piece of phy) {
      if (piece.points.length < 4) continue;
      const faces = piece.planes.map(([nx, ny, nz, d]) => { const n = applyM3(M, [nx, ny, nz]); return [...n, d * scale + dot3(n, o)]; });
      collision.push(convexEntry(place(piece.points), faces, piece.edges.map(([p, q]) => place([p, q])))); surfOf.push(surf); propCols++;
    }
  } else if (solid >= 2 && solid <= 4) {
    const l = m.hullMin.map((v) => v * scale), h = m.hullMax.map((v) => v * scale);
    const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((c) => [c & 1 ? h[0] : l[0], c & 2 ? h[1] : l[1], c & 4 ? h[2] : l[2]]);
    const edgePairs = []; for (let i = 0; i < 8; i++) for (let k = 0; k < 3; k++) if (!((i >> k) & 1)) edgePairs.push([corners[i], corners[i | (1 << k)]]);
    const faces = []; for (let a = 0; a < 3; a++) for (const sgn of [1, -1]) { const ax = [0, 0, 0]; ax[a] = sgn; const n = applyM3(M, ax); faces.push([...n, dot3(n, place([corners.find((c) => c[a] === (sgn > 0 ? h[a] : l[a]))])[0])]); }
    collision.push(convexEntry(place(corners), faces, edgePairs.map(([p, q]) => place([p, q])))); surfOf.push(surf); propCols++;
  }
}
for (const { s, noCol } of solids) {
  if (noCol) continue;
  if (dispTris.has(s)) {
    const { tris, mat } = dispTris.get(s), surf = surfaceOf(mat);
    for (const t of tris) {
      const a = [t[0], t[1], t[2]], b = [t[3], t[4], t[5]], c = [t[6], t[7], t[8]];
      if (Math.hypot(...cross3(sub3(b, a), sub3(c, a))) < 1e-3) continue;
      collision.push([Math.min(t[0], t[3], t[6]) - 16, Math.min(t[1], t[4], t[7]) - 16, Math.min(t[2], t[5], t[8]) - 16, Math.max(t[0], t[3], t[6]) + 16, Math.max(t[1], t[4], t[7]) + 16, Math.max(t[2], t[5], t[8]) + 16, ...t]);
      surfOf.push(surf);
    }
    continue;
  }
  const sd = parseSides(s), mats = sd.map((x) => x.material ?? '');
  if (sd.some((x) => x.n.some((v) => !Number.isFinite(v)))) continue;
  const allToolOrLiquid = mats.every((m) => !m || /^(?:tools\/|liquids\/|toolsnodraw)/.test(m) || /water/.test(m));
  if (allToolOrLiquid && !mats.some((m) => /toolsplayerclip|toolsclip|toolsskybox|toolsblack|toolswhite/.test(m))) { skippedBrushes++; continue; }
  const pts = [], edgeList = [], facePlanes = sd.map((x) => [...x.n, x.d]);
  for (let i = 0; i < sd.length; i++) {
    const poly = sidePolygon(sd, i);
    if (!poly || poly.length < 3) continue;
    for (let k = 0; k < poly.length; k++) { pts.push(poly[k]); edgeList.push([poly[k], poly[(k + 1) % poly.length]]); }
  }
  if (pts.length < 4) continue;
  const entry = convexEntry(pts, facePlanes, edgeList), lo = entry.slice(0, 3), hi = entry.slice(3, 6);
  if (mats.some((m) => /toolsplayerclip|toolsclip/.test(m))) { playerOnly.push(entry); continue; }
  if (mats.some((m) => /toolsskybox/.test(m))) skyBrushIdx.push(collision.length);
  else footprints.push({ lo, hi });
  collision.push(entry); surfOf.push(surfaceOf(mats.find((m) => m && !/^tools\//.test(m)) ?? ''));
}

// ---------- materials: real texture if the content has it, else a sibling from the same family ----------
const hash = (name) => { let h = 2166136261; for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const vtfCache = new Map();
const readVtf = (file) => {
  if (!vtfCache.has(file)) {
    try {
      const { W, H, rgba } = vtfToRgba(fs.readFileSync(file));
      let hasAlpha = false;
      const rgb = Buffer.alloc(W * H * 3);
      for (let i = 0; i < W * H; i++) { rgba.copy(rgb, i * 3, i * 4, i * 4 + 3); if (rgba[i * 4 + 3] < 245) hasAlpha = true; }
      vtfCache.set(file, { png: png(W, H, 3, rgb), w: W, h: H, hasAlpha });
    } catch { vtfCache.set(file, null); }
  }
  return vtfCache.get(file);
};
const SEE_THROUGH = /tree|leaf|fence|gate|grate|wire|vine|foliage|plant|bush|shrub|fern|ivy|grass|weed|palm|branch|frond|hedge|chainlink|rail|truss|grill|net|rungs|fanblade|decal|poster|card|stencil|curtain|lace/;
const gridPng = (rgbaA, rgbaB, fn) => {
  const N = 16, px = Buffer.alloc(N * N * 4);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) px.set(fn(x, y, N) ? rgbaA : rgbaB, (y * N + x) * 4);
  return { png: png(N, N, 4, px), w: 512, h: 512, alpha: 'MASK', stand: false };
};
const FLAT = [[/(?:^|\/)liquids\/|\bwater\b|water_/, [60, 105, 125, 170]], [/(?:^|\/)glass\/|glasswindow/, [150, 185, 200, 70]], [/bush|plant|shrub|foliage|tree|leaf|hedge|grass|nature|dirt|mud/, [78, 104, 58, 255]], [/wood/, [128, 96, 64, 255]], [/plaster|wallpaper/, [208, 190, 156, 255]], [/stone|brick|rock|cobble/, [150, 138, 120, 255]], [/metal/, [104, 106, 110, 255]], [/white\b/, [232, 228, 220, 255]], [/black\b/, [28, 28, 32, 255]], [/concrete/, [150, 148, 142, 255]]];
function standIn(name) {
  const isProp = name.startsWith('prop:'), clean = name.replace(/^prop:/, '').trim();
  let cs2 = cs2Texture(clean); // the real texture from the Counter-Strike 2 install when it still ships it
  if (!cs2) {
    try {
      const vmt = readGameFile('materials/' + clean + '.vmt')?.toString('latin1').toLowerCase().replace(/\\/g, '/');
      const vmtBase = vmt?.match(/"?\$basetexture"?\s+"?([^"\s]+)"?/)?.[1];
      if (vmtBase) cs2 = cs2Texture(vmtBase);
    } catch {}
  }
  const isWater = /(?:^|\/)liquids\/|\bwater\b|water_/.test(clean);
  const isGlass = /(?:^|\/)glass\/|glasswindow/.test(clean);
  if (cs2 && (!isGlass || cs2.alpha > 0.02)) {
    const alpha = cs2.alpha > 0.02 ? (isGlass ? 'BLEND' : (SEE_THROUGH.test(clean) || cs2.trans) ? 'MASK' : 'OPAQUE') : 'OPAQUE';
    return { png: cs2.png, w: cs2.w, h: cs2.h, alpha, stand: true, real: true };
  }
  const base = clean.replace(/^maps\/[^/]+\//, '');
  const isFoliage = /bush|plant|shrub|foliage|tree|leaf|hedge|fern|ivy|vine/.test(base);
  const isFence = /fence|gate|grate|chainlink|rail|truss|grill/.test(base);
  if (isFence) return gridPng([82, 86, 90, 255], [0, 0, 0, 0], (x, y) => ((x + y) % 8 === 0) || ((x - y + 16) % 8 === 0));
  if (isFoliage && (isProp || clean !== base)) return gridPng([74, 102, 52, 255], [0, 0, 0, 0], (x, y) => ((x * 5 + y * 3) % 7) < 3 && (x % 4 !== 0 || y % 4 !== 0));
  if (!isWater && !isGlass && !isFoliage && !/decal|sign|poster|graffiti|overlay/.test(base)) {
    const dirs = [path.dirname(base)];
    for (let d = path.dirname(dirs[0]); d && d !== '.'; d = path.dirname(d)) dirs.push(d);
    const cat = /brick/.test(base) ? 'brick' : /stone|cobble|flagstone|rock/.test(base) ? 'stone' : /plaster|stucco|wallpaper/.test(base) ? 'plaster' : /wood|plywood|plank/.test(base) ? 'wood' : /metal|steel|iron|corrugated/.test(base) ? 'metal' : /tile|marble/.test(base) ? 'tile' : /nature|dirt|sand|mud|grass|ground/.test(base) ? 'nature' : /concrete|asphalt|cinder|cement|floor/.test(base) ? 'concrete' : null;
    if (cat && !dirs.includes(cat)) dirs.push(cat);
    for (const dir of dirs) {
      if (dir === 'models' || dir.startsWith('models/')) continue; // prop UV sheets never tile cleanly on mismatched meshes
      try {
        const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.vtf') && !/_(ref|normal|bump|n|mask|height)\.|^inf(sky|tree)|^mil(?:ground|mountain|tree|barn|hole|roof|wndw|wall|beams|door)|^prod(?:grate|rail|vent|door)|sky|tool|curbred|caution|hazard|parking|sign|decal|poster|graffiti|arrow|grate|rail|fence|gate|hole|wndw|window|door|trim|steps|stairs|ibeam|truss|water/i.test(f)).sort();
        for (let k = 0; k < files.length; k++) {
          const t = readVtf(path.join(ROOT, dir, files[(hash(name) + k) % files.length]));
          if (t && !t.hasAlpha && t.w >= 128 && t.h >= 128 && t.w <= t.h * 1.5 && t.h <= t.w * 1.5) return { ...t, alpha: 'OPAQUE', stand: true };
        }
      } catch { /* folder missing */ }
    }
  }
  const [r, g, b, a] = (FLAT.find(([re]) => re.test(base)) ?? [0, [150, 145, 135, 255]])[1], px = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) px.set([r, g, b, a], i * 4);
  return { png: png(4, 4, 4, px), w: 512, h: 512, alpha: a < 255 ? 'BLEND' : 'OPAQUE', stand: false };
}

// ---------- groups + movers -> bin ----------
const SHADES = [0.55, 0.47, 0.41, 0.28]; // lightmap value (x2 in the shader) for: up, +-x walls, +-y walls, down
const lm = Buffer.alloc(SHADES.length * 3); SHADES.forEach((v, i) => lm.fill(Math.round(v * 255), i * 3, i * 3 + 3));
fs.writeFileSync(path.join(OUT, 'lightmap.png'), png(SHADES.length, 1, 3, lm));
const bins = []; let binLen = 0, standIns = 0, textured = 0;
const push = (arr) => { const f = new Float32Array(arr); bins.push(Buffer.from(f.buffer)); const o = binLen; binLen += f.byteLength; return o; };
function packParts(srcParts) {
  const out = [];
  for (const p of srcParts.values()) {
    if (!p.pos.length) continue;
    const isProp = p.name.startsWith('prop:');
    const tex = p.material.png ? { png: p.material.png, w: p.texW, h: p.texH, alpha: p.material.alpha, stand: false } : standIn(p.name);
    if (p.material.png || tex.real) textured++; else standIns++;
    const uv = isProp || !tex.stand ? p.uv : p.uv.map((v, i) => (v * 512) / (i % 2 ? tex.h : tex.w));
    const lmuv = [];
    for (let i = 0; i < p.pos.length; i += 9) {
      const a = p.pos.slice(i, i + 3), b = p.pos.slice(i + 3, i + 6), c = p.pos.slice(i + 6, i + 9);
      const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
      const idx = n[2] / l > 0.7 ? 0 : n[2] / l < -0.7 ? 3 : Math.abs(n[0]) > Math.abs(n[1]) ? 1 : 2;
      for (let k = 0; k < 3; k++) lmuv.push((idx + 0.5) / SHADES.length, 0.5);
    }
    const file = p.name.trim().replace(/[\/\\:]/g, '__') + '.png';
    fs.writeFileSync(path.join(OUT, 'tex', file), tex.png);
    out.push({ name: p.name.trim(), tex: file, alpha: { OPAQUE: 0, MASK: 1, BLEND: 2 }[tex.alpha] ?? 0, count: p.pos.length / 3, pos: push(p.pos), uv: push(uv), lm: push(lmuv) });
  }
  return out;
}
const groups = packParts(parts);

// Movers: breakable windows/objects + func_door* entities (ignoring invisible tool-only entities such as Mirage's covered vent)
const movers = [];
for (const e of ents) {
  const c = cls(e);
  if (!MOVER_DOORS.test(c) && !MOVER_BREAKABLES.test(c)) continue;
  const eSolids = e.kids.filter((k) => k.name === 'solid' && !inSky(solidCentre(k)));
  if (!eSolids.length) continue;
  const allMats = eSolids.flatMap((s) => parseSides(s).map((sd) => sd.material ?? '').filter((m) => m && !/^(tools\/|toolsnodraw)/i.test(m)));
  if (!allMats.length) continue; // e.g. Mirage invisible brush paired with missing CS:GO prop_dynamic vent
  const door = MOVER_DOORS.test(c), flags = Number(e.props.get('spawnflags') ?? 0), pivot = vec(e.props.get('origin'));
  const def = { cls: c, name: e.props.get('targetname') ?? '', slave: e.props.get('slavename') ?? '', parentName: e.props.get('parentname') ?? '', pivot, pieces: [], entries: [], groups: [], props: [] };
  let surface = 'wood';
  if (door) {
    def.kind = 'door'; def.locked = !!(flags & 2048); def.use = !!(flags & (256 | 1024));
    def.speed = Number(e.props.get('speed') ?? 100) || 100;
    if (c === 'func_door') {
      const [pt, yw] = vec(e.props.get('movedir')).map((a) => (a * Math.PI) / 180);
      def.slide = [Math.cos(pt) * Math.cos(yw), Math.cos(pt) * Math.sin(yw), -Math.sin(pt)];
    } else {
      def.dist = Number(e.props.get('distance') ?? 90) || 90;
      def.oneWay = flags & 16 ? (flags & 2 ? -1 : 1) : 0;
    }
    surface = allMats.some((m) => /metal/.test(m)) ? 'metal' : 'wood';
  } else {
    def.kind = 'break'; def.breakable = true;
    def.glass = c === 'func_breakable_surf' || Number(e.props.get('material') ?? 0) === 0 || allMats.some((m) => /glass|window/.test(m));
    def.health = def.glass ? 1 : Math.max(1, Number(e.props.get('health') ?? 1) || 1);
    surface = def.glass ? 'glass' : ['glass', 'wood', 'metal', 'concrete', 'concrete', 'concrete', 'concrete', 'concrete'][Number(e.props.get('material'))] ?? 'wood';
  }
  def.surface = surface;
  if (Number(e.props.get('rendermode') ?? 0) && Number(e.props.get('renderamt') ?? 255) < 255) def.opacity = Number(e.props.get('renderamt')) / 255;
  parts.clear();
  for (const s of eSolids) {
    emitSolid(s);
    const sd = parseSides(s), pts = sd.flatMap((_, i) => sidePolygon(sd, i) ?? []);
    if (pts.length) def.pieces.push({ pts, planes: sd.map((x) => [...x.n, x.d]) });
  }
  if (!def.pieces.length) continue;
  def.groups = packParts(parts);
  const all = def.pieces.flatMap((pc) => pc.pts), lo = [0, 1, 2].map((k) => Math.min(...all.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...all.map((p) => p[k])));
  if (door && def.slide) def.dist = Math.max(Math.abs(def.slide[0] * (hi[0] - lo[0]) + def.slide[1] * (hi[1] - lo[1]) + def.slide[2] * (hi[2] - lo[2])) - Number(e.props.get('lip') ?? 0), 0);
  const reach = [];
  if (door && !def.slide) for (let a = -def.dist; a <= def.dist + 0.01; a += Math.max(def.dist / 12, 1)) { const r = (a * Math.PI) / 180, cs = Math.cos(r), sn = Math.sin(r); for (const p of all) { const x = p[0] - pivot[0], y = p[1] - pivot[1]; reach.push([pivot[0] + x * cs - y * sn, pivot[1] + x * sn + y * cs, p[2]]); } }
  else if (door) for (const p of all) reach.push(p, p.map((v, k) => v + def.slide[k] * def.dist));
  else reach.push(...all);
  const swept = [...[0, 1, 2].map((k) => Math.min(...reach.map((p) => p[k]))), ...[0, 1, 2].map((k) => Math.max(...reach.map((p) => p[k])))];
  for (const pc of def.pieces) { const en = Array.from(moverEntry(pc, (q) => q, (q) => q)); en.splice(0, 6, ...swept); def.entries.push(collision.length); collision.push(en); surfOf.push(SURFACES.indexOf(surface)); }
  def.center = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2);
  movers.push(def);
}
for (const m of movers) {
  const parent = m.kind === 'door' || !m.parentName ? -1 : movers.findIndex((d) => d.kind === 'door' && !d.slide && d.name === m.parentName);
  if (parent >= 0) m.parent = parent;
}
fs.writeFileSync(path.join(OUT, 'world.bin'), Buffer.concat(bins));

// ---------- spawns, bombsites, sun ----------
const spawn = (c) => ents.filter((e) => cls(e) === c).map((e) => ({ o: vec(e.props.get('origin')), yaw: vec(e.props.get('angles'))[1] }));
const sites = ents.filter((e) => cls(e) === 'func_bomb_target').map((e) => {
  const pts = e.kids.filter((k) => k.name === 'solid').flatMap((s) => { const sd = parseSides(s); return sd.flatMap((_, i) => sidePolygon(sd, i) ?? []); });
  const c = [0, 1, 2].map((a) => pts.reduce((m, p) => m + p[a], 0) / (pts.length || 1));
  const lo = [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a]))), hi = [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a])));
  return { name: e.props.get('targetname') ?? '', o: c, min: lo, max: hi };
}).sort((a, b) => a.o[0] - b.o[0]);
const hostages = ents.filter((e) => cls(e) === 'hostage_entity' || cls(e) === 'info_hostage_spawn').map((e) => ({ o: vec(e.props.get('origin')), yaw: vec(e.props.get('angles'))[1] }));
const rescue = [
  ...ents.filter((e) => cls(e) === 'func_hostage_rescue').map((e) => {
    const pts = e.kids.filter((k) => k.name === 'solid').flatMap((s) => { const sd = parseSides(s); return sd.flatMap((_, i) => sidePolygon(sd, i) ?? []); });
    return { min: [0, 1, 2].map((a) => Math.min(...pts.map((p) => p[a]))), max: [0, 1, 2].map((a) => Math.max(...pts.map((p) => p[a]))) };
  }),
  ...ents.filter((e) => cls(e) === 'info_hostage_rescue').map((e) => { const o = vec(e.props.get('origin')); return { min: [o[0] - 128, o[1] - 128, o[2] - 64], max: [o[0] + 128, o[1] + 128, o[2] + 128] }; }),
];
const sunEnt = ents.find((e) => cls(e) === 'light_environment');
const ang = vec(sunEnt?.props.get('angles') ?? '-45 296 0'), pitch = (Number(sunEnt?.props.get('pitch') ?? ang[0]) * Math.PI) / 180, yaw = (ang[1] * Math.PI) / 180;
const sunDir = [-Math.cos(-pitch) * Math.cos(yaw), -Math.cos(-pitch) * Math.sin(yaw), Math.sin(-pitch)];
const col = vec(sunEnt?.props.get('_light') ?? '255 240 220'), m = Math.max(...col.slice(0, 3)) || 1;

// ---------- sky (the map's skybox if the content has it, else a matching daylight CS:S sky) ----------
const rawSky = (worldNode.props.get('skyname') ?? '').trim();
const skyName = readGameFile(`materials/skybox/${rawSky}ft.vmt`) ? rawSky
  : /dust|mirage/.test(MAP + rawSky) ? 'sky_dust'
  : /cbble|daylight03/.test(MAP + rawSky) ? 'de_cobble'
  : /train|nuke/.test(MAP + rawSky) ? 'train' : 'militia_hdr';
writeSky(skyName, OUT);

const modes = { wingman: { name: 'Wingman', teamSize: 2, roundTime: 90, sites: 1 } };
const spans = { ct: spawn('info_player_counterterrorist'), t: spawn('info_player_terrorist') };
const worldJson = {
  game: 'csgo', sites, hostages, rescue, hurt: [], ambience: { zones: [], scapes: {}, ambients: [] },
  groups, props: [], collision, playerOnly, movers, sky: null, spawns: spans,
  fog: null, skyFog: null, sun: null, light: { ambient: [0.32, 0.34, 0.38], direct: col.slice(0, 3).map((c) => (c / m) * 0.8), sunDir },
  skyBrushIdx, surfaces: SURFACES, surfOf, overview: { pos_x: 0, pos_y: 0, scale: 1 }, mode: modes[mode] ?? null,
};

// ---------- pre-build nav graph + walkable architectural radar ----------
const navWorld = makeWorld(collision.concat(playerOnly));
const doorEntries = movers.filter((mv) => (mv.kind === 'door' && !mv.locked) || (mv.breakable && mv.glass)).flatMap((mv) => mv.entries);
for (const idx of doorEntries) navWorld.entries[idx] = Float32Array.from([1e9, 1e9, 1e9, -1e9, -1e9, -1e9]);
const allSpawns = [...spans.ct, ...spans.t, ...hostages].map((s, idx) => {
  let start = s.o, clear = false;
  for (const lift of [0, 16, 32, 64, 96, 128]) { start = [s.o[0], s.o[1], s.o[2] + lift]; if (!trace(navWorld, start, start, [-16, -16, 0], [16, 16, 62]).startSolid) { clear = true; break; } }
  if (!clear) throw new Error(`${MAP} spawn #${idx} trapped startSolid at ${s.o.join(',')}`);
  const r = trace(navWorld, start, [start[0], start[1], start[2] - 400], [-16, -16, 0], [16, 16, 62]);
  return { o: [s.o[0], s.o[1], r.end[2] + 0.5], yaw: (s.yaw * Math.PI) / 180 };
});
fs.rmSync(path.join(OUT, 'nav.json'), { force: true });
const nav = loadOrBuildNav(navWorld, allSpawns, OUT);
const navPts = nav.nodes.length ? nav.nodes.map((n) => n.o) : allSpawns.map((s) => s.o);
const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
let minZ = Infinity, maxZ = -Infinity;
for (const p of navPts) { lo[0] = Math.min(lo[0], p[0]); lo[1] = Math.min(lo[1], p[1]); hi[0] = Math.max(hi[0], p[0]); hi[1] = Math.max(hi[1], p[1]); minZ = Math.min(minZ, p[2]); maxZ = Math.max(maxZ, p[2]); }
const scale = Math.max(hi[0] - lo[0], hi[1] - lo[1], 1) / 920, pos_x = lo[0] - 52 * scale, pos_y = hi[1] + 52 * scale;
const img = Buffer.alloc(1024 * 1024 * 4);
const paintRect = (x0, y0, x1, y1, rgba) => { for (let y = Math.max(0, y0); y <= Math.min(1023, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(1023, x1); x++) img.set(rgba, (y * 1024 + x) * 4); };
const rBorder = Math.max(2, Math.ceil(28 / scale) + 2), rWalk = Math.max(1, Math.ceil(22 / scale));
for (const p of navPts) { const cx = Math.round((p[0] - pos_x) / scale), cy = Math.round((pos_y - p[1]) / scale); paintRect(cx - rBorder, cy - rBorder, cx + rBorder, cy + rBorder, [34, 34, 34, 255]); }
for (const p of navPts.slice().sort((a, b) => a[2] - b[2])) {
  const cx = Math.round((p[0] - pos_x) / scale), cy = Math.round((pos_y - p[1]) / scale), t = Math.max(0, Math.min(1, (p[2] - minZ) / Math.max(1, maxZ - minZ)));
  paintRect(cx - rWalk, cy - rWalk, cx + rWalk, cy + rWalk, [Math.round(160 + t * 55), Math.round(154 + t * 50), Math.round(138 + t * 44), 255]);
}
for (const { lo: l, hi: h } of footprints) {
  if (h[2] - l[2] <= 55 || h[0] - l[0] > 380 || h[1] - l[1] > 380 || l[2] > maxZ + 80 || h[2] < minZ - 40) continue;
  paintRect(Math.floor((l[0] - pos_x) / scale), Math.floor((pos_y - h[1]) / scale), Math.ceil((h[0] - pos_x) / scale), Math.ceil((pos_y - l[1]) / scale), [62, 60, 56, 255]);
}
for (const [zones, colBox] of [[sites, [220, 60, 50, 230]], [rescue, [60, 195, 95, 230]]]) {
  for (const z of zones) {
    const x0 = Math.floor((z.min[0] - pos_x) / scale), x1 = Math.ceil((z.max[0] - pos_x) / scale), y0 = Math.floor((pos_y - z.max[1]) / scale), y1 = Math.ceil((pos_y - z.min[1]) / scale);
    paintRect(x0, y0, x1, y0 + 2, colBox); paintRect(x0, y1 - 2, x1, y1, colBox); paintRect(x0, y0, x0 + 2, y1, colBox); paintRect(x1 - 2, y0, x1, y1, colBox);
  }
}
fs.writeFileSync(path.join(OUT, 'overview.png'), png(1024, 1024, 4, img));
worldJson.overview = { pos_x, pos_y, scale };
fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify(worldJson));
const winRes = promoteMapWindows(MAP);
console.log(`${MAP}: ${groups.length} materials (${textured} textured, ${standIns} stand-ins), ${collision.length} brushes (${propCols} prop cols) + ${playerOnly.length} player clips (${skippedBrushes} tool/non-solid skipped), ${sites.length} bombsites, ${hostages.length} hostages, ${movers.length} movers (+${winRes.addedMovers} promoted windows), ${nav.nodes.length} nav nodes, spawns ${spans.ct.length}/${spans.t.length}`);
