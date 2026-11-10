// Ground patches are shared by fire rendering and server damage; all positions use Source z-up units.
import { trace } from './physics.js';
import { GRENADE } from './weapon-defs.js';

const ZERO = [0, 0, 0];
const above = (p) => [p[0], p[1], p[2] + 8];
const clear = (world, limit, a, b) => {
  const r = trace(world, a, b, ZERO, ZERO, limit);
  return !r.startSolid && r.fraction === 1;
};

export function fireCells(world, limit, origin) {
  const floor = trace(world, above(origin), [origin[0], origin[1], origin[2] - 96], ZERO, ZERO, limit);
  if (floor.startSolid || !floor.normal || floor.normal[2] < 0.7) return [];
  const centre = [...floor.end], cells = [centre];
  for (let i = 0; i < 8; i++) {
    const angle = i * Math.PI / 4, radius = GRENADE.fireRadius - GRENADE.fireCellRadius;
    const x = centre[0] + Math.cos(angle) * radius, y = centre[1] + Math.sin(angle) * radius;
    const r = trace(world, [x, y, centre[2] + 24], [x, y, centre[2] - 32], ZERO, ZERO, limit);
    if (!r.startSolid && r.normal?.[2] > 0.7 && clear(world, limit, above(centre), above(r.end))) cells.push([...r.end]);
  }
  return cells;
}

export function fireTouches(world, limit, fire, feet) {
  const growth = Math.min(1, fire.age / 0.6);
  return fire.cells.some((p, i) => (i === 0 || growth > 0.5) && Math.abs(feet[2] - p[2]) < 36 &&
    Math.hypot(feet[0] - p[0], feet[1] - p[1]) < GRENADE.fireCellRadius * growth &&
    clear(world, limit, above(p), above(feet)));
}

export function smokeExtinguishes(world, limit, fire, smoke) {
  return smoke.age < GRENADE.smokeTime - 1 && fire.cells.some((p) =>
    Math.abs(p[2] - smoke.o[2]) < 80 && Math.hypot(p[0] - smoke.o[0], p[1] - smoke.o[1]) < GRENADE.smokeRadius &&
    clear(world, limit, above(p), above(smoke.o)));
}
