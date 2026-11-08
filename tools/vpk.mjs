// Minimal VPK (v1 / v2) reader: open a *_dir.vpk, look files up by path, read their bytes (from the dir file or the numbered archives).
import fs from 'fs';
import path from 'path';

export function openVpk(dirFile) {
  const buf = fs.readFileSync(dirFile);
  if (buf.readUInt32LE(0) !== 0x55aa1234) throw new Error('not a VPK');
  const version = buf.readUInt32LE(4), treeSize = buf.readUInt32LE(8), headerSize = version === 1 ? 12 : 28;
  const entries = new Map(); // "dir/name.ext" (lower case) -> { archive, offset, length, preload }
  let p = headerSize;
  const str = () => { const s = p; while (buf[p] !== 0) p++; const r = buf.toString('latin1', s, p); p++; return r; };
  for (;;) {
    const ext = str(); if (!ext) break;
    for (;;) {
      const dir = str(); if (!dir) break;
      for (;;) {
        const name = str(); if (!name) break;
        const crc = buf.readUInt32LE(p), preloadBytes = buf.readUInt16LE(p + 4), archive = buf.readUInt16LE(p + 6), offset = buf.readUInt32LE(p + 8), length = buf.readUInt32LE(p + 12);
        p += 18;
        const preload = buf.subarray(p, p + preloadBytes); p += preloadBytes;
        const full = ((dir === ' ' ? '' : dir + '/') + (name === ' ' ? '' : name) + (ext === ' ' ? '' : '.' + ext)).toLowerCase();
        entries.set(full, { archive, offset, length, preload, crc });
      }
    }
  }
  const base = dirFile.replace(/_dir\.vpk$/i, ''), dataStart = headerSize + treeSize, fds = new Map();
  const read = (name) => {
    const e = entries.get(name.toLowerCase().replace(/\\/g, '/')); if (!e) return null;
    const parts = [e.preload];
    if (e.length) {
      let out;
      if (e.archive === 0x7fff) out = buf.subarray(dataStart + e.offset, dataStart + e.offset + e.length);
      else {
        const f = base + '_' + String(e.archive).padStart(3, '0') + '.vpk';
        if (!fds.has(f)) fds.set(f, fs.openSync(f, 'r'));
        out = Buffer.alloc(e.length); fs.readSync(fds.get(f), out, 0, e.length, e.offset);
      }
      parts.push(out);
    }
    return Buffer.concat(parts);
  };
  return { entries, read, has: (n) => entries.has(n.toLowerCase()), version };
}
