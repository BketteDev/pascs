// Converts CS:S player models (+ third-person rifles) and their layered animations into web assets: public/players/*.
// Usage: node tools/players.mjs
//
// CS:S animates players by layering: a lower-body sequence (Idle_lower / Run_lower blend) under an upper-body weapon pose
// (Idle_Upper_<WEAPON>) mixed per bone by that sequence's weight list. We bake those composites to per-frame local
// bone transforms keyed by bone name, so every model (whose bone order differs slightly) can play them.
import fs from 'fs';
import path from 'path';
import { loadModel, loadSkeleton } from './mdl.mjs';
import { png, vtfToRgba } from './vtf.mjs';
import { WEAPONS } from '../public/weapon-defs.js';
import { readGameFile } from './content.mjs';

const CONTENT = path.resolve(import.meta.dirname, '..', '..', 'content', 'css_content');
const OUT = path.resolve(import.meta.dirname, '..', 'public', 'players');
fs.mkdirSync(path.join(OUT, 'tex'), { recursive: true });
const MODELS = { ct: ['ct_gign', 'ct_gsg9', 'ct_sas', 'ct_urban'], t: ['t_arctic', 't_guerilla', 't_leet', 't_phoenix'], h: ['hostage_01', 'hostage_02', 'hostage_03', 'hostage_04'] }; // h: hostages (models/characters)

// ---------- textures ----------
const readVmt = (name) => {
  const f = path.join(CONTENT, 'materials', name + '.vmt');
  if (!fs.existsSync(f)) return null;
  const t = fs.readFileSync(f, 'latin1').toLowerCase().replace(/\\/g, '/');
  const get = (k) => t.match(new RegExp('"?\\$' + k + '"?\\s+"?([^"\\s]+)"?'))?.[1];
  return { base: get('basetexture'), alphatest: get('alphatest') === '1', translucent: get('translucent') === '1' };
};
const texCache = new Map();
function texture(cdDirs, material) {
  for (const cd of cdDirs) {
    const name = (cd + material).replace(/\\/g, '/').toLowerCase();
    if (texCache.has(name)) return texCache.get(name);
    const vmt = readVmt(name), vtf = vmt?.base && path.join(CONTENT, 'materials', vmt.base + '.vtf');
    if (!vtf || !fs.existsSync(vtf)) continue;
    const { W, H, rgba } = vtfToRgba(fs.readFileSync(vtf));
    const alpha = vmt.alphatest ? 1 : vmt.translucent ? 2 : 0;
    let data = rgba, ch = 4;
    if (!alpha) { ch = 3; data = Buffer.alloc(W * H * 3); for (let i = 0; i < W * H; i++) rgba.copy(data, i * 3, i * 4, i * 4 + 3); }
    const file = name.replace(/\//g, '__') + '.png';
    fs.writeFileSync(path.join(OUT, 'tex', file), png(W, H, ch, data));
    texCache.set(name, { tex: file, alpha });
    return texCache.get(name);
  }
  console.log('untextured', material);
  return { tex: null, alpha: 0 };
}

const bins = []; let binLen = 0;
const pushF32 = (arr) => { const a = new Float32Array(arr), off = binLen; bins.push(Buffer.from(a.buffer)); binLen += a.byteLength; return off; };
const meshesOf = (m) => m.meshes.map((mesh) => {
  const e = { material: mesh.material, ...texture(mesh.cd, mesh.material), count: mesh.pos.length / 3 };
  for (const k of ['pos', 'nrm', 'uv', 'bw', 'bi']) e[k] = pushF32(mesh[k]);
  return e;
});
const skeletonOf = (sk) => sk.bones.map((b) => ({ name: b.name, parent: b.parent, pos: b.pos, quat: b.quat, poseToBone: b.poseToBone }));

// ---------- animations ----------
const shared = loadSkeleton(path.join(CONTENT, 'models', 'player', 'cs_player_shared.mdl'));
const akAnims = loadSkeleton(path.join(CONTENT, 'models', 'player', 'ak_anims_t.mdl'));
const BONES = shared.bones.map((b) => b.name); // canonical bone list for baked animation data
const seqOf = (sk, name) => { const q = sk.sequences.find((x) => x.name.toLowerCase() === name.toLowerCase()); if (!q) throw new Error('missing sequence ' + name); return q; };
const blendOf = (sk, q, values) => { // pick the blend nearest the given pose-parameter values (e.g. move_x = 1 for running forward)
  if (q.blends.length <= 1) return sk.anims[q.anim];
  const idx = q.param.map((p, k) => { const pp = sk.poseParams[p], v = values[pp.name] ?? 0, n = q.group[k]; return Math.round(((v - pp.start) / (pp.end - pp.start)) * (n - 1)); });
  return sk.anims[q.blends[idx[0] + idx[1] * q.group[0]]];
};
const slerp = (a, b, t) => {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3], s = 1;
  if (d < 0) { d = -d; s = -1; }
  if (d > 0.9995) { const r = a.map((v, i) => v + (s * b[i] - v) * t), l = Math.hypot(...r); return r.map((v) => v / l); }
  const th = Math.acos(d), w0 = Math.sin((1 - t) * th) / Math.sin(th), w1 = Math.sin(t * th) / Math.sin(th);
  return a.map((v, i) => v * w0 + s * b[i] * w1);
};
// local pose of one source skeleton, re-keyed to the canonical bones by name
const keyed = (sk, anim, frame) => {
  const p = sk.pose(anim, Math.min(frame, anim.frames - 1)), byName = new Map(sk.bones.map((b, i) => [b.name, p[i]]));
  return BONES.map((n, i) => byName.get(n) ?? (anim.delta ? { pos: [0, 0, 0], quat: [0, 0, 0, 1] } : { pos: shared.bones[i].pos, quat: shared.bones[i].quat }));
};
function bake(name, lower, upper, opts = {}) {
  const [lsk, lq] = lower, la = blendOf(lsk, lq, opts.lowerParams ?? {});
  const frames = la.frames, data = [];
  let ua = null, weights = null;
  if (upper) {
    const [usk, uq] = upper; ua = [usk, blendOf(usk, uq, {})];
    const wByName = new Map(usk.bones.map((b, i) => [b.name, uq.weights ? uq.weights[i] : 1]));
    weights = BONES.map((n) => wByName.get(n) ?? 0);
  }
  for (let f = 0; f < frames; f++) {
    const base = keyed(lsk, la, f), top = ua && keyed(ua[0], ua[1], opts.upperStill ? 0 : ua[1].loop ? f % ua[1].frames : f);
    BONES.forEach((_, i) => {
      let { pos, quat } = base[i];
      if (top && weights[i] > 0) { const w = weights[i]; pos = pos.map((v, k) => v + (top[i].pos[k] - v) * w); quat = slerp(quat, top[i].quat, w); }
      data.push(...pos, ...quat);
    });
  }
  return { name, fps: la.fps, frames, loop: opts.loop ?? la.loop, data: pushF32(data) };
}
const S = (n) => [shared, seqOf(shared, n)], AK = (n) => [akAnims, seqOf(akAnims, n)];
const DIRS = { f: { move_x: 1, move_y: 0 }, b: { move_x: -1, move_y: 0 }, l: { move_x: 0, move_y: 1 }, r: { move_x: 0, move_y: -1 } }; // move_y +1 = strafing left
// Lower body (legs) and upper body (how the weapon is held) are baked separately and layered at runtime by the upper pose's bone
// weights, so any weapon's pose rides on any movement: anims = lower body only; uppers[CLASS] = standing + crouched pose of that class.
const anims = [];
anims.push(bake('idle', S('Idle_lower'), null, { loop: true }));
anims.push(bake('cidle', S('Crouch_Idle_Lower'), null, { loop: true }));
anims.push(bake('jump', S('Jump'), null, { loop: false }));
for (const [gait, lower] of [['run', 'Run_lower'], ['walk', 'walk_lower'], ['cwalk', 'Crouch_walk_lower']])
  for (const [d, params] of Object.entries(DIRS)) anims.push(bake(`${gait}_${d}`, S(lower), null, { lowerParams: params, loop: true }));
