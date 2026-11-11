// CS:S player models as shootable enemies: skinned meshes driven by the baked layered animations, bone-merged
// third-person rifles, the models' own hitboxes, CS:S hit-group damage, death poses and respawns.
import * as THREE from 'three';
import { trace, TICK } from './physics.js';
import { createRagdoll, stepRagdoll, ragdollPose } from './ragdoll.js';
import { HITGROUP_MULT, WEAPONS } from './weapon-defs.js';
import { createIncendiaryModel } from './incendiary-model.js';
import { agentsFor, AGENT_NAMES } from './agents.js';

const skinnedVertex = `
  #include <common>
  #include <skinning_pars_vertex>
  varying vec2 vUv; varying vec3 vN; varying float vDepth;
  void main() {
    vUv = uv;
    #include <skinbase_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    vN = normalize(mat3(modelMatrix) * objectNormal);
    vec4 mv = modelViewMatrix * vec4(transformed, 1.0); vDepth = -mv.z;
    gl_Position = projectionMatrix * mv;
  }`;
// Dynamic lighting for characters, same maths as the lightmaps: linear light = shade ambient + sun * N.L * (sun visible ? 1 : 0),
// encoded with gamma and doubled (overbright). The normal is in three's y-up space; the sun direction arrives in Source space.
const skinnedFragment = (fogGlsl) => `
  uniform sampler2D map; uniform float cutoff, gain, sunVis; uniform vec3 sunDir, ambientLin, directLin; varying vec2 vUv; varying vec3 vN; ${fogGlsl}
  void main() {
    vec4 t = texture2D(map, vUv); if (t.a < cutoff) discard;
    vec3 sd = normalize(vec3(sunDir.x, sunDir.z, -sunDir.y));
    vec3 lin = ambientLin + directLin * clamp(dot(normalize(vN), sd), 0.0, 1.0) * sunVis;
    vec3 enc = min(pow(max(lin, 0.0), vec3(1.0 / 2.2)) * 0.5, 1.0);
    gl_FragColor = vec4(applyFog(t.rgb * enc * 2.0 * gain), t.a);
  }`;

// Source 3x4 row-major helpers
const quatMatrix = (q, p, o, k) => { // writes into o[k..k+12]
  const [x, y, z, w] = q;
  o[k] = 1 - 2 * y * y - 2 * z * z; o[k + 1] = 2 * x * y - 2 * w * z; o[k + 2] = 2 * x * z + 2 * w * y; o[k + 3] = p[0];
  o[k + 4] = 2 * x * y + 2 * w * z; o[k + 5] = 1 - 2 * x * x - 2 * z * z; o[k + 6] = 2 * y * z - 2 * w * x; o[k + 7] = p[1];
  o[k + 8] = 2 * x * z - 2 * w * y; o[k + 9] = 2 * y * z + 2 * w * x; o[k + 10] = 1 - 2 * x * x - 2 * y * y; o[k + 11] = p[2];
};
const mul34 = (a, ai, b, bi, o, oi) => {
  for (let r = 0; r < 3; r++) {
    const A0 = a[ai + r * 4], A1 = a[ai + r * 4 + 1], A2 = a[ai + r * 4 + 2];
    o[oi + r * 4] = A0 * b[bi] + A1 * b[bi + 4] + A2 * b[bi + 8];
    o[oi + r * 4 + 1] = A0 * b[bi + 1] + A1 * b[bi + 5] + A2 * b[bi + 9];
    o[oi + r * 4 + 2] = A0 * b[bi + 2] + A1 * b[bi + 6] + A2 * b[bi + 10];
    o[oi + r * 4 + 3] = A0 * b[bi + 3] + A1 * b[bi + 7] + A2 * b[bi + 11] + a[ai + r * 4 + 3];
  }
};
const toThree = (m, i, e) => { for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) e[c * 4 + r] = m[i + r * 4 + c]; e[3] = e[7] = e[11] = 0; e[15] = 1; };

