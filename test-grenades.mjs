import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { makeWorld, TICK } from './public/physics.js';
import { launch, stepFlight, detonates } from './public/grenade-physics.js';
import { fireCells, fireTouches, smokeExtinguishes } from './public/fire-physics.js';
import { GRENADE, BUY, WEAPONS, canCarryGrenade } from './public/weapon-defs.js';
import { createGame } from './server/game.mjs';
import { createIncendiaryModel } from './public/incendiary-model.js';
import { createGrenades } from './public/grenades.js';
import * as THREE from 'three';

const box = (x0, y0, z0, x1, y1, z1) => [x0, y0, z0, x1, y1, z1,
  1, 0, 0, x1, -1, 0, 0, -x0, 0, 1, 0, y1, 0, -1, 0, -y0, 0, 0, 1, z1, 0, 0, -1, -z0];
const floor = box(-1000, -1000, -50, 1000, 1000, 0), wall = box(25, -200, 0, 35, 200, 200);
const open = makeWorld([floor]), walled = makeWorld([floor, wall]);
assert(canCarryGrenade({}, 'molotov'));
assert(!canCarryGrenade({ molotov: 1 }, 'molotov'));
assert(!canCarryGrenade({ molotov: 1 }, 'incgrenade'), 'one incendiary slot shared across teams');
assert(!canCarryGrenade({ hegrenade: 1, flashbang: 2, smokegrenade: 1 }, 'molotov'), 'four grenades maximum');
assert(canCarryGrenade({ flashbang: 1 }, 'flashbang'), 'two flashes allowed');
for (const [key, team, price] of [['molotov', 't', 400], ['incgrenade', 'ct', 600]]) {
  const item = BUY.flatMap((c) => c.items).find((i) => i.id === key);
  assert.equal(item.team, team); assert.equal(item.price, price);
}
assert.equal(detonates('fire', { age: 0.2, impactNormal: [0, 0, 1] }), true);
assert.equal(detonates('fire', { age: 0.2, impactNormal: [1, 0, 0] }), false, 'walls bounce');
assert.equal(detonates('fire', { age: GRENADE.fireFuse }), true, 'air fuse is bounded');
const projectile = launch(open, 1, { eye: [0, 0, 64], yaw: 0, pitch: -0.6, v: [0, 0, 0] }, 0.25);
for (let i = 0; i < 512; i++) {
  projectile.age = i * TICK; stepFlight(open, 1, projectile, TICK);
  if (detonates('fire', projectile)) break;
}
assert(projectile.impactNormal?.[2] > 0.7, 'bottle ignites on the floor');
const cells = fireCells(open, 1, [0, 0, 2]);
assert.equal(cells.length, 9);
assert.deepEqual(fireCells(open, 1, [0, 0, 400]), [], 'airbursts do not create floating fire');
const fire = { cells, age: 1 };
assert(fireTouches(open, 1, fire, [0, 0, 1]));
assert(!fireTouches(open, 1, fire, [0, 0, 90]), 'no damage through a different floor');
assert(!fireTouches(open, 1, fire, [300, 0, 1]));
assert(!fireTouches(walled, 2, { cells: fireCells(walled, 2, [0, 0, 2]), age: 1 }, [40, 0, 1]), 'wall blocks damage even inside the radius');
assert(fireCells(walled, 2, [0, 0, 2]).every((p) => p[0] < 25), 'fire spread stops at walls');
assert(smokeExtinguishes(open, 1, fire, { o: [0, 0, 2], age: 0 }));
assert(!smokeExtinguishes(walled, 2, { cells: [[0, 0, 0]], age: 1 }, { o: [40, 0, 2], age: 1 }), 'smoke cannot extinguish through walls');
assert(!smokeExtinguishes(open, 1, fire, { o: [0, 0, 2], age: GRENADE.smokeTime }));

// Build client effects from the existing asset manifest and check their GPU-material cleanup.
const originalDocument = globalThis.document, originalFetch = globalThis.fetch;
try {
  globalThis.document = { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) }) };
  globalThis.fetch = async (name) => new Response(fs.readFileSync(path.join(import.meta.dirname, 'public', name)));
  const loadTex = (name, apply) => { const texture = new THREE.Texture(); texture.name = name; apply(texture); };
  const root = new THREE.Group(), effects = await createGrenades({ worldRoot: root, loadTex });
  for (const key of ['molotov', 'incgrenade']) {
    const model = createIncendiaryModel(key);
    assert(model.children.length > 0 && model.children.every((mesh) =>
      mesh.geometry.index.count > 0 && mesh.material.map.name.startsWith(`equipment-models/${key}-`)), 'textured CS2 mesh loaded');
  }
  effects.sync([{ id: 1, w: 'molotov', o: [0, 0, 10] }, { id: 2, w: 'incgrenade', o: [50, 0, 10] }], [], [{ id: 3, cells, age: 1 }]);
  effects.update(1 / 60); assert(root.children.some((c) => c.isSprite), 'fire sprites are constructed');
  const sprites = root.children.filter((c) => c.isSprite); let disposed = 0;
  for (const sp of sprites) sp.material.addEventListener('dispose', () => disposed++);
  effects.sync([], [], []); assert.equal(root.children.length, 0); assert.equal(disposed, sprites.length, 'spent flame materials are disposed');
  effects.pop({ w: 'molotov', o: [0, 0, 0] }); effects.update(1);
  assert.equal(root.children.length, 0, 'ignition flare cleans itself up');
} finally { globalThis.document = originalDocument; globalThis.fetch = originalFetch; }

