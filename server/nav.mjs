// Bot navigation: a grid of walkable floor points flood-filled from the spawns with real player-hull traces, and A* over it.
// Built once per map and cached as nav.json next to world.json.
import fs from 'fs';
import path from 'path';
import { trace } from '../public/physics.js';

const STEP = 40, MAX_STEP_UP = 18, MAX_JUMP_UP = 44, MAX_DROP = 200, MAX_NODES = 40000; // MAX_DROP: Source's fall damage starts at 580 u/s, ~210 units of fall (cs_agency's CT helipad is a 138-unit drop)
const MINS = [-16, -16, 0], MAXS = [16, 16, 72]; // the standing player hull: bots walk upright, so crouch-only gaps are not paths
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

export function loadOrBuildNav(world, spawns, mapDir) {
  const file = path.join(mapDir, 'nav.json');
  try { return fromJson(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { /* build below */ }
  const t0 = performance.now(), nav = build(world, spawns);
  fs.writeFileSync(file, JSON.stringify({ nodes: nav.nodes.map((n) => n.o.map((v) => Math.round(v * 10) / 10)), edges: nav.edges }));
  console.log(`nav built: ${nav.nodes.length} nodes in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  return nav;
}

// the floor under (x, y) near height z: the hull is dropped from `up` above (to climb steps); under a doorway that start is inside the
// frame, so lower starts are tried before giving up
const floorAt = (world, x, y, z, up = 46, down = MAX_DROP + 2) => {
  for (const u of [up, 20, 2]) {
    if (u > up) continue;
    const r = trace(world, [x, y, z + u], [x, y, z - down], MINS, MAXS);
    if (r.startSolid) continue;
    return r.fraction < 1 && r.normal && r.normal[2] >= 0.7 ? [x, y, r.end[2]] : null;
  }
  return null;
};

function build(world, spawns) {
  const key = (x, y, z) => `${Math.round(x / STEP)},${Math.round(y / STEP)},${Math.round(z / 56)}`;
  const nodes = [], ids = new Map(), edges = [];
  const add = (o) => { const k = key(...o); if (ids.has(k)) return ids.get(k); ids.set(k, nodes.length); nodes.push({ o }); edges.push([]); return nodes.length - 1; };
  const queue = [];
  for (const s of spawns) { const o = floorAt(world, s.o[0], s.o[1], s.o[2], 8, 200) ?? floorAt(world, s.o[0], s.o[1], s.o[2], 60, 200) ?? floorAt(world, s.o[0], s.o[1], s.o[2], 130, 300); if (o) queue.push(add(o)); }
  for (let qi = 0; qi < queue.length && nodes.length < MAX_NODES; qi++) {
    const a = queue[qi], [x, y, z] = nodes[a].o;
    for (const [dx, dy] of DIRS) {
      const t = floorAt(world, x + dx * STEP, y + dy * STEP, z);
      if (!t) continue;
      const rise = t[2] - z;
      if (rise > MAX_JUMP_UP) continue;
      const hz = Math.max(z, t[2]) + 8; // sweep the hull across just above the higher floor (rough terrain has small bumps)
      const sweep = trace(world, [x, y, hz], [t[0], t[1], hz], MINS, MAXS);
      if (sweep.startSolid || sweep.fraction < 1) continue;
      const before = ids.size, b = add(t);
      if (ids.size > before) queue.push(b);
      edges[a].push([b, rise > MAX_STEP_UP ? 1 : 0]);
    }
  }
  return fromJson({ nodes: nodes.map((n) => n.o), edges });
}

function fromJson({ nodes, edges }) {
  const grid = new Map();
  nodes = nodes.map((o, i) => { const n = { o, i }; const k = `${Math.round(o[0] / STEP)},${Math.round(o[1] / STEP)}`; (grid.get(k) ?? grid.set(k, []).get(k)).push(n); return n; });
  return { nodes, edges, grid };
}

/** Nearest graph node to a point (same floor), or -1. */
export function nearest(nav, p) {
  const cx = Math.round(p[0] / STEP), cy = Math.round(p[1] / STEP);
  let best = -1, bd = Infinity;
  for (let r = 0; r <= 2 && best < 0; r++) for (let dx = -r; dx <= r; dx++) for (let dy = -r; dy <= r; dy++) {
    for (const n of nav.grid.get(`${cx + dx},${cy + dy}`) ?? []) {
      const d = Math.hypot(n.o[0] - p[0], n.o[1] - p[1]) + Math.abs(n.o[2] - p[2]) * 2;
      if (Math.abs(n.o[2] - p[2]) < 80 && d < bd) { bd = d; best = n.i; }
    }
  }
  return best;
}

/** A* between node ids; returns [{ o, jump }] (excluding the start) or null. */
export function findPath(nav, from, to) {
  if (from < 0 || to < 0) return null;
  const g = new Map([[from, 0]]), prev = new Map(), open = [[0, from]], closed = new Set();
  const h = (i) => Math.hypot(nav.nodes[i].o[0] - nav.nodes[to].o[0], nav.nodes[i].o[1] - nav.nodes[to].o[1], (nav.nodes[i].o[2] - nav.nodes[to].o[2]) * 0.5);
  while (open.length) {
    let bi = 0; for (let i = 1; i < open.length; i++) if (open[i][0] < open[bi][0]) bi = i; // small graphs per query region: a linear scan is fine
    const [, cur] = open.splice(bi, 1)[0];
    if (cur === to) { const out = []; for (let n = to; n !== from; n = prev.get(n).from) out.push({ o: nav.nodes[n].o, jump: prev.get(n).jump }); return out.reverse(); }
    if (closed.has(cur)) continue; closed.add(cur);
    for (const [nb, jump] of nav.edges[cur]) {
      const o = nav.nodes[cur].o, p = nav.nodes[nb].o, cost = g.get(cur) + Math.hypot(o[0] - p[0], o[1] - p[1], o[2] - p[2]) + (jump ? 30 : 0);
      if (cost < (g.get(nb) ?? Infinity)) { g.set(nb, cost); prev.set(nb, { from: cur, jump }); open.push([cost + h(nb), nb]); }
    }
  }
  return null;
}