export async function createPlayers({ loadTex, worldRoot, world, bulletLimit, gain, play, fog, light, skyBrush, fogGlsl, getMyTeam, getMyId, mapName }) {
  const [info, bin] = await Promise.all([fetch('players/players.json').then((r) => r.json()), fetch('players/players.bin').then((r) => r.arrayBuffer())]);
  const canon = new Map(info.bones.map((n, i) => [n, i]));
  const views = new Map(); // byte offset -> Float32Array(frames * bones * 7): the upper-body layer poses and gesture clips (tools/players.mjs)
  const view = (o, frames = 1) => views.get(o) ?? views.set(o, new Float32Array(bin, o, info.bones.length * 7 * frames)).get(o);
  const anims = Object.fromEntries(info.anims.map((a) => [a.name, { ...a, data: new Float32Array(bin, a.data, a.frames * info.bones.length * 7) }]));
  const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
  const lightUniforms = { sunDir: { value: new THREE.Vector3(...light.sunDir) }, ambientLin: { value: new THREE.Vector3(...light.ambient) }, directLin: { value: new THREE.Vector3(...light.direct) } };
  const materialFor = (m, sunVis) => { // one material per (texture, character): each character has its own sun visibility
    const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: white }, cutoff: { value: m.alpha === 1 ? 0.5 : 0 }, gain: { value: gain }, sunVis, ...fog, ...lightUniforms }, vertexShader: skinnedVertex, fragmentShader: skinnedFragment(fogGlsl), transparent: m.alpha === 2 });
    if (m.tex) loadTex('players/tex/' + m.tex, (t) => { mat.uniforms.map.value = t; });
    return mat;
  };
  const geometries = new Map();
  const geometryFor = (m) => {
    if (!geometries.has(m.pos)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, m.pos, m.count * 3), 3));
      g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(bin, m.nrm, m.count * 3), 3));
      g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bin, m.uv, m.count * 2), 2));
      g.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(bin, m.bw, m.count * 4), 4));
      g.setAttribute('skinIndex', new THREE.BufferAttribute(new Float32Array(bin, m.bi, m.count * 4), 4));
      geometries.set(m.pos, g);
    }
    return geometries.get(m.pos);
  };
  const skinned = (group, meshes, n, sunVis) => {
    const bones = Array.from({ length: n }, () => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; return b; });
    const skeleton = new THREE.Skeleton(bones);
    bones.meshes = meshes.map((m) => {
      const mesh = new THREE.SkinnedMesh(geometryFor(m), materialFor(m, sunVis));
      mesh.bindMode = THREE.DetachedBindMode; mesh.bind(skeleton, new THREE.Matrix4()); mesh.frustumCulled = false;
      group.add(mesh);
      return mesh;
    });
    return bones;
  };

  // Use the authored CS:S grenade grip instead of guessing axes in the player's hand bone.
  const handName = 'ValveBiped.Bip01_R_Hand', smoke = info.weapons.smokegrenade;
  const smokeBounds = new THREE.Box3(), partBounds = new THREE.Box3(), fireGrip = new THREE.Matrix4();
  for (const m of smoke.meshes) smokeBounds.union(partBounds.setFromBufferAttribute(geometryFor(m).attributes.position));
  toThree(smoke.bones.find((b) => b.name === handName).poseToBone, 0, fireGrip.elements);
  fireGrip.multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2).setPosition(smokeBounds.getCenter(new THREE.Vector3())));

  // soft blob shadow on the floor under each character (the lightmaps only hold the static world)
  const shadowTex = (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 2, 32, 32, 31); gr.addColorStop(0, 'rgba(0,0,0,0.55)'); gr.addColorStop(0.6, 'rgba(0,0,0,0.25)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new THREE.CanvasTexture(c); })();
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6 });
  const shadowGeo = new THREE.PlaneGeometry(44, 44);
  const makeShadow = () => { const m = new THREE.Mesh(shadowGeo, shadowMat.clone()); worldRoot.add(m); return m; }; // own material: own opacity
  // The blob shadow lies on the ground under `p` (traced down, tilted to the slope), shrinks and fades as the player rises (jumps, ledges),
  // and is stronger in sunlight than in shade.
  const UP = new THREE.Vector3(0, 0, 1), groundN = new THREE.Vector3();
  function placeShadow(bot, p) {
    const r = trace(world, [p[0], p[1], p[2] + 4], [p[0], p[1], p[2] - 200], [-12, -12, 0], [12, 12, 1]); // the player's footprint, against everything they can stand on (player clips too): on a ledge it finds the ledge, not the floor below
    if (!r.normal) { bot.shadow.visible = false; return; }
    const k = Math.max(0, 1 - Math.max(p[2] - r.end[2], 0) / 160), sh = bot.shadow;
    sh.visible = k > 0.02; sh.position.set(r.end[0], r.end[1], r.end[2] + 0.4);
    sh.quaternion.setFromUnitVectors(UP, groundN.set(r.normal[0], r.normal[1], r.normal[2]));
    sh.scale.setScalar(0.65 + 0.35 * k); sh.material.opacity = k * (0.35 + 0.65 * bot.sunVis.value);
  }
  const sunSkip = skyBrush;
  const sunVisible = (p) => trace(world, [p[0], p[1], p[2] + 40], [p[0] + light.sunDir[0] * 4000, p[1] + light.sunDir[1] * 4000, p[2] + 40 + light.sunDir[2] * 4000], [0, 0, 0], [0, 0, 0], bulletLimit, sunSkip).fraction === 1 ? 1 : 0;

  // ---------- remote players (bots and other humans), driven by server snapshots ----------
  const byId = new Map(), bots = [];
  // a character with its rifle: skinned meshes + the buffers pose() / skin() work on
  function makeRig(model, team, group, sunVis) {
    const def = info.models[model], wkey = team === 'ct' ? 'm4a1' : team === 't' ? 'ak47' : 'knife', wdef = info.weapons[wkey];
    return {
      team, def, group, sunVis, bones: skinned(group, def.meshes, def.bones.length, sunVis), wbones: skinned(group, wdef.meshes, wdef.bones.length, sunVis), wdef, weaponKey: wkey,
      map: def.bones.map((b) => canon.get(b.name) ?? -1),
      wmap: wdef.bones.map((b) => def.bones.findIndex((x) => x.name === b.name)),
      world: new Float32Array(def.bones.length * 12), wworld: new Float32Array(wdef.bones.length * 12), tmp: new Float32Array(12),
      anim: 'idle', animStart: performance.now() / 1000 - Math.random() * 2, phase: Math.random() * 30, fade: null, gait: 'idle', dir: 'f', air: 0, speed: 0,
    };
  }
  // swap the weapon in their hand: the world model is bone-merged onto the hand (skin()), the upper-body pose follows its class (pose())
  function setHeldWeapon(bot, key) {
    const fire = WEAPONS[key]?.grenade === 'fire';
    if ((!info.weapons[key] && !fire) || bot.weaponKey === key) return;
    for (const m of bot.wbones.meshes) bot.group.remove(m);
    bot.fireHand = null;
    if (fire) {
      const socket = new THREE.Group(), model = createIncendiaryModel(key);
      model.applyMatrix4(fireGrip); socket.add(model);
      socket.matrixAutoUpdate = false; socket.visible = !bot.dead; bot.group.add(socket);
      const wbones = []; wbones.meshes = [socket];
      Object.assign(bot, { weaponKey: key, wdef: { bones: [] }, wbones, fireHand: { socket, hand: bot.def.bones.findIndex((b) => b.name === handName) } });
      return;
    }
    const wdef = info.weapons[key];
    Object.assign(bot, { weaponKey: key, wdef, wbones: skinned(bot.group, wdef.meshes, wdef.bones.length, bot.sunVis), wworld: new Float32Array(wdef.bones.length * 12),
      wmap: wdef.bones.map((b) => bot.def.bones.findIndex((x) => x.name === b.name)) });
    if (bot.dead) bot.wbones.meshes.forEach((m) => { m.visible = false; });
  }
  function spawnBot(e) { // the map's agents, alternating by id
    const names = agentsFor(mapName, e.team), model = names[e.id % names.length];
    const group = new THREE.Group(); worldRoot.add(group);
    const bot = {
      ...makeRig(model, e.team, group, { value: 1 }),
      id: e.id, name: e.name, spotted: false, origin: [...e.o], yaw: e.yaw, health: e.hp, dead: false, deadAt: 0, shadow: makeShadow(),
    };
    if (e.team === 'h') { bot.wbones.meshes.forEach((m) => { m.visible = false; }); bot.upperClass = HOSTAGE_UPPER; } // hostages carry nothing
    byId.set(e.id, bot); bots.push(bot);
    return bot;
  }
  function removeBot(bot) {
    worldRoot.remove(bot.group); worldRoot.remove(bot.shadow);
    byId.delete(bot.id); bots.splice(bots.indexOf(bot), 1);
  }
  const revive = (bot) => { bot.wbones.meshes.forEach((m) => { m.visible = bot.team !== 'h'; }); Object.assign(bot, { ragdoll: null, dead: false, anim: 'idle', phase: 0, fade: null, gait: 'idle', air: 0 }); };

  // Snapshot interpolation on the server's clock. Every snapshot carries its tick; we track how far behind our clock the server's runs
  // (the smallest arrival offset seen, drifting slowly, so one late packet does not move it) and draw everyone a little behind that.
  // The delay grows with how jittery the connection is, so packets arriving in bursts no longer make other players stutter.
  const buffer = [];
  let clockOffset = null, lateness = 0.008, renderTick = null;
  function applySnapshot(snap, arrival) {
    const st = snap.tick * TICK, off = arrival - st;
    if (clockOffset === null || off < clockOffset) clockOffset = off; else clockOffset += (off - clockOffset) * 0.002;
    lateness += (Math.min(off - clockOffset, 0.25) - lateness) * 0.05;
    buffer.push({ t: st, ents: new Map(snap.ents.map((e) => [e.id, e])) });
    while (buffer.length > 64) buffer.shift();
    const ids = new Set(snap.ents.map((e) => e.id));
    for (const bot of [...bots]) if (!ids.has(bot.id)) removeBot(bot); // left / replaced by a human
  }
  const renderDelay = () => Math.min(Math.max(2.5 / 128 + lateness * 1.5, 0.03), 0.25); // 2.5 snapshots (128 Hz) + jitter margin
  // other live players as the latest snapshot has them: solid to our own movement prediction (physics.js separate())
  const solids = () => { const last = buffer[buffer.length - 1], out = []; if (last) for (const [id, e] of last.ents) if (id !== getMyId() && e.alive && e.team !== 'h') out.push({ o: e.o, ducked: !!e.duck }); return out; }; // hostages do not block (as on the server)
  const lerpAngle = (a, b, k) => a + (((b - a + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * k;

  // CS:S player animation: lower body from the movement (gait x direction relative to where they face, crouched or not), jump in the air.
  // Thresholds have hysteresis so a player hovering around a boundary does not flicker between animations.
  const RING = ['f', 'l', 'b', 'r']; // counter-clockwise from forward
  // ground speed each baked loop was authored for (measured from the planted foot in tools: the feet must not slide)
  const AUTHORED = { run: { f: 172, l: 217, b: 203, r: 203 }, walk: { f: 74, l: 87, b: 72, r: 85 }, cwalk: { f: 60, l: 56, b: 64, r: 56 } };
  function animFor(bot, e, v, speed, dt) {
    bot.air = e.g ? 0 : bot.air + dt;
    bot.blend = null;
    if (bot.air > 0.12) { bot.gait = 'idle'; return 'jump'; } // short ground losses (stairs, bumps) are not jumps
    const crouch = e.cr ?? e.duck; // crouch key held (or stuck crouched under something)
    if (bot.gait === 'idle' ? speed < 30 : speed < 12) { bot.gait = 'idle'; return crouch ? 'cidle' : 'idle'; }
    // like Source's move_x / move_y blend: the two directions either side of the movement, weighted by angle (diagonals, any strafe)
    const a = (((Math.atan2(v[1], v[0]) - bot.yaw) % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2); // 0 = forward, pi/2 = left
    const seg = Math.floor(a / (Math.PI / 2)) % 4, frac = (a - seg * (Math.PI / 2)) / (Math.PI / 2), d1 = RING[seg], d2 = RING[(seg + 1) % 4];
    bot.gait = crouch ? 'cwalk' : (bot.gait === 'run' ? speed > 135 : speed > 165) ? 'run' : 'walk';
    bot.dir = frac < 0.5 ? d1 : d2;
    bot.blend = { anim: `${bot.gait}_${frac < 0.5 ? d2 : d1}`, w: frac < 0.5 ? frac : 1 - frac };
    bot.authored = AUTHORED[bot.gait][d1] * (1 - frac) + AUTHORED[bot.gait][d2] * frac;
    return `${bot.gait}_${bot.dir}`;
  }
  function syncBots(now, dt) {
    if (!buffer.length || clockOffset === null) return;
    const rt = now - clockOffset - renderDelay();
    renderTick = rt / TICK; // what we see of the others is the server at this tick: sent with our hits so the server can rewind to it
    let i = buffer.length - 1; while (i > 0 && buffer[i - 1].t > rt) i--; // buffer[i-1] <= rt < buffer[i]
    const A = buffer[Math.max(i - 1, 0)], B = buffer[i], k = B.t > A.t ? Math.min(Math.max((rt - A.t) / (B.t - A.t), 0), 1) : 1;
    for (const [id, eb] of B.ents) {
      if (id === getMyId()) continue;
      const ea = A.ents.get(id) ?? eb;
      let bot = byId.get(id) ?? spawnBot(eb);
      if (bot.team !== eb.team) { removeBot(bot); bot = spawnBot(eb); } // switched team: new agent model, and friend / enemy for hits
      bot.name = eb.name; bot.health = eb.hp; bot.armor = eb.ar; bot.helmet = eb.hm; if (eb.w) setHeldWeapon(bot, eb.w);
      if (!bot.ragdoll) {
        bot.origin = [0, 1, 2].map((a) => ea.o[a] + (eb.o[a] - ea.o[a]) * k);
        bot.yaw = lerpAngle(ea.yaw, eb.yaw, k);
        bot.pitch = (ea.pt ?? 0) + ((eb.pt ?? 0) - (ea.pt ?? 0)) * k; // where they look: the aim layer raises / lowers the gun
      }
      const v = [ea.v[0] + (eb.v[0] - ea.v[0]) * k, ea.v[1] + (eb.v[1] - ea.v[1]) * k];
      bot.speed = Math.hypot(v[0], v[1]);
      if (!eb.alive && !bot.dead) die(bot, 0, [0, 0, 0], now); // died without a death event (joined late): fall where it stands
      else if (eb.alive && bot.dead) revive(bot); // new round
      else if (!bot.dead) {
        const want = animFor(bot, eb, v, bot.speed, dt);
        const up = bot.gait === 'cwalk' ? 'cwalk' : bot.gait === 'idle' ? ((eb.cr ?? eb.duck) ? 'crouch' : 'idle') : bot.gait; // upper-body set for the gait
        if (up !== bot.upState) { bot.upPrev = bot.upState ?? up; bot.upState = up; bot.upT = now; }
        if (bot.anim !== want) { // cross-fade from the old pose; loops keep their stride position (run forward -> run left)
          const o = anims[bot.anim], n = anims[want];
          if (bot.anim.split('_')[0] !== want.split('_')[0] || !o?.loop) bot.fade = { anim: bot.anim, phase: bot.phase, t: now }; // same gait, new direction: the blend is already continuous
          bot.phase = o?.loop && n.loop ? (bot.phase / o.frames) * n.frames : 0;
          bot.anim = want;
        }
      }
    }
  }
  function die(bot, hitBone, dir, now, force = 1) {
    if (bot.dead) return;
    bot.dead = true; bot.deadAt = now;
    startRagdoll(bot, hitBone, dir, force);
    play('player/death' + (1 + (Math.random() * 6 | 0)), 0.5);
  }
  // our own body when we die: the same agent the others see, posed where the server says we fell, then ragdolled
  function removeSelf(id) { const b = byId.get(id); if (b?.self) removeBot(b); }
  function ragdollSelf(ev, now, yaw, force) {
    removeSelf(ev.victim);
    const bot = spawnBot({ id: ev.victim, team: getMyTeam(), o: ev.o, yaw, name: '', hp: 0 });
    bot.self = true; bot.origin = [...ev.o]; bot.yaw = yaw;
    pose(bot, now); die(bot, ev.bone, ev.dir, now, force);
  }
  function onDeath(ev, now, myYaw = 0) {
    const force = Math.min(Math.max((WEAPONS[ev.w]?.damage ?? 30) / 33, 0.8), 1.9) * (ev.hs ? 1.15 : 1);
    if (ev.victim === getMyId()) { ragdollSelf(ev, now, myYaw, force); blood([ev.o[0], ev.o[1], ev.o[2] + (ev.hs ? 62 : 46)], ev.dir, ev.hs ? 40 : 28, 380); return; }
    const bot = byId.get(ev.victim); if (bot) { die(bot, ev.bone, ev.dir, now, force); blood([ev.o[0], ev.o[1], ev.o[2] + (ev.hs ? 62 : 46)], ev.dir, ev.hs ? 40 : 28, 380); } }

  // Spawn points are entity origins a little above the floor: drop them onto the ground.
  const alive = (team) => bots.filter((b) => b.team === team && !b.dead).length;

  const FADE = 0.18;
  const frameOf = (a, phase) => {
    const f = a.loop ? ((phase % a.frames) + a.frames) % a.frames : Math.min(Math.max(phase, 0), a.frames - 1), f0 = Math.floor(f);
    return [f0, a.loop ? (f0 + 1) % a.frames : Math.min(f0 + 1, a.frames - 1), f - f0];
  };
  function sample(a, [f0, f1, w], ci, n, p, q) { // one canonical bone at a fractional frame
    const d = a.data, A = (f0 * n + ci) * 7, B = (f1 * n + ci) * 7;
    let dot = 0; for (let k = 0; k < 4; k++) dot += d[A + 3 + k] * d[B + 3 + k];
    const s = dot < 0 ? -1 : 1;
    for (let k = 0; k < 3; k++) p[k] = d[A + k] + (d[B + k] - d[A + k]) * w;
    for (let k = 0; k < 4; k++) q[k] = d[A + 3 + k] + (s * d[B + 3 + k] - d[A + 3 + k]) * w;
  }
  function advance(bot, dt) { // feet match the ground speed: the loop plays faster or slower with how fast they move
    const a = anims[bot.anim], rate = a.loop && bot.blend && bot.authored ? Math.min(Math.max(bot.speed / bot.authored, 0.5), 2.2) : 1;
    bot.phase = a.loop ? (bot.phase + dt * a.fps * rate) % a.frames : Math.min(bot.phase + dt * a.fps, a.frames - 1);
  }
  const P2 = [0, 0, 0], Q2 = [0, 0, 0, 0], PA = [0, 0, 0], QA = [0, 0, 0, 0], ROW = new Float32Array(7);
  // One upper-body layer onto a bone (Source SlerpBones): an override slerps toward the layer's pose by its bone weight; a delta layer
  // (STUDIO_DELTA | STUDIO_POST) is post-multiplied, scaled by the weight: q = q * delta^w, p += delta.p * w.
  function layer(D, o, w, add, p, q) {
    if (add) {
      const sg = D[o + 6] < 0 ? -w : w, bx = D[o + 3] * sg, by = D[o + 4] * sg, bz = D[o + 5] * sg, bw = 1 - w + D[o + 6] * sg, l = Math.hypot(bx, by, bz, bw);
      const x = q[0], y = q[1], z = q[2], qw = q[3], X = bx / l, Y = by / l, Z = bz / l, Wq = bw / l;
      q[0] = qw * X + x * Wq + y * Z - z * Y; q[1] = qw * Y - x * Z + y * Wq + z * X; q[2] = qw * Z + x * Y - y * X + z * Wq; q[3] = qw * Wq - x * X - y * Y - z * Z;
      for (let k = 0; k < 3; k++) p[k] += D[o + k] * w;
    } else {
      const sg = D[o + 3] * q[0] + D[o + 4] * q[1] + D[o + 5] * q[2] + D[o + 6] * q[3] < 0 ? -1 : 1;
      for (let k = 0; k < 3; k++) p[k] += (D[o + k] - p[k]) * w;
      for (let k = 0; k < 4; k++) q[k] += (sg * D[o + 3 + k] - q[k]) * w;
      const l = Math.hypot(q[0], q[1], q[2], q[3]); for (let k = 0; k < 4; k++) q[k] /= l;
    }
  }
  // a gait's upper-body stack (weapon pose, body offset, hand position, aim at `pitchRow` 0..2 = looking up..down) onto one bone
  function upperStack(st, ci, pitchRow, p, q) {
    const o = ci * 7;
    for (const L of st) {
      const w = L.w[ci];
      if (!(w > 0)) continue;
      if (L.rows) { // the aim matrix: interpolate the two body_pitch rows either side
        const i0 = Math.min(Math.floor(pitchRow), 1), k = pitchRow - i0, A = view(L.rows[i0]), B = view(L.rows[i0 + 1]);
        const sg = A[o + 3] * B[o + 3] + A[o + 4] * B[o + 4] + A[o + 5] * B[o + 5] + A[o + 6] * B[o + 6] < 0 ? -1 : 1;
        for (let j = 0; j < 3; j++) ROW[j] = A[o + j] + (B[o + j] - A[o + j]) * k;
        for (let j = 3; j < 7; j++) ROW[j] = A[o + j] + (sg * B[o + j] - A[o + j]) * k;
        layer(ROW, 0, w, L.add, p, q);
      } else layer(view(L.pose), o, w, L.add, p, q);
    }
  }
  const UP_FADE = 0.2, HOSTAGE_UPPER = 'C4'; // hostages: CS:S has no hostage animations of its own here (HL2's male_shared); the C4 carry keeps the arms low
  function pose(bot, now) {
    const a = anims[bot.anim], n = info.bones.length, fr = frameOf(a, bot.phase ?? (now - bot.animStart) * a.fps);
    const fade = bot.fade && now - bot.fade.t < FADE ? bot.fade : null, fa = fade && anims[fade.anim], ffr = fade && frameOf(fa, fade.phase), fw = fade ? (now - fade.t) / FADE : 1;
    const blend = bot.blend && anims[bot.blend.anim] ? bot.blend : null, ba = blend && anims[blend.anim], bfr = blend && frameOf(ba, ((bot.phase ?? 0) / a.frames) * ba.frames);
    const U = info.uppers[bot.upperClass ?? WEAPONS[bot.weaponKey]?.upper], cur = U && (U[bot.upState] ?? U.idle);
    const prev = U && now - (bot.upT ?? -9) < UP_FADE ? U[bot.upPrev] ?? U.idle : null, uk = prev ? (now - bot.upT) / UP_FADE : 1;
    const pitchRow = 1 - Math.max(-1, Math.min(1, (bot.pitch ?? 0) / (Math.PI / 2))); // rows 0..2 = body_pitch -90..90; Source pitch is + looking down, ours + up
    const crouched = bot.upState === 'crouch' || bot.upState === 'cwalk', shot = U && (crouched ? U.cshoot ?? U.shoot : U.shoot);
    const sf = shot && bot.shotAt != null ? (performance.now() / 1000 - bot.shotAt) * shot.fps : -1, shotData = sf >= 0 && sf < shot.frames - 1 && view(shot.data, shot.frames);
    const W = bot.world, t = bot.tmp, bones = bot.def.bones;
    const q = [0, 0, 0, 0], p = [0, 0, 0];
    for (let i = 0; i < bones.length; i++) {
      const ci = bot.map[i];
      if (ci < 0) { quatMatrix(bones[i].quat, bones[i].pos, t, 0); }
      else {
        sample(a, fr, ci, n, p, q);
        if (blend) { // the neighbouring direction, at the same point of its stride
          sample(ba, bfr, ci, n, P2, Q2);
          const s = Q2[0] * q[0] + Q2[1] * q[1] + Q2[2] * q[2] + Q2[3] * q[3] < 0 ? -1 : 1;
          for (let k = 0; k < 3; k++) p[k] += (P2[k] - p[k]) * blend.w;
          for (let k = 0; k < 4; k++) q[k] += (s * Q2[k] - q[k]) * blend.w;
        }
        if (fade) { // blend from the previous animation's pose
          sample(fa, ffr, ci, n, P2, Q2);
          const s = Q2[0] * q[0] + Q2[1] * q[1] + Q2[2] * q[2] + Q2[3] * q[3] < 0 ? -1 : 1;
          for (let k = 0; k < 3; k++) p[k] = P2[k] + (p[k] - P2[k]) * fw;
          for (let k = 0; k < 4; k++) q[k] = Q2[k] + (s * q[k] - Q2[k]) * fw;
        }
        if (cur) { // upper body: how this weapon is held for the gait, aimed where they look; gait changes cross-fade
          if (prev) {
            PA.splice(0, 3, ...p); QA.splice(0, 4, ...q);
            upperStack(prev, ci, pitchRow, PA, QA); upperStack(cur, ci, pitchRow, p, q);
            const sg = QA[0] * q[0] + QA[1] * q[1] + QA[2] * q[2] + QA[3] * q[3] < 0 ? -1 : 1;
            for (let k = 0; k < 3; k++) p[k] = PA[k] + (p[k] - PA[k]) * uk;
            for (let k = 0; k < 4; k++) q[k] = QA[k] + (sg * q[k] - QA[k]) * uk;
          } else upperStack(cur, ci, pitchRow, p, q);
          if (shotData && shot.w[ci] > 0) { // the fire gesture (a delta clip): the gun kicks
            const f0 = Math.floor(sf), A = (f0 * n + ci) * 7, B = A + n * 7, fk = sf - f0;
            for (let j = 0; j < 7; j++) ROW[j] = shotData[A + j] + (shotData[B + j] - shotData[A + j]) * fk;
            layer(ROW, 0, shot.w[ci], true, p, q);
          }
        }
        const l = Math.hypot(q[0], q[1], q[2], q[3]); for (let k = 0; k < 4; k++) q[k] /= l;
        quatMatrix(q, p, t, 0);
      }
      if (bones[i].parent >= 0) mul34(W, bones[i].parent * 12, t, 0, W, i * 12); else W.set(t, i * 12);
    }
    skin(bot);
  }

  function skin(bot) { // bot.world (bone -> model space) -> skinning matrices, then bone-merge the rifle
    const W = bot.world, t = bot.tmp, bones = bot.def.bones;
    if (bot.fireHand?.hand >= 0) {
      const { socket, hand } = bot.fireHand;
      toThree(W, hand * 12, socket.matrix.elements);
      socket.matrixWorldNeedsUpdate = true;
    }
    for (let i = 0; i < bones.length; i++) {
      mul34(W, i * 12, bones[i].poseToBone, 0, t, 0);
      toThree(t, 0, bot.bones[i].matrixWorld.elements);
    }
    // bone-merge the rifle: bones with a matching player bone follow it, the rest keep their bind offset
    const wb = bot.wdef.bones, WW = bot.wworld;
    for (let j = 0; j < wb.length; j++) {
      const k = bot.wmap[j];
      if (k >= 0) WW.set(W.subarray(k * 12, k * 12 + 12), j * 12);
      else { quatMatrix(wb[j].quat, wb[j].pos, t, 0); if (wb[j].parent >= 0) mul34(WW, wb[j].parent * 12, t, 0, WW, j * 12); else WW.set(t, j * 12); }
      mul34(WW, j * 12, wb[j].poseToBone, 0, t, 0);
      toThree(t, 0, bot.wbones[j].matrixWorld.elements);
    }
  }

  let lastNow = 0;
  function update(now, eye) {
    const dt = Math.min(lastNow ? now - lastNow : 0, 0.1); lastNow = now;
    syncBots(now, dt); stepBlood(dt); stepShots(dt);
    for (const bot of bots) {
      bot.friendly = bot.team === getMyTeam(); if (bot.friendly || bot.team === 'h') bot.spotted = true; // hostages: always on the radar
      if (bot.ragdoll) { // simulated in world space: the group stays at the identity
        stepRagdoll(bot.ragdoll, dt);
        ragdollPose(bot.ragdoll, bot.def.bones, bot.world);
        bot.group.position.set(0, 0, 0); bot.group.rotation.set(0, 0, 0);
        skin(bot);
        const pv = bot.ragdoll.P[0];
        bot.sunVis.value += (sunVisible(pv) - bot.sunVis.value) * Math.min(1, dt * 12); // every frame: the shadow stays under the body
        placeShadow(bot, pv);
        continue;
      }
      if (!bot.dead && !bot.friendly) { // radar: an enemy shows while it has a clear line of sight to us
        const head = [bot.origin[0], bot.origin[1], bot.origin[2] + 64];
        bot.spotted = trace(world, head, eye, [0, 0, 0], [0, 0, 0], bulletLimit).fraction === 1;
      }
      bot.group.position.set(bot.origin[0], bot.origin[1], bot.origin[2]);
      bot.group.rotation.set(0, 0, bot.yaw);
      advance(bot, dt); pose(bot, now);
      bot.sunVis.value += (sunVisible(bot.origin) - bot.sunVis.value) * Math.min(1, dt * 12); // light + shadow follow the player every frame
      placeShadow(bot, bot.origin);
    }
  }

  // Ray vs every hitbox (oriented boxes in bone space). Returns nearest { bot, dist, group } within maxDist.
  function hitTest(from, dir, maxDist) {
    let best = null;
    for (const bot of bots) {
      if (bot.dead || bot.friendly) continue; // friendly fire is off
      const c = Math.cos(bot.yaw), s = Math.sin(bot.yaw);
      // into model space (undo yaw + origin)
      const rx = from[0] - bot.origin[0], ry = from[1] - bot.origin[1], rz = from[2] - bot.origin[2];
      const o = [c * rx + s * ry, -s * rx + c * ry, rz], v = [c * dir[0] + s * dir[1], -s * dir[0] + c * dir[1], dir[2]];
      for (const hb of bot.def.hitboxes) {
        const M = bot.world, i = hb.bone * 12;
        // bone space = R^T (p - t)
        const lo = [0, 0, 0], lv = [0, 0, 0], d = [o[0] - M[i + 3], o[1] - M[i + 7], o[2] - M[i + 11]];
        for (let a = 0; a < 3; a++) { lo[a] = M[i + a] * d[0] + M[i + 4 + a] * d[1] + M[i + 8 + a] * d[2]; lv[a] = M[i + a] * v[0] + M[i + 4 + a] * v[1] + M[i + 8 + a] * v[2]; }
        let t0 = 0, t1 = maxDist;
        for (let a = 0; a < 3 && t0 <= t1; a++) {
          if (Math.abs(lv[a]) < 1e-9) { if (lo[a] < hb.min[a] || lo[a] > hb.max[a]) t0 = Infinity; continue; }
          let ta = (hb.min[a] - lo[a]) / lv[a], tb = (hb.max[a] - lo[a]) / lv[a];
          if (ta > tb) [ta, tb] = [tb, ta];
          t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        }
        if (t0 <= t1 && (!best || t0 < best.dist)) best = { bot, dist: t0, group: hb.group, bone: hb.bone };
      }
    }
    return best;
  }

  function startRagdoll(bot, hitBone, dir, force = 1) { // freeze the current pose in world space and hand it to the ragdoll
    const c = Math.cos(bot.yaw), s = Math.sin(bot.yaw), o = bot.origin, G = [c, -s, 0, o[0], s, c, 0, o[1], 0, 0, 1, o[2]];
    const W = new Float32Array(bot.world.length);
    for (let i = 0; i < bot.def.bones.length; i++) mul34(G, 0, bot.world, i * 12, W, i * 12);
    bot.world.set(W);
    bot.ragdoll = createRagdoll(bot.def.bones, W, hitBone, dir, (a, b, mins, maxs) => trace(world, a, b, mins, maxs, bulletLimit), force);
    bot.wbones.meshes.forEach((m) => { m.visible = false; }); // the rifle is dropped
  }

  // ---------- blood: CS:S blood_impact particles + Source blood spray decals ----------
  // Sprites from CS:S's particle sheets (ui/blood_mist.png: 32 dark-red splat / puff frames; ui/blood_drops.png: 32 white droplet frames,
  // tinted like the .pcf does), each particle on a random frame: a mist that blooms and fades, goop thrown along the bullet, droplets that
  // fall. Where the spray lands (the wall behind the victim, the floor under them) the Source blood decal (decals/blood8) is stamped,
  // blended mod2x like the engine: it darkens the surface instead of painting over it.
  const sheet = (file) => { const t = new THREE.TextureLoader().load(file); t.repeat.set(1 / 32, 1); return t; };
  const mistTex = sheet('ui/blood_mist.png'), dropTex = sheet('ui/blood_drops.png'), DROP_TINT = [0.42, 0.03, 0.02];
  const drops = [], dropsIdle = [];
  function spawn(tex, pos, v, life, size, grow, grav, tint) {
    let d = dropsIdle.pop();
    if (!d) { if (drops.length >= 400) return; const sp = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false })); worldRoot.add(sp); d = { sp }; drops.push(d); }
    const m = d.sp.material;
    if (m.map?.source !== tex.source) { m.map = tex.clone(); m.map.needsUpdate = true; m.needsUpdate = true; } // a clone per sprite (same image on the GPU) for its own frame
    m.map.offset.set(((Math.random() * 32) | 0) / 32, 0); m.rotation = Math.random() * 6.28;
    if (tint) m.color.setRGB(tint[0], tint[1], tint[2]); else m.color.setRGB(1, 1, 1);
    Object.assign(d, { v, life, max: life, size, grow, grav, live: true }); d.sp.position.set(pos[0], pos[1], pos[2]); d.sp.visible = true;
  }
  function blood(pos, dir, count, speed) {
    const r = Math.random, k = count / 10; // 10 = a body shot, 16 = a headshot, 28-40 = a kill
    for (let i = 0; i < 2 + k * 2; i++) spawn(mistTex, pos, [dir[0] * speed * 0.15 + (r() - 0.5) * 40, dir[1] * speed * 0.15 + (r() - 0.5) * 40, (r() - 0.4) * 30], 0.35 + r() * 0.3, 6 + r() * 6, 1.8, -10); // mist
    for (let i = 0; i < 2 + k * 2; i++) { const s = speed * (0.5 + r() * 0.7); spawn(mistTex, pos, [dir[0] * s + (r() - 0.5) * 90, dir[1] * s + (r() - 0.5) * 90, dir[2] * s + (r() - 0.3) * 90 + 40], 0.3 + r() * 0.25, 3 + r() * 3, 0.6, 500); } // goop
    for (let i = 0; i < 6 + k * 8; i++) { const s = speed * (0.4 + r()) * (i % 7 === 6 ? -0.3 : 1); spawn(dropTex, pos, [dir[0] * s + (r() - 0.5) * 150, dir[1] * s + (r() - 0.5) * 150, dir[2] * s + (r() - 0.3) * 170 + 50], 0.3 + r() * 0.4, 1.2 + r() * 1.6, 0, 800, DROP_TINT); } // droplets
    splatter(pos, dir, count);
  }
  function stepBlood(dt) {
    for (const d of drops) {
      if (!d.live) continue;
      d.life -= dt; if (d.life <= 0) { d.live = false; d.sp.visible = false; dropsIdle.push(d); continue; }
      d.v[2] -= d.grav * dt; if (d.grav < 0) { d.v[0] *= 1 - dt * 3; d.v[1] *= 1 - dt * 3; }
      const p = d.sp.position; p.x += d.v[0] * dt; p.y += d.v[1] * dt; p.z += d.v[2] * dt;
      const k = 1 - d.life / d.max; d.sp.material.opacity = Math.min(1, (1 - k) * 1.6); d.sp.scale.setScalar(d.size * (1 + d.grow * k));
    }
  }
  // decals: mod2x (result = surface * decal * 2, so its 50% grey background leaves the wall as it is), the newest 48 kept
  const decalMats = [1, 2, 3, 4, 5, 6, 7].map((i) => new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load(`ui/blood_decal${i}.png`), fog: false, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor }));
  const splatGeo = new THREE.PlaneGeometry(1, 1), splats = []; let splatNext = 0;
  function decal(at, nrm, size) {
    let m = splats[splatNext];
    if (!m) { m = new THREE.Mesh(splatGeo, decalMats[0]); worldRoot.add(m); splats[splatNext] = m; }
    m.material = decalMats[(Math.random() * decalMats.length) | 0]; m.visible = true;
    splatNext = (splatNext + 1) % 48;
    m.position.set(at[0] + nrm[0] * 0.2, at[1] + nrm[1] * 0.2, at[2] + nrm[2] * 0.2);
    m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(nrm[0], nrm[1], nrm[2])); m.rotateZ(Math.random() * 6.28);
    m.scale.set(size * (Math.random() < 0.5 ? -1 : 1), size, 1); // mirrored half the time: more variety from the one texture
  }
  const clearDecals = (box) => { for (const m of splats) if (!box || m.position.toArray().every((v, k) => v >= box[0][k] && v <= box[1][k])) m.visible = false; }; // new round / broken window
  function splatter(pos, dir, count) {
    const wall = trace(world, pos, [pos[0] + dir[0] * 150, pos[1] + dir[1] * 150, pos[2] + dir[2] * 150 - 20], [0, 0, 0], [0, 0, 0], bulletLimit);
    if (wall.normal && !wall.startSolid) decal(wall.end, wall.normal, 38 * (0.8 + Math.random() * 0.4) * (count > 12 ? 1.3 : 1)); // the wall behind them (256 px x $decalscale 0.15)
    const floor = trace(world, pos, [pos[0] + dir[0] * 40, pos[1] + dir[1] * 40, pos[2] - 120], [0, 0, 0], [0, 0, 0], bulletLimit);
    if (floor.normal && !floor.startSolid && Math.random() < 0.6) decal(floor.end, floor.normal, 20 + Math.random() * 12); // drips on the floor
  }
  // ---------- other players' shots: muzzle flash at their gun hand, a tracer streak flying to where the bullet went, the impact ----------
  const flashTex = new THREE.TextureLoader().load('ui/muzzle1.png'), tracerMat = new THREE.MeshBasicMaterial({ color: 0xffe2a0, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false });
  const tracerGeo = new THREE.BoxGeometry(1, 0.35, 0.35).translate(-0.5, 0, 0); // a streak along +x, length scaled per tracer
  const flashes = [], tracers = [];
  const handOf = (bot) => { // world position a little in front of the right hand
    bot.hand ??= bot.def.bones.findIndex((b) => /R_Hand/.test(b.name));
    const W = bot.world, i = bot.hand * 12, c = Math.cos(bot.yaw), sn = Math.sin(bot.yaw), x = W[i + 3], y = W[i + 7], z = W[i + 11];
    return [bot.origin[0] + c * x - sn * y + c * 14, bot.origin[1] + sn * x + c * y + sn * 14, bot.origin[2] + z + 2];
  };
  function shotFx(ev, onImpact) {
    const bot = byId.get(ev.id);
    if (!bot || bot.dead || WEAPONS[ev.w]?.melee) return;
    const from = handOf(bot);
    let f = flashes.find((x) => !x.sp.visible);
    if (!f) { f = { sp: new THREE.Sprite(new THREE.SpriteMaterial({ map: flashTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })) }; worldRoot.add(f.sp); flashes.push(f); }
    bot.shotAt = performance.now() / 1000; // the fire gesture
    f.sp.position.set(from[0], from[1], from[2]); f.sp.scale.setScalar(10 + Math.random() * 6); f.sp.material.rotation = Math.random() * 6.28; f.sp.visible = true; f.life = 0.05; f.fresh = true;
    if (!ev.to) return;
    const d = [ev.to[0] - from[0], ev.to[1] - from[1], ev.to[2] - from[2]], len = Math.hypot(...d);
    if (len < 40) return;
    let tr = tracers.find((x) => !x.mesh.visible);
    if (!tr) { tr = { mesh: new THREE.Mesh(tracerGeo, tracerMat) }; tr.mesh.frustumCulled = false; worldRoot.add(tr.mesh); tracers.push(tr); }
    Object.assign(tr, { from, dir: d.map((v) => v / len), len, at: 0 }); tr.mesh.visible = true;
    tr.mesh.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), new THREE.Vector3(...tr.dir));
    if (ev.hit) { blood(ev.to, tr.dir, 10, 240); return; } // a bot's bullet that hit someone (players' own hits are drawn by their own client)
    const hit = trace(world, from, [ev.to[0] + tr.dir[0] * 4, ev.to[1] + tr.dir[1] * 4, ev.to[2] + tr.dir[2] * 4], [0, 0, 0], [0, 0, 0], bulletLimit);
    if (hit.normal && !hit.startSolid) onImpact(hit.end, hit.normal); // bullet hole where it struck a wall
  }
  function stepShots(dt) {
    for (const f of flashes) { if (!f.sp.visible) continue; if (f.fresh) { f.fresh = false; continue; } if ((f.life -= dt) <= 0) f.sp.visible = false; } // always drawn at least once
    for (const tr of tracers) {
      if (!tr.mesh.visible) continue;
      tr.at += dt * 7000; // tracer speed, units / s
      const head = Math.min(tr.at, tr.len), tail = Math.max(0, tr.at - 220); // a 220-unit streak flying along the path
      if (tail >= tr.len) { tr.mesh.visible = false; continue; }
      tr.mesh.position.set(tr.from[0] + tr.dir[0] * head, tr.from[1] + tr.dir[1] * head, tr.from[2] + tr.dir[2] * head); tr.mesh.scale.x = Math.max(head - tail, 1);
    }
  }
  // the server owns damage; locally we give instant feedback: blood where the bullet went in, a flesh / head sound, crosshair marker
  function feedback(hit, from, dir) {
    const at = [from[0] + dir[0] * hit.dist, from[1] + dir[1] * hit.dist, from[2] + dir[2] * hit.dist], head = hit.group === 1;
    blood(at, dir, head ? 16 : 10, head ? 340 : 240);
    const bot = hit.bot, legs = hit.group === 6 || hit.group === 7; // CS:S: the helmet "dink", a dull thud on kevlar, flesh otherwise
    play(head ? (bot.helmet ? 'player/bhit_helmet-1' : 'player/headshot' + (1 + (Math.random() * 2 | 0))) : bot.armor && !legs ? 'player/kevlar' + (1 + (Math.random() * 5 | 0)) : 'player/damage' + (1 + (Math.random() * 3 | 0)), head ? 0.85 : 0.7);
  }

  // Team-select portraits: the map's agents for a team, posed in their idle animation and drawn into a 2D canvas.
  let portraitGL = null; const portraitScenes = {};
  function drawPortrait(team, canvas, now) {
    if (!portraitGL) { portraitGL = new THREE.WebGLRenderer({ alpha: true, antialias: true }); portraitGL.outputColorSpace = THREE.LinearSRGBColorSpace; portraitGL.setPixelRatio(1); }
    let sc = portraitScenes[team];
    if (!sc) {
      const scene = new THREE.Scene(), root = new THREE.Group(); root.rotation.x = -Math.PI / 2; scene.add(root);
      const names = agentsFor(mapName, team).slice(0, 1), camera = new THREE.PerspectiveCamera(30, 1, 10, 2000); // the map's lead agent
      const rigs = names.map((n, i) => {
        const g = new THREE.Group(); root.add(g);
        const rig = makeRig(n, team, g, { value: 1 }); rig.phase = undefined; // portraits play by wall-clock time
        const k = i - (names.length - 1) / 2;
        g.position.set(0, 0, 0); g.rotation.z = (team === 'ct' ? 0.35 : -0.35); // turned a little towards the middle
        return rig;
      });
      sc = portraitScenes[team] = { scene, camera, rigs };
    }
    const w = canvas.width, h = canvas.height;
    if (portraitGL.domElement.width !== w || portraitGL.domElement.height !== h) portraitGL.setSize(w, h, false);
    sc.camera.aspect = w / h; sc.camera.updateProjectionMatrix();
    sc.camera.position.set(215, 40, 0); sc.camera.lookAt(0, 38, 0); // Source (215, 0, 40) looking at (0, 0, 38): y-up three space
    for (const r of sc.rigs) pose(r, now);
    portraitGL.setClearColor(0, 0); portraitGL.render(sc.scene, sc.camera);
    const g2 = canvas.getContext('2d'); g2.clearRect(0, 0, w, h); g2.drawImage(portraitGL.domElement, 0, 0);
  }
  const agentNames = (team) => agentsFor(mapName, team).map((n) => AGENT_NAMES[n]);
  return { renderTick: () => renderTick, clearDecals, shotFx, removeSelf, portraitScenes, solids, drawPortrait, agentNames, applySnapshot, onDeath, update, hitTest, feedback, alive, bots, byId };
}
