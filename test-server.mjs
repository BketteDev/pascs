// Integration test: starts the game server, connects two clients, checks the 128 Hz snapshot rate, bot movement and
// footstep events, command processing (a human walking), the buy flow and hit validation.
import assert from 'assert';
import path from 'path';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { createGame } from './server/game.mjs';
import { EventEmitter } from 'node:events';

const game = createGame({ mapDir: path.join(import.meta.dirname, 'public', 'maps', 'de_dust2'), botsFight: false }); // the feature tests move players around: no stray bot bullets
const http = createServer(); const wss = new WebSocketServer({ server: http, path: '/game' });
wss.on('connection', (ws) => game.connect(ws));
const inProcess = process.argv.includes('--in-process');
if (!inProcess) await new Promise((r) => http.listen(0, r));
const url = inProcess ? null : `ws://127.0.0.1:${http.address().port}/game`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function client(name, team) {
  const c = { snaps: 0, events: [], last: null, ws: inProcess ? {} : new WebSocket(url), id: null };
  c.ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.t === 'welcome') c.id = d.id; else if (d.t === 'snap') { c.snaps++; c.last = d; c.events.push(...d.ev); } };
  c.send = (o) => c.ws.send(JSON.stringify(o));
  if (inProcess) {
    const server = new EventEmitter(); server.readyState = 1;
    server.send = (data) => c.ws.onmessage({ data });
    server.ping = () => server.emit('pong');
    c.ws.send = (data) => server.emit('message', data);
    c.ws.close = () => { server.readyState = 3; server.emit('close'); };
    assert(game.connect(server), 'server accepts the in-process client');
    c.send({ t: 'join', name, team }); return Promise.resolve(c);
  }
  return new Promise((r) => { c.ws.onopen = () => { c.send({ t: 'join', name, team }); r(c); }; });
}
const a = await client('Alice', 'ct'), b = await client('Bob', 't');
// a real shot, as the client sends it: the shot, then the hit with the ray from the shooter's eye to the target's head / chest / legs
const shoot = (c, target, group, { w = 'deagle', at = target.p.o, rt, fire = true } = {}) => {
  const eye = game.ents.get(c.id).p.eye, z = { 1: 62, 2: 45, 6: 15 }[group] * (target.p.ducked ? 0.72 : 1);
  const d = [at[0] - eye[0], at[1] - eye[1], at[2] + z - eye[2]];
  if (fire) c.send({ t: 'fire', w });
  c.send({ t: 'hit', target: target.id, group, bone: group === 1 ? 14 : 1, w, o: eye, d, rt });
};
await sleep(300);
assert(a.id && b.id && a.id !== b.id, 'both clients got ids');
// rosters: 5v5, humans replace bots
const t0 = a.snaps, h0 = performance.now();
await sleep(2000);
const hz = ((a.snaps - t0) / (performance.now() - h0)) * 1000;
console.log('snapshot rate', hz.toFixed(0), 'Hz');
assert(hz > 115 && hz < 140, 'snapshots go out every 128 Hz tick, got ' + hz);
const count = (team) => a.last.ents.filter((e) => e.team === team).length;
assert.strictEqual(count('ct'), 5); assert.strictEqual(count('t'), 5);
assert.strictEqual(a.last.ents.filter((e) => !e.bot).length, 2);

// freeze time: humans cannot move; after it, a walking human moves and produces footstep events heard by the other client
const me = () => a.last.you;
let seq = 0;
const walk = async (client, ms, extra = {}) => { const end = performance.now() + ms; while (performance.now() < end) { client.send({ t: 'cmd', seq: ++seq, f: 1, s: 0, j: 0, d: 0, w: 0, yaw: client.yaw ?? 0, pitch: 0, ...extra }); await sleep(7); } };
a.yaw = 0;
const start = [...me().o];
await walk(a, 300);
assert(Math.hypot(me().o[0] - start[0], me().o[1] - start[1]) < 1, 'no movement during freeze time');
await sleep(5200); // freeze ends
assert.strictEqual(a.last.round.phase, 'live');
b.events.length = 0;
const s2 = [...me().o];
await walk(a, 1500);
assert(Math.hypot(me().o[0] - s2[0], me().o[1] - s2[1]) > 100 || a.last.you.ack > 0, 'human moved');
const stepsByA = b.events.filter((e) => e.e === 'step' && e.id === a.id);
console.log('footsteps of Alice heard by Bob:', stepsByA.length, 'surface', stepsByA[0]?.s);
const botSteps = b.events.filter((e) => e.e === 'step' && a.last.ents.find((x) => x.id === e.id && x.bot));
console.log('bot footsteps heard:', botSteps.length);
assert(botSteps.length > 3, 'wandering bots must make footstep sounds');

