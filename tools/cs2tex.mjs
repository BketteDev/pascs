// Looks up a legacy Source material name (e.g. "plaster/boathouse_wall01") in the Counter-Strike 2 install and converts its colour texture to PNG.
// CS2 keeps many of the old CS:GO / CS:S textures as Source 2 .vtex_c files in game/csgo/pak01_dir.vpk (BC1 / BC3 / BC7, mips LZ4-compressed).
// BC7 is decoded by Pillow through a small Python helper (tools/dds2png.py). Results are cached in tools/.cache/cs2tex.
import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';
import { openVpk } from './vpk.mjs';

const VPK = 'C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk';
const CACHE = path.resolve(import.meta.dirname, '.cache', 'cs2tex');
const MAX_SIZE = 1024; // pick the mip level that keeps textures at or under this size
let vpk = null, byBase = null, byStem = null;

function index() {
  if (byBase) return;
  vpk = openVpk(VPK); byBase = new Map(); byStem = new Map();
  for (const k of vpk.entries.keys()) {
    if (!k.startsWith('materials/') || !k.endsWith('.vtex_c')) continue;
    const m = k.match(/([^/]+?)(?:_vmat_g)?_(color|c|diffuse|albedo|tcolor)(?:_[a-z]+)?_[0-9a-f]{6,8}\.vtex_c$/);
    if (!m) continue;
    const base = m[1];
    (byBase.get(base) ?? byBase.set(base, []).get(base)).push(k);
    const stem = base.replace(/^(?:inferno|inf|mirage|nuke|vertigo|overpass|italy|dust2|baggage|office|hr)_/, '');
    if (stem !== base) (byStem.get(stem) ?? byStem.set(stem, []).get(stem)).push(k);
  }
}

export function cs2Pak() { index(); return vpk; }

export function lz4(src, outLen) {
  const out = Buffer.alloc(outLen); let s = 0, d = 0;
  while (s < src.length) {
    const t = src[s++]; let lit = t >> 4;
    if (lit === 15) { let b; do { b = src[s++]; lit += b; } while (b === 255); }
    src.copy(out, d, s, s + lit); s += lit; d += lit;
    if (s >= src.length) break;
    const off = src[s] | (src[s + 1] << 8); s += 2;
    let ml = t & 15; if (ml === 15) { let b; do { b = src[s++]; ml += b; } while (b === 255); }
    ml += 4;
    for (let i = 0; i < ml; i++) { out[d] = out[d - off]; d++; }
  }
  return out;
}

// .vtex_c -> { w, h, fmt, data } for the chosen mip, or null when the format is unsupported
function readVtex(b) {
  const bo = b.readUInt32LE(8), bc = b.readUInt32LE(12), tbl = 8 + bo;
  let off = -1, end = 0;
  for (let i = 0; i < bc; i++) { const o = tbl + i * 12; if (b.toString('latin1', o, o + 4) === 'DATA') { off = o + 4 + b.readInt32LE(o + 4); end = off + b.readUInt32LE(o + 8); } }
  if (off < 0) return null;
  const w = b.readUInt16LE(off + 20), h = b.readUInt16LE(off + 22), fmt = b.readUInt8(off + 26), mips = b.readUInt8(off + 27);
  const block = { 1: 8, 2: 16, 20: 16, 27: 8 }[fmt], bpp = { 4: 4, 28: 4 }[fmt];
  if (!block && !bpp) return null;
  const usize = (m) => { const mw = Math.max(1, w >> m), mh = Math.max(1, h >> m); return block ? Math.ceil(mw / 4) * Math.ceil(mh / 4) * block : mw * mh * bpp; };
  let sizes = null; const count = b.readUInt32LE(off + 36), extraBase = off + 32 + b.readUInt32LE(off + 32);
  for (let i = 0; i < count; i++) {
    const o = extraBase + i * 12;
    if (b.readUInt32LE(o) === 4) { const at = o + 4 + b.readUInt32LE(o + 4), n = b.readUInt32LE(at + 8); sizes = Array.from({ length: n }, (_, k) => b.readUInt32LE(at + 12 + k * 4)); }
  }
  const stored = (m) => (sizes ? sizes[m] : usize(m));
  let m = 0; while (m < mips - 1 && Math.max(w >> m, h >> m) > MAX_SIZE) m++;
  let pos = end; for (let k = mips - 1; k > m; k--) pos += stored(k); // mips are stored smallest first
  let data = b.subarray(pos, pos + stored(m));
  if (stored(m) < usize(m)) data = lz4(data, usize(m));
  return { w: Math.max(1, w >> m), h: Math.max(1, h >> m), fmt, data };
}