// Upper body, as CS:S builds it: <State>_Upper_<CLASS> over the legs (by its bone weights), then its autolayers in order: the body
// offset (delta), the hand position (override), the aim matrix (delta, 3x3 over body_yaw x body_pitch). Each layer is baked as a still
// pose + its bone weights and stacked at runtime (players.js), the aim as three body_pitch rows (-90, 0, 90) picked by where the player
// looks. shoot: the fire gesture (a delta clip), standing and crouched.
const STATES = { idle: 'Idle_Upper_', crouch: 'Crouch_Idle_Upper_', walk: 'Walk_Upper_', run: 'Run_Upper_', cwalk: 'Crouch_Walk_Upper_' };
const r3 = (v) => Math.round(v * 1000) / 1000;
const weightsOf = (usk, q) => { const by = new Map(usk.bones.map((b, i) => [b.name, q.weights ? q.weights[i] : 1])); return BONES.map((n) => r3(by.get(n) ?? 0)); };
const stillOf = (usk, anim) => pushF32(keyed(usk, anim, 0).flatMap((b) => [...b.pos, ...b.quat]));
function layerOf(usk, q) {
  const add = !!(q.flags & 4), w = weightsOf(usk, q); // STUDIO_DELTA: added on top (all of these are also STUDIO_POST: q = q * delta)
  if (q.blends.length === 9) return { add, w, rows: [-90, 0, 90].map((v) => stillOf(usk, blendOf(usk, q, { body_yaw: 0, body_pitch: v }))) };
  return { add, w, pose: stillOf(usk, blendOf(usk, q, {})) };
}
const uppers = {};
for (const cls of new Set(Object.values(WEAPONS).map((w) => w.upper).filter(Boolean))) {
  const usk = cls === 'AK' ? akAnims : shared, find = (n) => usk.sequences.find((x) => x.name.toLowerCase() === n.toLowerCase());
  const u = {};
  for (const [state, prefix] of Object.entries(STATES)) {
    const main = find(prefix + cls) ?? (state === 'cwalk' ? find(STATES.crouch + cls) : find(STATES.idle + cls));
    if (!main) continue;
    u[state] = [layerOf(usk, main), ...main.autolayers.map((l) => usk.sequences[l.seq]).filter(Boolean).map((q) => layerOf(usk, q))];
  }
  if (!u.idle) { console.log('no upper pose for', cls); continue; }
  for (const [k, n] of [['shoot', 'Idle_Shoot_'], ['cshoot', 'Crouch_Idle_Shoot_']]) {
    const q = find(n + cls) ?? find(n + cls + '_R');
    if (!q) continue;
    const an = usk.anims[q.anim];
    u[k] = { fps: an.fps, frames: an.frames, w: weightsOf(usk, q), data: pushF32(Array.from({ length: an.frames }, (_, f) => keyed(usk, an, f).flatMap((b) => [...b.pos, ...b.quat])).flat()) };
  }
  uppers[cls] = u;
}

