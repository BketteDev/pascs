// Bake viewmodels from exports/asset-import, then run tools/render-cosmetic-previews.mjs for the inventory.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { loadModel, loadSkeleton, mul34 } from './mdl.mjs';
import { loadGoldSrc } from './goldsrc-viewmodel.mjs';
import { png, vtfToRgba } from './vtf.mjs';

const imports = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, '../../exports/asset-import'));
const out = path.resolve(import.meta.dirname, '../public/cosmetics');
const filter = new Set(process.argv.slice(3));
const modelRoot = path.join(imports, 'csgo-models/My custom/models/weapons');
const materialRoot = path.join(imports, 'csgo/My custom/materials');
const pack = (folder, inner) => path.join(imports, folder, inner);
const knifeNames = {
  bayonet: 'Bayonet', butterfly: 'Butterfly Knife', classic: 'Classic Knife', falchion: 'Falchion Knife',
  flip: 'Flip Knife', gut: 'Gut Knife', huntsman: 'Huntsman Knife', karambit: 'Karambit', kukri: 'Kukri Knife',
  m9_bayonet: 'M9 Bayonet', navaja: 'Navaja Knife', nomad: 'Nomad Knife', paracord: 'Paracord Knife',
  shadow_daggers: 'Shadow Daggers', skeleton: 'Skeleton Knife', stiletto: 'Stiletto Knife',
  survival: 'Survival Knife', survival_bowie: 'Bowie Knife', talon: 'Talon Knife', ursus: 'Ursus Knife',
  ct: 'CS:GO Knife · CT', t: 'CS:GO Knife · T',
};
const guns = {
  ak47: ['rif_ak47'], aug: ['rif_aug'], awp: ['snip_awp'], deagle: ['pist_deagle'], elite: ['pist_elite'],
  famas: ['rif_famas'], fiveseven: ['pist_fiveseven'], g3sg1: ['snip_g3sg1'], galil: ['rif_galilar'],
  glock: ['pist_glock18'], m249: ['mach_m249'], m3: ['shot_m3super90'], mac10: ['smg_mac10'],
  m4a1: ['rif_m4a1_silencer', 'rif_m4a4'], mp5: ['smg_mp5sd'], p228: ['pist_p250'],
  p90: ['smg_p90'], scout: ['snip_ssg08'], sg550: ['snip_scar20'], sg552: ['rif_sg553'],
  tmp: ['smg_mp9'], ump45: ['smg_ump45'], usp: ['pist_usp', 'pist_usp_silencer'], xm1014: ['shot_xm1014'],
};
const weaponLabels = { rif_m4a4: 'M4A4 · CS:GO pack', pist_usp: 'USP · CS:GO pack', pist_usp_silencer: 'USP-S · CS:GO pack' };
const gloveStyles = [
  ['glove-hardknuckle', 'Hard Knuckle', 'glove_hardknuckle/v_glove_hardknuckle'],
  ['glove-hardknuckle-black', 'Hard Knuckle · Black', 'glove_hardknuckle/v_glove_hardknuckle_black'],
  ['glove-sport', 'Sport Gloves', 'glove_sporty/v_glove_sporty'],
  ['glove-driver', 'Driver Gloves', 'glove_slick/v_glove_slick'],
  ['glove-handwraps', 'Leather Hand Wraps', 'glove_handwrap_leathery/v_glove_handwrap_leathery'],
  ['glove-fullfinger', 'Full-Finger Gloves', 'glove_fullfinger/v_glove_fullfinger'],
  ['glove-specialist', 'Specialist Gloves', 'glove_specialist/v_glove_specialist'],
];
const models = [
  ...Object.entries(knifeNames).map(([name, label]) => ({ weapon: 'knife', id: name, label, materials: materialRoot, base: path.join(modelRoot, 'v_knife_' + name) })),
  ...Object.entries(guns).flatMap(([weapon, files]) => files.map((name) => ({ weapon, id: name, label: weaponLabels[name] ?? 'CS:GO pack', materials: materialRoot, base: path.join(modelRoot, 'v_' + name) }))),
  { weapon: 'ak47', id: 'rgx-vandal', label: 'RGX 11z Pro Vandal', materials: pack('vandal', 'valorant rgx11z pro vandal/materials'), base: pack('vandal', 'valorant rgx11z pro vandal/models/weapons/v_rif_ak47') },
  { weapon: 'knife', id: 'valorant', label: 'VALORANT Knife', materials: pack('valorant-knife', 'Valorant Knife/materials'), base: pack('valorant-knife', 'Valorant Knife/models/weapons/v_knife_t') },
  ...['ak47', 'awp', 'deagle', 'knife', 'm4a1', 'p228', 'tmp', 'usp'].map((weapon) => ({
    weapon, id: 'printstream-' + weapon, label: weapon === 'knife' ? 'Karambit · Printstream' : 'Printstream',
    goldSrc: true, base: pack('printstream', 'Printstream Pack/1024x1024/v_' + weapon),
  })),
  ...gloveStyles.map(([id, label, base]) => ({ weapon: 'gloves', id, label, materials: materialRoot, base: path.join(modelRoot, 'v_models/arms', base) })),
];

