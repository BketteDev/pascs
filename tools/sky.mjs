// Skybox faces -> <out>/sky/{ft,bk,lf,rt,up,dn}.png, square (a cube map needs equal square faces).
import fs from 'fs';
import path from 'path';
import { png, vtfToRgba } from './vtf.mjs';
import { readGameFile } from './content.mjs';

/** Returns the names of faces that were missing (copied from de_dust2's sky instead). */
export function writeSky(skyName, out) {
  fs.mkdirSync(path.join(out, 'sky'), { recursive: true });
  const missing = [];
  // CS:GO skies are often only "compressed HDR" (rgb * alpha * 16): one exposure for all six faces puts the brightest 1% just under white
  // (kept linear: gamma-encoding bleaches the clouds)
  const faces = ['ft', 'bk', 'lf', 'rt', 'up', 'dn'].map((f) => {
    try {
      const vmt = readGameFile(`materials/skybox/${skyName}${f}.vmt`)?.toString('latin1').toLowerCase() ?? '';
      // an HDR sky names its LDR picture as $basetexture: use it when it exists, else the sky's own texture (half floats are decoded too)
      const base = vmt.match(/\$basetexture"?\s+"([^"]+)"/)?.[1], ldr = base && readGameFile(`materials/${base}.vtf`);
      return { f, hdr: /\$hdrcompressedtexture/.test(vmt) && !ldr, ...vtfToRgba(ldr ?? readGameFile(`materials/skybox/${skyName}${f}.vtf`)) };
    } catch { return { f, rgba: null }; }
  });
  const hdrVals = faces.filter((x) => x.hdr && x.rgba).flatMap((x) => { const v = []; for (let i = 0; i < x.rgba.length; i += 64) v.push(Math.max(x.rgba[i], x.rgba[i + 1], x.rgba[i + 2]) * x.rgba[i + 3] * 16 / 65025); return v; }).sort((a, b) => a - b);
  const exposure = hdrVals.length ? 0.95 / hdrVals[Math.floor(hdrVals.length * 0.99)] : 1;
  for (const { f, hdr, W, H, rgba } of faces) {
    if (!rgba) { missing.push(f); fs.copyFileSync(path.join(out, '..', 'de_dust2', 'sky', f + '.png'), path.join(out, 'sky', f + '.png')); continue; }
    if (hdr) for (let i = 0; i < rgba.length; i += 4) { const k = (rgba[i + 3] * 16 / 255) * exposure; for (let c = 0; c < 3; c++) rgba[i + c] = Math.round(255 * Math.min(1, (rgba[i + c] / 255) * k)); rgba[i + 3] = 255; }
    // Source side faces are often W x W/2 (the engine stretches them; the lower half is below the horizon), dn can be a tiny swatch.
    // Sides go on the top half with the horizon row repeated below; tiny faces are scaled up.
    const S = Math.max(...faces.filter((x) => x.rgba).map((x) => x.W)), buf = Buffer.alloc(S * S * 4);
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const sx = Math.min(W - 1, Math.floor((x * W) / S)), sy = W < S ? Math.floor((y * H) / S) : Math.min(H - 1, Math.floor((y * W) / S));
      rgba.copy(buf, (y * S + x) * 4, (sy * W + sx) * 4, (sy * W + sx) * 4 + 4);
    }
    fs.writeFileSync(path.join(out, 'sky', f + '.png'), png(S, S, 4, buf));
  }
  return missing;
}