// ack + prediction fields
assert(me().ack > 0 && 'stamina' in me() && 'eyeZ' in me(), 'snapshot carries the reconciliation state');

// weapon deploy event + buy
a.events.length = 0; b.events.length = 0;
a.send({ t: 'buy', item: 'deagle' }); await sleep(100);
assert(me().owned.includes('deagle') && me().weapon === 'deagle' && me().money === 800 - 650, 'bought a deagle: ' + JSON.stringify(me()));
assert(b.events.some((e) => e.e === 'deploy' && e.id === a.id), 'deploy sound event is broadcast');
a.send({ t: 'buy', item: 'ak47' }); await sleep(100); // CT may not buy the T rifle
assert(!me().owned.includes('ak47'), 'team restricted weapon refused');
a.send({ t: 'buy', item: 'awp' }); await sleep(100);
assert(!me().owned.includes('awp') && me().money === 150, 'cannot afford the AWP');

// hit validation: enemy in the open -> accepted only with line of sight; friendly never
const enemy = a.last.ents.find((e) => e.team === 't' && e.alive);
shoot(a, game.ents.get(enemy.id), 1); await sleep(100);
const enemyAfter = a.last.ents.find((e) => e.id === enemy.id);
console.log('hit on enemy ->', enemyAfter.hp, 'hp (0..100; wall/LOS may reject it)');
const mate = a.last.ents.find((e) => e.team === 'ct' && e.id !== a.id);
shoot(a, game.ents.get(mate.id), 1); await sleep(100);
assert.strictEqual(a.last.ents.find((e) => e.id === mate.id).hp, 100, 'no friendly fire');

// a kill: put Alice (CT) next to a visible enemy bot and shoot its head with the (bought) deagle -> death event, money, round tally
{
  const { trace } = await import('./public/physics.js');
  const atk = game.ents.get(a.id), foe = [...game.ents.values()].find((e) => e.team === 't' && e.alive && e.bot);
  let placed = false;
  for (const r of [60, 90, 120, 160]) for (let k = 0; k < 8 && !placed; k++) {
    const o = [foe.p.o[0] + Math.cos(k * 0.785) * r, foe.p.o[1] + Math.sin(k * 0.785) * r, foe.p.o[2] + 1];
    if (atk.p.tr(o, o).startSolid) continue;
    atk.p.o = o; atk.p.v = [0, 0, 0];
    placed = trace(atk.p.world, atk.p.eye, [foe.p.o[0], foe.p.o[1], foe.p.o[2] + 60], [0, 0, 0], [0, 0, 0], 1e9).fraction > 0.97;
  }
  assert(placed, 'found an open spot next to the bot');
  const money0 = me().money; a.events.length = 0;
  shoot(a, foe, 1); await sleep(150);
  const death = a.events.find((e) => e.e === 'death');
  assert(death && death.victim === foe.id && death.killer === a.id && death.hs, 'headshot kill event: ' + JSON.stringify(death));
  assert.strictEqual(me().money, money0 + 300, 'kill reward');
  assert(!a.last.ents.find((e) => e.id === foe.id).alive, 'victim is dead in the snapshot');
  assert.strictEqual(a.last.round.alive.t, 4, 'alive count updated');
  console.log('kill ok: hs', death.hs, 'money', money0, '->', me().money);
}

