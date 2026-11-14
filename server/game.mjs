// Authoritative game server: runs every player (humans and bots) with the shared movement code at 128 Hz,
// owns rounds / economy / damage / the bomb, and broadcasts a snapshot + events every tick (128 Hz).
//
// Protocol (JSON over WebSocket):
//  client -> server  {t:'join', name, team?}  {t:'cmd', seq, f, s, j, d, w, yaw, pitch}  {t:'weapon', w}  {t:'fire', w}
//                    {t:'hit', target, group, bone, w, dist}  {t:'buy', item}  {t:'team', team}  {t:'throw', w, power}
//                    {t:'plant', on}  {t:'defuse', on}  {t:'drop'}
//  server -> client  {t:'welcome', id, tickRate}  {t:'snap', tick, ack, ents, you, round, ev}
// Hits are client-reported (the client owns the animation poses the hitboxes need) but validated here: shooter and target alive,
// enemies, in range, clear line of sight, and damage is computed from the weapon tables on the server.
import fs from 'fs';
import path from 'path';
import { Player, makeWorld, trace, TICK, TICK_RATE } from '../public/physics.js';
import { createMovers } from '../public/movers.js';
import { WEAPONS, HITGROUP_MULT, BUY, START_MONEY, MAX_MONEY, BUY_TIME, REWARD, DEFAULT_PISTOL, GRENADE, BOMB, canCarryGrenade } from '../public/weapon-defs.js';
import { reach } from '../public/ballistics.js';
import { launch, stepFlight, detonates } from '../public/grenade-physics.js';
import { fireCells, fireTouches, smokeExtinguishes } from '../public/fire-physics.js';
import { loadOrBuildNav, nearest, findPath } from './nav.mjs';

const BOT_NAMES = ['Albert', 'Allen', 'Bert', 'Bill', 'Brad', 'Brian', 'Chet', 'Cliffe', 'Crusher', 'Derek', 'Doug', 'Elmer', 'Eric', 'Felix', 'Frank', 'Gabe', 'Gary', 'Greg', 'Harvey', 'Ian', 'Jim', 'Joe', 'Keith', 'Kurt', 'Lyle', 'Minh', 'Moe', 'Ned', 'Quinn', 'Rich', 'Ron', 'Seth', 'Shark', 'Steve', 'Ted', 'Vladimir', 'Walt', 'Wolf', 'Yahn', 'Zach'];
const FREEZE = 5, ROUND_TIME = 115, END_TIME = 5, TEAM_SIZE = 5;
const r2 = (v) => Math.round(v * 100) / 100;
const rad = Math.PI / 180;

