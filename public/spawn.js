// Resolve an imported point to nearby walkable ground without putting it on top of furniture.
import { trace } from './physics.js';
const MINS = [-16, -16, 0], MAXS = [16, 16, 62];
export function resolveSpawn(world, origin) {
  const candidate = (x, y, lift) => {
    const start = [x, y, origin[2] + lift];
    if (trace(world, start, start, MINS, MAXS).startSolid) return null;
    const down = trace(world, start, [x, y, start[2] - 400], MINS, MAXS);
    if (down.startSolid || down.fraction === 1 || !(down.normal?.[2] >= 0.7)) return null;
    const o = [x, y, down.end[2] + 0.5];
    if (trace(world, o, o, MINS, MAXS).startSolid) return null;
    return o;
  };
  const direct = candidate(origin[0], origin[1], 0);
  if (direct) return direct;
  let best = null, score = Infinity;
  // A few sideways units are preferable to lifting a hostage onto the top of a cabinet.
  for (const radius of [0, 8, 16, 24, 32, 48, 64]) for (const lift of [0, 16, 32, 64, 96, 128]) {
    for (let a = 0; a < (radius ? 8 : 1); a++) {
      const angle = a * Math.PI / 4, o = candidate(origin[0] + radius * Math.cos(angle), origin[1] + radius * Math.sin(angle), lift);
      if (!o) continue;
      const cost = radius + Math.abs(o[2] - origin[2]) * 2;
      if (cost < score) { best = o; score = cost; }
    }
    if (best && score <= radius) return best;
  }
  if (!best) throw new Error(`No safe spawn near ${origin.join(', ')}`);
  return best;
}