// The pack renames some models but keeps their original material directories.
const aliases = {
  knife_classic: 'knife_css/knife_css.vmt',
  knife_falchion: 'knife_falchion_advanced/knife_falchion_advanced.vmt',
  knife_huntsman: 'knife_tactical/knife_tactical.vmt',
  knife_navaja: 'knife_gypsy_jack/knife_gypsy_jack.vmt',
  knife_nomad: 'knife_outdoor/knife_outdoor.vmt',
  knife_paracord: 'knife_cord/knife_cord.vmt',
  knife_shadow_daggers: 'knife_push/knife_push.vmt',
  knife_survival: 'knife_canis/knife_canis.vmt',
  knife_talon: 'knife_widowmaker/knife_widowmaker.vmt',
  mach_m249: '../cs2/weapon_mach_m249/m249_c.vtf',
  pist_elite: 'pist_elite/weapon_elite-cu_elites_beware-diffuse.vtf',
  pist_fiveseven: 'pist_fiveseven/fiveseven.vtf',
  rif_sg553: 'rif_sg553/rif_sg556.vmt',
  smg_mac10: 'smg_mac10/smg_mac10.vtf',
  snip_scar20: '../cs2/weapon_snip_scar20/scar20_c.vtf',
};
const goldPaint = (folder, inner, material) => ({ goldSrc: pack(folder, inner), material });
const paints = {
  bayonet: [['emerald', 'Doppler Emerald', 'knife_bayonet/weapon_bayonet-am_emerald_marbleized-diffuse.vtf']],
  butterfly: [
    ['emerald', 'Doppler Emerald', 'knife_butterfly/weapon_knife_butterfly-am_emerald_marbleized-diffuse.vtf'],
    ['love', 'Love', 'knife_butterfly/LOVE.vtf'],
    ['star', 'Star', 'knife_butterfly/STAR.vtf'],
    ['crimson', 'Crimson', goldPaint('pack-all-gloves', 'Pack all gloves/pack occult/v_knife.mdl', 'butterfly.bmp')],
    ['ultra-violet', 'Ultra Violet', goldPaint('pack-all-gloves', 'Pack all gloves/pack ultra violet/v_knife.mdl', 'butterfly.bmp')],
  ],
  karambit: [
    ['black-steel', 'Black Steel', goldPaint('karambit-marble', 'cs.go Karambit marble-by Alex/variants/default/v_knife.mdl', 'karam_red.bmp')],
    ['marble-blue', 'Marble Blue', goldPaint('karambit-marble', 'cs.go Karambit marble-by Alex/variants/blue/v_knife.mdl', 'karam_blue.bmp')],
    ['marble-green', 'Marble Green', goldPaint('karambit-marble', 'cs.go Karambit marble-by Alex/variants/green/v_knife.mdl', 'karam_green.bmp')],
    ['marble-purple', 'Marble Purple', goldPaint('karambit-marble', 'cs.go Karambit marble-by Alex/variants/purple/v_knife.mdl', 'karam_purple.bmp')],
    ['marble-red', 'Marble Red', goldPaint('karambit-marble', 'cs.go Karambit marble-by Alex/variants/red/v_knife.mdl', 'karam_red.bmp')],
  ],
  falchion: [['ruby', 'Doppler Ruby', 'knife_falchion_advanced/6_am_falchion_doppler_ruby.vtf']],
  survival_bowie: [['sapphire', 'Doppler Sapphire', 'knife_survival_bowie.rar/knife_survival_bowie/weapon_knife_survival_bowie-am_sapphire_marbleized-diffuse.vtf']],
  rif_ak47: [['professional', 'Slate', 'rif_ak47_ByFerris4227/weapon_ak47-gs_ak47_professional-diffuse.vtf']],
  pist_deagle: [['crimson-web', 'Crimson Web', 'pist_deagle_ByFerris4227.rar/pist_deagle_ByFerris4227/weapon_deagle-hy_webs_darker-diffuse.vtf']],
  'glove-driver': [
    ['flowers', 'Flowers', goldPaint('pack-all-gloves', 'Pack all gloves/pack flowers/v_ak47.mdl', 'driver.bmp')],
  ],
  'glove-sport': [
    ['occult', 'Occult', goldPaint('pack-all-gloves', 'Pack all gloves/pack occult/v_ak47.mdl', 'sport_left.bmp')],
  ],
  'glove-specialist': [
    ['pillow', 'Pillow', goldPaint('karambit-marble', 'cs.go Karambit marble-by Alex/variants/red/v_knife.mdl', 'specialist_left.bmp')],
  ],
};
const viewMaterials = 'models/weapons/v_models';
const archiveMaterials = pack('paint-archives', 'v_models');

