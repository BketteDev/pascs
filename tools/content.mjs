// Game files for the build tools, searched in order: the CS:S content dump, then the CS:GO install (its Source 1 pak01 VPK ships the
// HL2-era textures and props the dump lacks, and CS:GO's own), then Garry's Mod's base HL2 / CS:S VPKs (sourceengine/: the HL2 textures
// neither has), with the pak lumps of maps registered with addBspPak (custom map textures) checked before both.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { openVpk } from './vpk.mjs';

export const CSS = path.resolve(import.meta.dirname, '..', '..', 'content', 'css_content');
export const CSGO = 'C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive/csgo';
const CACHE = path.join(import.meta.dirname, '.cache', 'csgo');
let vpk;
const csgo = () => (vpk !== undefined ? vpk : (vpk = fs.existsSync(path.join(CSGO, 'pak01_dir.vpk')) ? openVpk(path.join(CSGO, 'pak01_dir.vpk')) : null));
const GMOD = 'C:/Program Files (x86)/Steam/steamapps/common/GarrysMod/sourceengine';
let gmodVpks;
const gmod = () => (gmodVpks ??= ['hl2_textures', 'hl2_misc', 'content_hl2', 'content_cstrike'].map((n) => path.join(GMOD, n + '_dir.vpk')).filter((f) => fs.existsSync(f)).map(openVpk));
const paks = [];

/** A file by its game path (e.g. "materials/concrete/x.vtf"), or null. */
export function readGameFile(rel) {
  rel = rel.replace(/\\/g, '/').toLowerCase();
  const f = path.join(CSS, rel);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  for (const p of paks) if (p.has(rel)) return p.get(rel);
  const fromCsgo = csgo()?.read(rel);
  if (fromCsgo) return fromCsgo;
  for (const v of gmod()) { const d = v.read(rel); if (d) return d; }
  return null;
}

/** A model's file base on disk (loadModel / loadSkeleton append .mdl / .vvd / .dx90.vtx), extracting CS:GO's into tools/.cache, or null. */
export function modelBase(rel) {
  const base = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\.mdl$/i, ''); // some maps write "./models/..."
  if (fs.existsSync(path.join(CSS, base + '.mdl'))) return path.join(CSS, base);
  const out = path.join(CACHE, base.toLowerCase());
  for (const ext of ['.mdl', '.vvd', '.dx90.vtx', '.phy']) {
    if (fs.existsSync(out + ext)) continue;
    const data = readGameFile(base + ext);
    if (!data) { if (ext === '.phy') continue; return null; }
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out + ext, data);
  }
  return out;
}

/** Also search a compiled map's embedded files (its pak lump: zip, stored or deflated entries). */
export function addBspPak(bspFile) {
  const b = fs.readFileSync(bspFile), files = new Map();
  for (const [o, l] of [[8 + 40 * 16, 8 + 40 * 16 + 4], [8 + 40 * 16 + 4, 8 + 40 * 16 + 8]]) { // lump 40; offset/length order differs between engine branches
    const ofs = b.readInt32LE(o), len = b.readInt32LE(l);
    if (ofs <= 0 || len <= 0 || ofs + len > b.length || b.readUInt32LE(ofs) !== 0x04034b50) continue;
    const z = b.subarray(ofs, ofs + len), eocd = z.lastIndexOf(Buffer.from([0x50, 0x4b, 5, 6]));
    for (let n = z.readUInt16LE(eocd + 10), p = z.readUInt32LE(eocd + 16); n-- > 0; p += 46 + z.readUInt16LE(p + 28) + z.readUInt16LE(p + 30) + z.readUInt16LE(p + 32)) {
      const name = z.toString('latin1', p + 46, p + 46 + z.readUInt16LE(p + 28)).toLowerCase(), lo = z.readUInt32LE(p + 42), method = z.readUInt16LE(p + 10);
      const start = lo + 30 + z.readUInt16LE(lo + 26) + z.readUInt16LE(lo + 28), data = z.subarray(start, start + z.readUInt32LE(p + 20));
      if (method === 0) files.set(name, data); else if (method === 8) files.set(name, zlib.inflateRawSync(data)); // LZMA entries are skipped
    }
    break;
  }
  paks.push(files);
  return files.size;
}
