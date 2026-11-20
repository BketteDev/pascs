// Small deterministic scenarios: safe to run on a phone, no large map or TCP required.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createGame } from './server/game.mjs';
import { WEAPONS } from './public/weapon-defs.js';
import { freshAmmo } from './public/ammo.js';
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pascs-gameplay-'));
const box = (a, b) => [...a, ...b, 1, 0, 0, b[0], -1, 0, 0, -a[0], 0, 1, 0, b[1], 0, -1, 0, -a[1], 0, 0, 1, b[2], 0, 0, -1, -a[2]];
fs.writeFileSync(path.join(directory, 'world.json'), JSON.stringify({ collision: [box([-1000, -1000, -32], [1000, 1000, 0])], spawns: { ct: [{ o: [-700, 0, 1], yaw: 0 }], t: [{ o: [700, 0, 1], yaw: 180 }] } }));
fs.writeFileSync(path.join(directory, 'nav.json'), JSON.stringify({ nodes: [], edges: [] }));
const original = { now: performance.now, interval: globalThis.setInterval, clear: globalThis.clearInterval };
let clock = 0, game;
const timers = new Set();
performance.now = () => clock;
globalThis.setInterval = (fn, delay) => { const timer = { fn, delay, next: clock + delay }; timers.add(timer); return timer; };
globalThis.clearInterval = (timer) => timers.delete(timer);
const advance = (seconds) => { const until = clock + seconds * 1000; for (; clock < until; clock++) for (const timer of timers) if (clock >= timer.next) { timer.next += timer.delay; timer.fn(); } };
function socket() {
  const ws = new EventEmitter(), c = { ws, id: null, messages: [], events: [], snaps: 0, aq: 0 };
  ws.readyState = 1; ws.bufferedAmount = 0; ws.ping = () => ws.emit('pong');
  ws.close = (code = 1006) => { ws.readyState = 3; ws.emit('close', code); };
  ws.send = (raw) => { const d = JSON.parse(raw); c.messages.push(d); if (d.t === 'welcome') { c.id = d.id; c.welcome = d; } if (d.t === 'snap') { c.last = d; c.snaps++; c.events.push(...d.ev); } };
  c.send = (m) => ws.emit('message', JSON.stringify(['fire', 'reload', 'weapon'].includes(m.t) ? { aq: ++c.aq, ...m } : m));
  assert(game.connect(ws)); return c;
}
function player(team) { const c = socket(); c.send({ t: 'join', team, name: team }); c.ent = game.ents.get(c.id); return c; }
const shots = (c, w) => c.events.filter((e) => e.e === 'shot' && e.id === c.id && e.w === w).length;
try {
  game = createGame({ mapDir: directory, bots: false, maxPlayers: 2, botDifficulty: 'normal' });
  assert.equal(game.botDifficulty, 'normal');
  const a = player('ct'), b = player('t'), ent = a.ent;
  a.send({ t: 'fire', w: 'usp' }); assert.equal(ent.ammo.usp.mag, 12, 'freeze time disallows shooting');
  Object.assign(game.round, { phase: 'live', left: 1000 });
  const tick0 = game.tick(), snaps0 = a.snaps;
  advance(2);
  assert.equal(game.tick() - tick0, 255, '128 Hz simulation over two seconds (first timer starts at 1 ms)');
  assert.equal(a.snaps - snaps0, 63, '32 Hz snapshots independent of simulation');
  for (let i = 0; i < 12; i++) { a.send({ t: 'fire', w: 'usp' }); advance(0.17); }
  assert.equal(ent.ammo.usp.mag, 0); assert.equal(shots(a, 'usp'), 12);
  a.send({ t: 'fire', w: 'usp' }); advance(0.04); assert.equal(shots(a, 'usp'), 12, 'empty gun cannot fire');
  a.send({ t: 'reload', w: 'usp' }); advance(WEAPONS.usp.reload - 0.03);
  a.send({ t: 'fire', w: 'usp' }); assert.equal(ent.ammo.usp.mag, 0, 'cannot fire before reload completes');
  advance(0.05); assert.deepEqual(ent.ammo.usp, { mag: 12, reserve: 88 });
  assert.equal(a.last.you.ammoAck, a.aq, 'snapshots acknowledge ammo actions');
  a.send({ t: 'fire', w: 'usp' }); advance(0.17);
  a.send({ t: 'reload', w: 'usp' }); advance(0.5);
  a.send({ t: 'weapon', w: 'knife' }); advance(2);
  assert.equal(ent.ammo.usp.mag, 11, 'switching weapons cancels a magazine reload');
  a.send({ t: 'weapon', w: 'usp' });
  const replay = { t: 'fire', w: 'usp', aq: ++a.aq };
  a.send(replay); a.send(replay); assert.equal(ent.ammo.usp.mag, 10, 'duplicate action cannot spend another bullet');

  // A picked-up weapon carries its real ammunition, rather than giving a free full magazine.
  ent.ammo.usp = { mag: 1, reserve: 20 };
  a.send({ t: 'drop' });
  const drop = game.drops.find((d) => d.w === 'usp'); assert(drop);
  b.ent.p.o = [drop.o[0] - 25, drop.o[1], drop.o[2] + 1]; b.ent.p.yaw = 0;
  b.send({ t: 'use' }); assert.deepEqual(b.ent.ammo.usp, { mag: 1, reserve: 20 });
  b.ent.p.o = [700, 0, 1];

  ent.money = 16000; a.send({ t: 'buy', item: 'm3' });
  ent.ammo.m3 = { mag: 2, reserve: 4 };
  a.send({ t: 'reload', w: 'm3' }); advance(0.52); assert.equal(ent.ammo.m3.mag, 3);
  advance(0.5); assert.equal(ent.ammo.m3.mag, 4);
  a.send({ t: 'fire', w: 'm3' }); assert.equal(ent.ammo.m3.mag, 3); assert(!ent.ammo.m3.reload, 'shot interrupts shell loading');
  advance(1); assert.equal(ent.ammo.m3.mag, 3);

  ent.money = 16000; a.send({ t: 'buy', item: 'rocket' }); ent.p.pitch = 1.5;
  for (let i = 0; i < 5; i++) {
    if (i) { a.send({ t: 'reload', w: 'rocket' }); advance(WEAPONS.rocket.reload + 0.03); }
    a.send({ t: 'fire', w: 'rocket' }); advance(0.04);
  }
  assert.equal(shots(a, 'rocket'), 5);
  a.send({ t: 'reload', w: 'rocket' }); advance(6); a.send({ t: 'fire', w: 'rocket' }); advance(0.04);
  assert.equal(shots(a, 'rocket'), 5, 'RPG has a finite reserve');
  assert.deepEqual(ent.ammo.rocket, { mag: 0, reserve: 0 });

  // Events survive the ticks between snapshots and a temporarily congested connection.
  a.events.length = 0; a.ws.bufferedAmount = 300 * 1024;
  a.send({ t: 'weapon', w: 'knife' }); advance(0.05);
  assert.equal(a.events.length, 0);
  a.ws.bufferedAmount = 0; advance(0.05);
  assert.equal(a.events.filter((e) => e.e === 'deploy').length, 1, 'buffered events delivered once');

  ent.kills = 7; ent.money = 4321;
  const id = a.id, token = a.welcome.resume;
  assert.equal(token.length, 48);
  a.ws.close(1006); assert(game.ents.has(id), 'place remains reserved');
  const full = socket(); full.send({ t: 'join', name: 'third player' });
  assert.equal(full.ws.readyState, 3, 'reserved seat counts toward capacity');
  const resumed = socket(); resumed.send({ t: 'join', resume: token, team: 'spec' }); advance(0.04);
  assert.equal(resumed.id, id); assert(resumed.welcome.resumed);
  assert.equal(resumed.last.you.money, 4321); assert.equal(ent.kills, 7); assert.equal(ent.team, 'ct');
  a.send({ t: 'name', name: 'stale socket' }); assert.notEqual(ent.name, 'stale socket');
  const takeover = socket(); takeover.send({ t: 'join', resume: token }); assert.equal(resumed.ws.readyState, 3);
  assert.equal(takeover.id, id); assert.equal(ent.ws, takeover.ws, 'old close cannot detach the new connection');
  takeover.ws.close(1006); advance(29); assert(game.ents.has(id));
  advance(1.1); assert(!game.ents.has(id), 'reservation expires after 30 seconds');
  const newcomer = player('ct'); assert.notEqual(newcomer.id, id);
  newcomer.ws.close(1006);
  game.kick(newcomer.id); assert(!game.ents.has(newcomer.id), 'kick frees the reserved seat immediately');
  game.stop(); assert.equal(timers.size, 0, 'shutdown clears heartbeat and simulation timers');
  for (const difficulty of ['easy', 'normal', 'hard']) {
    game = createGame({ mapDir: directory, bots: false, botDifficulty: difficulty, snapshotRate: 64 });
    assert.equal(game.botDifficulty, difficulty); assert.equal(game.snapshotRate, 64); game.stop();
  }
  assert.throws(() => createGame({ mapDir: directory, botDifficulty: 'impossible' }));
  assert.throws(() => createGame({ mapDir: directory, snapshotRate: 17 }));
  console.log('gameplay ok: authoritative magazines/reloads/shells/RPG, drops, acknowledgements, 128/32 Hz, backpressure, reconnect/reservation/expiry/kick');
} finally {
  game?.stop(); performance.now = original.now; globalThis.setInterval = original.interval; globalThis.clearInterval = original.clear;
  fs.rmSync(directory, { recursive: true, force: true });
}
