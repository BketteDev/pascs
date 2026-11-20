// Exercise the real client weapon controller without a GPU or large model assets.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createWeapons } from './public/weapons.js';
import { Player, makeWorld } from './public/physics.js';
const old = { document: globalThis.document, add: globalThis.addEventListener, fetch: globalThis.fetch, window: globalThis.window, now: performance.now, texture: THREE.TextureLoader.prototype.load };
let clock = 2000, canFire = true;
const messages = [], ammoReadings = [];
const net = { connected: true, actionSeq: 0, ammoShots: [], send(m) { if (!this.connected) return false; const seq = ++this.actionSeq; if (m.t === 'fire') this.ammoShots.push({ seq, w: m.w }); messages.push({ ...m, aq: seq }); return true; } };
const activities = ['ACT_VM_IDLE', 'ACT_VM_DRAW', 'ACT_VM_RELOAD', 'ACT_VM_PRIMARYATTACK', 'ACT_VM_DRYFIRE', 'ACT_SHOTGUN_RELOAD_START', 'ACT_SHOTGUN_RELOAD_FINISH'];
const model = { bones: 0, meshes: [], sequences: activities.map((activity) => ({ activity, name: activity, frames: 1, fps: 1, skin: 0, attach: -1, loop: activity === 'ACT_VM_IDLE' })) };
try {
  globalThis.document = { createElement: () => ({ width: 32, height: 32, getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }) }), addEventListener() {} };
  class AudioContext {
    constructor() { this.state = 'running'; this.destination = {}; }
    createGain() { return { gain: { value: 1 }, connect: (node) => node }; }
    createDynamicsCompressor() { return { ...Object.fromEntries(['threshold', 'knee', 'ratio', 'attack', 'release'].map((key) => [key, { value: 0 }])), connect: (node) => node }; }
    createBufferSource() { return { connect: (node) => node, start() {} }; }
  }
  globalThis.window = { AudioContext };
  globalThis.addEventListener = () => {};
  globalThis.fetch = async (url) => {
    if (url === 'cosmetics/catalog.json') return { ok: true, json: async () => ({}) };
    if (url === 'weapons/weapons.json') return { ok: true, json: async () => Object.fromEntries(['usp', 'knife', 'm3', 'rocket'].map((k) => [k, model])) };
    if (url.endsWith('.bin')) return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
    throw new Error('No optional asset in this test');
  };
  THREE.TextureLoader.prototype.load = () => new THREE.Texture();
  performance.now = () => clock;
  const player = new Player(makeWorld([]));
  const hud = new Proxy({}, { get: (_, key) => key === 'setAmmo' ? (...values) => ammoReadings.push(values) : () => {} });
  const weapons = await createWeapons({ player, world: player.world, worldRoot: new THREE.Group(), renderer: {}, loadTex() {}, hud, net, targets: () => null, uiOpen: () => false, alive: () => true, canFire: () => canFire && net.connected, initial: { owned: ['usp', 'knife', 'm3', 'rocket'], weapon: 'usp' } });
  const update = (ms) => { clock += ms; weapons.update(ms / 1000); };
  update(1200);
  weapons.primaryDown(); weapons.primaryUp();
  assert.equal(weapons.ammo.usp.mag, 11, 'client predicts the shot immediately');
  weapons.syncAmmo({ usp: { mag: 12, reserve: 100 } }, 0);
  assert.equal(weapons.ammo.usp.mag, 11, 'an older snapshot must not restore a pending bullet');
  weapons.syncAmmo({ usp: { mag: 11, reserve: 100 } }, 1);
  assert.equal(weapons.ammo.usp.mag, 11);
  weapons.reload(); const reloadAction = net.actionSeq;
  assert.equal(messages.at(-1).t, 'reload');
  weapons.syncAmmo({ usp: { mag: 11, reserve: 100, reload: { at: 10 } } }, reloadAction);
  update(2300); assert(weapons.state.reload, 'local animation cannot complete a server reload');
  weapons.syncAmmo({ usp: { mag: 12, reserve: 99 } }, reloadAction);
  assert(!weapons.state.reload); assert.equal(weapons.ammo.usp.mag, 12);
  // Resume during a reload blocks predicted firing until the server has completed it.
  weapons.syncAmmo({ usp: { mag: 5, reserve: 50, reload: { at: 20 } } }, reloadAction);
  assert(weapons.state.reload);
  const before = messages.length; weapons.primaryDown(); weapons.primaryUp(); update(100);
  assert.equal(messages.length, before, 'reload resumed from a snapshot prevents firing');
  weapons.syncAmmo({ usp: { mag: 12, reserve: 43 } }, reloadAction); assert(!weapons.state.reload);
  net.connected = false; weapons.state.held = true; update(500);
  assert(!weapons.state.held); assert.equal(weapons.ammo.usp.mag, 12, 'disconnect cancels held fire');
  net.connected = true; canFire = false; weapons.state.held = true; update(500);
  assert.equal(weapons.ammo.usp.mag, 12, 'freeze/menu gating also applies to automatic updates');
  canFire = true;
  weapons.select('knife'); await new Promise((resolve) => setImmediate(resolve));
  weapons.setLoadout(['usp', 'knife', 'm3', 'rocket'], 'usp', true);
  assert.equal(weapons.state.cur, 'usp', 'reconnection restores the authoritative equipped weapon');
  assert(ammoReadings.length > 0);
  console.log('weapons client ok: predicted/acknowledged ammo, server reload completion, resume during reload, held fire on disconnect, equipped weapon recovery');
} finally {
  globalThis.document = old.document; globalThis.addEventListener = old.add; globalThis.fetch = old.fetch; globalThis.window = old.window;
  performance.now = old.now; THREE.TextureLoader.prototype.load = old.texture;
}