const catalogFile = path.join(out, 'catalog.json');
const catalog = filter.size && fs.existsSync(catalogFile) ? JSON.parse(fs.readFileSync(catalogFile)) : {};
fs.mkdirSync(path.join(out, 'models'), { recursive: true });
fs.mkdirSync(path.join(out, 'tex'), { recursive: true });
const indexes = new Map();
function filesAt(root) {
  if (!indexes.has(root)) {
    const entries = fs.readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile());
    indexes.set(root, new Map(entries.map((entry) => {
      const file = path.join(entry.parentPath, entry.name);
      return [path.relative(root, file).replaceAll('\\', '/').toLowerCase(), file];
    })));
  }
  return indexes.get(root);
}
const saved = new Map();
function saveTexture(file, pixels) {
  if (saved.has(file)) return saved.get(file);
  const source = pixels ? png(pixels.W, pixels.H, 4, pixels.rgba) : fs.readFileSync(file);
  const id = createHash('sha1').update(source).digest('hex').slice(0, 18), dest = 'tex/' + id + '.png';
  const target = path.join(out, dest), old = fs.existsSync(target) ? fs.readFileSync(target) : null;
  const W = pixels?.W ?? source.readUInt16LE(16), H = pixels?.H ?? source.readUInt16LE(18);
  const stride = Math.max(1, Math.ceil(Math.max(W, H) / 1024));
  const width = Math.ceil(W / stride), height = Math.ceil(H / stride);
  if (!old || old.length < 24 || old.readUInt32BE(16) < width || old.readUInt32BE(20) < height) {
    const { rgba } = pixels ?? vtfToRgba(source);
    const data = stride === 1 ? rgba : Buffer.alloc(width * height * 4);
    if (stride > 1) for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let dy = 0; dy < stride && y * stride + dy < H; dy++) for (let dx = 0; dx < stride && x * stride + dx < W; dx++) {
        const s = ((y * stride + dy) * W + x * stride + dx) * 4;
        r += rgba[s]; g += rgba[s + 1]; b += rgba[s + 2]; a += rgba[s + 3]; n++;
      }
      const d = (y * width + x) * 4;
      data[d] = r / n + .5 | 0; data[d + 1] = g / n + .5 | 0; data[d + 2] = b / n + .5 | 0; data[d + 3] = a / n + .5 | 0;
    }
    fs.writeFileSync(target, png(width, height, 4, data));
  }
  saved.set(file, dest);
  return dest;
}

