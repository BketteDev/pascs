// Builds a web map (public/maps/<name>/) from a decompiled Source map (.vmf), e.g. the CS:GO maps in reference/decompiled-csgo-maps.
// Usage: node tools/vmf-build.mjs <map.vmf> <name> [--mode wingman]
// A VMF has no compiled lighting and CS:GO textures are mostly absent from the CS:S content, so this build: bakes simple face-direction
// shading (top / sides / underside) into a tiny lightmap, replaces missing textures with a deterministic CS:S texture of the same family
// (wood/ plaster/ stone/ ...), takes collision from the brushes (player clips become player-only), and draws a radar from brush footprints.
import fs from 'fs';
import path from 'path';
import { parseVmf, parseSides, sidePolygon, emitSolid, emitProp, parts } from './vmf-export.mjs';
import { png, vtfToRgba } from './vtf.mjs';
import { cs2Texture } from './cs2tex.mjs';
import { addBspPak, CSGO, readGameFile } from './content.mjs';
import { writeSky } from './sky.mjs';

const [vmfFile, MAP] = process.argv.slice(2);
if (!vmfFile || !MAP) { console.log('usage: node tools/vmf-build.mjs <map.vmf> <name> [--mode wingman]'); process.exit(1); }
// the compiled map in the CS:GO install carries the map's own textures in its pak lump
if (fs.existsSync(`${CSGO}/maps/${MAP}.bsp`)) console.log(`${MAP}: ${addBspPak(`${CSGO}/maps/${MAP}.bsp`)} files from the CS:GO map's pak`);
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
const SOLID_ENTS = /^(func_detail|func_breakable|func_wall|func_brush)$/;
const solids = [...worldNode.kids.filter((k) => k.name === 'solid').map((s) => ({ s, ent: worldNode }))];
for (const e of ents) if (SOLID_ENTS.test(cls(e))) for (const s of e.kids.filter((k) => k.name === 'solid')) solids.push({ s, ent: e });
// The 3D-skybox scenery (distant city, hills) lives in the same VMF around sky_camera: leave it out, the picture is a plain sky.
const skyCam = ents.find((e) => cls(e) === 'sky_camera'), skyAt = skyCam ? vec(skyCam.props.get('origin')) : null;
const inSky = (c) => skyAt && Math.hypot(c[0] - skyAt[0], c[1] - skyAt[1]) < 7000;
const solidCentre = (s) => { const sd = parseSides(s), pts = sd.flatMap((_, i) => sidePolygon(sd, i) ?? []); return [0, 1, 2].map((a) => pts.reduce((m, p) => m + p[a], 0) / (pts.length || 1)); };
for (let i = solids.length - 1; i >= 0; i--) if (inSky(solidCentre(solids[i].s))) solids.splice(i, 1);
const dispTris = new Map(); // displacement brushes: their collision is the displaced triangles, not the flat brush
for (const { s } of solids) {
  const hasDisp = parseSides(s).some((x) => x.disp), before = hasDisp ? new Map([...parts].map(([k, v]) => [k, v.pos.length])) : null;
  emitSolid(s);
  if (hasDisp) {
    const tris = [];
    for (const [k, v] of parts) for (let i = before.get(k) ?? 0; i < v.pos.length; i += 9) tris.push(v.pos.slice(i, i + 9).map((c) => Math.round(c * 10) / 10));
    dispTris.set(s, tris);
  }
}
for (const e of ents) if (/^prop_(static|dynamic|physics|detail)/.test(cls(e)) && !inSky(vec(e.props.get('origin')))) emitProp(e);