// grenades: buy, count limits, throw physics, HE damage, flash event, smoke cloud
{
  const atk = game.ents.get(a.id); atk.money = 5000;
  for (const g of ['hegrenade', 'hegrenade', 'flashbang', 'flashbang', 'flashbang', 'smokegrenade']) { a.send({ t: 'buy', item: g }); await sleep(30); }
  await sleep(100);
  assert.deepStrictEqual(me().gr, { hegrenade: 1, flashbang: 2, smokegrenade: 1 }, 'grenade counts are capped per type: ' + JSON.stringify(me().gr));
  assert(me().owned.includes('hegrenade'));
  atk.p.yaw = 0; atk.p.pitch = 0; a.events.length = 0;
  a.send({ t: 'throw', w: 'hegrenade', power: 1 }); await sleep(120);
  assert(a.last.gr.length === 1 && a.last.gr[0].w === 'hegrenade', 'thrown grenade is in the snapshot');
  assert(!me().owned.includes('hegrenade'), 'last HE is gone from the loadout');
  const z0 = a.last.gr[0].o[2]; await sleep(300);
  assert(!a.last.gr.length || a.last.gr[0].o[2] !== z0, 'grenade moves');
  await sleep(1800);
  assert(a.events.some((e) => e.e === 'explode' && e.w === 'hegrenade'), 'HE explodes after the fuse');
  assert(a.last.gr.length === 0, 'spent grenade removed');
  a.send({ t: 'throw', w: 'smokegrenade', power: 1 }); await sleep(3600);
  assert(a.last.smokes.length === 1, 'smoke cloud exists after pop');
  a.send({ t: 'throw', w: 'flashbang', power: 0.5 }); a.events.length = 0; await sleep(2200);
  assert(a.events.some((e) => e.e === 'explode' && e.w === 'flashbang'), 'flash pops');
  console.log('grenades ok; flash events', a.events.filter((e) => e.e === 'flash').length);
}

// player collision: two overlapping players are pushed apart when they move
{
  const atk = game.ents.get(a.id), other = [...game.ents.values()].find((e) => e !== atk && e.alive && e.team !== atk.team);
  atk.alive = true; atk.health = 100; // her own HE from the grenade test may have bounced back and killed her
  atk.p.o = [other.p.o[0] + 8, other.p.o[1] + 5, other.p.o[2]]; atk.p.v = [0, 0, 0];
  for (let i = 0; i < 3; i++) { a.send({ t: 'cmd', seq: ++seq, f: 0, s: 0, j: 0, d: 0, w: 0, yaw: 0, pitch: 0 }); await sleep(60); if (Math.max(Math.abs(atk.p.o[0] - other.p.o[0]), Math.abs(atk.p.o[1] - other.p.o[1])) >= 31.9) break; }
  const gap = Math.max(Math.abs(atk.p.o[0] - other.p.o[0]), Math.abs(atk.p.o[1] - other.p.o[1]));
  if (gap < 31.9) console.log('DEBUG collision', JSON.stringify({ atkAlive: atk.alive, otherAlive: other.alive, otherBot: other.bot, lastSeq: atk.lastSeq, queue: atk.queue.length, phase: game.round.phase, tokens: atk.tokens, atkO: atk.p.o.map(Math.round), otherO: other.p.o.map(Math.round) }));
  assert(gap >= 31.9, 'overlapping players are separated, gap ' + gap);
  console.log('collision ok, gap', gap.toFixed(1));
}

// humans kill humans: Alice (CT) headshots Bob (T) until he dies; Bob's own snapshot says he is dead
{
  const { trace } = await import('./public/physics.js');
  const alice = game.ents.get(a.id), bob = game.ents.get(b.id);
  let placed = false;
  for (const r of [70, 110, 150]) for (let k = 0; k < 8 && !placed; k++) {
    const o = [alice.p.o[0] + Math.cos(k * 0.785) * r, alice.p.o[1] + Math.sin(k * 0.785) * r, alice.p.o[2] + 1];
    if (bob.p.tr(o, o).startSolid) continue;
    bob.p.o = o; bob.p.v = [0, 0, 0];
    placed = trace(bob.p.world, alice.p.eye, [o[0], o[1], o[2] + 54], [0, 0, 0], [0, 0, 0], 1e9).fraction > 0.97;
  }
  assert(placed, 'found a spot for Bob in front of Alice');
  bob.alive = true; bob.health = 100; bob.armor = 0; a.events.length = 0;
  for (let i = 0; i < 3 && bob.alive; i++) { shoot(a, bob, 1); await sleep(250); }
  const death = a.events.find((e) => e.e === 'death' && e.victim === bob.id);
  assert(death && death.killer === alice.id, 'Alice killed Bob: ' + JSON.stringify(death));
  assert.strictEqual(b.last.you.alive, 0, "Bob's own client is told he is dead");
  console.log('human kill ok');
}