function materialFor(mesh, root) {
  const files = filesAt(root), name = mesh.material.toLowerCase().replaceAll('\\', '/');
  const dirs = mesh.cd.map((dir) => dir.replaceAll('\\', '/').replace(/\/*$/, '/').replace(/^\//, '').toLowerCase());
  const candidates = [...dirs.map((dir) => dir + name + '.vmt'), name + '.vmt'];
  const alias = root === materialRoot && aliases[name];
  const aliasPath = alias ? path.posix.normalize(viewMaterials + '/' + alias) : '';
  const kukri = root === materialRoot && name === 'knife_kukri' && path.join(archiveMaterials, 'Knife_ct/knife_ct.rar/kukri_c.vtf');
  const file = candidates.map((p) => files.get(p)).find(Boolean) || (aliasPath && files.get(aliasPath));
  const text = file?.toLowerCase().endsWith('.vmt') ? fs.readFileSync(file, 'latin1') : '';
  if (/^\s*"?WeaponDecal\b/i.test(text) && /^\s*"?\$no_draw"?\s+"?1\b/im.test(text)) return null;
  const base = text.match(/\$basetexture"?\s+"?([^"\s]+)/i)?.[1]?.replaceAll('\\', '/').toLowerCase();
  const texture = (kukri && fs.existsSync(kukri) && kukri)
    || (base && files.get(base + '.vtf'))
    || (file && files.get(path.relative(root, file).replaceAll('\\', '/').toLowerCase().replace(/\.vmt$/, '.vtf')))
    || (aliasPath.endsWith('.vtf') && files.get(aliasPath));
  if (!texture) throw new Error('Missing texture for ' + mesh.material);
  const alpha = /\$alphatest"?\s+"?1\b/i.test(text) ? 1 : /\$translucent"?\s+"?1\b/i.test(text) ? 2 : 0;
  return { tex: saveTexture(texture), alpha, source: texture };
}

const armsBase = path.join(modelRoot, 'v_models/arms/glove_hardknuckle/v_glove_hardknuckle');
const arms = loadModel(armsBase).meshes, armBones = loadSkeleton(armsBase + '.mdl').bones;
const knifeActivity = {
  ACT_VM_MISSCENTER: 'ACT_VM_HITCENTER', ACT_VM_MISSCENTER2: 'ACT_VM_SECONDARYATTACK',
  ACT_VM_HITCENTER2: 'ACT_VM_SECONDARYATTACK', ACT_VM_SWINGHIT: 'ACT_VM_HITCENTER', ACT_VM_SWINGHARD: 'ACT_VM_SECONDARYATTACK',
};
const isInspection = (q) => q.activity === 'ACT_VM_INSPECT' || /^(lookat\d+|inspect(?:_?\d+)?)$/i.test(q.name);
function bake(item) {
  const glove = item.weapon === 'gloves';
  const gold = item.goldSrc ? loadGoldSrc(item.base + '.mdl') : null;
  const model = gold ?? loadModel(item.base), sk = gold ?? loadSkeleton(item.base + '.mdl');
  if (glove && (sk.bones.length !== armBones.length || sk.bones.some((bone, i) =>
    bone.name !== armBones[i].name || bone.poseToBone.some((value, j) => Math.abs(value - armBones[i].poseToBone[j]) > 0.001)))) {
    throw new Error('Gloves do not match the arm skeleton');
  }
  const boneMap = new Map(gold ? [] : sk.bones.map((b, i) => [b.name.toLowerCase(), i]));
  const spareMagazine = item.id === 'rgx-vandal' ? boneMap.get('magazine2') : -1;
  const separateHands = !glove && boneMap.has('hand_r') && !model.meshes.some((m) => /hand|glove|sleeve|arms/i.test(m.material));
  const mapped = separateHands ? armBones.map((arm) => {
    let bone = arm;
    while (bone) {
      const exact = boneMap.get(bone.name.toLowerCase().replace(/armuppershoulder_/, 'arm_upper_'));
      if (exact !== undefined) return exact;
      bone = armBones[bone.parent];
    }
    return boneMap.get('hand_r');
  }) : [];
  const data = [], meta = { bones: sk.bones.length + mapped.length, rightHanded: !item.goldSrc || item.weapon === 'knife', meshes: [], sequences: [] };
  if (separateHands) meta.armBoneOffset = sk.bones.length;
  let offset = 0;
  const push = (values, Type = Float32Array) => {
    const prev = offset, buf = Buffer.from(Type.from(values).buffer);
    data.push(buf); offset += buf.length;
    if (offset % 4) { data.push(Buffer.alloc(4 - offset % 4)); offset += 4 - offset % 4; }
    return prev;
  };
  const goldTextures = new Map();
  for (const [number, mesh] of [...model.meshes, ...(separateHands ? arms : [])].entries()) {
    const isArm = number >= model.meshes.length;
    const bare = (glove || isArm) && mesh.material === 'bare_arm_133';
    let mat;
    try {
      if (gold) {
        if (!goldTextures.has(mesh.texture)) {
          goldTextures.set(mesh.texture, {
            tex: saveTexture(item.id + '/' + mesh.material, gold.pixels(mesh.texture)),
            alpha: mesh.texture.flags & 64 ? 1 : 0,
          });
        }
        mat = goldTextures.get(mesh.texture);
      } else if (bare) {
        mat = materialFor({ ...mesh, cd: [viewMaterials + '/arms/bare/'] }, materialRoot);
      } else mat = materialFor(mesh, isArm ? materialRoot : item.materials);
    }
    catch (error) {
      if (!number || gold || isArm || glove) throw error;
      continue; // optional stickers and charms may use unsupported Source shaders
    }
    if (!mat) continue;
    const packed = { pos: [], nrm: [], uv: [], bi: [], bw: [] }, seen = new Map(), indices = [];
    const lengths = { pos: 3, nrm: 3, uv: 2, bi: 4, bw: 4 };
    for (let i = 0; i < mesh.pos.length / 3; i++) {
      const vertex = Object.entries(lengths).map(([attr, size]) => mesh[attr].slice(i * size, (i + 1) * size));
      const key = vertex.join('/');
      let v = seen.get(key);
      if (v === undefined) {
        v = seen.size; seen.set(key, v);
        if (isArm) vertex[3] = vertex[3].map((bone) => bone + sk.bones.length);
        Object.keys(lengths).forEach((attr, j) => packed[attr].push(...vertex[j]));
      }
      indices.push(v);
    }
    const m = { material: mesh.material, tex: mat.tex, alpha: mat.alpha, count: seen.size, indexCount: indices.length };
    if (isArm) m.arm = true;
    if (glove && bare && !mesh.pos.some((value, i) => i % 3 === 2 && value < 43)) m.forearm = true;
    for (const [attr, values] of Object.entries(packed)) m[attr] = push(values);
    m.idx = push(indices, Uint32Array);
    meta.meshes.push(m);
  }
  const keys = new Set();
  const sequences = (glove ? sk.sequences.filter((q) => q.name === 'idle').map((q) => ({ ...q, activity: 'ACT_VM_IDLE' })) : sk.sequences).filter((q) => {
    const anim = sk.anims[q.anim];
    if (!anim || !anim.frames || !anim.fps || anim.delta) return false;
    if (isInspection(q)) return true;
    const wanted = /ACT_VM_(?:IDLE|DRAW|RELOAD|PRIMARYATTACK|SECONDARYATTACK|HITCENTER|MISSCENTER|SWINGHIT|SWINGHARD|DRYFIRE)|ACT_SHOTGUN_RELOAD/.test(q.activity);
    if (!wanted || keys.has(q.activity)) return false;
    keys.add(q.activity);
    return true;
  }).map((q) => ({ ...q, activity: isInspection(q) ? 'ACT_VM_INSPECT' : knifeActivity[q.activity] ?? q.activity }));
  for (const q of sequences) {
    const anim = sk.anims[q.anim], skip = anim.frames > 16 ? 2 : 1, frames = Math.ceil(anim.frames / skip), skin = [], attach = [];
    for (let frame = 0; frame < anim.frames; frame += skip) {
      const world = sk.boneToWorld(anim, frame);
      if (spareMagazine >= 0 && q.activity !== 'ACT_VM_RELOAD') {
        // Collapse the reload prop inside the seated magazine so it cannot float into view.
        const magazine = world[boneMap.get('magazine')];
        world[spareMagazine] = [0, 0, 0, magazine[3], 0, 0, 0, magazine[7], 0, 0, 0, magazine[11]];
      }
      world.forEach((m, i) => skin.push(...mul34(m, sk.bones[i].poseToBone)));
      mapped.forEach((bone, i) => skin.push(...mul34(world[bone], armBones[i].poseToBone)));
      const at = sk.attachments[0];
      if (at && !glove && item.weapon !== 'knife') { const m = mul34(world[at.bone], at.local); attach.push(m[3], m[7], m[11]); }
    }
    if (!skin.every(Number.isFinite)) throw new Error('Non-finite animation in ' + q.name);
    meta.sequences.push({ name: q.name, activity: q.activity, loop: anim.loop, fps: anim.fps / skip, frames, skin: push(skin), attach: attach.length ? push(attach) : -1 });
  }
  if (!meta.meshes.some((mesh) => !mesh.arm)) throw new Error('Missing viewmodel meshes');
  if (!meta.sequences.some((seq) => seq.activity === 'ACT_VM_IDLE')) throw new Error('Missing idle animation');
  const dest = 'models/' + item.id;
  fs.writeFileSync(path.join(out, dest + '.json'), JSON.stringify(meta));
  fs.writeFileSync(path.join(out, dest + '.bin.gz'), gzipSync(Buffer.concat(data), { level: 9 }));
  const first = glove ? meta.meshes.find((m) => m.material.startsWith('glove_')) : gold ? meta.meshes.at(-1) : meta.meshes[0];
  const entry = { id: item.id, name: item.label, model: dest, preview: first.tex };
  if (separateHands) entry.gloves = true;
  const variants = [];
  const targets = glove ? meta.meshes.filter((m) => m.material.startsWith('glove_')) : [first];
  if (item.id === 'glove-driver') {
    const clean = goldPaint('pack-all-gloves', 'Pack all gloves/pack wave chaser/v_ak47.mdl', 'driver.bmp');
    const gs = loadGoldSrc(clean.goldSrc), mesh = gs.meshes.find((m) => m.material === clean.material);
    if (mesh) {
      entry.preview = saveTexture('glove-driver-clean/' + clean.material, gs.pixels(mesh.texture));
      entry.name = 'Driver Gloves · Wave Chaser';
      entry.textures = Object.fromEntries(targets.map((m) => [m.material, entry.preview]));
    }
  }
  for (const [id, finish, source] of paints[item.id] ?? []) {
    let preview;
    if (source.goldSrc) {
      if (!fs.existsSync(source.goldSrc)) { console.warn('Missing paint: ' + source.goldSrc); continue; }
      const gs = loadGoldSrc(source.goldSrc), mesh = gs.meshes.find((m) => m.material === source.material);
      if (!mesh) { console.warn('Missing paint material: ' + source.material); continue; }
      preview = saveTexture(item.id + '-' + id + '/' + source.material, gs.pixels(mesh.texture));
    } else {
      const file = [path.join(materialRoot, viewMaterials, source), path.join(archiveMaterials, source)].find((p) => fs.existsSync(p));
      if (!file) { console.warn('Missing paint: ' + source); continue; }
      preview = saveTexture(file);
    }
    if (preview !== first.tex) variants.push({
      ...entry, id: item.id + '-' + id,
      name: item.weapon === 'knife' || glove ? item.label + ' · ' + finish : finish,
      preview, textures: Object.fromEntries(targets.map((m) => [m.material, preview])),
    });
  }
  return [entry, ...variants];
}

for (const item of models) {
  if (filter.size && !filter.has(item.id)) continue;
  try {
    const entries = bake(item);
    const items = catalog[item.weapon] ??= [];
    catalog[item.weapon] = items.filter((entry) => entry.model !== entries[0].model).concat(entries);
    console.log('Imported ' + item.weapon + ': ' + item.label);
  } catch (error) { console.warn(item.id + ': ' + error.message); }
}
for (const items of Object.values(catalog)) items.sort((a, b) => a.name.localeCompare(b.name));
fs.writeFileSync(catalogFile, JSON.stringify(catalog, null, 2) + '\n');