function dds({ w, h, fmt, data }) {
  const hdr = Buffer.alloc(128 + (fmt === 20 || fmt === 27 ? 20 : 0));
  hdr.write('DDS ', 0, 'latin1'); hdr.writeUInt32LE(124, 4); hdr.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, 8);
  hdr.writeUInt32LE(h, 12); hdr.writeUInt32LE(w, 16); hdr.writeUInt32LE(data.length, 20); hdr.writeUInt32LE(1, 28);
  hdr.writeUInt32LE(32, 76);
  if (fmt === 4 || fmt === 28) { hdr.writeUInt32LE(0x41, 80); hdr.writeUInt32LE(32, 88); const [r, g, b, a] = fmt === 4 ? [0xff, 0xff00, 0xff0000, 0xff000000] : [0xff0000, 0xff00, 0xff, 0xff000000]; hdr.writeUInt32LE(r, 92); hdr.writeUInt32LE(g, 96); hdr.writeUInt32LE(b, 100); hdr.writeUInt32LE(a, 104); }
  else { hdr.writeUInt32LE(0x4, 80); hdr.write(fmt === 1 ? 'DXT1' : fmt === 2 ? 'DXT5' : 'DX10', 84, 'latin1'); }
  hdr.writeUInt32LE(0x1000, 108);
  if (fmt === 20 || fmt === 27) { hdr.writeUInt32LE(fmt === 27 ? 80 : 98, 128); hdr.writeUInt32LE(3, 132); hdr.writeUInt32LE(0, 136); hdr.writeUInt32LE(1, 140); hdr.writeUInt32LE(0, 144); } // BC7=98, BC4=80
  return Buffer.concat([hdr, data]);
}

// shortcut: CS:GO materials renamed in CS2 map to their direct CS2 equivalent before generic stand-in fallback
const MAT_ALIASES = [
  [/^props\/woodcrate/, 'models/props/de_mirage/dust_crates/dust_shipping_crate_02_wood_color'],
  [/^wood\/vostok_wood/, 'wood/plywood_ext_01'],
  [/^wood\/vertigo_plywood/, 'de_aztec/hr_aztec/hr_aztec_plywood_plain'],
  [/^wallpaper\/yellow/, 'de_inferno/wallpaper/inferno_wallpaper_02'],
  [/^(?:plaster|wallpaper)\/wallpaper01/, 'de_inferno/wallpaper/inferno_wallpaper_01'],
  [/^(?:plaster|wallpaper)\/wallpaper02/, 'de_inferno/wallpaper/inferno_wallpaper_02'],
  [/^concrete\/(?:blend_blacktop|highway)/, 'ground/blendblacktop_blacktopdry'],
  [/^concrete\/(?:drainage|sewer|subway|tunnel|train_tunnel)_concrete/, 'concrete/drainage_concreteceiling_01'],
  [/^metal\/(?:metalgrate|metalgate|metalbar|metalfence)/, 'models/props/de_nuke/hr_nuke/chainlink_fence_001/chainlink_fence_001'],
];

