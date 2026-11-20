import assert from 'node:assert/strict';
import { makeWorld, trace } from './public/physics.js';
import { resolveSpawn } from './public/spawn.js';
import { cleanNav } from './server/nav.mjs';
function box(x0, y0, z0, x1, y1, z1) {
  return [x0,y0,z0,x1,y1,z1, 1,0,0,x1, -1,0,0,-x0, 0,1,0,y1, 0,-1,0,-y0, 0,0,1,z1, 0,0,-1,-z0];
}
const floor = box(-1000,-1000,-50,1000,1000,0);
const empty = makeWorld([floor]);
assert(Math.abs(resolveSpawn(empty,[0,0,4])[2] - 0.5) < 0.04);
assert(Math.abs(resolveSpawn(empty,[0,0,-2])[2] - 0.5) < 0.04, 'recover from slightly embedded floor');
const furniture = makeWorld([floor, box(12,-20,0,50,20,128)]);
const origin = [0,0,3], safe = resolveSpawn(furniture,origin);
assert(Math.abs(safe[2] - 0.5) < 0.04,'prefer nearby floor to top of cabinet');
assert(Math.hypot(safe[0],safe[1]) <= 16,'keep relocation local');
assert(!trace(furniture,safe,safe,[-16,-16,0],[16,16,62]).startSolid);
assert.throws(()=>resolveSpawn(makeWorld([]),origin),/No safe spawn/,'do not silently spawn in void');
const raw = { nodes: [[-80,0,0],[24,0,0],[-120,0,0]], edges: [[[1,0],[2,1]],[[0,0]],[[0,0],[999,0]]] };
assert.deepEqual(cleanNav(furniture,raw),{nodes:[[-80,0,0],[-120,0,0]],edges:[[[1,1]],[[0,0]]]},'remove embedded nodes, preserve/remap valid links');
assert.deepEqual(raw.nodes[1],[24,0,0],'cache validation does not mutate input');
console.log('Map spawn recovery and navigation regression checks passed');