export function createGame({ mapDir, teamSize: teamSizeOption = null, bombTimer = BOMB.timer, botsFight = true, range = false, maxPlayers = null, bots: botsOn = true }) { // bots: false = humans only (no bots fill the teams) // range: shooting-range mode (no rounds, target bots)
  const worldJson = JSON.parse(fs.readFileSync(path.join(mapDir, 'world.json'), 'utf8'));
  const world = makeWorld(worldJson.collision.concat(worldJson.playerOnly ?? []));
  const bulletLimit = worldJson.collision.length;
  const movers = createMovers(world, worldJson.movers); // doors + breakable glass (entries inside world.collision)
  const spawns = {};
  for (const team of ['ct', 't', 'h']) {
    spawns[team] = (team === 'h' ? worldJson.hostages ?? [] : worldJson.spawns[team]).map((s) => { // spawn origins float above the floor (or sit inside rough terrain): lift until clear, then drop onto the floor
      let start = s.o;
      for (const lift of [0, 16, 32, 64, 96, 128]) { start = [s.o[0], s.o[1], s.o[2] + lift]; if (!trace(world, start, start, [-16, -16, 0], [16, 16, 62], bulletLimit).startSolid) break; }
      const r = trace(world, start, [start[0], start[1], start[2] - 400], [-16, -16, 0], [16, 16, 62], bulletLimit);
      return { o: [s.o[0], s.o[1], r.end[2] + 0.5], yaw: (s.yaw * Math.PI) / 180 };
    });
  }
  const bulletCtx = { world, limit: bulletLimit, surfOf: worldJson.surfOf, surfaces: worldJson.surfaces };
  const allSpawns = [...spawns.ct, ...spawns.t, ...spawns.h];
  // bots path through doors (they open them on the way): the nav graph is built with every door gone
  const opens = (d) => d.kind === 'door' && !d.locked, doorIdx = movers.defs.filter((d) => opens(d) || (d.parent >= 0 && opens(movers.defs[d.parent]))).flatMap((d) => d.entries), shut = doorIdx.map((i) => world.entries[i]);
  for (const i of doorIdx) world.entries[i] = Float32Array.from([1e9, 1e9, 1e9, -1e9, -1e9, -1e9]);
  const nav = loadOrBuildNav(world, allSpawns, mapDir);
  doorIdx.forEach((i, k) => { world.entries[i] = shut[k]; });
  const mode = worldJson.mode, teamSize = teamSizeOption ?? mode?.teamSize ?? TEAM_SIZE, roundTime = mode?.roundTime ?? ROUND_TIME; // e.g. Wingman: 2v2, 90 s rounds, one bombsite
  const sites = worldJson.sites?.length ? worldJson.sites.slice(0, mode?.sites ?? 99) : null; // bombsite centres; Ts all attack one per round, CTs split up to defend both
  // inside a bombsite (func_bomb_target bounds, a little generous vertically); older map builds only have the centre
  const inSite = (o) => !!sites?.some((st) => (st.min ? o[0] >= st.min[0] - 8 && o[0] <= st.max[0] + 8 && o[1] >= st.min[1] - 8 && o[1] <= st.max[1] + 8 && o[2] >= st.min[2] - 72 && o[2] <= st.max[2] + 32
    : Math.hypot(o[0] - st.o[0], o[1] - st.o[1]) < 200 && Math.abs(o[2] - st.o[2]) < 120));
  // Hostage rescue (cs_ maps: hostages, rescue zones, no bombsites): CTs lead hostages (E) into a rescue zone; every surviving hostage
  // rescued = CT win, time out = T win. Hostages are entities of team 'h', so snapshots, collision, hits and lag compensation treat them like players.
  const hostageMode = !range && !sites && spawns.h.length > 0, rescueZones = worldJson.rescue ?? [];
  const inRescue = (o) => rescueZones.some((z) => o[0] >= z.min[0] && o[0] <= z.max[0] && o[1] >= z.min[1] && o[1] <= z.max[1] && o[2] >= z.min[2] - 16 && o[2] <= z.max[2] + 16);
  const inActiveFire = (o) => fires.find((f) => fireTouches(world, bulletLimit, f, o));
  const spotsCache = new Map();
  const spotsAround = (site, radius) => { // nav nodes near a site, on its floor level (preferring unburned spots)
    const k = `${site.o[0]},${site.o[1]},${radius}`;
    if (!spotsCache.has(k)) spotsCache.set(k, nav.nodes.filter((n) => Math.hypot(n.o[0] - site.o[0], n.o[1] - site.o[1]) < radius && Math.abs(n.o[2] - site.o[2]) < 160).map((n) => n.i));
    const all = spotsCache.get(k), safe = fires.length ? all.filter((i) => !inActiveFire(nav.nodes[i].o)) : all;
    return safe.length ? safe : all;
  };
  const surfaceAt = (p) => { // footstep surface under a player
    const r = trace(world, [p.o[0], p.o[1], p.o[2] + 1], [p.o[0], p.o[1], p.o[2] - 6], [-8, -8, 0], [8, 8, 2]);
    return worldJson.surfaces?.[worldJson.surfOf?.[r.entry] ?? 0] ?? 'concrete';
  };

  const ents = new Map();
  let nextId = 1, tickNo = 0, events = [];
  const round = { phase: 'freeze', left: FREEZE, elapsed: 0, scores: { ct: 0, t: 0 }, number: 1, tSite: 0, rescued: 0 };

  // ---------- entities ----------
  function addEntity({ team, name, bot, ws = null, hostage = null }) {
    const ent = {
      id: nextId++, team, name, bot, ws, p: new Player(world), kills: 0, deaths: 0, ping: 0, health: 100, armor: 0, alive: true, money: START_MONEY,
      owned: new Set(), gr: {}, weapon: 'usp', kit: false, planting: null, defusing: null, queue: [], stepTimer: 0, foot: 0, walk: false, lastSeq: 0, tokens: 32, lastCmdAt: performance.now(),
      hostage, ai: bot && !hostage ? { path: null, idx: 0, stuck: 0, walking: false, holdUntil: 0, holdCrouch: false, enemy: 0, threat: 0, shots: 0, nextShot: 0, react: 0, err: [0, 0], ammo: {}, reloadUntil: 0 } : null,
    };
    ents.set(ent.id, ent);
    ent.p.others = () => { const out = []; if (!ent.hostage) for (const e of ents.values()) if (e !== ent && e.alive && !e.hostage) out.push(e.p); return out; }; // hostages never block (they would jam corridors)
    resetLoadout(ent);
    spawn(ent);
    return ent;
  }
  function resetLoadout(ent) { // knife + the team's pistol, no armor or grenades
    if (ent.team === 'spec') return; // spectators carry nothing (their old gear is reset when they join a team)
    if (ent.hostage) { ent.owned = new Set(); ent.gr = {}; ent.weapon = ''; ent.armor = 0; ent.helmet = false; ent.kit = false; return; }
    const pistol = DEFAULT_PISTOL[ent.team];
    ent.owned = new Set(['knife', pistol]); ent.gr = {}; ent.weapon = pistol; ent.armor = 0; ent.helmet = false; ent.kit = false;
    ent.p.maxSpeed = WEAPONS[pistol].speed;
  }
  function spawn(ent) {
    if (ent.team === 'spec') { ent.alive = false; ent.health = 0; return; } // spectators watch, they never spawn
    const taken = [...ents.values()].filter((e) => e !== ent && e.alive).map((e) => e.p.o);
    const pool = spawns[ent.team].filter((s) => !taken.some((o) => Math.hypot(o[0] - s.o[0], o[1] - s.o[1]) < 40));
    const rs = ent.hostage ? spawns.h[ent.hostage.home] : range && ent.bot ? rangeSpot(ent) : null;
    const s = rs ?? (pool.length ? pool : spawns[ent.team])[Math.floor(Math.random() * (pool.length || spawns[ent.team].length))];
    Object.assign(ent.p, { velMod: 1, o: [...s.o], v: [0, 0, 0], yaw: s.yaw, pitch: 0, ducked: false, ducking: false, ducktime: 0, eyeZ: 64, stamina: 0, oldJump: false, oldDuck: false, onGround: false });
    ent.p.prev = { o: [...s.o], eyeZ: 64 };
    ent.p.maxSpeed = ent.hostage ? 250 : WEAPONS[ent.weapon].speed;
    if (ent.hostage) Object.assign(ent.hostage, { leader: 0, path: null, stuck: 0 });
    ent.stepTimer = 0; ent.alive = true; ent.health = 100; ent.planting = ent.defusing = null; ent.queue.length = 0;
    if (ent.ai) Object.assign(ent.ai, { path: null, stuck: 0, enemy: 0, threat: 0, shots: 0, nextShot: 0, ammo: {}, reloadUntil: 0, blindUntil: 0 });
  }
  const humans = () => [...ents.values()].filter((e) => !e.bot);
  // ---------- shooting range ----------
  // Target bots stand on nav spots the shooters' spawn can see, 350..2200 units out and spread apart; a third stand, a third crouch, a third strafe.
  const rangeTeam = () => other(humans()[0]?.team ?? 'ct'); // the targets: the team the (first) human is not on
  const rangeSpots = new Map();
  function rangeSpot(bot) {
    const shooters = other(bot.team);
    if (!rangeSpots.has(shooters)) {
      const s0 = spawns[shooters][0].o, eye = [s0[0], s0[1], s0[2] + 64], picked = [];
      const cand = nav.nodes.map((n) => ({ n, d: Math.hypot(n.o[0] - s0[0], n.o[1] - s0[1]) })).filter((c) => c.d > 350 && c.d < 2200).sort((a, b) => a.d - b.d);
      for (const c of cand) {
        if (picked.length >= 16) break;
        if (picked.some((q) => Math.hypot(q.o[0] - c.n.o[0], q.o[1] - c.n.o[1]) < 250)) continue;
        if (trace(world, eye, [c.n.o[0], c.n.o[1], c.n.o[2] + 54], ZERO, ZERO, bulletLimit).fraction > 0.995) picked.push(c.n);
      }
      rangeSpots.set(shooters, picked.map((n) => ({ o: [n.o[0], n.o[1], n.o[2] + 1], yaw: Math.atan2(s0[1] - n.o[1], s0[0] - n.o[0]) })));
    }
    const spots = rangeSpots.get(shooters), mates = [...ents.values()].filter((e) => e.bot && e.team === bot.team);
    return spots.length ? spots[Math.max(mates.indexOf(bot), 0) % spots.length] : null;
  }
  function rangeBot(bot) {
    const p = bot.p, h = humans().find((e) => e.alive), kind = bot.id % 3;
    if (h) p.yaw = Math.atan2(h.p.o[1] - p.o[1], h.p.o[0] - p.o[0]);
    simulate(bot, { fwd: 0, side: kind === 1 ? Math.sign(Math.sin((tickNo * TICK * Math.PI) / 0.8 + bot.id)) : 0, duck: kind === 2 }); // strafe 0.8 s each way
  }
  const humansOn = (team) => [...ents.values()].filter((e) => !e.bot && e.team === team).length;
  const other = (team) => (team === 'ct' ? 't' : 'ct');
  // Team balance (humans; bots fill the rest): you may join a team only if it has fewer humans than the team you would leave
  // (or, when joining, no more humans than the other team), so the human counts never drift apart by more than one.
  function moveTeam(ent, team) {
    if (bomb.carrier === ent.id) dropBomb(ent);
    ent.team = team; resetLoadout(ent);
    if (round.phase === 'freeze' && team !== 'spec') spawn(ent); // still at the start: play right away
    else { ent.alive = false; ent.health = 0; ent.planting = ent.defusing = null; } // mid-round: sit out until the next round, like CS
    fillBots();
  }
  function autoBalance() { // at the start of each round: move the newest human off a team that has 2+ more humans
    for (;;) {
      const big = humansOn('ct') - humansOn('t') > 1 ? 'ct' : humansOn('t') - humansOn('ct') > 1 ? 't' : null;
      if (!big) return;
      const ent = [...ents.values()].filter((e) => !e.bot && e.team === big).sort((a, b) => b.id - a.id)[0];
      moveTeam(ent, other(big));
      ent.ws?.readyState === 1 && ent.ws.send(JSON.stringify({ t: 'notice', text: 'Teams were unbalanced: you have been moved to the ' + (ent.team === 'ct' ? 'Counter-Terrorists' : 'Terrorists') }));
    }
  }
  function addHostages() { // a fresh set every round: the rescued and the dead come back
    for (const e of [...ents.values()]) if (e.hostage) ents.delete(e.id);
    if (hostageMode) spawns.h.forEach((_, home) => addEntity({ team: 'h', name: 'Hostage', bot: true, hostage: { home, leader: 0, path: null, stuck: 0 } }));
  }
  function fillBots() { // keep both teams at TEAM_SIZE with bots filling the human gaps
    for (const team of ['ct', 't']) {
      const mine = [...ents.values()].filter((e) => e.team === team);
      let bots = mine.filter((e) => e.bot);
      const wanted = (range && team !== rangeTeam()) || (!botsOn && !range) ? 0 : Math.max(teamSize - mine.filter((e) => !e.bot).length, 0);
      while (bots.length > wanted) ents.delete(bots.pop().id);
      while (bots.length < wanted) { const b = addEntity({ team, name: BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)], bot: true }); bots.push(b); }
    }
  }

  // ---------- movement + sounds ----------
  function emit(ev) { events.push(ev); }
  function simulate(ent, inp) {
    const p = ent.p, wasGround = p.onGround, vzBefore = p.v[2];
    p.tick(inp, TICK);
    ent.walk = !!inp.walk;
    // footsteps: running on the ground only (walking and crouching are silent in CS:S); a landing thud when falling hard
    const speed = Math.hypot(p.v[0], p.v[1]);
    ent.stepTimer -= TICK;
    if (p.onGround && !wasGround && vzBefore < -180) { emit({ e: 'step', id: ent.id, o: p.o.map(r2), s: surfaceAt(p), land: 1 }); ent.stepTimer = 0.3; }
    else if (p.onGround && speed > 135 && !p.ducked && !inp.walk && ent.stepTimer <= 0) {
      ent.foot ^= 1;
      emit({ e: 'step', id: ent.id, o: p.o.map(r2), s: surfaceAt(p), f: ent.foot });
      ent.stepTimer = speed > 225 ? 0.29 : 0.36;
    }
  }
  function processCmd(ent, c) {
    if (c.seq <= ent.lastSeq) return;
    const now = performance.now(), el = (now - ent.lastCmdAt) / 1000; ent.lastCmdAt = now;
    ent.tokens = Math.min(ent.tokens + el * TICK_RATE * 1.3, 40); // token bucket: a client cannot run faster than the tick rate
    if (ent.tokens < 1) return;
    ent.tokens -= 1; ent.lastSeq = c.seq;
    if (!ent.alive) return;
    const frozen = round.phase === 'freeze' || !!ent.planting || !!ent.defusing; // planting / defusing roots you in place
    ent.p.yaw = Number(c.yaw) || 0; ent.p.pitch = Number(c.pitch) || 0;
    simulate(ent, { fwd: frozen ? 0 : Math.sign(c.f), side: frozen ? 0 : Math.sign(c.s), jump: !frozen && !!c.j, duck: !!c.d, walk: !!c.w });
  }

  // ---------- hostages ----------
  // A hostage follows the CT who used it (A* over the nav graph, re-planned twice a second), stops near them, stays where its rescuer fell,
  // and is rescued the moment it is inside a rescue zone.
  function hostageThink(h) {
    const hs = h.hostage, p = h.p, now = tickNo * TICK;
    if (!h.alive || round.phase !== 'live') return simulate(h, { fwd: 0, side: 0 });
    let leader = hs.leader && ents.get(hs.leader);
    if (leader && (!leader.alive || leader.team !== 'ct')) { hs.leader = 0; leader = null; }
    if (inRescue(p.o)) return rescue(h, leader);
    if (!leader) return simulate(h, { fwd: 0, side: 0 });
    const dx = leader.p.o[0] - p.o[0], dy = leader.p.o[1] - p.o[1], d = Math.hypot(dx, dy);
    if (d < 90 && Math.abs(leader.p.o[2] - p.o[2]) < 60) { p.yaw = Math.atan2(dy, dx); hs.stuck = 0; return simulate(h, { fwd: 0, side: 0 }); }
    if (!hs.path || now > hs.repath) { hs.path = findPath(nav, nearest(nav, p.o), nearest(nav, leader.p.o)); hs.idx = 0; hs.repath = now + 0.5; }
    let to = leader.p.o;
    if (hs.path?.length) {
      while (hs.idx < hs.path.length - 1 && Math.hypot(hs.path[hs.idx].o[0] - p.o[0], hs.path[hs.idx].o[1] - p.o[1]) < 26 && Math.abs(hs.path[hs.idx].o[2] - p.o[2]) < 40) hs.idx++;
      if (hs.idx < hs.path.length - 1) to = hs.path[hs.idx].o;
    }
    const want = Math.atan2(to[1] - p.o[1], to[0] - p.o[0]), turn = angTo(p.yaw, want);
    p.yaw += Math.sign(turn) * Math.min(Math.abs(turn), 10 * TICK);
    hs.stuck = Math.hypot(p.v[0], p.v[1]) < 30 ? hs.stuck + TICK : 0;
    simulate(h, { fwd: Math.abs(turn) < 1.2 ? 1 : 0, side: 0, walk: d < 150, jump: p.onGround && hs.stuck > 0.4 });
  }
  function rescue(h, leader) {
    round.rescued++;
    if (leader) give(leader, REWARD.rescue);
    emit({ e: 'rescued', id: h.id, by: leader?.id ?? 0, o: h.p.o.map(r2) });
    ents.delete(h.id); // gone from the map (back next round)
  }
  function useHostage(ent) { // E: the hostage in front of a CT starts / stops following them
    if (!hostageMode || ent.team !== 'ct' || !ent.alive || round.phase !== 'live') return;
    const fwd = [Math.cos(ent.p.yaw), Math.sin(ent.p.yaw)];
    let best = null, bestD = 100;
    for (const h of ents.values()) {
      if (!h.hostage || !h.alive) continue;
      const dx = h.p.o[0] - ent.p.o[0], dy = h.p.o[1] - ent.p.o[1], d = Math.hypot(dx, dy);
      if (d < bestD && Math.abs(h.p.o[2] - ent.p.o[2]) < 72 && (d < 40 || (fwd[0] * dx + fwd[1] * dy) / d > 0.5)) { best = h; bestD = d; }
    }
    if (best) { leadHostage(best, best.hostage.leader === ent.id ? null : ent); return true; }
  }
  function leadHostage(h, ent) {
    h.hostage.leader = ent?.id ?? 0; h.hostage.path = null;
    emit({ e: 'hostage', id: h.id, by: ent?.id ?? 0, o: h.p.o.map(r2) }); // the hostage's "let's go" / "I'll stay here"
  }
  // ---------- doors + breakable glass (public/movers.js holds the shapes) ----------
  const moverTarget = new Float32Array(movers.defs.length), moverHp = movers.defs.map((d) => d.health ?? 0);
  const doorCenter = (i) => movers.pose(i, movers.state[i])[0](movers.defs[i].center);
  const partners = (i) => { const d = movers.defs[i]; return movers.defs.map((x, k) => k).filter((k) => k !== i && movers.defs[k].kind === 'door' && ((d.slave && movers.defs[k].name === d.slave) || (movers.defs[k].slave && movers.defs[k].slave === d.name))); };
  function setDoor(i, open, by) { // by: where the opener stands; a rotating door swings away from them
    const d = movers.defs[i];
    if (d.locked) return;
    let t = 0;
    if (open && d.slide) t = d.dist;
    else if (open && d.oneWay) t = d.dist * d.oneWay;
    else if (open) { const away = (sg) => { const c = movers.pose(i, sg * d.dist)[0](d.center); return Math.hypot(c[0] - by[0], c[1] - by[1]); }; t = away(1) >= away(-1) ? d.dist : -d.dist; }
    if (moverTarget[i] === t) return;
    moverTarget[i] = t;
    emit({ e: 'door', i, open: open ? 1 : 0, o: doorCenter(i).map(r2) });
  }
  function useDoor(ent) { // E: the door in front of you opens (away from you) or closes
    if (!ent.alive) return;
    const eye = ent.p.eye, fwd = [Math.cos(ent.p.yaw), Math.sin(ent.p.yaw)];
    let best = -1, bestD = 96;
    movers.defs.forEach((d, i) => {
      if (d.kind !== 'door' || !d.use || d.locked) return;
      const c = doorCenter(i), dx = c[0] - eye[0], dy = c[1] - eye[1], dist = Math.hypot(dx, dy);
      if (dist < bestD && Math.abs(c[2] - eye[2]) < 90 && (dist < 40 || (fwd[0] * dx + fwd[1] * dy) / dist > 0.4)) { best = i; bestD = dist; }
    });
    if (best < 0) return;
    const open = moverTarget[best] === 0;
    for (const i of [best, ...partners(best)]) setDoor(i, open, ent.p.o);
    return true;
  }
  const blockedBy = (i) => { // a player inside the door's new shape stops it (Source doors stop on what they hit)
    const w = makeWorld(movers.defs[i].entries.map((k) => world.entries[k]));
    for (const e of ents.values()) if (e.alive && trace(w, e.p.o, e.p.o, [-16, -16, 0], [16, 16, e.p.ducked ? 45 : 62]).startSolid) return true;
    return false;
  };
  function updateMovers() {
    movers.defs.forEach((d, i) => {
      if (d.kind !== 'door' || d.locked) return;
      const c = doorCenter(i), near = (r) => [...ents.values()].find((e) => e.alive && Math.hypot(e.p.o[0] - c[0], e.p.o[1] - c[1]) < r && Math.abs(e.p.o[2] + 36 - c[2]) < 96);
      if (!d.use) { // map-logic doors: open for whoever comes close, close once everyone has gone
        const who = near(110);
        if (who) setDoor(i, true, who.p.o); else if (!near(170)) setDoor(i, false);
      } else if (movers.state[i] === 0 && moverTarget[i] === 0) { const bot = [...ents.values()].find((e) => e.bot && !e.hostage && e.alive && Math.hypot(e.p.o[0] - c[0], e.p.o[1] - c[1]) < 64); if (bot) setDoor(i, true, bot.p.o); } // bots open doors they walk into
      const cur = movers.state[i], tgt = moverTarget[i];
      if (cur === tgt) return;
      const step = d.speed * TICK, next = cur + Math.max(Math.min(tgt - cur, step), -step);
      movers.apply(i, next);
      if (blockedBy(i)) movers.apply(i, cur);
    });
  }
  function damageMovers(a, b, dmg) { // bullets (and blasts) break glass and breakables they pass through
    movers.defs.forEach((d, i) => {
      if (!d.breakable || movers.state[i] || trace(makeWorld(d.entries.map((k) => world.entries[k])), a, b, ZERO, ZERO).fraction >= 1) return; // where it is now (glass in a door swings)
      if ((moverHp[i] -= dmg) > 0) return;
      movers.apply(i, 1);
      emit({ e: 'break', i, glass: d.glass ? 1 : 0, o: d.center.map(r2) });
    });
  }
  // trigger_hurt: Source deals `damage` every half second to whoever is inside (death pits use a huge value)
  const hurtZones = worldJson.hurt ?? [];
  function updateHurt() {
    if (!hurtZones.length) return;
    for (const e of ents.values()) {
      if (!e.alive) continue;
      const z = hurtZones.find((h) => e.p.o.every((v, k) => v >= h.min[k] - (k < 2 ? 16 : 0) && v <= h.max[k]));
      if (z) applyDamage(e, e, z.damage * 2 * TICK, 'world', { group: 0 });
    }
  }
  function resetMovers() { movers.defs.forEach((d, i) => { moverTarget[i] = 0; moverHp[i] = d.health ?? 0; movers.apply(i, 0); }); }
  const hostagesLeft = () => [...ents.values()].filter((e) => e.hostage && e.alive).length;

  // ---------- bots ----------
  // Bots follow A* paths over the nav graph (nav.mjs): to the enemy spawn or a random spot, then pick a new goal.
  const repathAll = () => { for (const e of ents.values()) if (e.ai) { e.ai.path = null; e.ai.holdUntil = 0; } }; // the bomb situation changed
  function newGoal(bot) {
    const ai = bot.ai;
    let goal = -1;
    const closestT = () => [...ents.values()].filter((e) => e.alive && e.team === 't').sort((a, b) => Math.hypot(a.p.o[0] - bomb.o[0], a.p.o[1] - bomb.o[1]) - Math.hypot(b.p.o[0] - bomb.o[0], b.p.o[1] - bomb.o[1]))[0];
    if (bomb.state === 'planted') { // CTs rush the bomb, Ts guard it
      if (bot.team === 'ct') goal = nearest(nav, bomb.o);
      else { const spots = spotsAround({ o: bomb.o }, 380); if (spots.length) goal = spots[Math.floor(Math.random() * spots.length)]; }
    } else if (bomb.state === 'dropped' && bot.team === 't' && closestT() === bot) goal = nearest(nav, bomb.o); // fetch the dropped bomb
    else if (bomb.state === 'carried' && bomb.carrier === bot.id && sites) goal = nearest(nav, sites[round.tSite].o); // carry it onto the site
    if (goal < 0 && hostageMode) {
      const hs = [...ents.values()].filter((e) => e.hostage && e.alive), dist = (e) => Math.hypot(e.p.o[0] - bot.p.o[0], e.p.o[1] - bot.p.o[1]);
      if (bot.team === 'ct') {
        if (hs.some((h) => h.hostage.leader === bot.id) && rescueZones.length) { // lead them out: the nearest rescue zone
          const z = rescueZones.map((r) => [(r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2, r.min[2] + 8]).sort((a, b) => Math.hypot(a[0] - bot.p.o[0], a[1] - bot.p.o[1]) - Math.hypot(b[0] - bot.p.o[0], b[1] - bot.p.o[1]))[0];
          goal = nearest(nav, z); ai.wantHostage = 0;
        } else {
          const free = hs.filter((h) => !h.hostage.leader).sort((a, b) => dist(a) - dist(b))[0];
          if (free) { goal = nearest(nav, free.p.o); ai.wantHostage = free.id; }
        }
      } else if (hs.length) { const h = hs[Math.floor(Math.random() * hs.length)], spots = spotsAround({ o: h.p.o }, 520); if (spots.length) goal = spots[Math.floor(Math.random() * spots.length)]; }
    }
    if (goal < 0 && sites) {
      const mates = [...ents.values()].filter((e) => e.bot && e.team === bot.team);
      const site = bot.team === 't' ? sites[round.tSite] : sites[mates.indexOf(bot) % sites.length]; // CTs alternate between the sites
      const spots = spotsAround(site, bot.team === 't' ? 320 : 650);
      if (spots.length) goal = spots[Math.floor(Math.random() * spots.length)];
    }
    if (goal < 0) goal = Math.floor(Math.random() * nav.nodes.length);
    ai.path = findPath(nav, nearest(nav, bot.p.o), goal); ai.idx = 0; ai.stuck = 0; ai.walking = Math.random() < 0.2;
    if (!ai.path?.length) { ai.path = null; ai.holdUntil = tickNo * TICK + 0.5; } // already there / unreachable: wait a moment, then pick another goal
  }
  function botThrowAt(bot, wKey, to, now) {
    const p = bot.p, dx = to[0] - p.o[0], dy = to[1] - p.o[1], dist = Math.hypot(dx, dy);
    const prevYaw = p.yaw, prevPitch = p.pitch;
    p.yaw = Math.atan2(dy, dx);
    p.pitch = Math.min(0.45, Math.max(-0.4, (to[2] - p.eye[2]) / (dist || 1) + dist / 1800));
    throwGrenade(bot, { w: wKey, power: Math.min(1, Math.max(0.3, dist / 750)) });
    p.yaw = prevYaw; p.pitch = prevPitch;
    bot.ai.nextNadeAt = now + 6;
  }
  function think(bot) {
    const ai = bot.ai, p = bot.p;
    if (!bot.alive || round.phase !== 'live') return simulate(bot, { fwd: 0, side: 0 });
    const now = tickNo * TICK;
    if (bot.planting || bot.defusing) return simulate(bot, { fwd: 0, side: 0, duck: !!bot.defusing });
    if (range) return rangeBot(bot);
    const standingFire = fires.length && inActiveFire(p.o);
    if (standingFire) { // sprint clear of active flames before stopping to fight or hold
      ai.holdUntil = 0; ai.path = null;
      const away = Math.atan2(p.o[1] - standingFire.o[1], p.o[0] - standingFire.o[0]), dy = angTo(p.yaw, away);
      p.yaw += Math.sign(dy) * Math.min(Math.abs(dy), 12 * TICK);
      return simulate(bot, { fwd: Math.abs(dy) > 1.8 ? -1 : 1, side: Math.hypot(p.v[0], p.v[1]) < 35 ? 1 : 0 });
    }
    if (botsFight && bot.gr.smokegrenade > 0 && now >= (ai.nextNadeAt ?? 0) && fires.length) {
      const f = fires.find((x) => Math.hypot(x.o[0] - p.o[0], x.o[1] - p.o[1]) < 550 && clear(p.eye, [x.o[0], x.o[1], x.o[2] + 16]));
      if (f) botThrowAt(bot, 'smokegrenade', f.o, now);
    }
    if (botsFight && botCombat(bot, now)) return; // an enemy in sight: fight
    if (bomb.state === 'carried' && bomb.carrier === bot.id && inSite(p.o) && p.onGround) { setWeapon(bot, 'c4'); startPlant(bot); return simulate(bot, { fwd: 0, side: 0 }); }
    if (bomb.state === 'planted' && bot.team === 'ct' && Math.hypot(p.o[0] - bomb.o[0], p.o[1] - bomb.o[1]) < 48 && Math.abs(p.o[2] - bomb.o[2]) < 64) { startDefuse(bot); return simulate(bot, { fwd: 0, side: 0, duck: true }); }
    if (hostageMode && ai.wantHostage) { // reached the hostage we came for: take it, then head for the rescue zone
      const h = ents.get(ai.wantHostage);
      if (!h?.alive || h.hostage.leader) ai.wantHostage = 0;
      else if (Math.hypot(h.p.o[0] - p.o[0], h.p.o[1] - p.o[1]) < 80) { leadHostage(h, bot); ai.wantHostage = 0; ai.path = null; ai.holdUntil = 0; }
    }
    if (now < ai.holdUntil) { // holding a spot: watch the way the enemy will come from (their spawn side)
      const es = spawns[bot.team === 'ct' ? 't' : 'ct'][0].o, want = Math.atan2(es[1] - p.o[1], es[0] - p.o[0]) + (ai.lookOff ??= (Math.random() - 0.5) * 1.2);
      const dy = angTo(p.yaw, want); p.yaw += Math.sign(dy) * Math.min(Math.abs(dy), 3 * TICK); p.pitch *= 0.95;
      return simulate(bot, { fwd: 0, side: 0, duck: bot.team === 'ct' && ai.holdCrouch });
    }
    if (!ai.path || ai.idx >= ai.path.length || ai.stuck > 1.2) newGoal(bot);
    if (!ai.path) return simulate(bot, { fwd: 0, side: 0 });
    let wp = ai.path[ai.idx];
    while (Math.hypot(wp.o[0] - p.o[0], wp.o[1] - p.o[1]) < 26 && Math.abs(wp.o[2] - p.o[2]) < 40) { // reached it: on to the next
      if (++ai.idx >= ai.path.length) { ai.holdUntil = now + (bot.team === 'ct' ? 3 + Math.random() * 6 : 1 + Math.random() * 2.5); ai.holdCrouch = Math.random() < 0.3; ai.path = null; return simulate(bot, { fwd: 0, side: 0 }); } // arrived: CTs dig in a while, Ts keep moving around the site
      wp = ai.path[ai.idx];
    }
    if (fires.length && inActiveFire(wp.o)) { ai.path = null; ai.holdUntil = now + 0.4; return simulate(bot, { fwd: -1, side: 0 }); } // don't walk into fire
    const want = Math.atan2(wp.o[1] - p.o[1], wp.o[0] - p.o[0]), d = ((want - p.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
    p.yaw += Math.sign(d) * Math.min(Math.abs(d), 7 * TICK);
    ai.stuck = Math.hypot(p.v[0], p.v[1]) < 30 ? ai.stuck + TICK : Math.max(ai.stuck - TICK, 0);
    const near = Math.hypot(wp.o[0] - p.o[0], wp.o[1] - p.o[1]) < 70;
    // stuck on another player (corridors, stairs): step to the right to pass, as both sides do, instead of jumping on their head
    const blocked = ai.stuck > 0.25 && [...ents.values()].some((e) => e !== bot && e.alive && !e.hostage && Math.hypot(e.p.o[0] - p.o[0], e.p.o[1] - p.o[1]) < 48 && Math.abs(e.p.o[2] - p.o[2]) < 72);
    simulate(bot, { fwd: Math.abs(d) < 1 ? 1 : 0, side: blocked ? 1 : 0, jump: !blocked && p.onGround && ((wp.jump && near) || ai.stuck > 0.4), walk: ai.walking });
  }

  // ---------- bot combat ----------
  // Vision (16 Hz): enemies in a 130 degree view cone, or whoever just shot them, with a clear line to the head or chest; smoke and flashes
  // blind them. On first sight a human-like reaction delay and an aim error that settles over ~0.35 s; then they turn at a limited speed,
  // stop to shoot (moving ruins accuracy, as in CS), tap/burst at range, spray up close with half-controlled recoil, and reload.
  // Shots are real: the same spread / range / armor / penetration rules as players, against simplified hitboxes (head sphere, body cylinders).
  const tri = () => Math.random() - 0.5 + (Math.random() - 0.5);
  const angTo = (a, b) => ((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI;
  const eyeOf = (e) => e.p.eye, headOf = (e) => [e.p.o[0], e.p.o[1], e.p.o[2] + (e.p.ducked ? 46 : 63)], chestOf = (e) => [e.p.o[0], e.p.o[1], e.p.o[2] + (e.p.ducked ? 30 : 44)];
  const clear = (a, b) => trace(world, a, b, ZERO, ZERO, bulletLimit).fraction > 0.995;
  const smokeBlocks = (a, b) => smokes.some((m) => { // segment vs smoke ball, once it has bloomed
    if (m.age < 1 || m.age > GRENADE.smokeTime - 1) return false;
    const c = [m.o[0], m.o[1], m.o[2] + 60], d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], l2 = d[0] ** 2 + d[1] ** 2 + d[2] ** 2;
    const t = Math.max(0, Math.min(1, ((c[0] - a[0]) * d[0] + (c[1] - a[1]) * d[1] + (c[2] - a[2]) * d[2]) / (l2 || 1)));
    return Math.hypot(a[0] + d[0] * t - c[0], a[1] + d[1] * t - c[1], a[2] + d[2] * t - c[2]) < GRENADE.smokeRadius * 0.9;
  });
  function spot(bot, now) {
    const ai = bot.ai, eye = eyeOf(bot), fwd = [Math.cos(bot.p.yaw), Math.sin(bot.p.yaw)];
    if (now < (ai.blindUntil ?? 0)) return 0;
    let best = 0, bestD = Infinity;
    for (const e of ents.values()) {
      if (!e.alive || e.team === bot.team || e.hostage) continue;
      const d = [e.p.o[0] - bot.p.o[0], e.p.o[1] - bot.p.o[1]], dist = Math.hypot(...d);
      if (dist > 3500 || dist >= bestD) continue;
      if ((fwd[0] * d[0] + fwd[1] * d[1]) / (dist || 1) < Math.cos((65 * Math.PI) / 180) && ai.threat !== e.id) continue; // outside the view cone
      const h = headOf(e), c = chestOf(e);
      if (!((clear(eye, h) && !smokeBlocks(eye, h)) || (clear(eye, c) && !smokeBlocks(eye, c)))) continue;
      best = e.id; bestD = dist;
    }
    return best;
  }
  function botSpread(w, shots, moving, air) { // the same accuracy / spread tables the players use (weapons.js accuracyAt / spreadAt)
    const a = w.accuracy, acc = a.kind === 'shots' ? Math.min(a.max, Math.pow(shots, a.pow) / a.div + a.base) : a.kind === 'time' ? a.start ?? 0.9 : 1;
    const sp = w.spread, term = sp.term === 'inv' ? 1 - acc : acc, val = ([c, k]) => c + k * term;
    return air ? val(sp.air) : moving ? val(sp.move) : sp.duck && bot_ducked ? val(sp.duck) : val(sp.stand);
  }
  let bot_ducked = false;
  // ray vs simplified hitboxes of the enemies: head sphere + body cylinders (legs / stomach / chest)
  const rayCyl = (o, d, cx, cy, z0, z1, r) => {
    const ox = o[0] - cx, oy = o[1] - cy, A = d[0] * d[0] + d[1] * d[1], B = 2 * (ox * d[0] + oy * d[1]), C = ox * ox + oy * oy - r * r;
    if (A < 1e-9) return Infinity;
    const disc = B * B - 4 * A * C; if (disc < 0) return Infinity;
    for (const t of [(-B - Math.sqrt(disc)) / (2 * A), (-B + Math.sqrt(disc)) / (2 * A)]) { const z = o[2] + d[2] * t; if (t > 0 && z >= z0 && z <= z1) return t; }
    return Infinity;
  };
  const raySphere = (o, d, c, r) => { const oc = [o[0] - c[0], o[1] - c[1], o[2] - c[2]], b = oc[0] * d[0] + oc[1] * d[1] + oc[2] * d[2], cc = oc[0] ** 2 + oc[1] ** 2 + oc[2] ** 2 - r * r, disc = b * b - cc; return disc < 0 ? Infinity : -b - Math.sqrt(disc) > 0 ? -b - Math.sqrt(disc) : Infinity; };
  function bodyHit(shooter, o, d) {
    let best = null;
    for (const e of ents.values()) {
      if (!e.alive || e === shooter || e.team === shooter.team) continue; // teammates: no friendly fire
      const z = e.p.o[2], k = e.p.ducked ? 0.72 : 1, x = e.p.o[0], y = e.p.o[1];
      const parts = [[raySphere(o, d, [x, y, z + 63 * k], 6.5), 1], [rayCyl(o, d, x, y, z + 40 * k, z + 57 * k, 11), 2], [rayCyl(o, d, x, y, z + 30 * k, z + 40 * k, 10), 3], [rayCyl(o, d, x, y, z, z + 30 * k, 8), 6]];
      for (const [t, group] of parts) if (t < (best?.t ?? Infinity)) best = { e, t, group };
    }
    return best;
  }
  function botShoot(bot, now, dist) {
    const ai = bot.ai, w = WEAPONS[bot.weapon], p = bot.p;
    const am = (ai.ammo[bot.weapon] ??= { mag: w.mag, reserve: w.reserve });
    if (am.mag <= 0) { if (am.reserve > 0 && !ai.reloadUntil) ai.reloadUntil = now + w.reload; return; }
    am.mag--; ai.shots++;
    const longRange = dist > 900 && w.auto;
    ai.nextShot = now + w.cycle + (!w.auto ? 0.12 + Math.random() * 0.15 : 0); // semi-autos are tapped
    if (longRange && ai.shots >= 2 + (Math.random() * 3 | 0)) { ai.nextShot = now + 0.35 + Math.random() * 0.25; ai.burstEnd = true; } // bursts at range
    // recoil: the fixed CS pattern (or a flat kick), about half of it controlled
    let pu = [0, 0];
    if (w.recoil.type === 'kickback') { const pt = w.recoil.pts[Math.min(ai.shots - 1, w.recoil.pts.length - 1)]; pu = [pt[0] * 0.5, pt[1] * 0.5]; }
    else if (w.recoil.type === 'punch') pu = [Math.min(ai.shots * w.recoil.pitch * 0.3, 4), 0];
    bot_ducked = p.ducked;
    const spread = botSpread(w, ai.shots, Math.hypot(p.v[0], p.v[1]) > 140, !p.onGround);
    const yaw = p.yaw + (pu[1] * Math.PI) / 180, pitch = p.pitch + (pu[0] * Math.PI) / 180, cp = Math.cos(pitch), eye = p.eye;
    const fwd = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)], right = [Math.sin(yaw), -Math.cos(yaw), 0], up = [-Math.sin(pitch) * Math.cos(yaw), -Math.sin(pitch) * Math.sin(yaw), Math.cos(pitch)];
    let to = null, hitAny = false;
    for (let i = 0; i < (w.pellets ?? 1); i++) {
      const x = tri() * spread, y = tri() * spread;
      let d = [fwd[0] + right[0] * x + up[0] * y, fwd[1] + right[1] * x + up[1] * y, fwd[2] + right[2] * x + up[2] * y]; const l = Math.hypot(...d); d = d.map((v) => v / l);
      const wall = trace(world, eye, [eye[0] + d[0] * 8192, eye[1] + d[1] * 8192, eye[2] + d[2] * 8192], ZERO, ZERO, bulletLimit);
      const hit = bodyHit(bot, eye, d), end = hit ? eye.map((v, j) => v + d[j] * hit.t) : wall.end;
      if (i === 0) to = end;
      if (!hit) continue;
      const k = reach(bulletCtx, eye, end, w); // walls in between: stopped, or weakened by penetration
      if (!k) continue;
      hitAny = true;
      const dmg = w.damage * Math.pow(w.rangeMod ?? 1, hit.t / 500) * HITGROUP_MULT[hit.group] * k;
      applyDamage(hit.e, bot, dmg, bot.weapon, { group: hit.group, bone: hit.group === 1 ? 14 : 1, dir: d.map((v) => r2(v)), from: eye, wb: wall.fraction * 8192 < hit.t });
    }
    emit({ e: 'shot', id: bot.id, o: p.o.map(r2), w: bot.weapon, to: to.map((v) => Math.round(v)), hit: hitAny ? 1 : 0 });
  }
  function botCombat(bot, now) {
    const ai = bot.ai, p = bot.p;
    if (ai.reloadUntil && now >= ai.reloadUntil) { const am = ai.ammo[bot.weapon], take = Math.min(WEAPONS[bot.weapon].mag - am.mag, am.reserve); am.mag += take; am.reserve -= take; ai.reloadUntil = 0; }
    if ((tickNo + bot.id) % 8 === 0) { // look around 16 times a second
      const seen = spot(bot, now);
      if (seen && seen !== ai.enemy) { // new target: react, with an aim error that settles
        const surprised = ai.threat === seen; // we were shot by them: no time to settle, and less precise
        ai.react = now + (surprised ? 0.12 : 0.2) + Math.random() * 0.2; ai.err = [(Math.random() - 0.5) * (surprised ? 0.3 : 0.22), (Math.random() - 0.5) * 0.09]; ai.head = Math.random() < 0.3; ai.shots = 0;
      }
      if (seen) { ai.enemy = seen; ai.lastSeen = now; }
      else if (now - (ai.lastSeen ?? -9) > 0.6) ai.enemy = 0; // lost them for a moment: keep aiming where they were
    }
    const e = ai.enemy && ents.get(ai.enemy);
    if (!e || !e.alive) { ai.enemy = 0; ai.threat = 0; if (ai.shots && now > ai.nextShot + 0.4) ai.shots = 0; return false; }
    // the right tool: rifle / SMG / shotgun first, then the pistol
    const gun = [...bot.owned].filter((k) => WEAPONS[k].slot <= 2 && (ai.ammo[k]?.mag ?? 1) + (ai.ammo[k]?.reserve ?? 1) > 0).sort((x, y) => WEAPONS[x].slot - WEAPONS[y].slot)[0];
    if (gun && bot.weapon !== gun) { setWeapon(bot, gun); ai.nextShot = now + 0.4; ai.reloadUntil = 0; }
    const eye = p.eye, aim = ai.head ? headOf(e) : chestOf(e), d = [aim[0] - eye[0], aim[1] - eye[1], aim[2] - eye[2]], dist = Math.hypot(...d);
    if (botsFight && round.phase === 'live' && now >= (ai.nextNadeAt ?? 0) && dist > 380 && dist < 950 && bot.health > 35) {
      const nade = ['molotov', 'incgrenade', 'hegrenade'].find((k) => bot.gr[k] > 0);
      if (nade && (!inActiveFire(e.p.o) || nade === 'hegrenade')) botThrowAt(bot, nade, e.p.o, now);
    }
    const settle = Math.exp(-(now - (ai.react - 0.25)) / 0.35); // aim error shrinks after first sight
    const wantYaw = Math.atan2(d[1], d[0]) + ai.err[0] * Math.min(settle, 1), wantPitch = Math.atan2(d[2], Math.hypot(d[0], d[1])) + ai.err[1] * Math.min(settle, 1);
    const dy = angTo(p.yaw, wantYaw), dp = wantPitch - p.pitch, turn = (Math.abs(dy) > 1 ? 16 : 9) * TICK; // rad per tick: a fast flick when far off target
    p.yaw += Math.sign(dy) * Math.min(Math.abs(dy), turn); p.pitch += Math.sign(dp) * Math.min(Math.abs(dp), turn);
    if (ai.shots && now > ai.nextShot + 0.3) ai.shots = 0; // the spray resets after a pause
    const onTarget = Math.abs(angTo(p.yaw, wantYaw)) < 0.05 && Math.abs(wantPitch - p.pitch) < 0.05;
    if (onTarget && now >= ai.react && now >= (ai.nextShot ?? 0) && !ai.reloadUntil && round.phase === 'live') botShoot(bot, now, dist);
    simulate(bot, { fwd: 0, side: 0, duck: dist > 1300 && WEAPONS[bot.weapon].slot === 1 }); // stop to shoot; crouch for long shots
    return true;
  }

  // ---------- rounds + economy ----------
  const alive = (team) => [...ents.values()].filter((e) => e.team === team && e.alive).length;
  const give = (ent, amt) => { ent.money = Math.max(0, Math.min(ent.money + amt, MAX_MONEY)); };
  function endRound(winner, reason = 'elim') {
    round.scores[winner]++; round.winner = winner; round.reason = reason; round.phase = 'over'; round.left = END_TIME;
    for (const e of ents.values()) give(e, e.team === winner ? REWARD.win : REWARD.loss + (e.team === 't' && bomb.planter ? REWARD.plantedLoss : 0));
    for (const e of ents.values()) { e.planting = e.defusing = null; }
    emit({ e: 'round', phase: 'over', winner, reason });
  }
  // bots buy at the start of a round like CS bots: the best gun they can afford (keeping money for kevlar when they can), then kevlar
  const BOT_GUNS = { ct: ['m4a1', 'famas', 'mp5', 'tmp'], t: ['ak47', 'galil', 'mac10'] };
  function botsBuy() {
    for (const b of ents.values()) {
      if (!b.bot || !b.alive || b.hostage) continue;
      if (![...b.owned].some((w) => WEAPONS[w].slot === 1)) {
        const gun = BOT_GUNS[b.team].find((w) => b.money >= WEAPONS[w].price + (b.money >= WEAPONS[w].price + 650 ? 650 : 0)) ?? BOT_GUNS[b.team].find((w) => b.money >= WEAPONS[w].price);
        if (gun) buy(b, gun);
      }
      if (b.money >= 650 && b.armor < 100) buy(b, b.money >= 1000 + 400 ? 'vesthelm' : 'kevlar');
      if (botsFight) {
        const fireNade = b.team === 't' ? 'molotov' : 'incgrenade';
        for (const g of [fireNade, 'smokegrenade', 'hegrenade', 'flashbang']) if (b.money >= WEAPONS[g].price + 400) buy(b, g);
      }
    }
  }
  function newRound() {
    autoBalance();
    grenades.length = 0; smokes.length = 0; fires.length = 0; drops.length = 0;
    round.tSite = Math.floor(Math.random() * (sites?.length ?? 1));
    round.number++; round.phase = 'freeze'; round.left = FREEZE; round.elapsed = 0; round.rescued = 0;
    Object.assign(bomb, { state: 'none', carrier: 0, o: null, explodeAt: 0, defuser: 0, planter: 0 });
    resetMovers();
    for (const e of ents.values()) {
      e.owned.delete('c4'); if (e.weapon === 'c4') e.weapon = DEFAULT_PISTOL[e.team];
      if (!e.alive) resetLoadout(e); // the dead lose their gear
      spawn(e);
    }
    addHostages(); giveBomb(); botsBuy();
    emit({ e: 'round', phase: 'freeze' });
  }
  function updateRound() {
    if (range) { // no rounds: the dead are back after 1.5 s, money is unlimited
      Object.assign(round, { phase: 'live', left: roundTime });
      for (const e of ents.values()) { if (!e.alive && now() - (e.diedAt ?? 0) > 1.5) spawn(e); e.money = MAX_MONEY; }
      return;
    }
    round.left -= TICK;
    if (round.phase === 'freeze' && round.left <= 0) { round.phase = 'live'; round.left = roundTime; round.elapsed = 0; emit({ e: 'round', phase: 'live' }); }
    else if (round.phase === 'live') {
      round.elapsed += TICK;
      const ct = alive('ct'), t = alive('t');
      if (bomb.state === 'planted') { // the clock is now the bomb: it explodes or gets defused; killing every T does not end it
        round.left = Math.max(bomb.explodeAt - tickNo * TICK, 0);
        if (!ct) endRound('t');
      } else if (!t && !ct) endRound('ct');
      else if (!t) endRound('ct'); else if (!ct) endRound('t');
      else if (hostageMode && round.rescued > 0 && !hostagesLeft()) endRound('ct', 'rescued'); // every surviving hostage is out
      else if (round.left <= 0) endRound(hostageMode ? 't' : 'ct', 'time'); // hostage maps: the Ts held them
    } else if (round.phase === 'over' && round.left <= 0) newRound();
  }

  // ---------- player actions ----------
  function setWeapon(ent, w, silent) {
    if (!WEAPONS[w] || !ent.owned.has(w) || ent.weapon === w) return;
    ent.weapon = w; ent.p.maxSpeed = WEAPONS[w].speed;
    if (!silent) emit({ e: 'deploy', id: ent.id, o: ent.p.o.map(r2), w });
  }
  function buy(ent, item) {
    const buyable = BUY.flatMap((c) => c.items).find((i) => i.id === item);
    if (!buyable || !ent.alive) return;
    if (!range && !(round.phase === 'freeze' || (round.phase === 'live' && round.elapsed < BUY_TIME))) return;
    if (buyable.team && buyable.team !== ent.team) return;
    if (ent.money < buyable.price) return;
    const w = WEAPONS[item];
    if (item === 'kevlar') { if (ent.armor >= 100) return; ent.armor = 100; }
    else if (item === 'vesthelm') { // full armor + helmet; with full armor already you only pay for the helmet
      if (ent.armor >= 100 && ent.helmet) return;
      if (ent.armor >= 100) { if (ent.money < 350) return; ent.helmet = true; ent.money -= 350; return; }
      ent.armor = 100; ent.helmet = true;
    }
    else if (item === 'defuser') { if (ent.kit) return; ent.kit = true; }
    else if (w.grenade) { if (!canCarryGrenade(ent.gr, item)) return; ent.gr[item] = (ent.gr[item] ?? 0) + 1; ent.owned.add(item); }
    else {
      if (ent.owned.has(item)) return;
      for (const o of [...ent.owned]) if (WEAPONS[o].slot === w.slot) ent.owned.delete(o); // replaces the slot's weapon
      ent.owned.add(item); ent.weapon = ''; setWeapon(ent, item);
    }
    ent.money -= buyable.price;
  }
  // CS:S armor (CCSPlayer::OnTakeDamage): kevlar covers chest, stomach, arms (and generic damage); the head only with a helmet; never the legs.
  // The weapon's ArmorRatio decides how much gets through: health takes dmg * ratio/2, the armor pays half of the rest.
  function applyDamage(target, attacker, dmg, wKey, { group = 2, bone = 0, dir = [0, 0, 1], from = null, wb = false, bypassArmor = false } = {}) {
    const covered = group === 0 || group === 2 || group === 3 || group === 4 || group === 5 || (group === 1 && target.helmet);
    if (target.armor > 0 && covered && !bypassArmor) {
      let health = dmg * 0.5 * (WEAPONS[wKey]?.armor ?? 1), armorLoss = (dmg - health) * 0.5;
      if (armorLoss > target.armor) { armorLoss = target.armor; health = dmg - armorLoss * 2; }
      target.armor -= armorLoss; dmg = health;
      if (target.armor <= 0) target.helmet = false;
    }
    target.health -= dmg;
    if (from && WEAPONS[wKey] && !WEAPONS[wKey].grenade && wKey !== 'c4') target.p.velMod = 0.5; // tagging: shot players slow down (CS:S m_flVelocityModifier)
    if (target.ai && attacker?.p && attacker.team !== target.team) target.ai.threat = attacker.id; // bots turn on whoever shot them
    if (from && !target.bot) emit({ e: 'hurt', to: target.id, from: from.map(r2), dmg: Math.round(dmg) }); // the victim's screen: direction + aim punch
    if (target.health > 0) return;
    target.health = 0; target.alive = false; target.diedAt = now();
    if (!target.hostage) { target.deaths++; attacker.kills += attacker !== target && attacker.team !== target.team ? 1 : -1; } // scoreboard: a team kill or suicide costs a frag
    if (target.hostage) give(attacker, -REWARD.hostageKill); // CS:S: killing a hostage costs you
    else if (attacker.team !== target.team) give(attacker, WEAPONS[wKey].melee ? REWARD.knife : REWARD.kill);
    if (!target.hostage && !range) {
      const pri = [...target.owned].find((k) => WEAPONS[k]?.slot === 1);
      const sec = [...target.owned].find((k) => WEAPONS[k]?.slot === 2 && k !== DEFAULT_PISTOL[target.team]);
      if (pri) dropWeapon(target, pri, false);
      else if (sec) dropWeapon(target, sec, false);
    }
    emit({ e: 'death', victim: target.id, killer: attacker.id, w: wKey, hs: group === 1, wb: wb ? 1 : 0, bone, dir, o: target.p.o.map(r2) });
  }
  // ---------- hits: lag compensation + validation ----------
  // Clients report their hits (their screen is what the player aimed at) with the shot ray and the server tick they were looking at.
  // The server rewinds the target to that tick (CS lag compensation, at most 0.4 s back) and accepts the hit only if the ray really
  // passes through the target there; a headshot claim must pass by the head (else it counts as the chest). Every bullet hit needs a shot
  // the server accepted just before (rate of fire: fired()), and the damage follows the real ray: range, walls, penetration.
  const HIST = 64, MAX_UNLAG = 0.4 * TICK_RATE;
  const record = () => { for (const e of ents.values()) (e.hist ??= [])[tickNo % HIST] = { t: tickNo, o: [...e.p.o], d: e.p.ducked }; };
  function rewound(e, rt) {
    const t = Math.min(Math.max(Number.isFinite(rt) ? rt : tickNo, tickNo - MAX_UNLAG), tickNo), i = Math.floor(t);
    const a = e.hist?.[i % HIST], b = e.hist?.[(i + 1) % HIST];
    if (!a || a.t !== i) return { o: e.p.o, ducked: e.p.ducked };
    if (!b || b.t !== i + 1) return { o: a.o, ducked: a.d };
    const k = t - i; return { o: a.o.map((v, j) => v + (b.o[j] - v) * k), ducked: k < 0.5 ? a.d : b.d };
  }
  const isVec = (v) => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  function shotRay(shooter, m) { // the reported ray if believable: from near the shooter's eye (client prediction runs a few ticks ahead, never through a wall)
    if (!isVec(m.d)) return null;
    const l = Math.hypot(...m.d), eye = shooter.p.eye;
    if (l < 0.5) return null;
    const near = isVec(m.o) && Math.hypot(m.o[0] - eye[0], m.o[1] - eye[1], m.o[2] - eye[2]) < 64 && trace(world, eye, m.o, ZERO, ZERO, bulletLimit).fraction > 0.99;
    return { o: near ? m.o : eye, d: m.d.map((v) => v / l) };
  }
  function fired(ent, m) { // a shot: rate of fire is a token bucket at the weapon's cycle (3 shots of slack for network bunching)
    const w = WEAPONS[m.w];
    if (!ent.alive || !ent.owned.has(m.w) || !w || w.melee || w.grenade || w.c4) return;
    const t = now();
    ent.fireTok = Math.min((ent.fireTok ?? 3) + (t - (ent.fireAt ?? t)) / (w.cycle * 0.9), 3); ent.fireAt = t;
    if (ent.fireTok < 1) return; // faster than the gun can fire: dropped
    ent.fireTok -= 1; ent.firedW = m.w; ent.hitUntil = t + 0.5; ent.hitTok = w.pellets ?? 1; // a shot's hits follow it in order: no banking across shots
    // shortcut: ammo is not tracked server-side (the bucket bounds the damage rate); add per-weapon mags if reload cheats matter
    const to = isVec(m.to) && Math.hypot(m.to[0] - ent.p.o[0], m.to[1] - ent.p.o[1], m.to[2] - ent.p.o[2]) < 8300 ? m.to : null; // visuals: tracer end
    emit({ e: 'shot', id: ent.id, o: ent.p.o.map(r2), w: m.w, to });
    if (to && movers.defs.length) { const e = ent.p.eye, l = Math.hypot(to[0] - e[0], to[1] - e[1], to[2] - e[2]) || 1; damageMovers(e, to.map((v, k) => v + ((v - e[k]) / l) * 8), w.damage * (w.pellets ?? 1)); } // a little past the end: a bullet stopped by the pane ends on its surface
  }
  function hit(shooter, m) {
    const target = ents.get(m.target), w = WEAPONS[m.w];
    if (!target || !w || !shooter.alive || !target.alive || target.team === shooter.team || !shooter.owned.has(m.w) || w.grenade) return;
    const t = now();
    if (w.melee) { if (t - (shooter.knifeAt ?? -9) < 0.3) return; shooter.knifeAt = t; } // swing rate
    else { if (shooter.firedW !== m.w || !(shooter.hitTok >= 1) || t > shooter.hitUntil) return; shooter.hitTok--; } // hits arrive right after their shot
    const ray = shotRay(shooter, m);
    if (!ray) return;
    const { o: to, ducked } = rewound(target, Number(m.rt)), kz = ducked ? 0.72 : 1, [dx, dy, dz] = ray.d, hh = dx * dx + dy * dy;
    // where the ray passes the target's vertical axis; it must go through the body there (hull + arms / gun)
    const tc = hh > 1e-6 ? ((to[0] - ray.o[0]) * dx + (to[1] - ray.o[1]) * dy) / hh : (to[2] + 40 * kz - ray.o[2]) / dz;
    const P = ray.o.map((v, j) => v + ray.d[j] * tc);
    if (!(tc > 0) || Math.hypot(P[0] - to[0], P[1] - to[1]) > 28 || P[2] < to[2] - 8 || P[2] > to[2] + 72 * kz + 8) return;
    let group = HITGROUP_MULT[m.group] ? Number(m.group) : 2;
    if (group === 1) { // the head (bodyHit's sphere centre) must be within reach of the ray
      const c = [to[0] - ray.o[0], to[1] - ray.o[1], to[2] + 63 * kz - ray.o[2]], along = c[0] * dx + c[1] * dy + c[2] * dz;
      if (Math.hypot(c[0] - dx * along, c[1] - dy * along, c[2] - dz * along) > 16) group = 2;
    }
    if (tc > (w.melee ? 90 : 8192) || (w.melee && m.alt && tc > (w.stabRange ?? 32) + 40)) return;
    const wall = trace(world, ray.o, P, ZERO, ZERO, bulletLimit).fraction < 0.99;
    // walls: knives are stopped by them; bullets may punch through (ballistics.js decides how much damage is left)
    const k = w.melee ? (wall ? 0 : 1) : reach(bulletCtx, ray.o, P, w);
    if (!k) return;
    let dmg;
    if (w.melee) { // knife: slash 25 / stab 50 (before kevlar), three times that from behind (backstab); hit groups do not matter
      const fwd = [Math.cos(target.p.yaw), Math.sin(target.p.yaw)], d2 = [target.p.o[0] - shooter.p.o[0], target.p.o[1] - shooter.p.o[1]], tl = Math.hypot(...d2) || 1;
      const behind = (fwd[0] * d2[0] + fwd[1] * d2[1]) / tl > 0.5; // the victim faces away from us
      dmg = (m.alt ? w.stab : w.damage) * (behind ? 3 : 1);
    } else dmg = w.damage * Math.pow(w.rangeMod ?? 1, tc / 500) * HITGROUP_MULT[group] * k;
    applyDamage(target, shooter, dmg, m.w, { group, bone: Number(m.bone) || 0, dir: ray.d.map(r2), from: ray.o, wb: !w.melee && wall });
  }

  // ---------- the bomb ----------
  // state: none (not handed out yet) | carried (bomb.carrier) | dropped (bomb.o) | planted (bomb.o, explodeAt) | defused | exploded
  const bomb = { state: 'none', carrier: 0, o: null, explodeAt: 0, defuser: 0, planter: 0 };
  const now = () => tickNo * TICK;
  function giveBomb(to = null) { // one random T (or `to`) gets the C4
    if (range || !sites) return; // no bombsites (hostage maps): no bomb
    const ts = [...ents.values()].filter((e) => e.team === 't' && e.alive);
    const ent = to ?? ts[Math.floor(Math.random() * ts.length)];
    if (!ent) { bomb.state = 'none'; return; }
    for (const e of ents.values()) e.owned.delete('c4');
    ent.owned.add('c4'); Object.assign(bomb, { state: 'carried', carrier: ent.id, o: [...ent.p.o] });
  }
  const floorBelow = (o) => { const r = trace(world, [o[0], o[1], o[2] + 8], [o[0], o[1], o[2] - 600], [-4, -4, 0], [4, 4, 4], bulletLimit); return [o[0], o[1], r.end[2]]; };
  function dropBomb(ent, toss) {
    let o = bomb.o ?? ent?.p.o;
    if (ent) {
      o = ent.p.o;
      if (toss) { // G: thrown a little in front, never into a wall
        const f = [Math.cos(ent.p.yaw), Math.sin(ent.p.yaw), 0], from = [o[0], o[1], o[2] + 40];
        const r = trace(world, from, [from[0] + f[0] * 64, from[1] + f[1] * 64, from[2]], [-4, -4, -4], [4, 4, 4], bulletLimit);
        o = r.end;
      }
      ent.owned.delete('c4');
      if (ent.weapon === 'c4') { const next = [...ent.owned].sort((a, b) => WEAPONS[a].slot - WEAPONS[b].slot)[0]; ent.weapon = ''; setWeapon(ent, next, true); }
      ent.planting = null;
    }
    Object.assign(bomb, { state: 'dropped', carrier: 0, o: floorBelow(o) });
    emit({ e: 'bombdrop', o: bomb.o.map(r2) }); repathAll();
  }
  function startPlant(ent) {
    if (ent.planting || bomb.state !== 'carried' || bomb.carrier !== ent.id || !ent.alive || round.phase !== 'live' || ent.weapon !== 'c4' || !ent.p.onGround || !inSite(ent.p.o)) return;
    ent.planting = { end: now() + BOMB.plantTime, start: now() };
    emit({ e: 'planting', id: ent.id, o: ent.p.o.map(r2) });
  }
  function cancelPlant(ent) { if (!ent.planting) return; ent.planting = null; emit({ e: 'plantcancel', id: ent.id }); } // stops the arming beeps others hear
  function startDefuse(ent) {
    if (ent.defusing || bomb.state !== 'planted' || ent.team !== 'ct' || !ent.alive || round.phase !== 'live') return;
    if (bomb.defuser && bomb.defuser !== ent.id && ents.get(bomb.defuser)?.defusing) return; // someone else is already on it
    if (Math.hypot(ent.p.o[0] - bomb.o[0], ent.p.o[1] - bomb.o[1], (ent.p.o[2] - bomb.o[2]) * 0.5) > BOMB.useRange) return;
    ent.defusing = { start: now(), end: now() + (ent.kit ? BOMB.kitTime : BOMB.defuseTime) }; bomb.defuser = ent.id;
    emit({ e: 'defusing', id: ent.id, o: bomb.o.map(r2), kit: ent.kit ? 1 : 0 });
  }
  function updateBomb() {
    const t = now();
    if (round.phase === 'freeze' && bomb.state === 'none') giveBomb();
    if (bomb.state === 'carried') {
      const c = ents.get(bomb.carrier);
      if (!c || !c.alive || c.team !== 't' || !c.owned.has('c4')) dropBomb(c && c.owned.has('c4') ? c : null); // died / left / switched team
      else bomb.o = [...c.p.o];
    }
    if (bomb.state === 'dropped') { // any live T walking over it picks it up
      for (const e of ents.values()) if (e.alive && e.team === 't' && Math.hypot(e.p.o[0] - bomb.o[0], e.p.o[1] - bomb.o[1]) < 40 && Math.abs(e.p.o[2] - bomb.o[2]) < 64) {
        giveBomb(e); emit({ e: 'bombpickup', id: e.id }); repathAll(); break;
      }
    }
    for (const e of ents.values()) {
      if (e.planting) {
        if (!e.alive || bomb.carrier !== e.id || e.weapon !== 'c4' || !inSite(e.p.o) || round.phase !== 'live') cancelPlant(e);
        else if (t >= e.planting.end) { // planted
          e.planting = null; e.owned.delete('c4');
          const next = [...e.owned].sort((a, b) => WEAPONS[a].slot - WEAPONS[b].slot)[0]; e.weapon = ''; setWeapon(e, next, true);
          Object.assign(bomb, { state: 'planted', carrier: 0, o: floorBelow(e.p.o), explodeAt: t + bombTimer, planter: e.id, defuser: 0 });
          give(e, REWARD.plant); emit({ e: 'planted', o: bomb.o.map(r2), by: e.id }); repathAll();
        }
      }
      if (e.defusing) {
        const far = Math.hypot(e.p.o[0] - bomb.o[0], e.p.o[1] - bomb.o[1], (e.p.o[2] - bomb.o[2]) * 0.5) > BOMB.useRange + 16;
        if (!e.alive || bomb.state !== 'planted' || far || round.phase !== 'live') { e.defusing = null; if (bomb.defuser === e.id) bomb.defuser = 0; }
        else if (t >= e.defusing.end) {
          e.defusing = null; bomb.state = 'defused'; give(e, REWARD.defuse);
          emit({ e: 'defused', by: e.id, o: bomb.o.map(r2) }); endRound('ct', 'defused');
        }
      }
    }
    if (bomb.state === 'planted' && round.phase === 'live' && t >= bomb.explodeAt) { // boom: everyone near it, either team
      bomb.state = 'exploded';
      emit({ e: 'bombexplode', o: bomb.o.map(r2) });
      const planter = ents.get(bomb.planter) ?? { id: -1, team: 't', money: 0 }, sigma = BOMB.radius / 3, centre = [bomb.o[0], bomb.o[1], bomb.o[2] + 8];
      for (const v of ents.values()) {
        if (!v.alive) continue;
        const chest = [v.p.o[0], v.p.o[1], v.p.o[2] + 36], d = Math.hypot(chest[0] - centre[0], chest[1] - centre[1], chest[2] - centre[2]);
        if (d > BOMB.radius) continue;
        const dmg = BOMB.damage * Math.exp(-(d * d) / (2 * sigma * sigma)), dir = [chest[0] - centre[0], chest[1] - centre[1], 40], dl = Math.hypot(...dir) || 1;
        if (dmg > 1) applyDamage(v, planter, dmg, 'c4', { dir: dir.map((x) => r2(x / dl)), from: centre });
      }
      endRound('t', 'bombed');
    }
  }

  // ---------- grenades + world weapon drops ----------
  const grenades = [], smokes = [], fires = [], drops = [];
  let nextGrenade = 1, nextDropId = 1;
  function dropWeapon(ent, wKey, toss) {
    const w = WEAPONS[wKey];
    if (!w || (w.slot !== 1 && w.slot !== 2) || !ent.owned.has(wKey)) return false;
    ent.owned.delete(wKey);
    let o = [...ent.p.o];
    if (toss) {
      const f = [Math.cos(ent.p.yaw), Math.sin(ent.p.yaw), 0], from = [o[0], o[1], o[2] + 40];
      const r = trace(world, from, [from[0] + f[0] * 64, from[1] + f[1] * 64, from[2]], [-4, -4, -4], [4, 4, 4], bulletLimit);
      o = r.end;
    }
    const pos = floorBelow(o);
    drops.push({ id: nextDropId++, w: wKey, o: pos, yaw: ent.p.yaw ?? 0, grace: toss ? 0.9 : 0 });
    if (ent.weapon === wKey) {
      const next = [...ent.owned].sort((a, b) => WEAPONS[a].slot - WEAPONS[b].slot)[0] ?? 'knife';
      ent.weapon = ''; setWeapon(ent, next, true);
    }
    emit({ e: 'weapondrop', id: ent.id, w: wKey, o: pos.map(r2) });
    return true;
  }
  function useDrop(ent) {
    if (!ent.alive || ent.hostage || round.phase === 'over') return false;
    const fwd = [Math.cos(ent.p.yaw), Math.sin(ent.p.yaw)];
    let bestIdx = -1, bestD = 90;
    for (let i = 0; i < drops.length; i++) {
      const d = drops[i], dx = d.o[0] - ent.p.o[0], dy = d.o[1] - ent.p.o[1], dist = Math.hypot(dx, dy);
      if (dist < bestD && Math.abs(d.o[2] - ent.p.o[2]) < 72 && (dist < 32 || (fwd[0] * dx + fwd[1] * dy) / (dist || 1) > 0.45)) { bestIdx = i; bestD = dist; }
    }
    if (bestIdx < 0) return false;
    const [d] = drops.splice(bestIdx, 1), slot = WEAPONS[d.w].slot;
    const old = [...ent.owned].find((k) => WEAPONS[k]?.slot === slot);
    if (old) dropWeapon(ent, old, false);
    ent.owned.add(d.w); ent.weapon = ''; setWeapon(ent, d.w);
    emit({ e: 'itempickup', id: ent.id, item: d.w });
    return true;
  }
  function updateDrops() {
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      if (d.grace > 0) { d.grace = Math.max(0, d.grace - TICK); continue; }
      const slot = WEAPONS[d.w]?.slot;
      for (const e of ents.values()) {
        if (!e.alive || e.hostage || [...e.owned].some((k) => WEAPONS[k]?.slot === slot)) continue;
        if (Math.hypot(e.p.o[0] - d.o[0], e.p.o[1] - d.o[1]) < 40 && Math.abs(e.p.o[2] - d.o[2]) < 64) {
          e.owned.add(d.w);
          if (slot === 1 || (e.bot && WEAPONS[d.w].price > (WEAPONS[e.weapon]?.price ?? 0))) { e.weapon = ''; setWeapon(e, d.w); }
          emit({ e: 'itempickup', id: e.id, item: d.w });
          drops.splice(i, 1);
          break;
        }
      }
    }
  }
  const ZERO = [0, 0, 0];
  const cut = (ent, key) => { // one grenade less; fall back to a real weapon when the last one is gone
    ent.gr[key]--;
    if (ent.gr[key] > 0) return;
    delete ent.gr[key]; ent.owned.delete(key);
    if (ent.weapon === key) { const next = [...ent.owned].sort((x, y) => WEAPONS[x].slot - WEAPONS[y].slot)[0]; ent.weapon = ''; setWeapon(ent, next, true); }
  };
  function throwGrenade(ent, m) {
    const w = WEAPONS[m.w];
    if (!w?.grenade || !ent.alive || !(ent.gr[m.w] > 0) || round.phase !== 'live') return;
    cut(ent, m.w);
    const power = Math.min(Math.max(Number(m.power) || 1, 0.25), 1), start = launch(world, bulletLimit, ent.p, power);
    grenades.push({ id: nextGrenade++, w: m.w, owner: ent.id, attacker: ent, team: ent.team, ...start, age: 0, lastBounce: -1 });
  }
  function explode(g) {
    const k = WEAPONS[g.w].grenade, owner = g.attacker;
    emit({ e: 'explode', w: g.w, o: g.o.map(r2), by: g.owner });
    if (WEAPONS[g.w].grenade === 'he') movers.defs.forEach((d, i) => { if (d.breakable && Math.hypot(...d.center.map((v, k) => v - g.o[k])) < 300) damageMovers(g.o, d.center, 1e9); });
    const at = [g.o[0], g.o[1], g.o[2] + 6];
    if (k === 'smoke') { smokes.push({ id: g.id, o: [...g.o], age: 0 }); return; }
    if (k === 'fire') {
      const cells = fireCells(world, bulletLimit, g.o);
      if (cells.length) fires.push({ id: g.id, w: g.w, owner, team: g.team, o: cells[0], cells, age: 0, damageAt: 0 });
      return;
    }
    for (const t of ents.values()) {
      if (!t.alive) continue;
      const chest = [t.p.o[0], t.p.o[1], t.p.o[2] + 36], eye = t.p.eye;
      if (k === 'he') {
        const d = Math.hypot(chest[0] - g.o[0], chest[1] - g.o[1], chest[2] - g.o[2]);
        if (d > GRENADE.heRadius || (t.team === g.team && t.id !== g.owner)) continue; // no friendly fire, but you can hurt yourself
        if (trace(world, at, chest, ZERO, ZERO, bulletLimit).fraction < 0.9) continue;
        const dmg = GRENADE.heDamage * (1 - d / GRENADE.heRadius), dir = [chest[0] - g.o[0], chest[1] - g.o[1], chest[2] - g.o[2] + 40], dl = Math.hypot(...dir) || 1;
        applyDamage(t, owner, dmg, g.w, { dir: dir.map((v) => r2(v / dl)), from: g.o });
      } else {
        const d = Math.hypot(eye[0] - g.o[0], eye[1] - g.o[1], eye[2] - g.o[2]);
        if (d > GRENADE.flashRange || trace(world, at, eye, ZERO, ZERO, bulletLimit).fraction < 0.97) continue;
        const cp = Math.cos(t.p.pitch), look = [cp * Math.cos(t.p.yaw), cp * Math.sin(t.p.yaw), Math.sin(t.p.pitch)];
        const facing = (look[0] * (g.o[0] - eye[0]) + look[1] * (g.o[1] - eye[1]) + look[2] * (g.o[2] - eye[2])) / (d || 1);
        const dur = 4.5 * (1 - d / GRENADE.flashRange) * (facing > 0.5 ? 1 : facing > -0.2 ? 0.6 : 0.25);
        if (dur > 0.2) { emit({ e: 'flash', to: t.id, dur: r2(dur) }); if (t.ai) t.ai.blindUntil = tickNo * TICK + dur * 0.8; }
      }
    }
  }
  function stepGrenade(g) { // returns false when the grenade is spent
    g.age += TICK;
    const kind = WEAPONS[g.w].grenade;
    const speed = stepFlight(world, bulletLimit, g, TICK);
    if (speed > 90 && g.age - g.lastBounce > 0.06) { g.lastBounce = g.age; emit({ e: 'bounce', w: g.w, o: g.o.map(r2) }); }
    if (detonates(kind, g)) { explode(g); return false; }
    return true;
  }
  function updateGrenades() {
    for (let i = grenades.length - 1; i >= 0; i--) if (!stepGrenade(grenades[i])) grenades.splice(i, 1);
    for (let i = smokes.length - 1; i >= 0; i--) { smokes[i].age += TICK; if (smokes[i].age > GRENADE.smokeTime) smokes.splice(i, 1); }
    for (let i = fires.length - 1; i >= 0; i--) {
      const f = fires[i]; f.age += TICK;
      const extinguished = smokes.some((m) => smokeExtinguishes(world, bulletLimit, f, m));
      if (f.age >= GRENADE.fireTime || extinguished) {
        if (extinguished) emit({ e: 'extinguish', o: f.o.map(r2) });
        fires.splice(i, 1); continue;
      }
      if (f.age < f.damageAt) continue;
      f.damageAt = f.age + GRENADE.fireTick;
      for (const t of ents.values()) {
        if (!t.alive || (t.team === f.team && t.id !== f.owner.id) || !fireTouches(world, bulletLimit, f, t.p.o)) continue;
        applyDamage(t, f.owner, GRENADE.fireDps * GRENADE.fireTick, f.w, { from: f.o, bypassArmor: true });
      }
    }
  }

  // ---------- network ----------
  function connect(ws) { // false = full (maxPlayers humans; default: humans fill both teams)
    if (humans().length >= (maxPlayers ?? teamSize * 2)) return false;
    let ent = null;
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    ws.on('message', (raw) => {
      let m; try { m = JSON.parse(raw); } catch { return; }
      if (m.t === 'join' && !ent) {
        const count = (t) => [...ents.values()].filter((e) => e.team === t && !e.bot).length;
        const auto = count('ct') <= count('t') ? 'ct' : 't', team = m.team === 'spec' ? 'spec' : (m.team === 'ct' || m.team === 't') && count(m.team) <= count(other(m.team)) ? m.team : auto; // never onto the bigger team; the menu joins as a spectator
        ent = addEntity({ team, name: String(m.name || 'Player').slice(0, 24).replace(/[<>&]/g, ''), bot: false, ws });
        fillBots(); // a bot of that team makes room for the human
        send({ t: 'welcome', id: ent.id, tickRate: TICK_RATE, team });
      } else if (!ent) return;
      else if (m.t === 'cmd') { if (ent.queue.length < 64) ent.queue.push(m); } // run at the tick rate (see tick()), so jittery networks still move smoothly
      else if (m.t === 'weapon') setWeapon(ent, m.w);
      else if (m.t === 'fire') fired(ent, m);
      else if (m.t === 'hit') hit(ent, m);
      else if (m.t === 'throw') throwGrenade(ent, m);
      else if (m.t === 'buy') buy(ent, m.item);
      else if (m.t === 'plant') { if (m.on) startPlant(ent); else cancelPlant(ent); }
      else if (m.t === 'name' && typeof m.name === 'string' && m.name.trim()) ent.name = m.name.trim().slice(0, 24).replace(/[<>&]/g, ''); // Options > player name
      else if (m.t === 'use') { if (!useHostage(ent) && !useDoor(ent)) useDrop(ent); }
      else if (m.t === 'defuse') { if (m.on) startDefuse(ent); else if (ent.defusing) { ent.defusing = null; if (bomb.defuser === ent.id) bomb.defuser = 0; } }
      else if (m.t === 'drop' && ent.alive && round.phase !== 'over') {
        if (bomb.state === 'carried' && bomb.carrier === ent.id && ent.weapon === 'c4') dropBomb(ent, true);
        else dropWeapon(ent, ent.weapon, true);
      }
      else if (m.t === 'team' && (m.team === 'ct' || m.team === 't' || m.team === 'spec') && m.team !== ent.team) {
        // a spectator may join a team that has no more humans than the other one; a player may switch to one with fewer than theirs
        const full = m.team !== 'spec' && (ent.team === 'spec' ? humansOn(m.team) > humansOn(other(m.team)) : humansOn(m.team) >= humansOn(ent.team));
        if (full) send({ t: 'notice', text: 'That team is full: it already has as many players as yours' });
        else moveTeam(ent, m.team);
      }
    });
    let pingAt = 0; // latency for the scoreboard: a WebSocket ping every second, timed to its pong
    const pinger = setInterval(() => { if (ws.readyState === 1) { pingAt = performance.now(); ws.ping(); } }, 1000);
    ws.on('pong', () => { if (ent) ent.ping = performance.now() - pingAt; });
    ws.on('close', () => { clearInterval(pinger); if (ent) { if (bomb.carrier === ent.id) dropBomb(ent); ents.delete(ent.id); fillBots(); } });
    ws.on('error', () => {});
    return true;
  }

  const P_FIELDS = ['onGround', 'ducked', 'ducking', 'ducktime', 'stamina', 'oldJump', 'oldDuck', 'eyeZ', 'velMod'];
  function snapshot() {
    record();
    const list = [...ents.values()].filter((e) => e.team !== 'spec').map((e) => ({
      id: e.id, team: e.team, bot: e.bot ? 1 : 0, name: e.name, o: e.p.o.map(r2), yaw: r2(e.p.yaw), pt: r2(e.p.pitch), v: [r2(e.p.v[0]), r2(e.p.v[1])], m: e.money,
      ar: e.armor > 0 ? 1 : 0, hm: e.helmet ? 1 : 0, duck: e.p.ducked ? 1 : 0, cr: e.p.oldDuck || e.p.ducked ? 1 : 0, alive: e.alive ? 1 : 0, hp: Math.round(e.health), w: e.weapon, g: e.p.onGround ? 1 : 0, k: e.kills, dt: e.deaths, pg: e.bot ? 0 : Math.round(e.ping),
    }));
    const rd = { winner: round.phase === 'over' ? round.winner : null, reason: round.phase === 'over' ? round.reason : null, bomb: bomb.state === 'planted' ? 1 : 0, phase: round.phase, left: r2(Math.max(round.left, 0)), scores: round.scores, number: round.number, alive: { ct: alive('ct'), t: alive('t') } };
    const bm = { s: bomb.state, o: bomb.o?.map(r2) ?? null, carrier: bomb.carrier, left: bomb.state === 'planted' ? r2(Math.max(bomb.explodeAt - now(), 0)) : 0, defusing: bomb.defuser && ents.get(bomb.defuser)?.defusing ? bomb.defuser : 0 };
    const gr = grenades.map((g) => ({ id: g.id, w: g.w, o: g.o.map(r2) })), smk = smokes.map((m) => ({ id: m.id, o: m.o.map(r2), age: r2(m.age) }));
    const flames = fires.map((f) => ({ id: f.id, o: f.o.map(r2), cells: f.cells.map((p) => p.map(r2)), age: r2(f.age) }));
    const drp = drops.map((d) => ({ id: d.id, w: d.w, o: d.o.map(r2), yaw: r2(d.yaw) }));
    for (const e of ents.values()) {
      if (!e.ws) continue;
      const you = { id: e.id, yaw: e.p.yaw, ack: e.lastSeq, team: e.team, money: e.money, armor: Math.round(e.armor), hp: Math.round(e.health), alive: e.alive ? 1 : 0, owned: [...e.owned], gr: e.gr, weapon: e.weapon, o: e.p.o, v: e.p.v, kit: e.kit ? 1 : 0, helmet: e.helmet ? 1 : 0, inSite: e.team === 't' && inSite(e.p.o) ? 1 : 0 };
      const act = e.planting ?? e.defusing; // progress bar
      you.act = act ? { k: e.planting ? 'plant' : 'defuse', p: r2((now() - act.start) / (act.end - act.start)), len: r2(act.end - act.start) } : null;
      for (const f of P_FIELDS) you[f] = e.p[f];
      if (e.ws.readyState === 1) e.ws.send(JSON.stringify({ t: 'snap', tick: tickNo, ents: list, you, round: rd, ev: events, gr, smokes: smk, fires: flames, drops: drp, bomb: bm, mv: movers.defs.length ? Array.from(movers.state, r2) : undefined }));
    }
  }

  // ---------- main loop: fixed 128 Hz with catch-up, driven by setInterval(1) ----------
  let last = performance.now(), acc = 0, running = true, ticksRun = 0, started = performance.now();
  function tick() {
    for (const e of ents.values()) {
      if (e.hostage) hostageThink(e);
      else if (e.bot) think(e);
      else if (e.queue.length) { // one usercmd per tick; a backlog (network hiccup) drains a little faster
        const n = e.queue.length > 8 ? 3 : e.queue.length > 3 ? 2 : 1;
        for (let i = 0; i < n && e.queue.length; i++) processCmd(e, e.queue.shift());
      }
    }
    updateGrenades();
    updateMovers();
    updateHurt();
    updateBomb();
    updateDrops();
    updateRound();
    tickNo++; ticksRun++;
    snapshot(); events = [];
  }
  const timer = setInterval(() => {
    const now = performance.now(); acc += Math.min((now - last) / 1000, 0.25); last = now;
    while (running && acc >= TICK) { tick(); acc -= TICK; }
  }, 1);
  fillBots(); addHostages();
  if (range) for (const e of ents.values()) e.money = MAX_MONEY; // range targets carry real guns
  giveBomb(); botsBuy();
  return {
    // admin: the people on the server, and kicking one (closed with 4001; their client says so instead of reconnecting)
    players: () => [...ents.values()].filter((e) => !e.bot).map((e) => ({ id: e.id, name: e.name, team: e.team, ping: Math.round(e.ping), kills: e.kills })),
    kick(id) { const e = ents.get(id); if (!e || e.bot) return false; e.ws?.close(4001, 'kicked'); return true; },
    bots: botsOn,
    connect, ents, round, tick: () => tickNo, range, hostageMode, rescueZones, teamSize, maxPlayers: maxPlayers ?? teamSize * 2, bomb, drops, inSite, sites, stats: () => ({ tickRate: TICK_RATE, ticks: ticksRun, measuredHz: ticksRun / ((performance.now() - started) / 1000), entities: ents.size, humans: humans().length }),
    stop() { running = false; clearInterval(timer); },
  };
}
