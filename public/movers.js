// Doors and breakable glass: collision entries (part of world.collision, so bullets and movement both see them) whose shape changes
// at runtime. Shared by the server (authoritative state) and the client (prediction + rendering), so both build identical geometry.
// A mover's state is one number: doors = how far open (signed degrees for rotating doors, units for sliding ones), breakables = 1 broken.
const EMPTY = Float32Array.from([1e9, 1e9, 1e9, -1e9, -1e9, -1e9]); // inverted bounds: every trace culls it

function pose(def, v) { // -> (point) => point, (normal) => normal
  if (def.slide) { const m = def.slide.map((c) => c * v); return [(p) => [p[0] + m[0], p[1] + m[1], p[2] + m[2]], (n) => n]; }
  const a = (v * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a), h = def.pivot;
  const rot = (n) => [n[0] * c - n[1] * s, n[0] * s + n[1] * c, n[2]];
  return [(p) => { const r = rot([p[0] - h[0], p[1] - h[1], p[2]]); return [r[0] + h[0], r[1] + h[1], p[2]]; }, rot];
}
// One convex piece moved: its faces plus the world-axis slabs. Doors only turn about z, so their faces stay vertical or horizontal and
// these planes are the exact box-sweep volume (the edge x axis bevels of a general rotation collapse onto them).
export function moverEntry(piece, point, normal) {
  const pts = piece.pts.map(point), out = [];
  const lo = [0, 1, 2].map((k) => Math.min(...pts.map((p) => p[k]))), hi = [0, 1, 2].map((k) => Math.max(...pts.map((p) => p[k])));
  out.push(...lo, ...hi);
  for (const [nx, ny, nz, d] of piece.planes) { const n = normal([nx, ny, nz]), p0 = point([nx * d, ny * d, nz * d]); out.push(...n, n[0] * p0[0] + n[1] * p0[1] + n[2] * p0[2]); }
  for (let k = 0; k < 3; k++) { const n = [0, 0, 0]; n[k] = 1; out.push(...n, hi[k]); n[k] = -1; out.push(...n, -lo[k]); }
  return Float32Array.from(out);
}

export function createMovers(world, defs = []) {
  const state = new Float32Array(defs.length);
  const ID = [(p) => p, (n) => n];
  function shape(i) { // a door follows its own state; glass attached to a door (def.parent) follows the door's
    const def = defs[i], by = def.kind === 'door' ? i : def.parent ?? -1, [point, normal] = by >= 0 ? pose(defs[by], state[by]) : ID;
    def.entries.forEach((idx, k) => { world.entries[idx] = def.breakable && state[i] ? EMPTY : moverEntry(def.pieces[k], point, normal); });
  }
  function apply(i, v) {
    state[i] = v;
    shape(i);
    defs.forEach((d, c) => { if (d.parent === i) shape(c); });
  }
  defs.forEach((_, i) => apply(i, 0)); // the build stored swept bounds (for the grid); start with the exact closed / intact shapes
  return { defs, state, apply, pose: (i, v) => pose(defs[i], v) };
}