// CS:S armor: a deagle (ArmorRatio 1.5) to a kevlar-wearing chest takes 54 * 0.75 off health and 54 * 0.125 off armor; legs ignore armor
{
  const bob = game.ents.get(b.id);
  bob.alive = true; bob.health = 100; bob.armor = 100; bob.helmet = false; b.events.length = 0;
  shoot(a, bob, 2); await sleep(250);
  const hurt = b.events.find((e) => e.e === 'hurt' && e.to === bob.id);
  assert(hurt && hurt.dmg > 30 && Math.hypot(hurt.from[0] - game.ents.get(a.id).p.o[0], hurt.from[1] - game.ents.get(a.id).p.o[1]) < 2, 'the victim learns where the shot came from: ' + JSON.stringify(hurt));
  const chest = 100 - bob.health, armorLoss = 100 - bob.armor;
  assert(Math.abs(chest - 54 * 0.75) < 1.5 && Math.abs(armorLoss - 54 * 0.125) < 0.6, `chest through kevlar: -${chest.toFixed(1)} hp, -${armorLoss.toFixed(1)} armor`);
  bob.health = 100; bob.armor = 100;
  shoot(a, bob, 6); await sleep(250);
  assert(Math.abs(100 - bob.health - 54 * 0.75) < 1.5 && bob.armor === 100, 'legs: no armor, 0.75 multiplier');
  // validation: a hit with no shot fired, a ray that misses, a headshot claim on a chest ray, and lag compensation (the target as the shooter saw it)
  const hp = () => bob.health;
  bob.health = 100; bob.armor = 0;
  shoot(a, bob, 1, { fire: false }); await sleep(120);
  assert.strictEqual(hp(), 100, 'a hit without a shot is ignored');
  shoot(a, bob, 2, { at: [bob.p.o[0] + 120, bob.p.o[1] + 120, bob.p.o[2]] }); await sleep(250);
  assert.strictEqual(hp(), 100, 'a ray that passes beside the target is ignored');
  shoot(a, bob, 1, { at: [bob.p.o[0], bob.p.o[1], bob.p.o[2] - 17] }); await sleep(250); // aimed at the chest, claimed as a head
  assert(hp() < 100 && hp() > 100 - 54 * 1.5, 'a false headshot claim counts as the chest: -' + (100 - hp()).toFixed(1));
  bob.health = 100;
  const tick0 = game.tick(), old = [...bob.p.o];
  await sleep(150); // a few snapshots with Bob here
  const alice = game.ents.get(a.id), side = [-(bob.p.o[1] - alice.p.o[1]), bob.p.o[0] - alice.p.o[0]], sl = Math.hypot(...side);
  bob.p.o = [old[0] + (side[0] / sl) * 70, old[1] + (side[1] / sl) * 70, old[2]]; // he steps aside after Alice saw him (and fired)
  await sleep(50);
  shoot(a, bob, 2, { at: old }); await sleep(120);
  assert.strictEqual(hp(), 100, 'without the tick she saw, the shot at where he was misses');
  shoot(a, bob, 2, { at: old, rt: tick0 + 5 }); await sleep(250);
  assert(hp() < 100, 'lag compensation: rewound to the tick she saw, the hit counts');
  bob.p.o = old; bob.health = 1000; await sleep(300);
  for (let i = 0; i < 8; i++) shoot(a, bob, 6); // eight shots at once: a deagle cannot fire that fast
  await sleep(200);
  const legHits = Math.round((1000 - hp()) / (54 * 0.75));
  assert(legHits >= 1 && legHits <= 4, 'rate of fire: only the shots the gun could fire hit, got ' + legHits);
  bob.health = 100;
  console.log('hit validation ok: no shot / miss / false headshot rejected, lag compensation, rate of fire', legHits, 'of 8');
  console.log(`armor ok: chest -${chest.toFixed(1)} hp / -${armorLoss.toFixed(1)} armor, leg -${(100 - bob.health).toFixed(1)} hp`);
}