// shortcut: CS2 hr_nuke .vmat_c tint palette (lost when BSPSource decompiles StaticPropLump m_DiffuseModulation or KV3 v5 Layer1Tint)
const TINT_RULES = [
  [/green_light/, [0.816, 0.882, 0.699]],
  [/blue_light/, [0.68, 0.78, 0.88]],
  [/floor_001_dark|corrugated_002_dark/, [0.74, 0.75, 0.77]],
  [/polished_001_dark|tile_001_dark/, [0.78, 0.79, 0.81]],
  [/concrete_floor_05/, [0.52, 0.53, 0.55]],
  [/hr_metal_trim_002/, [0.58, 0.61, 0.65]],
  [/hr_metal_wall_00[136]/, [0.66, 0.71, 0.76]],
  [/metal_crate_001/, [0.54, 0.58, 0.63]],
  [/metal_crate_002/, [0.68, 0.65, 0.57]],
  [/metal_crate_003/, [0.46, 0.58, 0.54]],
  [/metal_crate_004/, [0.36, 0.51, 0.66]],
  [/metal_door_001|rollup_door_001/, [0.45, 0.58, 0.68]],
  [/metal_pipe_00[12]/, [0.68, 0.71, 0.74]],
  [/metal_railing_001|metal_ladder_001|security_barrier/, [0.84, 0.68, 0.24]],
  [/nuke_industrial_props|nuke_machinery|nuke_electric_panel|web_joist_001/, [0.56, 0.61, 0.66]],
  [/nuke_office_chair|nuke_chair|nuke_recycle_bin/, [0.34, 0.52, 0.72]],
  [/nuke_office_desk|nuke_control_room_table/, [0.68, 0.66, 0.62]],
  [/nuke_fire_extinguisher|nuke_lifering/, [0.78, 0.22, 0.20]],
];

