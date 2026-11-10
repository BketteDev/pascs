import fs from 'fs';
import assert from 'assert';
import { Player, makeWorld, TICK } from './public/physics.js';
const T = (sec) => Math.round(sec / TICK); // tests are written in seconds so they hold at any tick rate

const world = JSON.parse(fs.readFileSync('public/maps/de_dust2/world.json', 'utf8'));
const L = 1e5; // big synthetic floor (top at z=0) for open-field tests
const floor = [-L, -L, -50, L, L, 0, 0, 0, 1, 0, 0, 0, -1, 50, 1, 0, 0, L, -1, 0, 0, L, 0, 1, 0, L, 0, -1, 0, L];
const field = () => { const p = new Player(makeWorld([floor]), [0, 0, 2]); run(p, T(0.45), {}); return p; };
const run = (p, n, inp) => { for (let i = 0; i < n; i++) p.tick(inp); };
const hs = (p) => Math.hypot(p.v[0], p.v[1]);

// 1. real map: both spawns settle onto the (displaced) ground
const W = makeWorld(world.collision.concat(world.playerOnly));
for (const team of ['ct', 't']) {
  const s = world.spawns[team][0], p = new Player(W, [s.o[0], s.o[1], s.o[2] + 2]); p.yaw = s.yaw * Math.PI / 180;
  run(p, T(1.5), {});
  assert(p.onGround && p.o[2] <= s.o[2] + 1 && s.o[2] - p.o[2] < 64, `${team} spawn settle ${p.o}`);
  run(p, T(2.2), { fwd: 1 });
  console.log(team, 'spawn ok, walked to', p.o.map(Math.round));
}

// 2. ground speeds: run 250, walk 130 (0.52), crouch 85 (0.34)
{ const p = field(); p.yaw = 0; run(p, T(1.5), { fwd: 1 }); assert(Math.abs(hs(p) - 250) < 0.5, 'run ' + hs(p)); }
{ const p = field(); run(p, T(1.5), { fwd: 1, walk: true }); assert(Math.abs(hs(p) - 130) < 0.5, 'walk ' + hs(p)); }
{ const p = field(); run(p, T(1.5), { fwd: 1, side: 1 }); assert(Math.abs(hs(p) - 250) < 0.5, 'diagonal must not exceed maxspeed: ' + hs(p)); }
{ const p = field(); run(p, T(1.5), { fwd: 1, duck: true }); assert(p.ducked && Math.abs(hs(p) - 85) < 0.5, 'duck ' + hs(p)); assert(p.eyeZ === 47); }

// 3. crouch timing: hull switches after 0.4s, stands back up after 0.2s
{ const p = field(); run(p, T(0.3), { duck: true }); assert(!p.ducked && p.ducking, 'still ducking at 0.3s'); run(p, T(0.15), { duck: true }); assert(p.ducked && p.eyeZ === 47, 'ducked at 0.45s');
  run(p, T(0.15), {}); assert(p.ducked, 'still crouched at 0.15s'); run(p, T(0.075), {}); assert(!p.ducked && p.eyeZ === 64, 'standing at 0.225s'); }

// 4. standing jump: apex ~ 57 units (minus Source's double half-gravity step quirk), and holding space never auto-rehops
{ const p = field(); let top = 0, jumps = 0, was = true;
  for (let i = 0; i < T(3); i++) { p.tick({ jump: true }); top = Math.max(top, p.o[2]); if (was && !p.onGround) jumps++; was = p.onGround; }
  console.log('jump apex', top.toFixed(1), 'jumps while holding space', jumps);
  assert(top > 45 && top < 58, 'apex ' + top); assert(jumps === 1, 'no autohop, got ' + jumps); }

// 5. bunnyhop: press only on the landing tick. Takeoff speed is cropped to 1.1*250 = 275, air strafing builds past it,
//    and jump stamina makes consecutive hops lower.
{ const p = field(); let hops = 0, peak = 0, maxTakeoff = 0, vz = [];
  for (let i = 0; i < T(22); i++) {
    const jump = p.onGround; // press exactly when grounded; released while airborne
    const s = hs(p), th = Math.acos(Math.min(1, 27 / Math.max(s, 27))), va = s > 1 ? Math.atan2(p.v[1], p.v[0]) : 0.3;
    p.yaw = Math.atan2(Math.cos(va + th), -Math.sin(va + th)); // optimal strafe angle (wishdir = (sin yaw, -cos yaw) for side=+1)
    const before = p.onGround; p.tick({ side: 1, jump });
    if (before && !p.onGround) { hops++; maxTakeoff = Math.max(maxTakeoff, hs(p)); vz.push(p.v[2]); }
    peak = Math.max(peak, hs(p));
  }
  console.log('bhop hops', hops, 'peak air speed', peak | 0, 'max takeoff speed', maxTakeoff | 0, 'takeoff vz first/second', vz[0] | 0, vz[1] | 0);
  assert(hops > 10); assert(maxTakeoff <= 276.5, 'takeoff cap ' + maxTakeoff); assert(peak > 280, 'strafing should beat the cap in the air: ' + peak);
  assert(vz[1] < vz[0] * 0.95, 'stamina should lower consecutive hops'); }

// 6. stamina: walking right after a jump is slowed
{ const p = field(); run(p, T(1.5), { fwd: 1 }); const before = hs(p); run(p, 1, { fwd: 1, jump: true }); assert(p.stamina > 1000, 'stamina set'); }

// 7. no tunneling when falling fast
{ const p = new Player(makeWorld([floor]), [0, 0, 600]); run(p, T(4.5), {}); assert(p.onGround && Math.abs(p.o[2]) < 0.2, 'landed at ' + p.o[2]); }

// 8. embedded in solid: pops out instead of freezing
{ const p = new Player(makeWorld([floor]), [0, 0, -6]); run(p, 8, {}); assert(p.o[2] >= -0.5 && p.onGround, 'unstuck ' + p.o[2]); }

console.log('physics ok (tick', TICK, 's)');