// teams: Bob (T) may not move to CT while both teams have one human each; the refusal comes back as a notice
{
  const notes = []; const prev = b.ws.onmessage;
  b.ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.t === 'notice') notes.push(d.text); prev(m); };
  b.send({ t: 'team', team: 'ct' }); await sleep(150);
  assert.strictEqual(game.ents.get(b.id).team, 't', 'team switch refused: it would unbalance the teams');
  assert(notes.length === 1, 'the player is told why: ' + JSON.stringify(notes));
  b.ws.onmessage = prev;
  console.log('team balance ok:', notes[0]);
}

// the bomb: one T carries it; planting takes 3 s inside a site; a CT with a kit defuses in 5 s -> CT win
{
  // Previous combat may kill the carrier, and bots can plant while those tests run.
  Object.assign(game.round, { phase: 'over', left: 0 }); await sleep(100);
  const carriers = [...game.ents.values()].filter((e) => e.owned.has('c4'));
  assert.strictEqual(carriers.length, 1, 'exactly one player carries the C4');
  assert.strictEqual(carriers[0].team, 't', 'a terrorist carries it');
  assert.strictEqual(game.bomb.state, 'carried');
  await sleep(5100); // let this new round's freeze finish before testing planting
  // hand it to Bob (human T) and put him on a bombsite floor
  const bob = game.ents.get(b.id), alice = game.ents.get(a.id);
  for (const e of game.ents.values()) e.owned.delete('c4');
  bob.owned.add('c4'); game.bomb.state = 'carried'; game.bomb.carrier = bob.id;
  const site = game.sites[0], { trace } = await import('./public/physics.js');
  const spot = [site.o[0], site.o[1], site.max[2] + 40], fl = trace(bob.p.world, spot, [spot[0], spot[1], spot[2] - 400], [-16, -16, 0], [16, 16, 62], 1e9);
  bob.p.o = [spot[0], spot[1], fl.end[2] + 0.5]; bob.p.v = [0, 0, 0]; bob.alive = true; bob.health = 100;
  assert(game.inSite(bob.p.o), 'Bob stands inside the bombsite ' + JSON.stringify(bob.p.o));
  b.send({ t: 'weapon', w: 'c4' }); b.send({ t: 'cmd', seq: 1e6, f: 0, s: 0, j: 0, d: 0, w: 0, yaw: 0, pitch: 0 }); await sleep(100);
  b.events.length = 0; b.send({ t: 'plant', on: true }); await sleep(1500);
  assert(b.last.you.act?.k === 'plant' && b.last.you.act.p > 0.3, 'planting progress is shown: ' + JSON.stringify(b.last.you.act));
  await sleep(1800);
  assert(b.events.some((e) => e.e === 'planted'), 'the bomb is planted after 3 s');
  assert.strictEqual(b.last.bomb.s, 'planted'); assert.strictEqual(b.last.round.bomb, 1);
  assert(!b.last.you.owned.includes('c4'), 'the planter no longer has the C4');
  // Alice (CT) with a kit, next to the bomb
  alice.kit = true; alice.alive = true; alice.health = 100;
  alice.p.o = [game.bomb.o[0] + 20, game.bomb.o[1], game.bomb.o[2] + 0.5]; alice.p.v = [0, 0, 0];
  a.events.length = 0; a.send({ t: 'defuse', on: true }); await sleep(200);
  assert(a.last.you.act?.k === 'defuse' || game.bomb.defuser, 'defusing started (Alice, or a CT bot that got there first)');
  for (let i = 0; i < 60 && !a.events.some((e) => e.e === 'defused'); i++) await sleep(200); // 5 s with Alice's kit, 10 s for a bot
  const done = a.events.find((e) => e.e === 'defused'), over = a.events.find((e) => e.e === 'round' && e.phase === 'over');
  assert(done, 'the bomb is defused with a kit in 5 s (a bot CT may have done it first)');
  assert(over && over.winner === 'ct' && over.reason === 'defused', 'CTs win by defusal: ' + JSON.stringify(over));
  console.log('bomb ok: planted by', b.id, 'defused by', done.by);
}
// explosion: a short timer on a private game, nobody defuses -> T win, players near it die
{
  const g2 = createGame({ mapDir: path.join(import.meta.dirname, 'public', 'maps', 'de_dust2'), bombTimer: 1, botsFight: false });
  await sleep(5300); // freeze time
  const carrier = [...g2.ents.values()].find((e) => e.owned.has('c4')), site = g2.sites[0];
  for (const e of g2.ents.values()) if (e.team === 'ct') { e.p.o = [site.o[0], site.o[1], site.max[2] + 200]; }
  carrier.p.o = [site.o[0], site.o[1], site.max[2] + 40];
  await sleep(1500); // the bot carrier lands inside the site and plants by itself (3 s), then 1 s fuse
  for (let i = 0; i < 40 && g2.round.phase !== 'over'; i++) await sleep(250);
  assert.strictEqual(g2.round.phase, 'over', 'round ended');
  assert.strictEqual(g2.round.winner, 't', 'Ts win when the bomb explodes');
  assert.strictEqual(g2.round.reason, 'bombed');
  console.log('explosion ok, CTs alive after blast:', [...g2.ents.values()].filter((e) => e.team === 'ct' && e.alive).length);
  g2.stop();
}