// ---------- collision brushes ----------
const collision = [], playerOnly = [], skyBrushIdx = [], surfOf = [];
const surfaceOf = (m) => SURFACES.indexOf(/glass|window/.test(m) ? 'glass' : /wood/.test(m) ? 'wood' : /grass|blendgrass/.test(m) ? 'grass' : /sand/.test(m) ? 'sand' : /dirt|mud|gravel|nature/.test(m) ? 'gravel' : /metal/.test(m) ? 'metal' : /tile/.test(m) ? 'tile' : 'concrete');
const footprints = [];
let skippedBrushes = 0;
for (const { s } of solids) {
  if (dispTris.has(s)) { for (const t of dispTris.get(s)) { collision.push([Math.min(t[0], t[3], t[6]), Math.min(t[1], t[4], t[7]), Math.min(t[2], t[5], t[8]), Math.max(t[0], t[3], t[6]), Math.max(t[1], t[4], t[7]), Math.max(t[2], t[5], t[8]), ...t]); surfOf.push(SURFACES.indexOf('gravel')); } continue; }
  const sides = parseSides(s), mats = sides.map((x) => x.material ?? '');
  if (mats.some((m) => /toolsblockbullets|toolsskip|toolshint|toolsinvisible|toolstrigger|water/.test(m)) && !mats.some((m) => /toolsplayerclip|toolsclip|toolsskybox/.test(m)) && mats.every((m) => /^tools\/|water/.test(m))) { skippedBrushes++; continue; }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  sides.forEach((_, i) => { for (const p of sidePolygon(sides, i) ?? []) for (let a = 0; a < 3; a++) { lo[a] = Math.min(lo[a], p[a]); hi[a] = Math.max(hi[a], p[a]); } });
  if (!Number.isFinite(lo[0])) continue;
  const entry = [...lo, ...hi]; for (const sd of sides) entry.push(sd.n[0], sd.n[1], sd.n[2], sd.d);
  if (mats.some((m) => /toolsplayerclip|toolsclip/.test(m))) { playerOnly.push(entry); continue; }
  if (mats.some((m) => /toolsskybox/.test(m))) skyBrushIdx.push(collision.length);
  else footprints.push({ lo, hi });
  collision.push(entry); surfOf.push(surfaceOf(mats.find((m) => m && !/^tools\//.test(m)) ?? ''));
}

// ---------- materials: real texture if the content has it, else a sibling from the same family ----------
const hash = (name) => { let h = 2166136261; for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };
const vtfCache = new Map();
const readVtf = (file) => {
  if (!vtfCache.has(file)) { try { const { W, H, rgba } = vtfToRgba(fs.readFileSync(file)); const rgb = Buffer.alloc(W * H * 3); for (let i = 0; i < W * H; i++) rgba.copy(rgb, i * 3, i * 4, i * 4 + 3); vtfCache.set(file, { png: png(W, H, 3, rgb), w: W, h: H }); } catch { vtfCache.set(file, null); } }
  return vtfCache.get(file);
};
const FLAT = [[/water/, [60, 105, 125, 170]], [/glass|window/, [150, 185, 200, 70]], [/wood/, [128, 96, 64, 255]], [/plaster/, [208, 190, 156, 255]], [/stone|brick|rock/, [150, 138, 120, 255]], [/grass|nature|dirt|mud/, [92, 112, 70, 255]], [/metal/, [104, 106, 110, 255]], [/concrete/, [150, 148, 142, 255]]];
function standIn(name) {
  const cs2 = name.startsWith('prop:') ? null : cs2Texture(name); // the real texture from the Counter-Strike 2 install when it still ships it
  if (cs2) return { png: cs2.png, w: cs2.w, h: cs2.h, alpha: cs2.alpha > 0.02 && /glass|window|tree|leaf|fence|grate|wire|vine|foliage|plant|bush|grass|weed/.test(name) ? 'MASK' : 'OPAQUE', stand: true, real: true };
  const base = name.replace(/^prop:/, '').replace(/^maps\/[^/]+\//, ''), dir = path.dirname(base);
  if (!/water|glass|window/.test(base)) {
    try {
      const files = fs.readdirSync(path.join(ROOT, dir)).filter((f) => f.endsWith('.vtf') && !/_(ref|normal|bump|n|mask)\.|^inf(sky|tree)|sky|tool/.test(f)).sort();
      for (let k = 0; k < Math.min(files.length, 6); k++) { const t = readVtf(path.join(ROOT, dir, files[(hash(name) + k) % files.length])); if (t) return { ...t, alpha: 'OPAQUE', stand: true }; }
    } catch { /* folder missing */ }
  }
  const [r, g, b, a] = (FLAT.find(([re]) => re.test(base)) ?? [0, [150, 145, 135, 255]])[1], px = Buffer.alloc(64);
  for (let i = 0; i < 16; i++) px.set([r, g, b, a], i * 4);
  return { png: png(4, 4, 4, px), w: 512, h: 512, alpha: a < 255 ? 'BLEND' : 'OPAQUE', stand: false };
}

// ---------- groups -> bin ----------
const SHADES = [0.55, 0.47, 0.41, 0.28]; // lightmap value (x2 in the shader) for: up, +-x walls, +-y walls, down
const lm = Buffer.alloc(SHADES.length * 3); SHADES.forEach((v, i) => lm.fill(Math.round(v * 255), i * 3, i * 3 + 3));
fs.writeFileSync(path.join(OUT, 'lightmap.png'), png(SHADES.length, 1, 3, lm));
const bins = []; let binLen = 0, standIns = 0, textured = 0;
const push = (arr) => { const f = new Float32Array(arr); bins.push(Buffer.from(f.buffer)); const o = binLen; binLen += f.byteLength; return o; };
const groups = [];
for (const p of parts.values()) {
  if (!p.pos.length) continue;
  const isProp = p.name.startsWith('prop:');
  let tex = p.material.png ? { png: p.material.png, w: p.texW, h: p.texH, alpha: p.material.alpha, stand: false } : standIn(p.name);
  if (p.material.png || tex.real) textured++; else standIns++;
  const uv = isProp || !tex.stand ? p.uv : p.uv.map((v, i) => (v * 512) / (i % 2 ? tex.h : tex.w)); // stand-in textures are not 512 px: keep the world scale
  const lmuv = [];
  for (let i = 0; i < p.pos.length; i += 9) {
    const a = p.pos.slice(i, i + 3), b = p.pos.slice(i + 3, i + 6), c = p.pos.slice(i + 6, i + 9);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], n = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]], l = Math.hypot(...n) || 1;
    const idx = n[2] / l > 0.7 ? 0 : n[2] / l < -0.7 ? 3 : Math.abs(n[0]) > Math.abs(n[1]) ? 1 : 2;
    for (let k = 0; k < 3; k++) lmuv.push((idx + 0.5) / SHADES.length, 0.5);
  }
  const file = p.name.replace(/[\/\\:]/g, '__') + '.png';
  fs.writeFileSync(path.join(OUT, 'tex', file), tex.png);
  groups.push({ name: p.name, tex: file, alpha: { OPAQUE: 0, MASK: 1, BLEND: 2 }[tex.alpha] ?? 0, count: p.pos.length / 3, pos: push(p.pos), uv: push(uv), lm: push(lmuv) });
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
const sunEnt = ents.find((e) => cls(e) === 'light_environment');
const ang = vec(sunEnt?.props.get('angles') ?? '-45 296 0'), pitch = (Number(sunEnt?.props.get('pitch') ?? ang[0]) * Math.PI) / 180, yaw = (ang[1] * Math.PI) / 180;
const sunDir = [-Math.cos(-pitch) * Math.cos(yaw), -Math.cos(-pitch) * Math.sin(yaw), Math.sin(-pitch)];
const col = vec(sunEnt?.props.get('_light') ?? '255 240 220'), m = Math.max(...col.slice(0, 3));

// ---------- sky (the map's skybox if the content has it, else Dust2's) ----------
const skyName = worldNode.props.get('skyname') ?? '';
writeSky(skyName, OUT);

// ---------- radar: brush footprints from above (tall = walls, bright) ----------
const lo = [Infinity, Infinity], hi = [-Infinity, -Infinity];
for (const { lo: l, hi: h } of footprints) for (let a = 0; a < 2; a++) { lo[a] = Math.min(lo[a], l[a]); hi[a] = Math.max(hi[a], h[a]); }
const scale = Math.max(hi[0] - lo[0], hi[1] - lo[1]) / 980, pos_x = lo[0] - 20 * scale, pos_y = hi[1] + 20 * scale;
const img = Buffer.alloc(1024 * 1024 * 4);
for (const { lo: l, hi: h } of footprints.slice().sort((a, b) => a.hi[2] - b.hi[2])) {
  const x0 = Math.max(0, Math.floor((l[0] - pos_x) / scale)), x1 = Math.min(1023, Math.ceil((h[0] - pos_x) / scale)), y0 = Math.max(0, Math.floor((pos_y - h[1]) / scale)), y1 = Math.min(1023, Math.ceil((pos_y - l[1]) / scale));
  const v = h[2] - l[2] > 110 ? 230 : 120;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) img.set([v, v, v, 255], (y * 1024 + x) * 4);
}
fs.writeFileSync(path.join(OUT, 'overview.png'), png(1024, 1024, 4, img));

const modes = { wingman: { name: 'Wingman', teamSize: 2, roundTime: 90, sites: 1 } };
fs.writeFileSync(path.join(OUT, 'world.json'), JSON.stringify({
  groups, props: [], collision, playerOnly, sky: null, spawns: { ct: spawn('info_player_counterterrorist'), t: spawn('info_player_terrorist') },
  fog: null, skyFog: null, sun: null, light: { ambient: [0.32, 0.34, 0.38], direct: col.slice(0, 3).map((c) => (c / m) * 0.8), sunDir },
  skyBrushIdx, surfaces: SURFACES, surfOf, overview: { pos_x, pos_y, scale }, sites, mode: modes[mode] ?? null,
}));
console.log(`${MAP}: ${groups.length} materials (${textured} textured, ${standIns} stand-ins), ${collision.length} brushes + ${playerOnly.length} player clips (${skippedBrushes} bullet-only/non-solid skipped), ${sites.length} bombsites, spawns ${spawn('info_player_counterterrorist').length}/${spawn('info_player_terrorist').length}`);
