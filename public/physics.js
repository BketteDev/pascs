// Port of Counter-Strike: Source player movement (CGameMovement + CCSGameMovement, Source SDK).
// Units: Source inches, z-up. No DOM deps, so it runs in Node tests too.
// Reference: game/shared/gamemovement.cpp, game/shared/cstrike/cs_gamemovement.cpp, cs_gamerules.cpp (hull/view vectors).

export const TICK_RATE = 128;       // server + client simulate usercmds at 128 Hz
export const TICK = 1 / TICK_RATE;  // frametime of every usercmd
const GRAVITY = 800, ACCELERATE = 5, AIR_ACCELERATE = 10, FRICTION = 4, STOP_SPEED = 75, MAX_VELOCITY = 3500;
const STEP_SIZE = 18, DIST_EPSILON = 0.03125, AIR_SPEED_CAP = 30;
const STAMINA_MAX = 100, STAMINA_COST_JUMP = 25, STAMINA_RECOVER_RATE = 19;   // cs_gamemovement.cpp
const BUNNYJUMP_MAX_SPEED_FACTOR = 1.1;                                       // sv_enablebunnyhopping 0
const JUMP_VELOCITY = Math.sqrt(2 * 800 * 57.0);                              // 301.993
const TIME_TO_DUCK = 0.4, TIME_TO_UNDUCK = 0.2;
const DUCK_MODIFIER = 0.34, WALK_MODIFIER = 0.52, CLIENT_SPEED = 450;         // cl_forwardspeed / cl_sidespeed
export const RUN_SPEED = 250;                                                 // knife / pistols; weapons will override Player.maxSpeed

export const HULL_MINS = [-16, -16, 0], HULL_STAND = [16, 16, 62], HULL_DUCK = [16, 16, 45];
export const VIEW_STAND = 64, VIEW_DUCK = 47;

const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const madd = (a, b, t) => [a[0] + b[0] * t, a[1] + b[1] * t, a[2] + b[2] * t];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const spline = (x) => x * x * (3 - 2 * x);
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// ---------- collision world: convex entries [minx,miny,minz,maxx,maxy,maxz,(nx,ny,nz,d)*] in a 2D grid ----------
const CELL = 256;
const TRI_THICKNESS = 16;
// A displacement triangle is solid as a thin prism. By the separating-axis theorem a box overlaps a convex prism iff no axis
// separates them, so the prism "inflated by the box" is the intersection of one slab per axis (box faces, prism faces, edge x edge).
// trace() already expands each plane by the box extents, which makes box-vs-triangle sweeps exact (correct edge/vertex normals too).
function triPlanes(a, b, c) {
  const sub = (p, q) => [p[0] - q[0], p[1] - q[1], p[2] - q[2]];
  const unit = (v) => { const l = Math.hypot(v[0], v[1], v[2]); return l < 1e-4 ? null : [v[0] / l, v[1] / l, v[2] / l]; };
  const n = unit(cross(sub(b, a), sub(c, a)));
  if (!n) return null;
  const edges = [sub(b, a), sub(c, b), sub(a, c)], X = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
  const axes = [...X, n, ...edges.map((e) => cross(e, n)), ...[...edges, n].flatMap((e) => X.map((x) => cross(e, x)))].map(unit).filter(Boolean);
  const pts = [a, b, c, ...[a, b, c].map((p) => [p[0] - n[0] * TRI_THICKNESS, p[1] - n[1] * TRI_THICKNESS, p[2] - n[2] * TRI_THICKNESS])];
  const out = [];
  for (const ax of axes) {
    const d = pts.map((p) => dot(ax, p)), hi = Math.max(...d), lo = Math.min(...d);
    out.push(ax[0], ax[1], ax[2], hi, -ax[0], -ax[1], -ax[2], -lo);
  }
  return out;
}
export function makeWorld(raw) {
  // entries: convex brush [bounds(6), (nx,ny,nz,d)*] or triangle [bounds(6), 9 vertex coords] (length 15)
  const entries = raw.map((e) => { if (e.length !== 15) return e; const p = triPlanes(e.slice(6, 9), e.slice(9, 12), e.slice(12, 15)); return p ? Float32Array.from([...e.slice(0, 6), ...p]) : [0, 0, 0, 0, 0, 0]; });
  const cells = new Map();
  entries.forEach((e, i) => {
    for (let x = Math.floor(e[0] / CELL); x <= Math.floor(e[3] / CELL); x++) for (let y = Math.floor(e[1] / CELL); y <= Math.floor(e[4] / CELL); y++) {
      const k = x + ',' + y;
      (cells.get(k) ?? cells.set(k, []).get(k)).push(i);
    }
  });
  return { entries, cells, stamp: new Uint32Array(entries.length), tick: 0 };
}

