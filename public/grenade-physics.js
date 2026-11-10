// Grenade flight, shared by the server (the real thing) and the client (the dotted throw preview while the pin is pulled).
import { trace } from './physics.js';
import { GRENADE } from './weapon-defs.js';

const HULL = [[-2, -2, -2], [2, 2, 2]];

/** Start position and velocity of a grenade thrown by a player { eye, yaw, pitch, v } with power 0.25..1. */
export function launch(world, limit, p, power) {
  const down = (-p.pitch * 180) / Math.PI, speed = Math.min(Math.max((90 - down) * 6, 0), GRENADE.speedMax) * power;
  const ap = p.pitch + 0.17 * (1 - Math.abs(p.pitch) / 1.57), cp = Math.cos(ap); // thrown a little above the crosshair
  const fwd = [cp * Math.cos(p.yaw), cp * Math.sin(p.yaw), Math.sin(ap)], eye = p.eye;
  const r = trace(world, eye, [eye[0] + fwd[0] * 16, eye[1] + fwd[1] * 16, eye[2] + fwd[2] * 16], HULL[0], HULL[1], limit);
  return { o: [...r.end], v: fwd.map((c, i) => c * speed + (i < 2 ? p.v[i] * 1.25 : 0)), rest: 0 };
}

/** One step of dt seconds on g { o, v, rest }; returns the impact speed when it bounced, else 0. */
export function stepFlight(world, limit, g, dt) {
  if (g.rest) return 0;
  g.v[2] -= GRENADE.gravity * 800 * dt;
  const to = g.o.map((c, i) => c + g.v[i] * dt), r = trace(world, g.o, to, HULL[0], HULL[1], limit);
  if (!r.normal) { if (r.startSolid) g.v = [0, 0, 0]; else g.o = to; return 0; }
  g.o = [...r.end];
  const n = r.normal, vn = g.v[0] * n[0] + g.v[1] * n[1] + g.v[2] * n[2], speed = Math.hypot(...g.v);
  g.v = g.v.map((c, i) => (c - 2 * vn * n[i]) * GRENADE.bounce);
  if (n[2] > 0.7) { g.v[0] *= GRENADE.friction; g.v[1] *= GRENADE.friction; }
  if (n[2] > 0.7 && Math.hypot(...g.v) < 25) { g.v = [0, 0, 0]; g.rest = 1; }
  return speed;
}
