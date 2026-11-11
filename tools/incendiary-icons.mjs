// Extract optional equipment icons from a local CS2 installation.
import fs from 'node:fs';
import path from 'node:path';
import { CSGO } from './content.mjs';
import { openVpk } from './vpk.mjs';

const archive = process.argv[2] ?? path.resolve(CSGO, '..', 'game', 'csgo', 'pak01_dir.vpk');
const pack = openVpk(archive);
const icons = ['molotov', 'incgrenade'].map((id) => {
  const data = pack.read(`panorama/images/icons/equipment/${id}.vsvg_c`);
  const start = data?.indexOf('<svg') ?? -1;
  const end = start >= 0 ? data.indexOf('</svg>', start) : -1;
  if (end < 0) throw new Error(`No SVG found for ${id} in ${archive}`);
  return [id, data.subarray(start, end + '</svg>'.length)];
});
const output = path.resolve(import.meta.dirname, '..', 'public', 'ui', 'icons');
fs.mkdirSync(output, { recursive: true });
for (const [id, svg] of icons) fs.writeFileSync(path.join(output, `${id}.svg`), svg);