// Box sweep vs convex brushes (VBSP bevels make axial boxes exact). Returns {fraction,end,normal|null,startSolid,allSolid}.
export function trace(world, start, end, mins, maxs, limit = Infinity, skip = null) { // limit: ignore entries with index >= limit (bullets skip player-only clips)
  const EPS = DIST_EPSILON;
  const r = { fraction: 1, normal: null, startSolid: false, allSolid: false };
  const lo = [0, 1, 2].map((a) => Math.min(start[a], end[a]) + mins[a] - 1), hi = [0, 1, 2].map((a) => Math.max(start[a], end[a]) + maxs[a] + 1);
  const stamp = ++world.tick;
  for (let cx = Math.floor(lo[0] / CELL); cx <= Math.floor(hi[0] / CELL); cx++) for (let cy = Math.floor(lo[1] / CELL); cy <= Math.floor(hi[1] / CELL); cy++) {
    for (const idx of world.cells.get(cx + ',' + cy) ?? []) {
      if (idx >= limit || world.stamp[idx] === stamp || skip?.has(idx)) continue;
      world.stamp[idx] = stamp;
      const b = world.entries[idx];
      if (b[0] > hi[0] || b[1] > hi[1] || b[2] > hi[2] || b[3] < lo[0] || b[4] < lo[1] || b[5] < lo[2]) continue;
      let enter = -1, leave = 1, getOut = false, startOut = false, clip = null, miss = false;
      for (let i = 6; i < b.length; i += 4) {
        const nx = b[i], ny = b[i + 1], nz = b[i + 2];
        const dist = b[i + 3] - ((nx < 0 ? maxs[0] : mins[0]) * nx + (ny < 0 ? maxs[1] : mins[1]) * ny + (nz < 0 ? maxs[2] : mins[2]) * nz);
        const d1 = start[0] * nx + start[1] * ny + start[2] * nz - dist, d2 = end[0] * nx + end[1] * ny + end[2] * nz - dist;
        if (d2 > 0) getOut = true;
        if (d1 > 0) startOut = true;
        if (d1 > 0 && (d2 >= EPS || d2 >= d1 - 1e-4)) { miss = true; break; } // 1e-4: motion parallel to a plane (after clipping) must not count as "into" it by float noise
        if (d1 <= 0 && d2 <= 0) continue;
        if (d1 > d2) { const f = (d1 - EPS) / (d1 - d2); if (f > enter) { enter = f; clip = [nx, ny, nz]; } }
        else { const f = (d1 + EPS) / (d1 - d2); if (f < leave) leave = f; }
      }
      if (miss) continue;
      if (!startOut) { r.startSolid = true; if (!getOut) r.allSolid = true; continue; }
      if (enter < leave && enter > -1 && enter < r.fraction) { r.fraction = Math.max(enter, 0); r.normal = clip; r.entry = idx; }
    }
  }
  r.end = madd(start, [end[0] - start[0], end[1] - start[1], end[2] - start[2]], r.fraction);
  return r;
}

// Velocity clip against a plane (CGameMovement::ClipVelocity).
function clipVelocity(v, n, overbounce) {
  const out = madd(v, n, -dot(v, n) * overbounce);
  const adjust = dot(out, n);
  return adjust < 0 ? madd(out, n, -adjust) : out;
}

