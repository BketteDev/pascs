// Thrown grenades (world models from the per-weapon bins), plus explosion / flash pops and smoke clouds.
// Everything is driven by server snapshots: `sync(gr, smokes)` every snapshot, `pop(ev)` on an explode event, `update(dt)` per frame.
import * as THREE from 'three';
import { GRENADE, GRENADES, WEAPONS } from './weapon-defs.js';
import { createIncendiaryModel, loadIncendiaryModels } from './incendiary-model.js';

const KEYS = GRENADES.filter((key) => WEAPONS[key].model);
const blob = (stops) => { // soft round sprite texture
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32); for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
};

export async function createGrenades({ worldRoot, loadTex }) {
  const [manifest] = await Promise.all([fetch('weapons/weapons.json').then((r) => r.json()), loadIncendiaryModels(loadTex)]);
  const geos = {}, mats = {};
  await Promise.all(KEYS.map(async (k) => {
    const m = manifest[k]?.world?.[0]; if (!m) return;
    const bin = await fetch(`weapons/${k}.bin`).then((r) => r.arrayBuffer());
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, m.pos, m.count * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(bin, m.nrm, m.count * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bin, m.uv, m.count * 2), 2));
    const mat = new THREE.MeshBasicMaterial({ color: 0xdddddd, side: THREE.DoubleSide });
    if (m.tex) loadTex('weapons/tex/' + m.tex, (t) => { mat.map = t; mat.needsUpdate = true; });
    geos[k] = geo; mats[k] = mat;
  }));

  const fireTex = blob([[0, 'rgba(255,240,200,1)'], [0.35, 'rgba(255,150,40,0.9)'], [1, 'rgba(120,30,0,0)']]);
  const flashTex = blob([[0, 'rgba(255,255,255,1)'], [0.4, 'rgba(255,255,255,0.7)'], [1, 'rgba(255,255,255,0)']]);
  const puffTex = blob([[0, 'rgba(200,200,200,0.95)'], [0.6, 'rgba(170,170,170,0.7)'], [1, 'rgba(150,150,150,0)']]);
  const flameFrames = [];
  loadTex('equipment-models/ground-fire.png', (atlas) => {
    for (let i = 0; i < 16; i++) {
      const frame = atlas.clone();
      frame.flipY = true;
      frame.repeat.set(0.25, 0.25);
      frame.offset.set((i % 4) / 4, (3 - Math.floor(i / 4)) / 4);
      frame.needsUpdate = true;
      flameFrames.push(frame);
    }
  });
  const sprite = (tex, additive) => {
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending }));
    worldRoot.add(sp); return sp;
  };

  const live = new Map(); // grenade id -> { mesh, last }
  const clouds = new Map(); // smoke id -> { puffs, age }
  const burning = new Map();
  const pops = []; // short effects: { sp, t, life, size }
  const removeSprite = (sp) => { worldRoot.remove(sp); sp.material.dispose(); };

  function sync(gr, smokes, fires = []) {
    const seen = new Set();
    for (const g of gr) {
      seen.add(g.id);
      let e = live.get(g.id);
      if (!e) {
        if (!geos[g.w] && WEAPONS[g.w]?.grenade !== 'fire') continue;
        const mesh = geos[g.w] ? new THREE.Mesh(geos[g.w], mats[g.w]) : createIncendiaryModel(g.w);
        if (WEAPONS[g.w].grenade === 'fire') mesh.rotation.x = Math.PI / 2;
        worldRoot.add(mesh); e = { mesh, last: g.o }; live.set(g.id, e);
      }
      e.moved = Math.hypot(g.o[0] - e.last[0], g.o[1] - e.last[1], g.o[2] - e.last[2]) > 0.05; e.last = g.o;
      e.mesh.position.set(g.o[0], g.o[1], g.o[2]);
    }
    for (const [id, e] of live) if (!seen.has(id)) { worldRoot.remove(e.mesh); live.delete(id); }
    const seenSmoke = new Set();
    for (const m of smokes) {
      seenSmoke.add(m.id);
      let c = clouds.get(m.id);
      if (!c) {
        const puffs = Array.from({ length: 16 }, (_, i) => {
          const sp = sprite(puffTex, false), a = Math.random() * 6.28, r = Math.sqrt(Math.random()) * GRENADE.smokeRadius * 0.7;
          sp.position.set(m.o[0] + Math.cos(a) * r, m.o[1] + Math.sin(a) * r, m.o[2] + 20 + Math.random() * 90);
          sp.userData = { base: 150 + Math.random() * 70, rot: Math.random() * 6.28 + i };
          return sp;
        });
        c = { puffs }; clouds.set(m.id, c);
      }
      c.age = m.age;
    }
    for (const [id, c] of clouds) if (!seenSmoke.has(id)) { c.puffs.forEach(removeSprite); clouds.delete(id); }
    const seenFire = new Set();
    for (const f of fires) {
      seenFire.add(f.id);
      let c = burning.get(f.id);
      if (!c) {
        const flames = f.cells.flatMap((p, cell) => Array.from({ length: 2 }, (_, i) => {
          const sp = sprite(fireTex, true), angle = (cell * 3 + i) * 2.4;
          sp.userData = { p: [p[0] + Math.cos(angle) * i * 12, p[1] + Math.sin(angle) * i * 12, p[2]], phase: angle, cell };
          return sp;
        }));
        const wisps = f.cells.filter((_, i) => i % 2 === 0).map((p, i) => {
          const sp = sprite(puffTex, false);
          sp.material.color.setHex(0x4a4038);
          sp.userData = { p, phase: i * 0.37 };
          return sp;
        });
        c = { flames, wisps, age: f.age }; burning.set(f.id, c);
      }
      c.age = f.age;
    }
    for (const [id, c] of burning) if (!seenFire.has(id)) { [...c.flames, ...c.wisps].forEach(removeSprite); burning.delete(id); }
  }

  function pop(ev) { // explosion / flash flare at the grenade
    const he = ev.w === 'hegrenade' || WEAPONS[ev.w]?.grenade === 'fire', flash = ev.w === 'flashbang';
    if (!he && !flash) return;
    const sp = sprite(he ? fireTex : flashTex, true); sp.position.set(ev.o[0], ev.o[1], ev.o[2] + 10);
    pops.push({ sp, t: 0, life: he ? 0.5 : 0.25, size: he ? 260 : 120 });
  }

  function update(dt) {
    for (const e of live.values()) if (e.moved) { e.mesh.rotation.x += dt * 11; e.mesh.rotation.y += dt * 4; }
    for (const c of clouds.values()) {
      const fade = Math.min(c.age / 0.8, 1) * Math.min((GRENADE.smokeTime - c.age) / 3, 1); // blooms in, thins out at the end
      for (const sp of c.puffs) { sp.material.opacity = 0.92 * Math.max(fade, 0); sp.material.rotation = sp.userData.rot + c.age * 0.05; sp.scale.setScalar(sp.userData.base * (0.45 + 0.55 * Math.min(c.age / 1.2, 1))); }
    }
    for (const c of burning.values()) {
      c.age += dt;
      const fade = Math.max(0, Math.min(1, (GRENADE.fireTime - c.age) / 0.7));
      for (const sp of c.flames) {
        const { p, phase, cell } = sp.userData, growth = Math.max(0, Math.min(1, (c.age - (cell ? 0.3 : 0)) / 0.3));
        const flicker = 0.9 + 0.1 * Math.sin(c.age * 13 + phase), height = (58 + 18 * Math.sin(phase)) * flicker * growth;
        const frame = Math.floor(c.age * 20 + phase * 4) % 16;
        if (flameFrames.length) sp.material.map = flameFrames[frame];
        sp.position.set(p[0], p[1], p[2] + height * 0.48);
        sp.scale.set(56 * growth, height, 1); sp.material.opacity = fade * flicker * growth * 0.8;
      }
      for (const sp of c.wisps) {
        const { p, phase } = sp.userData, k = (c.age * 0.65 + phase) % 1;
        sp.position.set(p[0] + k * 11, p[1] + k * 4, p[2] + 20 + k * 78);
        sp.scale.setScalar(26 + k * 45);
        sp.material.opacity = fade * Math.min(1, c.age * 2) * Math.sin(k * Math.PI) * 0.27;
      }
    }
    for (let i = pops.length - 1; i >= 0; i--) {
      const p = pops[i]; p.t += dt; const k = p.t / p.life;
      if (k >= 1) { removeSprite(p.sp); pops.splice(i, 1); continue; }
      p.sp.material.opacity = 1 - k; p.sp.scale.setScalar(p.size * (0.4 + 0.6 * Math.sqrt(k)));
    }
  }
  return { sync, pop, update };
}
