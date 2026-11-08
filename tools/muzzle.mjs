// Converts the CS:S effect sprites to PNG: the sniper scope (arc mask + lens dirt), muzzle flashes (grayscale/alpha = additive intensity) and the blood impact particles
// (particle/blood_mist, particle/droplets, as CS:S's blood_impact.pcf uses them), plus the Source blood splatter decals (decals/bloodN,
// mod2x textures: 50% grey = no change), which this machine only has in the CS:GO install.
import fs from 'fs';
import path from 'path';
import { png, vtfToRgba } from './vtf.mjs';
import { readGameFile } from './content.mjs';
const SRC = 'C:/CsPaSource/content/css_content/materials', OUT = path.join(import.meta.dirname, '..', 'public', 'ui');
for (const [file, name] of [['sprites/muzzleflash4', 'muzzle1'], ['effects/muzzleflashx', 'muzzle2'], ['particle/blood_mist/blood_mist', 'blood_mist'], ['particle/droplets/droplets', 'blood_drops'], ['sprites/scope_arc', 'scope_arc'], ['overlays/scope_lens', 'scope_lens']]) {
  const { W, H, rgba } = vtfToRgba(fs.readFileSync(path.join(SRC, file + '.vtf')));
  fs.writeFileSync(path.join(OUT, name + '.png'), png(W, H, 4, rgba));
  console.log(name, W, H);
}
// the Source "Blood" splatter decals (DecalModulate, $decalscale 0.15: 256 px = 38 units), from the CS:GO install's pak
for (const [k, n] of [1, 2, 3, 4, 5, 7, 8].entries()) {
  const vtf = readGameFile(`materials/decals/blood${n}.vtf`);
  if (!vtf) { console.log(`decals/blood${n}: not found (CS:GO not installed?)`); continue; }
  const { W, H, rgba } = vtfToRgba(vtf);
  fs.writeFileSync(path.join(OUT, `blood_decal${k + 1}.png`), png(W, H, 4, rgba));
}
console.log('blood decals: 7');
// CS:S bullet holes (DecalModulate, mod2x like the blood): decals/<surface>/shot1-5; the size in units is texture width * $decalscale
const holeSizes = {};
for (const surf of ['concrete', 'wood', 'metal', 'glass']) {
  holeSizes[surf] = [];
  for (let i = 1; i <= 5; i++) {
    const vtf = readGameFile(`materials/decals/${surf}/shot${i}.vtf`), vmt = readGameFile(`materials/decals/${surf}/shot${i}.vmt`)?.toString('latin1') ?? '';
    if (!vtf) { console.log(`decals/${surf}/shot${i}: not found`); continue; }
    const { W, H, rgba } = vtfToRgba(vtf);
    fs.writeFileSync(path.join(OUT, `hole_${surf}${i}.png`), png(W, H, 4, rgba));
    holeSizes[surf].push(+(W * Number(vmt.match(/\$decalscale"?\s+"?([\d.]+)/i)?.[1] ?? 0.1)).toFixed(1));
  }
}
console.log('bullet holes (units):', JSON.stringify(holeSizes));