// Drive the real game loop and message handlers with a deterministic clock, without TCP or real-time waits.
const mapDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pascs-grenades-'));
fs.writeFileSync(path.join(mapDir, 'world.json'), JSON.stringify({ collision: [floor], spawns: { ct: [{ o: [-700, 0, 1], yaw: 0 }], t: [{ o: [700, 0, 1], yaw: 180 }] } }));
fs.writeFileSync(path.join(mapDir, 'nav.json'), JSON.stringify({ nodes: [], edges: [] }));
const originalInterval = globalThis.setInterval, originalClear = globalThis.clearInterval, originalNow = performance.now;
const timers = new Set(); let clock = 0, game;
globalThis.setInterval = (fn, delay) => { const timer = { fn, delay, next: clock + delay }; timers.add(timer); return timer; };
globalThis.clearInterval = (timer) => timers.delete(timer);
performance.now = () => clock;
const advance = (seconds) => {
  const until = clock + seconds * 1000;
  for (; clock < until; clock++) for (const timer of timers) if (clock >= timer.next) { timer.next += timer.delay; timer.fn(); }
};
const sockets = [];
try {
  game = createGame({ mapDir, bots: false, botsFight: false, teamSize: 2 });
  function client(team) {
    const ws = new EventEmitter(), c = { events: [], last: null, id: 0 };
    ws.readyState = 1; ws.ping = () => ws.emit('pong');
    ws.send = (raw) => { const d = JSON.parse(raw); if (d.t === 'welcome') c.id = d.id; else { c.last = d; c.events.push(...d.ev); } };
    c.send = (m) => ws.emit('message', JSON.stringify(m));
    game.connect(ws); c.send({ t: 'join', name: team, team }); sockets.push(ws); return c;
  }
  const t = client('t'), ct = client('ct'), mate = client('t'); client('ct');
  const thrower = game.ents.get(t.id), enemy = game.ents.get(ct.id), friendly = game.ents.get(mate.id);
  thrower.money = enemy.money = 16000;
  t.send({ t: 'buy', item: 'molotov' }); ct.send({ t: 'buy', item: 'molotov' });
  assert.equal(thrower.gr.molotov, 1); assert.equal(enemy.gr.molotov, undefined, 'server enforces teams');
  const money = thrower.money; t.send({ t: 'buy', item: 'molotov' }); assert.equal(thrower.money, money, 'duplicate rejected without spending');
  t.send({ t: 'throw', w: 'molotov', power: 0.25 }); assert.equal(thrower.gr.molotov, 1, 'cannot throw during freeze');
  advance(5.1);
  function throwFire() {
    thrower.p.o = [0, 0, 1]; thrower.p.v = [0, 0, 0]; thrower.p.yaw = 0; thrower.p.pitch = -1.3;
    thrower.alive = true; thrower.health = 100; thrower.gr.molotov = 1; thrower.owned.add('molotov');
    t.send({ t: 'throw', w: 'molotov', power: 0.25 }); advance(0.8);
    assert(t.last.fires.length > 0, 'fire replicated in real server snapshots');
    return t.last.fires[0];
  }
  let f = throwFire();
  enemy.p.o = friendly.p.o = [f.o[0], f.o[1], f.o[2] + 1]; enemy.health = 100; enemy.armor = 100;
  thrower.p.o = [f.o[0], f.o[1], f.o[2] + 1];
  const ownHealth = thrower.health; advance(0.6);
  assert(enemy.health < 100 && enemy.armor === 100, 'fire bypasses armor');
  assert.equal(friendly.health, 100, 'no friendly fire');
  assert(thrower.health < ownHealth, 'self damage');
  thrower.p.o = [-500, 0, 1]; enemy.health = 1; const kills = thrower.kills;
  // Credit survives an owner disconnect: the fire keeps the original attacker, not a partial fallback.
  sockets[0].readyState = 3; sockets[0].emit('close'); advance(0.3);
  assert.equal(enemy.alive, false); assert.equal(thrower.kills, kills + 1);
  assert(ct.events.some((e) => e.e === 'death' && e.w === 'molotov' && e.killer === thrower.id), 'kill feed attributes fire kills');
  advance(GRENADE.fireTime); assert.equal(ct.last.fires.length, 0, 'fire expires');
  // Reconnect a thrower and test smoke using real throw messages.
  const t2 = client('t'), actor = game.ents.get(t2.id);
  actor.p.o = [0, 0, 1]; actor.p.pitch = -1.3; actor.gr = { molotov: 1, smokegrenade: 1 }; actor.owned.add('molotov'); actor.owned.add('smokegrenade');
  t2.send({ t: 'throw', w: 'molotov', power: 0.25 }); advance(0.8);
  assert(t2.last.fires.length > 0);
  t2.send({ t: 'throw', w: 'smokegrenade', power: 0.25 }); advance(3.1);
  assert(t2.last.smokes.length > 0 && t2.last.fires.length === 0, 'smoke extinguishes server fire');
  assert(t2.events.some((e) => e.e === 'extinguish'));
  actor.gr.molotov = 1; t2.send({ t: 'throw', w: 'molotov', power: 0.25 }); advance(0.8);
  assert.equal(t2.last.fires.length, 0, 'existing smoke prevents re-ignition');
  Object.assign(game.round, { phase: 'over', left: 0 }); advance(0.1);
  assert.equal(t2.last.fires.length, 0); assert.equal(t2.last.smokes.length, 0, 'round reset clears utility');
  console.log('grenades ok: inventory, flight, walls, floors, damage, armor, teams, kills after disconnect, smoke, expiry, round reset');
} finally {
  game?.stop(); for (const ws of sockets) ws.emit('close');
  globalThis.setInterval = originalInterval; globalThis.clearInterval = originalClear; performance.now = originalNow;
  for (const name of ['world.json', 'nav.json']) fs.unlinkSync(path.join(mapDir, name)); fs.rmdirSync(mapDir);
}
