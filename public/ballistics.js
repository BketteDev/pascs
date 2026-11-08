// Bullet penetration ("wallbang"), shared by the client (hit detection, bullet holes) and the server (validation, damage).
// A bullet that hits a solid looks for where it leaves it; if the thickness is within what the weapon can punch through for that
// material, it continues with reduced damage. Allowance (units) = weapon.pen * 12 * PEN_FACTOR[surface]; a few layers at most.
import { trace } from './physics.js';

export const PEN_FACTOR = { glass: 6, wood: 3, grass: 0.5, sand: 0.5, gravel: 0.5, concrete: 0.45, tile: 0.45, metal: 0.5 };
const PEN_UNIT = 12, DAMAGE_PER_LAYER = 0.75, MAX_LAYERS = 4;

/**
 * @param ctx { world, limit, surfOf, surfaces }  collision world, index limit for bullets, per-entry surface table
 * @returns { segments: [{ from, len, start, scale, impact? }], coverage }  segments are consecutive pieces of the bullet's path;
 *          `impact` marks the surface that ends a segment (hole decal), `coverage` is how far the bullet got in total.
 */
export function march(ctx, from, dir, maxDist, weapon) {
  const segments = [];
  let pos = from, remaining = maxDist, start = 0, scale = 1, power = (weapon.pen ?? 0) * PEN_UNIT;
  for (let layer = 0; layer <= MAX_LAYERS; layer++) {
    const r = trace(ctx.world, pos, [pos[0] + dir[0] * remaining, pos[1] + dir[1] * remaining, pos[2] + dir[2] * remaining], [0, 0, 0], [0, 0, 0], ctx.limit);
    if (!r.normal) { segments.push({ from: pos, len: remaining, start, scale }); start += remaining; break; }
    const len = r.fraction * remaining, surface = ctx.surfaces?.[ctx.surfOf?.[r.entry] ?? 0] ?? 'concrete';
    segments.push({ from: pos, len, start, scale, impact: { pos: r.end, n: r.normal, surface } });
    start += len; remaining -= len;
    // can it get through? find where it leaves the solid: look back from the far side
    const allowance = (power * (PEN_FACTOR[surface] ?? 0.45)) / 1;
    if (layer === MAX_LAYERS || allowance <= 1 || remaining <= 1) break;
    // walk forward in small steps until the point is outside every solid (the far side of the wall), then look back for the exact exit face
    let free = null;
    for (let d = 2; d <= Math.min(allowance + 2, remaining); d += 2) {
      const p = [r.end[0] + dir[0] * d, r.end[1] + dir[1] * d, r.end[2] + dir[2] * d];
      if (!trace(ctx.world, p, p, [0, 0, 0], [0, 0, 0], ctx.limit).startSolid) { free = p; break; }
    }
    if (!free) break; // still inside solid at the weapon's limit: too thick
    const back = trace(ctx.world, free, r.end, [0, 0, 0], [0, 0, 0], ctx.limit);
    if (!back.normal) break;
    const exit = back.end, thickness = Math.hypot(exit[0] - r.end[0], exit[1] - r.end[1], exit[2] - r.end[2]);
    if (thickness > allowance) break;
    power -= thickness / (PEN_FACTOR[surface] ?? 0.45); // thick/hard layers use up more of the bullet's power
    scale *= DAMAGE_PER_LAYER;
    segments[segments.length - 1].impact.exit = { pos: exit, n: back.normal }; // the bullet came out here: a hole on the far side too
    pos = [exit[0] + dir[0] * 0.5, exit[1] + dir[1] * 0.5, exit[2] + dir[2] * 0.5];
    start += thickness + 0.5; remaining -= thickness + 0.5;
    if (remaining <= 0) break;
  }
  return { segments, coverage: start };
}

/** Damage multiplier (0..1) for a bullet fired from `from` reaching the point `to`; 0 when the walls in between stop it. */
export function reach(ctx, from, to, weapon) {
  const d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]], dist = Math.hypot(...d);
  if (dist < 1e-3) return 1;
  const dir = d.map((v) => v / dist), { segments, coverage } = march(ctx, from, dir, dist, weapon);
  if (coverage < dist - 1) return 0;
  const seg = [...segments].reverse().find((s) => s.start <= dist) ?? segments[0];
  return seg.scale;
}