// ---------- models ----------
const models = {};
for (const [team, list] of Object.entries(MODELS)) for (const name of list) {
  const file = path.join(CONTENT, 'models', team === 'h' ? 'characters' : 'player', name);
  const sk = loadSkeleton(file + '.mdl');
  models[name] = { team, meshes: meshesOf(loadModel(file)), bones: skeletonOf(sk), hitboxes: sk.hitboxes };
}
const weapons = {}; // every weapon's world model, bone-merged into the player's hand at runtime
for (const [key, def] of Object.entries(WEAPONS)) {
  if (!def.model) continue;
  const file = path.join(CONTENT, 'models', 'weapons', def.model.replace(/^v_/, 'w_'));
  weapons[key] = { meshes: meshesOf(loadModel(file)), bones: skeletonOf(loadSkeleton(file + '.mdl')) };
}
fs.writeFileSync(path.join(OUT, 'players.bin'), Buffer.concat(bins));
fs.writeFileSync(path.join(OUT, 'players.json'), JSON.stringify({ bones: BONES, anims, uppers, models, weapons }));

// sounds used on hits / deaths
const FOOTSTEPS = ['sand', 'dirt', 'tile', 'wood', 'metal', 'concrete', 'gravel', 'grass'].flatMap((m) => [1, 2, 3, 4].map((i) => `player/footsteps/${m}${i}`));
for (const s of [...FOOTSTEPS, 'player/headshot1', 'player/headshot2', 'player/bhit_helmet-1', 'player/kevlar1', 'player/kevlar2', 'player/kevlar3', 'radio/ctwin', 'radio/terwin', 'player/kevlar4', 'player/kevlar5', 'player/damage1', 'player/damage2', 'player/damage3', 'player/death1', 'player/death2', 'player/death3', 'player/death4', 'player/death5', 'player/death6',
  'radio/rescued', 'radio/hostagecompromised', 'radio/go', 'radio/letsgo', 'radio/locknload', 'radio/moveout', 'doors/default_move', 'doors/door_wood_close1', 'physics/glass/glass_sheet_break1', 'physics/glass/glass_sheet_break2', 'physics/wood/wood_plank_break1', ...['getouttahere', 'illfollow', 'letsdoit', 'letsgo'].map((n) => 'hostage/huse/' + n),
  ...['comeback', 'dontleaveme', 'illstayhere', 'notleaveme', 'yeahillstay'].map((n) => 'hostage/hunuse/' + n), ...[1, 2, 3, 4, 5, 6].map((i) => 'hostage/hpain/hpain' + i),
  // bullet impacts (HL2 sounds CS:S uses; only the CS:GO install has them here)
  ...[['concrete/concrete', 4], ['surfaces/tile', 4], ['wood/wood_solid', 5], ['metal/metal_solid', 4], ['glass/glass', 4], ['surfaces/sand', 4]].flatMap(([k, n]) => Array.from({ length: n }, (_, i) => `physics/${k}_impact_bullet${i + 1}`))]) {
  const data = readGameFile('sound/' + s + '.wav'); // CS:S first, then CS:GO
  if (!data) { console.log('missing sound', s); continue; }
  fs.mkdirSync(path.dirname(path.join(OUT, '..', 'sound', s)), { recursive: true });
  fs.writeFileSync(path.join(OUT, '..', 'sound', s + '.wav'), data);
}
console.log(`players: ${Object.keys(models).length} models, ${anims.length} baked animations (${anims.map((a) => a.name + ':' + a.frames).join(' ')}), ${texCache.size} textures, ${(binLen / 1e6).toFixed(1)} MB`);