export class Player {
  constructor(world, origin = [0, 0, 0]) {
    this.world = world; this.o = origin; this.v = [0, 0, 0];
    this.yaw = 0; this.pitch = 0;                // radians
    this.maxSpeed = RUN_SPEED;                   // weapon max speed (player->m_flMaxspeed)
    this.onGround = false;
    this.ducked = false; this.ducking = false; this.ducktime = 0;   // FL_DUCKING/m_bDucked, m_bDucking, m_flDucktime (ms)
    this.stamina = 0;                            // ms
    this.oldJump = false; this.oldDuck = false;  // m_nOldButtons
    this.velMod = 1;                             // m_flVelocityModifier: getting shot slows you (tagging), recovers over ~1.5 s
    this.eyeZ = VIEW_STAND;
    this.prev = { o: [...origin], eyeZ: VIEW_STAND };
    this.dt = TICK;
    this.others = null;                          // () => [{ o, ducked }]: the other live players, who are solid to us
  }

  get hullMaxs() { return this.ducked ? HULL_DUCK : HULL_STAND; }
  get eye() { return [this.o[0], this.o[1], this.o[2] + this.eyeZ]; }
  eyeAt(alpha) { // render interpolation between the last two ticks
    const p = this.prev;
    return [p.o[0] + (this.o[0] - p.o[0]) * alpha, p.o[1] + (this.o[1] - p.o[1]) * alpha, p.o[2] + (this.o[2] - p.o[2]) * alpha + p.eyeZ + (this.eyeZ - p.eyeZ) * alpha];
  }
  tr(a, b, mins = HULL_MINS, maxs = this.hullMaxs) { return trace(this.world, a, b, mins, maxs); }

  // ---------- ground detection ----------
  setGround(g) { this.onGround = g; if (g) this.v[2] = 0; }
  categorizePosition() {
    const point = [this.o[0], this.o[1], this.o[2] - 2];
    if (this.v[2] > 140) return this.setGround(false); // shooting up fast: a jump, not standing
    let pm = this.tr(this.o, point);
    if (!pm.normal || pm.normal[2] < 0.7) {
      // try four sub-boxes for a shallower slope we can stand on (TryTouchGroundInQuadrants)
      const mx = this.hullMaxs, mn = HULL_MINS;
      const quads = [
        [mn, [Math.min(0, mx[0]), Math.min(0, mx[1]), mx[2]]],
        [[Math.max(0, mn[0]), Math.max(0, mn[1]), mn[2]], mx],
        [[mn[0], Math.max(0, mn[1]), mn[2]], [Math.min(0, mx[0]), mx[1], mx[2]]],
        [[Math.max(0, mn[0]), mn[1], mn[2]], [mx[0], Math.min(0, mx[1]), mx[2]]],
      ];
      let found = null;
      for (const [a, b] of quads) { const q = this.tr(this.o, point, a, b); if (q.normal && q.normal[2] >= 0.7) { found = q; break; } }
      pm = found;
    }
    this.setGround(!!pm && !!pm.normal && pm.normal[2] >= 0.7);
  }
  stayOnGround() {
    let start = [this.o[0], this.o[1], this.o[2] + 2];
    const end = [this.o[0], this.o[1], this.o[2] - STEP_SIZE];
    start = this.tr(this.o, start).end;
    const t = this.tr(start, end);
    if (t.fraction > 0 && t.fraction < 1 && !t.startSolid && t.normal[2] >= 0.7 && Math.abs(this.o[2] - t.end[2]) > 0.5 / 8) this.o = t.end;
  }

