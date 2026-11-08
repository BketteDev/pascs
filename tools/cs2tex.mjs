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
let vpk = null, byBase = null;

function index() {
  if (byBase) return;
  vpk = openVpk(VPK); byBase = new Map();
  for (const k of vpk.entries.keys()) {
    if (!k.startsWith('materials/') || !k.endsWith('.vtex_c')) continue;
    const m = k.match(/([^/]+?)_(color|c|diffuse|albedo)(?:_[a-z]+)?_[0-9a-f]{8}\.vtex_c$/);
    if (m) (byBase.get(m[1]) ?? byBase.set(m[1], []).get(m[1])).push(k);
  }
}

function lz4(src, outLen) {
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
  const block = { 1: 8, 2: 16, 20: 16 }[fmt], bpp = { 4: 4, 28: 4 }[fmt];
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
  const hdr = Buffer.alloc(128 + (fmt === 20 ? 20 : 0));
  hdr.write('DDS ', 0, 'latin1'); hdr.writeUInt32LE(124, 4); hdr.writeUInt32LE(0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, 8);
  hdr.writeUInt32LE(h, 12); hdr.writeUInt32LE(w, 16); hdr.writeUInt32LE(data.length, 20); hdr.writeUInt32LE(1, 28);
  hdr.writeUInt32LE(32, 76);
  if (fmt === 4 || fmt === 28) { hdr.writeUInt32LE(0x41, 80); hdr.writeUInt32LE(32, 88); const [r, g, b, a] = fmt === 4 ? [0xff, 0xff00, 0xff0000, 0xff000000] : [0xff0000, 0xff00, 0xff, 0xff000000]; hdr.writeUInt32LE(r, 92); hdr.writeUInt32LE(g, 96); hdr.writeUInt32LE(b, 100); hdr.writeUInt32LE(a, 104); }
  else { hdr.writeUInt32LE(0x4, 80); hdr.write(fmt === 1 ? 'DXT1' : fmt === 2 ? 'DXT5' : 'DX10', 84, 'latin1'); }
  hdr.writeUInt32LE(0x1000, 108);
  if (fmt === 20) { hdr.writeUInt32LE(98, 128); hdr.writeUInt32LE(3, 132); hdr.writeUInt32LE(0, 136); hdr.writeUInt32LE(1, 140); hdr.writeUInt32LE(0, 144); } // BC7_UNORM, 2D
  return Buffer.concat([hdr, data]);
}

/** Candidate vtex paths for a legacy material name: same folder first, then any folder; "inf" prefixes are optional. */
export function cs2Find(name) {
  index();
  const n = name.toLowerCase().replace(/^maps\/[^/]+\//, '').replace(/_-?\d+_-?\d+_-?\d+$/, ''), base = n.split('/').pop(), dir = n.includes('/') ? n.slice(0, n.lastIndexOf('/')) : '';
  const list = byBase.get(base) ?? byBase.get(base.replace(/^inf/, '')) ?? [];
  return list.slice().sort((a, b) => (b.startsWith('materials/' + dir + '/') ? 1 : 0) - (a.startsWith('materials/' + dir + '/') ? 1 : 0))[0] ?? null;
}

/** PNG for a material name from CS2, or null. Returns { png: Buffer, w, h, alpha: fraction of non-opaque pixels }. */
export function cs2Texture(name) {
  let path0; try { path0 = cs2Find(name); } catch { return null; }
  return path0 ? cs2TextureAt(path0) : null;
}
/** PNG for an exact vtex path in the CS2 VPK (e.g. names cs2Find's pattern does not index), or null. */
export function cs2TextureAt(path0) {
  index();
  const key = path0.replace(/[\/\\:]/g, '__'), png = path.join(CACHE, key + '.png'), meta = path.join(CACHE, key + '.json');
  if (!fs.existsSync(png)) {
    fs.mkdirSync(CACHE, { recursive: true });
    const tex = readVtex(vpk.read(path0)); if (!tex) { fs.writeFileSync(meta, 'null'); return null; }
    const file = path.join(CACHE, key + '.dds'); fs.writeFileSync(file, dds(tex));
    const r = spawnSync('python', [path.join(import.meta.dirname, 'dds2png.py'), file, png, meta], { encoding: 'utf8' });
    if (process.env.CS2_DEBUG) console.log('python', r.status, r.stderr?.slice(0, 400));
    fs.rmSync(file, { force: true });
    if (r.status !== 0 || !fs.existsSync(png)) { fs.writeFileSync(meta, 'null'); return null; }
  }
  const info = JSON.parse(fs.readFileSync(meta, 'utf8')); if (!info) return null;
  return { png: fs.readFileSync(png), ...info };
}
