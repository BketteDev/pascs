// The C4 in the world: the dropped bomb, the planted bomb with its blinking light and accelerating beeps, and the explosion.
// Driven by the server's bomb state in every snapshot: sync(bomb, now) and update(now, dt) each frame; explode(o) on the event.
import * as THREE from 'three';
import { BOMB } from './weapon-defs.js';

const glow = (stops) => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32); for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c);
};

export async function createBombs({ worldRoot, loadTex, playAt }) {
  const manifest = await fetch('weapons/weapons.json').then((r) => r.json()), info = manifest.c4;
  const bin = await fetch('weapons/c4.bin').then((r) => r.arrayBuffer());
  const meshOf = (list) => {
    const group = new THREE.Group(); group.visible = false; worldRoot.add(group);
    for (const m of list ?? []) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, m.pos, m.count * 3), 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bin, m.uv, m.count * 2), 2));
      const mat = new THREE.MeshBasicMaterial({ color: 0xcccccc, side: THREE.DoubleSide });
      if (m.tex) loadTex('weapons/tex/' + m.tex, (t) => { mat.map = t; mat.needsUpdate = true; });
      group.add(new THREE.Mesh(geo, mat));
    }
    return group;
  };
  const dropped = meshOf(info.world), planted = meshOf(info.planted);
  const led = new THREE.Sprite(new THREE.SpriteMaterial({ map: glow([[0, 'rgba(255,60,40,1)'], [0.4, 'rgba(255,0,0,0.6)'], [1, 'rgba(255,0,0,0)']]), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
  led.scale.setScalar(10); led.visible = false; worldRoot.add(led);
  const fireTex = glow([[0, 'rgba(255,250,220,1)'], [0.3, 'rgba(255,160,50,0.95)'], [0.7, 'rgba(160,50,10,0.5)'], [1, 'rgba(60,20,0,0)']]);
  const smokeTex = glow([[0, 'rgba(70,64,58,0.9)'], [0.6, 'rgba(60,55,50,0.6)'], [1, 'rgba(50,50,50,0)']]);
  const fx = []; // explosion sprites { sp, t, life, from, to, rise }

  let state = 'none', at = null, blowAt = 0, nextBeep = 0, ledOff = 0, yaw = 0;
  function sync(b, now) {
    if (!b) return;
    if (b.s !== state || (b.o && (!at || Math.hypot(b.o[0] - at[0], b.o[1] - at[1], b.o[2] - at[2]) > 1))) yaw = Math.random() * 6.28;
    state = b.s; at = b.o;
    if (state === 'planted') { const est = now + b.left; if (!blowAt || Math.abs(est - blowAt) > 0.25) blowAt = est; } else blowAt = 0; // follow the server's timer
    dropped.visible = state === 'dropped'; planted.visible = state === 'planted';
    for (const g of [dropped, planted]) if (g.visible) { g.position.set(at[0], at[1], at[2] + (g === dropped ? 2 : 0)); g.rotation.set(0, 0, yaw); }
    if (state !== 'planted') led.visible = false;
  }
  function explode(o, now) {
    state = 'exploded'; dropped.visible = planted.visible = led.visible = false;
    for (let i = 0; i < 14; i++) { // fireball + rolling smoke
      const fire = i < 8, sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: fire ? fireTex : smokeTex, transparent: true, depthWrite: false, blending: fire ? THREE.AdditiveBlending : THREE.NormalBlending }));
      const a = Math.random() * 6.28, r = Math.random() * 120;
      sp.position.set(o[0] + Math.cos(a) * r, o[1] + Math.sin(a) * r, o[2] + 30 + Math.random() * 80); worldRoot.add(sp);
      fx.push({ sp, t: now - Math.random() * 0.15, life: fire ? 1.1 + Math.random() * 0.5 : 2.6 + Math.random(), from: fire ? 150 : 220, to: fire ? 700 + Math.random() * 300 : 900, rise: fire ? 60 : 140 });
    }
  }
  function update(now) {
    if (state === 'planted' && at && blowAt) { // beep faster as it gets closer, the light blinks with each beep
      const left = Math.max(blowAt - now, 0);
      if (now >= nextBeep) {
        playAt('weapons/c4/c4_beep1', at, 0.75, 'bomb');
        nextBeep = now + Math.max(0.1, Math.min(1, 0.1 + (left / BOMB.timer) * 0.95));
        ledOff = now + 0.08; led.visible = true;
      }
      led.position.set(at[0], at[1], at[2] + 6);
      if (now > ledOff) led.visible = false;
    }
    for (let i = fx.length - 1; i >= 0; i--) {
      const f = fx[i], k = (now - f.t) / f.life;
      if (k >= 1) { worldRoot.remove(f.sp); fx.splice(i, 1); continue; }
      if (k < 0) continue;
      f.sp.scale.setScalar(f.from + (f.to - f.from) * Math.sqrt(k)); f.sp.material.opacity = 1 - k; f.sp.position.z += f.rise * 0.016 * (1 - k);
    }
  }
  return { sync, update, explode, get state() { return state; }, get at() { return at; } };
}