  // ---------- sliding (TryPlayerMove) ----------
  tryPlayerMove() {
    const planes = [], primal = [...this.v];
    let orig = [...this.v], allFraction = 0, tleft = this.dt;
    for (let bump = 0; bump < 4; bump++) {
      if (len(this.v) === 0) break;
      const pm = this.tr(this.o, madd(this.o, this.v, tleft));
      allFraction += pm.fraction;
      if (pm.allSolid) { this.v = [0, 0, 0]; return; }
      if (pm.fraction > 0) {
        if (pm.fraction === 1) { // swept box may succeed while ending embedded; re-test unswept
          const s = this.tr(pm.end, pm.end);
          if (s.startSolid || s.fraction !== 1) { this.v = [0, 0, 0]; break; }
        }
        this.o = pm.end; orig = [...this.v]; planes.length = 0;
      }
      if (pm.fraction === 1) break;
      tleft -= tleft * pm.fraction;
      if (planes.length >= 5) { this.v = [0, 0, 0]; break; }
      planes.push(pm.normal);
      if (planes.length === 1 && !this.onGround) { // airborne first impact: slide (sv_bounce is 0)
        orig = clipVelocity(orig, planes[0], 1); this.v = [...orig];
      } else {
        let i = 0;
        for (; i < planes.length; i++) {
          this.v = clipVelocity(orig, planes[i], 1);
          if (planes.every((q, j) => j === i || dot(this.v, q) >= 0)) break;
        }
        if (i === planes.length) { // crease: slide along the intersection of the two planes
          if (planes.length !== 2) { this.v = [0, 0, 0]; break; }
          let d = cross(planes[0], planes[1]); const l = len(d); d = d.map((x) => x / l);
          this.v = madd([0, 0, 0], d, dot(d, this.v));
        }
        if (dot(this.v, primal) <= 0) { this.v = [0, 0, 0]; break; } // don't oscillate in sloped corners
      }
    }
    if (allFraction === 0) this.v = [0, 0, 0];
  }

  stepMove(dest) {
    const pos = [...this.o], vel = [...this.v];
    this.tryPlayerMove();                       // slide along the ground
    const downPos = this.o, downVel = this.v;
    this.o = pos; this.v = vel;
    let t = this.tr(this.o, [this.o[0], this.o[1], this.o[2] + STEP_SIZE + DIST_EPSILON]); // up a stair height
    if (!t.startSolid && !t.allSolid) this.o = t.end;
    this.tryPlayerMove();
    t = this.tr(this.o, [this.o[0], this.o[1], this.o[2] - STEP_SIZE - DIST_EPSILON]);     // and back down
    if (!t.normal || t.normal[2] < 0.7) { this.o = downPos; this.v = downVel; return; }    // not standing: use the flat attempt
    if (!t.startSolid && !t.allSolid) this.o = t.end;
    const d2 = (p) => (p[0] - pos[0]) ** 2 + (p[1] - pos[1]) ** 2;
    if (d2(downPos) > d2(this.o)) { this.o = downPos; this.v = downVel; } else this.v[2] = downVel[2];
  }