function cleanMatName(name) {
  let n = name.trim().toLowerCase().replace(/\\/g, '/').replace(/^materials\//, '').replace(/\.vmat(?:_c)?$/, '').replace(/^maps\/[^/]+\//, '').replace(/_-?\d+_-?\d+_-?\d+$/, '');
  for (const [re, sub] of MAT_ALIASES) if (re.test(n)) { n = sub; break; }
  return n;
}

function findVmat(n) {
  const clean = n.replace(/_(?:cheap|clean|dirty|nodetail)$/, '');
  for (const cand of [`materials/${n}.vmat_c`, `materials/${n}_.vmat_c`, `${n}.vmat_c`, ...(clean !== n ? [`materials/${clean}.vmat_c`] : [])]) {
    if (vpk.entries.has(cand)) return cand;
  }
  return null;
}

/** Candidate vtex paths for a legacy material name: same folder first, then any folder; "inf" prefixes are optional. */
export function cs2Find(name) {
  index();
  const n = cleanMatName(name), clean = n.replace(/_(?:cheap|clean|dirty|nodetail)$/, '');
  const cand = findVmat(n);
  if (cand) {
    const strs = (vpk.read(cand).toString('latin1').match(/materials\/[a-z0-9_\/\-]+\.vtex/gi) ?? [])
      .map((s) => s.toLowerCase() + '_c').filter((k) => vpk.entries.has(k) && !/(?:^|\/|_)default/.test(k));
    const pick = strs.find((s) => /(?:_vmat_g)?_(color|c|diffuse|albedo|tcolor)(?:_[a-z]+)?_[0-9a-f]+\.vtex_c$/.test(s))
      ?? strs.find((s) => !/normal|ao|ambient|mask|rough|metal|height|tint|selfillum|detail|trans/.test(s))
      ?? strs.find((s) => /_trans_(?:[a-z]+_)?[0-9a-f]+\.vtex_c$/.test(s));
    if (pick) return pick;
  }
  const base = clean.split('/').pop(), dir = clean.includes('/') ? clean.slice(0, clean.lastIndexOf('/')) : '';
  const list = byBase.get(base) ?? byBase.get(base.replace(/^inf/, '')) ?? byStem.get(base) ?? [];
  if (list.length) return list.slice().sort((a, b) => (b.startsWith('materials/' + dir + '/') ? 1 : 0) - (a.startsWith('materials/' + dir + '/') ? 1 : 0))[0];
  // Last resort before stand-in: match stripped numeric variant within the same top-level folder (e.g. concrete/concrete_ext_12 -> concrete_ext_07)
  const top = dir.split('/')[0], pref = base.replace(/\d+[a-z]?$/, '');
  if (top && pref.length >= 6 && !/blend|decal|card|overlay|sky/.test(clean)) {
    for (const [k, v] of byBase) if (k.startsWith(pref)) {
      const hit = v.find((p) => p.startsWith('materials/' + top + '/'));
      if (hit) return hit;
    }
  }
  return null;
}

/** PNG for a material name from CS2, or null. Returns { png: Buffer, w, h, alpha: fraction of non-opaque pixels }. */
export function cs2Texture(name) {
  index();
  let path0; try { path0 = cs2Find(name); } catch { return null; }
  if (!path0) return null;
  const n = cleanMatName(name), cand = findVmat(n);
  let ao = null, mask = null, tint = TINT_RULES.find(([re]) => re.test(n))?.[1] ?? null;
  if (cand) {
    const strs = (vpk.read(cand).toString('latin1').match(/materials\/[a-z0-9_\/\-]+\.vtex/gi) ?? [])
      .map((s) => s.toLowerCase() + '_c').filter((k) => vpk.entries.has(k) && !/(?:^|\/|_)default/.test(k));
    ao = strs.find((s) => /(?:_ao_|tambientocclusion)_[a-z0-9_]+\.vtex_c$/.test(s)) ?? null;
    mask = strs.find((s) => /(?:_tintmask_|_mask_psd)_[a-z0-9_]+\.vtex_c$/.test(s)) ?? null;
  }
  const tx = cs2TextureAt(path0, { ao, mask, tint });
  return tx && { ...tx, trans: /_trans_/.test(path0) };
}
/** PNG for an exact vtex path in the CS2 VPK (e.g. names cs2Find's pattern does not index), or null. */
export function cs2TextureAt(path0, opts = {}) {
  index();
  const { ao = null, mask = null, tint = null } = opts;
  const tintKey = tint ? `__t_${tint.map((v) => Math.round(v * 100)).join('_')}` : '';
  const aoKey = ao ? '__ao' : '';
  const key = path0.replace(/[\/\\:]/g, '__') + aoKey + tintKey;
  const png = path.join(CACHE, key + '.png'), meta = path.join(CACHE, key + '.json');
  if (!fs.existsSync(png)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const tex = readVtex(vpk.read(path0)); if (!tex) { fs.writeFileSync(meta, 'null'); return null; }
    const file = path.join(CACHE, key + '.dds'); fs.writeFileSync(file, dds(tex));
    let aoFile = '', maskFile = '';
    if (ao) { const tAo = readVtex(vpk.read(ao)); if (tAo) { aoFile = path.join(CACHE, key + '_ao.dds'); fs.writeFileSync(aoFile, dds(tAo)); } }
    if (mask && tint) { const tM = readVtex(vpk.read(mask)); if (tM) { maskFile = path.join(CACHE, key + '_m.dds'); fs.writeFileSync(maskFile, dds(tM)); } }
    const args = [path.join(import.meta.dirname, 'dds2png.py'), file, png, meta, aoFile, maskFile, tint ? tint.join(',') : ''];
    const r = spawnSync('python', args, { encoding: 'utf8' });
    if (process.env.CS2_DEBUG) console.log('python', r.status, r.stderr?.slice(0, 400));
    for (const f of [file, aoFile, maskFile]) if (f) fs.rmSync(f, { force: true });
    if (r.status !== 0 || !fs.existsSync(png)) { fs.writeFileSync(meta, 'null'); return null; }
  }
  const info = JSON.parse(fs.readFileSync(meta, 'utf8')); if (!info) return null;
  return { png: fs.readFileSync(png), ...info };
}
