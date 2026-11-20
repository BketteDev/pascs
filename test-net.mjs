import assert from 'node:assert/strict';
import { connectToServer } from './public/net.js';
import { KEYBOARD_PRESETS, setKeyboardLayout, keyName } from './public/binds.js';
const names = ['WebSocket', 'location', 'sessionStorage', 'document', 'addEventListener', 'removeEventListener', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
const saved = Object.fromEntries(names.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
const savedNow = performance.now;
let clock = 0, reloads = 0;
const timers = new Set(), sockets = [], storage = new Map(), listeners = new Map();
const add = (type, fn) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); };
const remove = (type, fn) => listeners.get(type)?.delete(fn);
const timeout = (fn, delay, repeat = false) => { const t = { fn, at: clock + delay, delay, repeat }; timers.add(t); return t; };
const advance = (ms) => { const end = clock + ms; for (; clock < end; clock++) for (const t of [...timers]) if (clock >= t.at) { if (t.repeat) t.at += t.delay; else timers.delete(t); t.fn(); } };
class Socket {
  constructor(url) { this.url = url; this.readyState = 0; this.bufferedAmount = 0; this.sent = []; sockets.push(this); }
  open() { this.readyState = 1; this.onopen(); }
  send(raw) { this.sent.push(JSON.parse(raw)); }
  message(data) { this.onmessage({ data: JSON.stringify(data) }); }
  close(code = 1005) { if (this.readyState === 3) return; this.readyState = 3; this.onclose({ code }); }
}
const snap = (ack = 0) => ({ t: 'snap', tick: 4, you: { ammoAck: ack, team: 'ct', ack: 14 }, ev: [], ents: [] });
const welcomes = (socket, id, resumed = false) => socket.message({ t: 'welcome', id, tickRate: 128, snapshotRate: 32, resume: 'private-token', resumed });
try {
  Object.assign(globalThis, {
    WebSocket: Socket, location: { host: 'localhost:6767', protocol: 'http:', reload: () => reloads++ },
    sessionStorage: { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: (k) => storage.delete(k) },
    document: { hidden: false, addEventListener: add, removeEventListener: remove }, addEventListener: add, removeEventListener: remove,
    setTimeout: (fn, delay) => timeout(fn, delay), clearTimeout: (t) => timers.delete(t),
    setInterval: (fn, delay) => timeout(fn, delay, true), clearInterval: (t) => timers.delete(t),
  });
  performance.now = () => clock;
  let snapshots = 0, resumed = 0;
  const net = connectToServer({ name: 'Alice', map: 'de_dust2', onSnap: () => snapshots++, onResume: () => resumed++ });
  let socket = sockets.at(-1); socket.open();
  assert.equal(socket.sent[0].team, 'spec'); assert.equal(socket.sent[0].name, 'Alice');
  welcomes(socket, 1); assert(!net.connected, 'wait for state before enabling input');
  socket.message(snap()); await net.ready; assert(net.connected); assert.equal(net.snapshotRate, 32);
  net.send({ t: 'fire', w: 'usp' }); assert.equal(net.ammoShots[0].seq, 1);
  socket.message(snap(1)); assert.equal(net.ammoShots.length, 0);
  socket.bufferedAmount = 70000; assert.equal(net.send({ t: 'cmd' }), false, 'do not accumulate commands on a blocked uplink'); socket.bufferedAmount = 0;
  socket.close(1006); assert(!net.connected && net.reconnecting);
  assert.equal(net.send({ t: 'fire', w: 'usp' }), false);
  advance(501); socket = sockets.at(-1); socket.open(); assert.equal(socket.sent[0].resume, 'private-token');
  welcomes(socket, 1, true); socket.message(snap(8));
  assert.equal(resumed, 1); assert(net.connected && !net.reconnecting); assert.equal(net.actionSeq, 8);
  net.send({ t: 'reload', w: 'usp' }); assert.equal(socket.sent.at(-1).aq, 9);
  // A silent connection is restarted on returning from the background.
  advance(9600); assert(!net.connected && net.reconnecting);
  advance(600); socket = sockets.at(-1); if (socket.readyState === 0) socket.open();
  welcomes(socket, 2, false); socket.message(snap()); assert.equal(net.id, 2); assert.equal(net.actionSeq, 0); assert.equal(resumed, 2);
  socket.close(4001); const count = sockets.length; advance(12000);
  assert.equal(sockets.length, count, 'a kicked session never reconnects'); assert(net.kicked);
  net.close(); assert.equal(timers.size, 0);
  assert.equal([...listeners.values()].reduce((n, set) => n + set.size, 0), 0);

  const full = connectToServer({ name: 'Bob', map: 'de_dust2', onSnap() {} });
  const rejected = assert.rejects(full.ready, /Server full/);
  sockets.at(-1).open(); sockets.at(-1).close(1013); await rejected; full.close();
  const changed = connectToServer({ name: 'Bob', map: 'de_dust2', onSnap() {} });
  sockets.at(-1).open(); sockets.at(-1).close(4000); assert.equal(reloads, 1); changed.close();
  assert.equal(storage.size, 0, 'map changes clear the previous resume token');
  setKeyboardLayout('azerty'); assert.equal(keyName(KEYBOARD_PRESETS.azerty.forward), 'Z'); assert.equal(keyName(KEYBOARD_PRESETS.azerty.left), 'Q'); assert.equal(keyName(KEYBOARD_PRESETS.azerty.team), 'M');
  setKeyboardLayout('qwerty'); assert.equal(keyName(KEYBOARD_PRESETS.qwerty.forward), 'W');
  console.log('client ok: initial join, action acknowledgements, backpressure, reconnect/watchdog, expiry, kick/full/map change, AZERTY/QWERTY');
} finally {
  performance.now = savedNow;
  for (const key of names) { if (saved[key]) Object.defineProperty(globalThis, key, saved[key]); else delete globalThis[key]; }
}
