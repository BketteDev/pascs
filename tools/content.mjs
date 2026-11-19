// Game files for the build tools, searched in order: the current map's embedded pack, the CS:S content dump, then the CS:GO install (its Source 1 pak01 VPK ships the
// HL2-era textures and props the dump lacks, and CS:GO's own), then Garry's Mod's base HL2 / CS:S VPKs (sourceengine/: the HL2 textures
// neither has).
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { createHash } from 'node:crypto';
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
  if (rel.startsWith('/') || rel.includes(':') || rel.split('/').includes('..')) return null;
  for (const p of paks) if (p.files.has(rel)) return p.files.get(rel);
  return readInstalledFile(rel);
}

function readInstalledFile(rel) {
  const f = path.join(CSS, rel);
  if (fs.existsSync(f)) return fs.readFileSync(f);
  const fromCsgo = csgo()?.read(rel);
  if (fromCsgo) return fromCsgo;
  for (const v of gmod()) { const d = v.read(rel); if (d) return d; }
  return null;
}

/** A model's file base on disk (loadModel / loadSkeleton append .mdl / .vvd / .dx90.vtx), extracting CS:GO's into tools/.cache, or null. */
export function modelBase(rel) {
  const base = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\.mdl$/i, '').toLowerCase();
  if (!base.startsWith('models/') || base.split('/').includes('..') || base.includes(':')) return null;
  const required = ['.mdl', '.vvd', '.dx90.vtx'];
  const pack = paks.find(({ files }) => required.every((ext) => files.has(base + ext)));
  const loose = path.join(CSS, base);
  if (!pack && required.every((ext) => fs.existsSync(loose + ext))) return loose;
  const archives = pack ? [] : [csgo(), ...gmod()];
  let data = pack ? required.map((ext) => pack.files.get(base + ext)) : null;
  const archiveIndex = archives.findIndex((archive) => {
    if (!archive) return false;
    data = required.map((ext) => archive.read(base + ext));
    return data.every(Boolean);
  });
  if (!pack && archiveIndex < 0) return null;
  data.push(pack ? pack.files.get(base + '.phy') : archives[archiveIndex].read(base + '.phy'));
  const out = path.join(CACHE, pack?.key ?? `installed-${archiveIndex}`, base);
  for (const [i, ext] of [...required, '.phy'].entries()) {
    if (fs.existsSync(out + ext)) continue;
    if (!data[i]) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out + ext, data[i]);
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
    if (eocd < 0) continue;
    for (let n = z.readUInt16LE(eocd + 10), p = z.readUInt32LE(eocd + 16); n-- > 0; p += 46 + z.readUInt16LE(p + 28) + z.readUInt16LE(p + 30) + z.readUInt16LE(p + 32)) {
      const name = z.toString('latin1', p + 46, p + 46 + z.readUInt16LE(p + 28)).toLowerCase(), lo = z.readUInt32LE(p + 42), method = z.readUInt16LE(p + 10);
      const start = lo + 30 + z.readUInt16LE(lo + 26) + z.readUInt16LE(lo + 28), data = z.subarray(start, start + z.readUInt32LE(p + 20));
      if (method === 0) files.set(name, data); else if (method === 8) files.set(name, zlib.inflateRawSync(data)); // LZMA entries are skipped
    }
    paks.push({ files, key: createHash('sha256').update(z).digest('hex') });
    break;
  }
  return files.size;
}
