// Structural and gameplay checks without WebGL. Run one map per process on phones.
import fs from 'node:fs';
import path from 'node:path';
import { createGunzip } from 'node:zlib';
import { MAPS } from '../public/maps.js';
import { resolveSpawn } from '../public/spawn.js';
import { Player, makeWorld, trace } from '../public/physics.js';
import { createMovers } from '../public/movers.js';
import { nearest } from '../server/nav.mjs';
const map = MAPS.find((m) => [m.directory, m.id].includes(process.argv[2]));
if (!map) throw new Error('Choose a map from public/maps.js');
const dir = path.resolve(import.meta.dirname, '../public/maps', map.directory);
const data = JSON.parse(fs.readFileSync(path.join(dir, 'world.json')));
const world = makeWorld(data.collision.concat(data.playerOnly ?? []), data.ladders);
const raw = JSON.parse(fs.readFileSync(path.join(dir, 'nav.json')));
const nav = { nodes: raw.nodes.map((o, i) => ({o, i})), edges: raw.edges, grid: new Map() };
for (const n of nav.nodes) { const key = `${Math.round(n.o[0]/40)},${Math.round(n.o[1]/40)}`; if (!nav.grid.has(key)) nav.grid.set(key, []); nav.grid.get(key).push(n); }
const mins = [-16, -16, 0], maxs = [16, 16, 62];
function settled(s) {
  const p = new Player(world, resolveSpawn(world, s.o));
  for (let t = 0; t < 128; t++) p.tick({});
  return p;
}
const spawns = {};
for (const team of ['ct', 't', 'h']) {
  const sources = team === 'h' ? data.hostages ?? [] : data.spawns[team];
  spawns[team] = sources.map((s, i) => {
    const p = settled(s), stuck = trace(world, p.o, p.o, mins, maxs).startSolid;
    const escapes = [];
    for (let a = 0; a < 8; a++) {
      const q = new Player(world, [...p.o]); q.yaw = a * Math.PI / 4;
      for (let t = 0; t < 96; t++) q.tick({ fwd: 1 });
      escapes.push(Math.hypot(q.o[0] - p.o[0], q.o[1] - p.o[1]));
    }
    return { i, o: p.o.map((v) => Math.round(v * 10) / 10), ground: p.onGround, stuck, escape: Math.round(Math.max(...escapes)), nav: nearest(nav, p.o), fall: Math.round(s.o[2] - p.o[2]) };
  });
}
const reachable = (roots) => {
  const visited = new Set(roots.filter((i) => i >= 0)), queue = [...visited];
  for (let i = 0; i < queue.length; i++) for (const [n] of nav.edges[queue[i]] ?? []) if (!visited.has(n)) { visited.add(n); queue.push(n); }
  return visited;
};
const hostageReach = spawns.h.map((h) => reachable([h.nav]));
for (const team of ['ct', 't']) for (const s of spawns[team]) { const r = reachable([s.nav]); s.enemyReachable = spawns[team === 'ct' ? 't' : 'ct'].some((other) => r.has(other.nav)); s.reachableNodes = r.size; }
const from = Object.fromEntries(['ct', 't'].map((team) => [team, reachable(spawns[team].map((s) => s.nav))]));
const objectives = [];
for (const [i, s] of (data.sites ?? []).entries()) {
  const candidates = nav.nodes.filter(({ o }) => s.min ? o.every((v, k) => v >= s.min[k] - (k === 2 ? 72 : 8) && v <= s.max[k] + (k === 2 ? 32 : 8)) : Math.hypot(o[0] - s.o[0], o[1] - s.o[1]) < 200 && Math.abs(o[2] - s.o[2]) < 120);
  objectives.push({ kind: 'bomb', i, nodes: candidates.length, ct: candidates.some((n) => from.ct.has(n.i)), t: candidates.some((n) => from.t.has(n.i)) });
}
for (const [i, s] of (data.rescue ?? []).entries()) {
  const candidates = nav.nodes.filter(({ o }) => o.every((v, k) => v >= s.min[k] - (k === 2 ? 16 : 0) && v <= s.max[k] + (k === 2 ? 16 : 0)));
  objectives.push({ kind: 'rescue', i, nodes: candidates.length, ct: candidates.some((n) => from.ct.has(n.i)), t: candidates.some((n) => from.t.has(n.i)), hostages: hostageReach.map((r) => candidates.some((n) => r.has(n.i))) });
}
const invalidEdges = nav.edges.flatMap((edges, i) => edges.filter(([n]) => !Number.isInteger(n) || !nav.nodes[n]).map((e) => [i, e]));
const movers = createMovers(world, data.movers);
const opens = (d) => (d.kind === 'door' && !d.locked) || (d.breakable && d.glass);
for (const d of movers.defs) if (opens(d) || (d.parent >= 0 && opens(movers.defs[d.parent]))) for (const i of d.entries) world.entries[i] = [1e9, 1e9, 1e9, -1e9, -1e9, -1e9];
const badNodes = nav.nodes.filter((n) => trace(world, [n.o[0], n.o[1], n.o[2] + 2], [n.o[0], n.o[1], n.o[2] + 2], mins, maxs).startSolid);
const groups = [...data.groups, ...data.props, ...(data.sky?.groups ?? []), ...(data.sky?.props ?? []), ...(data.movers ?? []).flatMap((m) => [...(m.groups ?? []), ...(m.props ?? [])])];
const missingTextures = [...new Set(groups.flatMap((g) => g.tex && !fs.existsSync(path.join(dir, 'tex', g.tex)) ? [g.tex] : []))];
// Stream geometry on phones: verify the whole compressed file without retaining a second large buffer.
const binaryPath = path.join(dir, 'world.bin');
let stream = fs.createReadStream(fs.existsSync(binaryPath) ? binaryPath : binaryPath + '.gz');
if (!fs.existsSync(binaryPath)) stream = stream.pipe(createGunzip());
let bytes = 0, tail = Buffer.alloc(0), nonFinite = 0;
for await (const chunk of stream) {
  bytes += chunk.length;
  const block = tail.length ? Buffer.concat([tail, chunk]) : chunk;
  const aligned = block.length - block.length % 4;
  for (let i = 0; i < aligned; i += 4) if (!Number.isFinite(block.readFloatLE(i))) nonFinite++;
  tail = Buffer.from(block.subarray(aligned));
}
const invalidGeometry = groups.filter(g => !Number.isInteger(g.count) || g.count < 0 || g.count % 3 ||
  Object.entries({pos:3,nrm:3,uv:2,lm:2,col:3}).some(([key, width]) => g[key] != null &&
    (!Number.isInteger(g[key]) || g[key] < 0 || g[key] % 4 || g[key] + g.count * width * 4 > bytes))).length;
const result = {
  map: map.directory, geometry: { bytes, nonFinite, invalidGeometry, trailingBytes: tail.length }, spawns, objectives, nav: { nodes: nav.nodes.length, ctReach: from.ct.size, tReach: from.t.size, ctToT: spawns.t.some((s) => from.ct.has(s.nav)), tToCT: spawns.ct.some((s) => from.t.has(s.nav)), invalidEdges, blockedNodes: badNodes.length, blockedSample: badNodes.slice(0, 5).map((n) => n.o) },
  missingTextures,
};
console.log(JSON.stringify(result));
