// Penetration: wood and glass can be shot through, thick concrete cannot; damage drops per layer; stronger weapons get further.
import assert from 'assert';
import { makeWorld } from './public/physics.js';
import { march, reach } from './public/ballistics.js';
import { WEAPONS } from './public/weapon-defs.js';

const box = (x0, y0, z0, x1, y1, z1) => [x0, y0, z0, x1, y1, z1, 1, 0, 0, x1, -1, 0, 0, -x0, 0, 1, 0, y1, 0, -1, 0, -y0, 0, 0, 1, z1, 0, 0, -1, -z0];
const surfaces = ['concrete', 'wood', 'glass'];
// along +x at y=0: wood slab x 100..110 (10 thick), glass 200..202, concrete 300..364 (64 thick), wood 400..440 (40 thick)
const world = makeWorld([box(100, -50, -50, 110, 50, 50), box(200, -50, -50, 202, 50, 50), box(300, -50, -50, 364, 50, 50), box(400, -50, -50, 440, 50, 50)]);
const ctx = { world, limit: Infinity, surfaces, surfOf: [1, 2, 0, 1] };
const ak = WEAPONS.ak47, m3 = WEAPONS.m3, awp = WEAPONS.awp, usp = WEAPONS.usp;
const from = [0, 0, 0], dir = [1, 0, 0];

assert.strictEqual(reach(ctx, from, [105 + 10, 0, 0], ak) > 0, true, 'point just behind the thin wood slab is reachable');
const toGlass = reach(ctx, from, [250, 0, 0], ak);
assert(toGlass > 0.5 && toGlass < 0.6, 'wood then glass: two layers -> 0.75^2 = 0.56, got ' + toGlass);
assert.strictEqual(reach(ctx, from, [320, 0, 0], ak), 0, 'inside the thick concrete: blocked');
assert.strictEqual(reach(ctx, from, [380, 0, 0], ak), 0, 'behind 64 units of concrete: blocked');
assert.strictEqual(reach(ctx, from, [105, 0, 0], m3), 0, 'shotgun pellets (pen 0) do not penetrate');
assert(reach(ctx, from, [150, 0, 0], usp) > 0, 'a pistol punches through thin wood');
assert.strictEqual(reach(ctx, from, [250, 0, 0], usp) > 0, true, 'and glass');
// wood 40 thick at x=400: the AK (24*3 = 72 allowance) goes through, a pistol (12*3 = 36) does not
assert.strictEqual(reach(ctx, [310, 0, 0], [450, 0, 0], ak) > 0, true, 'AK through 40 units of wood');
assert.strictEqual(reach(ctx, [310, 0, 0], [450, 0, 0], usp), 0, 'USP cannot get through 40 units of wood');
// march exposes the impact points (for bullet holes) and segments (for hit detection)
const m = march(ctx, from, dir, 1000, ak);
assert(m.segments.length >= 3 && m.segments[0].impact.surface === 'wood', 'first impact is the wood slab: ' + JSON.stringify(m.segments.map((s) => [s.start, s.len, s.impact?.surface])));
assert(m.coverage > 290 && m.coverage < 310, 'stops at the concrete: ' + m.coverage);
console.log('ballistics ok:', m.segments.map((s) => `${s.start.toFixed(0)}+${s.len.toFixed(0)} x${s.scale}${s.impact ? ' ' + s.impact.surface : ''}`).join(' | '));