  // ---------- acceleration ----------
  accelerate(dir, wishspeed, accel) {
    const add = wishspeed - dot(this.v, dir);
    if (add <= 0) return;
    this.v = madd(this.v, dir, Math.min(accel * this.dt * wishspeed, add));
  }
  airAccelerate(dir, wishspeed, accel) {
    const wishspd = Math.min(wishspeed, AIR_SPEED_CAP);
    const add = wishspd - dot(this.v, dir);
    if (add <= 0) return;
    this.v = madd(this.v, dir, Math.min(accel * wishspeed * this.dt, add)); // note: full (uncapped) wishspeed scales the step
  }
  wish() {
    const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw), f = this.fmove, s = this.smove;
    let w = [cy * f + sy * s, sy * f - cy * s, 0];
    let ws = len(w);
    if (ws > 0) w = w.map((x) => x / ws);
    return { dir: w, speed: Math.min(ws, this.moveMax) };
  }

  friction() {
    const speed = len(this.v);
    if (speed < 0.1) return;
    if (this.onGround) {
      const control = speed < STOP_SPEED ? STOP_SPEED : speed;
      const ns = Math.max(speed - control * FRICTION * this.dt, 0) / speed;
      this.v = this.v.map((x) => x * ns);
    }
  }

  walkMove() {
    if (this.stamina > 0) { // CCSGameMovement::WalkMove: stamina bleeds ground speed
      let ratio = (STAMINA_MAX - (this.stamina / 1000) * STAMINA_RECOVER_RATE) / STAMINA_MAX;
      ratio = Math.pow(ratio, this.dt / (1 / 70));
      this.v[0] *= ratio; this.v[1] *= ratio;
    }
    const { dir, speed } = this.wish();
    this.v[2] = 0;
    this.accelerate(dir, speed, ACCELERATE);
    this.v[2] = 0;
    if (len(this.v) < 1) { this.v = [0, 0, 0]; return; }
    const dest = [this.o[0] + this.v[0] * this.dt, this.o[1] + this.v[1] * this.dt, this.o[2]];
    const pm = this.tr(this.o, dest);
    if (pm.fraction === 1) { this.o = pm.end; this.stayOnGround(); return; }
    this.stepMove(dest);
    this.stayOnGround();
  }
  airMove() {
    const { dir, speed } = this.wish();
    this.airAccelerate(dir, speed, AIR_ACCELERATE);
    this.tryPlayerMove();
  }

  // ---------- jumping (CCSGameMovement::CheckJumpButton) ----------
  checkJump() {
    if (!this.onGround) { this.oldJump = true; return; }
    if (this.oldJump) return;               // no pogo-sticking: the button must be released first (no autohop)
    // PreventBunnyJumping: crop 3D speed to 1.1 * weapon max speed
    const cap = BUNNYJUMP_MAX_SPEED_FACTOR * this.maxSpeed, spd = len(this.v);
    if (spd > cap) this.v = this.v.map((x) => x * (cap / spd));
    this.setGround(false);
    if (this.ducking || this.ducked) this.v[2] = JUMP_VELOCITY; else this.v[2] += JUMP_VELOCITY;
    if (this.stamina > 0) this.v[2] *= (STAMINA_MAX - (this.stamina / 1000) * STAMINA_RECOVER_RATE) / STAMINA_MAX;
    this.stamina = (STAMINA_COST_JUMP / STAMINA_RECOVER_RATE) * 1000;
    this.v[2] -= GRAVITY * this.dt * 0.5;   // FinishGravity() inside CheckJumpButton
    this.oldJump = true;
  }

  // ---------- ducking (CCSGameMovement::Duck) ----------
  canUnduck() {
    const stand = HULL_STAND;
    let end = [...this.o];
    if (!this.onGround) end[2] -= 0.5 * (HULL_STAND[2] - HULL_DUCK[2]);
    const t = this.tr(this.o, end, HULL_MINS, stand);
    return !(t.startSolid || t.fraction !== 1);
  }
  finishDuck() {
    this.eyeZ = VIEW_DUCK; this.ducking = false;
    if (!this.ducked) {
      if (!this.onGround) this.o = [this.o[0], this.o[1], this.o[2] + 0.5 * (HULL_STAND[2] - HULL_DUCK[2])];
      this.ducked = true;
    }
    this.categorizePosition();
  }
  finishUnduck() {
    if (!this.onGround) this.o = [this.o[0], this.o[1], this.o[2] - 0.5 * (HULL_STAND[2] - HULL_DUCK[2])];
    this.ducked = false; this.ducking = false; this.eyeZ = VIEW_STAND; this.ducktime = 0;
    this.categorizePosition();
  }
  duck(inp) {
    const pressed = inp.duck && !this.oldDuck, released = !inp.duck && this.oldDuck;
    this.oldDuck = !!inp.duck;
    if (inp.duck || this.ducking || this.ducked) { this.fmove *= DUCK_MODIFIER; this.smove *= DUCK_MODIFIER; } // HandleDuckingSpeedCrop
    if (!(inp.duck || this.ducking || this.ducked)) return;
    const duckSeconds = () => Math.max(0, 1000 - this.ducktime) / 1000;
    if (inp.duck) {
      const already = this.ducked;
      if (pressed && !this.ducked) { this.ducktime = 1000; this.ducking = true; }
      if (this.ducking) {
        if (duckSeconds() > TIME_TO_DUCK || !this.onGround || already) this.finishDuck();
        else this.eyeZ = VIEW_DUCK * spline(duckSeconds() / TIME_TO_DUCK) + VIEW_STAND * (1 - spline(duckSeconds() / TIME_TO_DUCK));
      }
    } else {
      if (released && this.ducked) { this.ducktime = 1000; this.ducking = true; }
      if (this.canUnduck()) {
        if (this.ducking || this.ducked) {
          if (duckSeconds() > TIME_TO_UNDUCK || !this.onGround) this.finishUnduck();
          else { const f = spline(1 - duckSeconds() / TIME_TO_UNDUCK); this.eyeZ = VIEW_DUCK * f + VIEW_STAND * (1 - f); }
        }
      } else this.ducktime = 1000; // stuck under something: restart the stand-up timer
    }
  }

  // CheckStuck: if the hull is embedded in solid (rounding, spawning in a prop, a prop moving in), pop out to the nearest free spot.
  checkStuck() {
    if (!this.tr(this.o, this.o).startSolid) return;
    for (const r of [1, 2, 3, 4, 6, 8, 12, 16, 24, 32, 48]) for (let dz = -1; dz <= 1; dz++) for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      if (!dx && !dy && !dz) continue;
      const p = [this.o[0] + dx * r, this.o[1] + dy * r, this.o[2] + dz * r];
      if (!this.tr(p, p).startSolid) { this.o = p; return; }
    }
  }

  checkVelocity() { this.v = this.v.map((x) => Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, x))); }

  /**
   * One usercmd (TICK seconds). inp = { fwd, side (-1..1), jump (button HELD), duck (held), walk (held, +speed) }.
   * Order mirrors CGameMovement::PlayerMove -> FullWalkMove.
   */
  tick(inp, dt = TICK) {
    this.dt = dt;
    this.prev = { o: [...this.o], eyeZ: this.eyeZ };

    // CheckParameters: client sends 450 per held key; the vector is clamped to maxspeed (walk key scales it by 0.52)
    this.moveMax = this.maxSpeed * (inp.walk ? WALK_MODIFIER : 1) * this.velMod;
    if (this.velMod < 1) this.velMod = Math.min(1, this.velMod + dt / 3);
    this.fmove = (inp.fwd ?? 0) * CLIENT_SPEED; this.smove = (inp.side ?? 0) * CLIENT_SPEED;
    const spd = Math.hypot(this.fmove, this.smove);
    if (spd > this.moveMax) { const r = this.moveMax / spd; this.fmove *= r; this.smove *= r; }

    // ReduceTimers
    const ms = dt * 1000;
    if (this.stamina > 0) this.stamina = Math.max(0, this.stamina - ms);
    if (this.ducktime > 0) this.ducktime = Math.max(0, this.ducktime - ms);

    this.checkStuck();
    if (this.v[2] > 250) this.setGround(false);
    this.duck(inp);

    // FullWalkMove
    this.v[2] -= GRAVITY * 0.5 * dt;            // StartGravity
    this.checkVelocity();
    if (inp.jump) this.checkJump(); else this.oldJump = false;
    if (this.onGround) { this.v[2] = 0; this.friction(); }
    this.checkVelocity();
    if (this.onGround) this.walkMove(); else this.airMove();
    this.categorizePosition();
    this.checkVelocity();
    this.v[2] -= GRAVITY * dt * 0.5;            // FinishGravity
    if (this.onGround) this.v[2] = 0;
    this.separate();
  }

  // Players are solid to each other: overlapping hulls are pushed apart along the axis of least penetration (so you slide around
  // someone instead of passing through) and you can stand on a head. The same code runs on the server and in client prediction.
  separate() {
    if (!this.others) return;
    const top = this.hullMaxs[2];
    for (const q of this.others()) {
      const qTop = q.ducked ? HULL_DUCK[2] : HULL_STAND[2];
      const dx = this.o[0] - q.o[0], dy = this.o[1] - q.o[1], ox = 32 - Math.abs(dx), oy = 32 - Math.abs(dy);
      if (ox <= 0 || oy <= 0 || Math.min(this.o[2] + top, q.o[2] + qTop) - Math.max(this.o[2], q.o[2]) <= 0) continue;
      if (this.o[2] >= q.o[2] + qTop - 10 && this.v[2] <= 0) { this.o[2] = q.o[2] + qTop; this.v[2] = 0; this.onGround = true; continue; } // landed on a head
      const was = [...this.o];
      if (ox < oy) { this.o[0] += (dx < 0 ? -ox : ox) || ox; if (this.v[0] * dx < 0) this.v[0] = 0; }
      else { this.o[1] += (dy < 0 ? -oy : oy) || oy; if (this.v[1] * dy < 0) this.v[1] = 0; }
      if (this.tr(this.o, this.o).startSolid) this.o = was; // never push into a wall
    }
  }
}