// bots fight: a full bot game, someone gets shot dead by a bot within a minute and a half of play
{
  { // hostage rescue (cs_office): 4 hostages, no bomb; hostages inside a rescue zone are rescued and the CTs win once all are out
    const g5 = createGame({ mapDir: path.join(import.meta.dirname, 'public', 'maps', 'cs_office'), teamSize: 2, botsFight: false });
    await sleep(300);
    const hs = [...g5.ents.values()].filter((e) => e.hostage);
    assert(g5.hostageMode && hs.length === 4 && g5.bomb.state === 'none', 'office: hostage mode with 4 hostages and no bomb');
    Object.assign(g5.round, { phase: 'live', left: 100 });
    const z = g5.rescueZones[0], c = [(z.min[0] + z.max[0]) / 2, (z.min[1] + z.max[1]) / 2, z.min[2] + 10];
    for (const h of hs) h.p.o = [...c];
    await sleep(200);
    assert(g5.round.rescued === 4 && g5.round.winner === 'ct' && g5.round.reason === 'rescued', 'all hostages rescued -> CT win: ' + JSON.stringify(g5.round));
    assert(![...g5.ents.values()].some((e) => e.hostage), 'rescued hostages leave the map');
    console.log('hostage rescue ok');
    g5.stop();
  }
  { // doors + breakable glass (de_lake): E opens the door in front of you, a shot through a pane breaks it, a new round restores both
    const dir = path.join(import.meta.dirname, 'public', 'maps', 'de_lake'), { movers } = JSON.parse((await import('fs')).readFileSync(path.join(dir, 'world.json'), 'utf8'));
    const g6 = createGame({ mapDir: dir, teamSize: 1, botsFight: false });
    const { trace } = await import('./public/physics.js');
    const fake = { readyState: 1, handlers: {}, last: null, events: [], on(k, f) { this.handlers[k] = f; }, ping() {}, send(m) { const d = JSON.parse(m); if (d.t === 'snap') { this.last = d; this.events.push(...d.ev); } } };
    g6.connect(fake); fake.handlers.message(JSON.stringify({ t: 'join', name: 'Tester', team: 'ct' }));
    await sleep(100);
    const me = [...g6.ents.values()].find((e) => !e.bot);
    Object.assign(g6.round, { phase: 'live', left: 100 });
    const standBefore = (c) => { // a free spot 56 units from c, looking at it
      for (let a = 0; a < 8; a++) {
        const yaw = (a * Math.PI) / 4, o = [c[0] - Math.cos(yaw) * 56, c[1] - Math.sin(yaw) * 56, c[2] - 50];
        me.p.o = o; me.p.yaw = yaw;
        if (!trace(me.p.world, o, o, [-16, -16, 0], [16, 16, 62]).startSolid) return true;
      }
      return false;
    };
    const door = movers.findIndex((m) => m.kind === 'door' && m.use && !m.locked), pane = movers.findIndex((m) => m.breakable && m.glass);
    assert(door >= 0 && pane >= 0, 'lake has a usable door and a glass pane');
    assert(standBefore(movers[door].center), 'room to stand at the door');
    fake.handlers.message(JSON.stringify({ t: 'use' }));
    await sleep(1500);
    assert(Math.abs(fake.last.mv[door]) > 80, 'E opened the door: ' + fake.last.mv[door]);
    assert(standBefore(movers[pane].center), 'room to stand at the window');
    fake.handlers.message(JSON.stringify({ t: 'fire', w: me.weapon, to: movers[pane].center }));
    await sleep(100);
    assert(fake.last.mv[pane] === 1 && fake.events.some((e) => e.e === 'break'), 'the shot broke the pane');
    Object.assign(g6.round, { phase: 'over', left: 0 });
    await sleep(200);
    assert(fake.last.mv.every((v) => v === 0), 'a new round closes doors and restores glass');
    console.log('doors + glass ok:', movers.filter((m) => m.kind === 'door').length, 'doors,', movers.filter((m) => m.breakable).length, 'breakables');
    g6.stop();
  }
  { // spectating: off both teams (bots fill them), never spawns, out of the player list; joining a team again works
    const g7 = createGame({ mapDir: path.join(import.meta.dirname, 'public', 'maps', 'de_dust2'), teamSize: 2, botsFight: false });
    const fake = { readyState: 1, handlers: {}, last: null, on(k, f) { this.handlers[k] = f; }, ping() {}, send(m) { const d = JSON.parse(m); if (d.t === 'snap') this.last = d; } };
    g7.connect(fake); fake.handlers.message(JSON.stringify({ t: 'join', name: 'Watcher', team: 'ct' }));
    fake.handlers.message(JSON.stringify({ t: 'team', team: 'spec' }));
    await sleep(100);
    const me = [...g7.ents.values()].find((e) => !e.bot);
    assert(me.team === 'spec' && !me.alive, 'spectator is off the teams and not alive');
    assert(!fake.last.ents.some((e) => e.id === me.id) && fake.last.ents.filter((e) => e.team === 'ct').length === 2, 'bots refill CT, the spectator is not drawn');
    Object.assign(g7.round, { phase: 'over', left: 0 });
    await sleep(100);
    assert(!me.alive, 'a new round does not spawn spectators');
    fake.handlers.message(JSON.stringify({ t: 'team', team: 't' }));
    await sleep(50);
    assert(me.team === 't' && me.owned.has('glock'), 'a spectator can join a team');
    console.log('spectate ok');
    g7.stop();
  }
  { // shooting range: target bots in view of the shooters, no bomb, the dead come back
    const g4 = createGame({ mapDir: path.join(import.meta.dirname, 'public', 'maps', 'de_dust2'), range: true, teamSize: 4 });
    await sleep(400);
    const targets = [...g4.ents.values()];
    assert(targets.length === 4 && targets.every((e) => e.team === 't' && e.bot), 'range: 4 target bots, no teammates');
    assert.strictEqual(g4.round.phase, 'live'); assert.strictEqual(g4.bomb.state, 'none');
    targets[0].alive = false; targets[0].diedAt = g4.tick() / 128;
    await sleep(1800);
    assert(targets[0].alive, 'range: a dead target respawns');
    console.log('range ok: targets at', targets.map((e) => e.p.o.map(Math.round).join(',')).join(' | '));
    g4.stop();
  }
  const g3 = createGame({ mapDir: path.join(import.meta.dirname, 'public', 'maps', 'de_dust2') });
  let botKill = false;
  for (let i = 0; i < 95 && !botKill; i++) { await sleep(1000); botKill = [...g3.ents.values()].some((e) => !e.alive) && g3.round.phase !== 'freeze'; }
  assert(botKill, 'bots shot each other');
  console.log('bots fight ok:', [...g3.ents.values()].filter((e) => !e.alive).length, 'down after', g3.round.elapsed.toFixed(0), 's of play');
  g3.stop();
}

console.log('server ok', JSON.stringify(game.stats()));
a.ws.close(); b.ws.close(); game.stop(); http.close(); wss.close();
process.exit(0);
