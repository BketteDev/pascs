// Weapons: view models (loaded on demand), hitscan firing with CS:S-style recoil/spread and wall penetration, shotguns, grenade throwing,
// ammo/reload, sounds, bullet decals, HUD.
import * as THREE from 'three';
import { WEAPONS, ORDER, GRENADES } from './weapon-defs.js';
import { createIncendiaryModel, loadIncendiaryModels } from './incendiary-model.js';
import { trace } from './physics.js';
import { march } from './ballistics.js';
import { audio, play as playSound, playAt, preload } from './audio.js';
import { is } from './binds.js';

const rad = Math.PI / 180;
const VM_FOV = 54; // viewmodel_fov (horizontal degrees at 4:3, like the world fov)
const LIGHT_FRAME = 0.16, LIGHT_TIME = 0.28;
// Smoke viewmodel left hand (bone 7), from the Source bind pose.
const LEFT_HAND_BIND = new THREE.Matrix4().set(
  0.05580, -0.99121, 0.11992, -12.551,
  0.99696, 0.06185, 0.04737, -5.97416,
  -0.05437, 0.11692, 0.99165, 0.57934,
  0, 0, 0, 1,
).invert();

// CS:S view models are authored left-handed (x forward, y left, z up) and mirrored for cl_righthand 1:
// three camera space = (right = +y, up = +z, back = -x). Determinant -1, three flips the winding for us.
// A few CS:S view models (Galil, FAMAS, M249, knife: "BuiltRightHanded") are authored right-handed already: those are not mirrored.
const MODEL_TO_CAMERA_RH = new THREE.Matrix4().set(
  0, -1, 0, 0,
  0, 0, 1, 0,
  -1, 0, 0, 0,
  0, 0, 0, 1,
);
const MODEL_TO_CAMERA = new THREE.Matrix4().set(
  0, 1, 0, 0,
  0, 0, 1, 0,
  -1, 0, 0, 0,
  0, 0, 0, 1,
);

const vmVertex = `
  #include <common>
  #include <skinning_pars_vertex>
  varying vec2 vUv; varying vec3 vN;
  void main() {
    vUv = uv;
    #include <skinbase_vertex>
    #include <beginnormal_vertex>
    #include <skinnormal_vertex>
    #include <begin_vertex>
    #include <skinning_vertex>
    vN = normalize(normalMatrix * objectNormal);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
  }`;
const vmFragment = `
  uniform sampler2D map; uniform float cutoff; varying vec2 vUv; varying vec3 vN;
  void main() {
    vec4 t = texture2D(map, vUv); if (t.a < cutoff) discard;
    float l = 0.6 + 0.4 * max(dot(normalize(vN), normalize(vec3(0.35, 0.65, 0.7))), 0.0);
    gl_FragColor = vec4(t.rgb * l * 1.2, t.a);
  }`;

export async function createWeapons({ loadTex, player, world, bulletLimit, surfOf, surfaces, worldRoot, hud, renderer, targets, net, uiOpen, initial, alive = () => true }) {
  // ---------- assets ----------
  const manifest = await fetch('weapons/weapons.json').then((r) => r.json());
  const ctx = { world, limit: bulletLimit, surfOf, surfaces };
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 300);
  const holder = new THREE.Group(); scene.add(holder);
  const vms = {}, loading = new Map(); // key -> { group, bones, seqs, anim }
  const loadVm = (key) => {
    const fire = WEAPONS[key].grenade === 'fire', source = fire ? 'smokegrenade' : key;
    if (!loading.has(key)) loading.set(key, fetch(`weapons/${source}.bin`).then((r) => r.arrayBuffer()).then(async (bin) => {
      if (fire) await loadIncendiaryModels(loadTex);
      const info = manifest[source];
      const group = new THREE.Group(); group.visible = false;
      group.matrixAutoUpdate = false; group.matrix.copy(WEAPONS[source].rightHanded ? MODEL_TO_CAMERA_RH : MODEL_TO_CAMERA);
      // bones carry the baked skinning matrices directly (boneInverse = identity)
      const bones = Array.from({ length: info.bones }, () => { const b = new THREE.Bone(); b.matrixAutoUpdate = false; return b; });
      const skeleton = new THREE.Skeleton(bones);
      let incendiary, ignition;
      for (const m of info.meshes) {
        const geo = new THREE.BufferGeometry();
        geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, m.pos, m.count * 3), 3));
        if (fire && m === info.meshes[0]) {
          // The smoke grenade's item mesh is skinned entirely to bone 0; keep its animated hands.
          const model = createIncendiaryModel(key);
          model.rotation.x = Math.PI / 2;
          geo.computeBoundingBox(); geo.boundingBox.getCenter(model.position);
          incendiary = new THREE.Group(); incendiary.matrixAutoUpdate = false;
          incendiary.add(model); group.add(incendiary);
          if (key === 'molotov') {
            model.scale.setScalar(0.55);
            const lighter = createIncendiaryModel('lighter'), socket = new THREE.Group();
            const spark = lighter.children.find((mesh) => mesh.material.transparent);
            lighter.scale.setScalar(0.62);
            lighter.rotation.x = Math.PI / 2;
            lighter.position.set(1.7, -0.2, 0.3).applyMatrix4(LEFT_HAND_BIND);
            socket.matrixAutoUpdate = false; socket.visible = false;
            socket.add(lighter); group.add(socket);
            const wick = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
            wick.position.set(2.15, 8.3, -0.2); wick.scale.set(2.8, 4.2, 1); wick.visible = false;
            loadTex('equipment-models/ground-fire.png', (map) => {
              const flame = map.clone();
              flame.flipY = true; flame.repeat.set(0.25, 0.25); flame.offset.set(0, 0.75); flame.needsUpdate = true;
              wick.material.map = flame; wick.material.needsUpdate = true;
            });
            model.add(wick);
            ignition = { socket, spark, wick, model };
          }
          continue;
        }
        geo.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(bin, m.nrm, m.count * 3), 3));
        geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bin, m.uv, m.count * 2), 2));
        geo.setAttribute('skinWeight', new THREE.BufferAttribute(new Float32Array(bin, m.bw, m.count * 4), 4));
        geo.setAttribute('skinIndex', new THREE.BufferAttribute(new Float32Array(bin, m.bi, m.count * 4), 4));
        const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
        const mat = new THREE.ShaderMaterial({ uniforms: { map: { value: white }, cutoff: { value: m.alpha === 1 ? 0.5 : 0 } }, vertexShader: vmVertex, fragmentShader: vmFragment, transparent: m.alpha === 2 });
        if (m.tex) loadTex('weapons/tex/' + m.tex, (t) => { mat.uniforms.map.value = t; });
        const mesh = new THREE.SkinnedMesh(geo, mat);
        mesh.bindMode = THREE.DetachedBindMode; mesh.bind(skeleton, new THREE.Matrix4());
        mesh.frustumCulled = false;
        group.add(mesh);
      }
      const seqs = info.sequences.map((q) => ({ ...q, skin: new Float32Array(bin, q.skin, q.frames * info.bones * 12), attach: q.attach >= 0 ? new Float32Array(bin, q.attach, q.frames * 3) : null }));
      if (ignition) {
        const reach = seqs.find((q) => q.activity === 'ACT_VM_PULLPIN');
        seqs.push({ ...reach, frames: Math.min(28, reach.frames), fps: reach.fps * 1.15, loop: false, activity: 'ACT_VM_LIGHT' });
      }
      holder.add(group);
      const snd = WEAPONS[key].sounds; // fire / empty / deploy / reload / ... decoded now, not on first use
      preload(...Object.values(snd).flatMap((v) => (typeof v === 'string' ? [v] : Array.isArray(v) ? (typeof v[1] === 'string' && !Array.isArray(v[0]) ? [v[1]] : v.map((x) => x[1])) : [])).map((n) => 'weapons/' + n));
      return (vms[key] = { group, bones, seqs, incendiary, ignition, anim: null });
    }));
    return loading.get(key);
  };
  await loadVm(initial.weapon);
  // CS:S muzzle flash: the game's own additive sprites (a fireball and a star), randomly rotated and scaled each shot
  const tl = new THREE.TextureLoader();
  const flashPart = (file, size) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: tl.load('ui/' + file), transparent: true, blending: THREE.AdditiveBlending, depthTest: false, depthWrite: false, side: THREE.DoubleSide }));
    m.visible = false; m.renderOrder = 5; scene.add(m); return m;
  };
  const flash = flashPart('muzzle1.png', 4), flashStar = flashPart('muzzle2.png', 5.5);

  // ---------- view model animation (baked sequences, chosen by activity like the engine) ----------
  const findSeqs = (vm, act) => vm.seqs.filter((q) => q.activity === act);
  function playAct(key, act, fallback) {
    const vm = vms[key], sil = WEAPONS[key].silenced ? findSeqs(vm, act + '_SILENCED') : []; // the USP-S plays its suppressed sequences
    const list = sil.length ? sil : findSeqs(vm, act).length ? findSeqs(vm, act) : findSeqs(vm, fallback ?? '');
    if (!list.length) return 0;
    const seq = list[Math.floor(Math.random() * list.length)];
    vm.anim = { seq, start: performance.now() / 1000 };
    return seq.frames / seq.fps;
  }
  const muzzle = new THREE.Vector3();
  function poseViewModel(key, t) { // write interpolated skinning matrices into the bones; returns muzzle (model space) or null
    const vm = vms[key];
    if (!vm.anim || (!(s.pin && key === s.cur) && !vm.anim.seq.loop && (t - vm.anim.start) * vm.anim.seq.fps >= vm.anim.seq.frames - 1)) {
      if (!vm.anim || !vm.anim.seq.activity.startsWith('ACT_VM_IDLE')) playAct(key, 'ACT_VM_IDLE');
    }
    const { seq, start } = vm.anim, n = vm.bones.length;
    let f = (t - start) * seq.fps;
    f = seq.loop ? f % seq.frames : Math.min(f, seq.frames - 1);
    const f0 = Math.floor(f), f1 = seq.loop ? (f0 + 1) % seq.frames : Math.min(f0 + 1, seq.frames - 1), w = f - f0;
    const A = f0 * n * 12, B = f1 * n * 12, S = seq.skin;
    for (let i = 0; i < n; i++) {
      const a = A + i * 12, b = B + i * 12, e = vm.bones[i].matrixWorld.elements;
      // Source 3x4 row-major -> three column-major 4x4
      for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) e[c * 4 + r] = S[a + r * 4 + c] + (S[b + r * 4 + c] - S[a + r * 4 + c]) * w;
      e[3] = e[7] = e[11] = 0; e[15] = 1;
    }
    if (vm.incendiary) {
      vm.incendiary.matrix.copy(vm.bones[0].matrixWorld);
      vm.incendiary.matrixWorldNeedsUpdate = true;
      vm.incendiary.visible = seq.activity !== 'ACT_VM_THROW' || t - start < 0.22;
      if (vm.ignition?.model) {
        const lighting = seq.activity === 'ACT_VM_LIGHT', elapsed = t - start;
        vm.ignition.model.rotation.z = lighting ? -0.18 * Math.sin(Math.min(elapsed / 0.45, 1) * Math.PI) : Math.sin(t * 1.8) * 0.025;
      }
    }
    if (vm.ignition) {
      const { socket, spark, wick } = vm.ignition, elapsed = t - start;
      const lighting = seq.activity === 'ACT_VM_LIGHT', lit = lighting && elapsed >= LIGHT_FRAME;
      socket.visible = lighting;
      if (lighting) {
        socket.matrix.copy(vm.bones[7].matrixWorld);
        socket.matrixWorldNeedsUpdate = true;
      }
      if (spark) {
        spark.visible = lighting && elapsed >= LIGHT_FRAME - 0.04 && elapsed < LIGHT_FRAME + 0.35;
        if (spark.visible) spark.scale.setScalar(0.85 + 0.3 * Math.abs(Math.sin(t * 45)));
      }
      wick.visible = lit || seq.activity === 'ACT_VM_THROW';
      if (wick.visible) {
        const fi = Math.floor(t * 24) % 16;
        wick.material.map?.offset.set((fi % 4) * 0.25, 0.75 - Math.floor(fi / 4) * 0.25);
        const fl = (lighting ? 3.8 : 2.8) + Math.sin(t * 37) * 0.5;
        wick.scale.set(fl * 0.85, fl * 1.35, 1);
        wick.material.rotation = Math.sin(t * 21) * 0.16;
      }
      if (lit && !vm.anim.ignited) { vm.anim.ignited = true; play(WEAPONS[key].sounds.light, 0.55); }
    }
    if (!seq.attach) return null;
    const P = seq.attach;
    return muzzle.set(P[f0 * 3] + (P[f1 * 3] - P[f0 * 3]) * w, P[f0 * 3 + 1] + (P[f1 * 3 + 1] - P[f0 * 3 + 1]) * w, P[f0 * 3 + 2] + (P[f1 * 3 + 2] - P[f0 * 3 + 2]) * w);
  }

  const play = (name, volume) => playSound('weapons/' + name, volume);

  // ---------- bullet decals ----------
  // CS:S's own bullet holes (decals/<surface>/shot1-5, DecalModulate = mod2x: 50% grey leaves the surface as it is); sizes = texture width * $decalscale
  const HOLE_SIZE = { concrete: 3.8, wood: 6.4, metal: 6.4, glass: 14.1 }, HOLE_OF = { wood: 'wood', metal: 'metal', glass: 'glass' };
  const holeMats = Object.fromEntries(Object.keys(HOLE_SIZE).map((k) => [k, [1, 2, 3, 4, 5].map((i) => new THREE.MeshBasicMaterial({ map: new THREE.TextureLoader().load(`ui/hole_${k}${i}.png`), fog: false, depthWrite: false,
    polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.DstColorFactor, blendDst: THREE.SrcColorFactor }))]));
  const holeGeo = new THREE.PlaneGeometry(1, 1), holes = []; let holeNext = 0;
  // ---------- bullet impacts: a puff of dust / debris off the surface, sparks on metal ----------
  const glowTex = (stops) => { const c = document.createElement('canvas'); c.width = c.height = 32; const g = c.getContext('2d'); const gr = g.createRadialGradient(16, 16, 0, 16, 16, 16); for (const [o, col] of stops) gr.addColorStop(o, col); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); return new THREE.CanvasTexture(c); };
  const dustTex = glowTex([[0, 'rgba(200,188,166,0.95)'], [0.55, 'rgba(180,168,146,0.6)'], [1, 'rgba(160,150,130,0)']]);
  const sparkTex = glowTex([[0, 'rgba(255,245,200,1)'], [0.4, 'rgba(255,190,80,0.9)'], [1, 'rgba(255,120,0,0)']]);
  const chipTex = glowTex([[0, 'rgba(60,52,44,1)'], [0.7, 'rgba(60,52,44,0.8)'], [1, 'rgba(60,52,44,0)']]);
  const fx = [];
  const fxIdle = []; // free sprites (a scan of 500 every spawn would be slow)
  const spawnFx = (tex, additive, pos, v, life, from, to, grav, tint = WHITE) => {
    let f = fxIdle.pop();
    if (!f) { if (fx.length >= 500) return; f = { sp: new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthWrite: false })) }; worldRoot.add(f.sp); fx.push(f); }
    if (f.sp.material.map !== tex || f.add !== additive) { f.sp.material.map = tex; f.sp.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending; f.sp.material.needsUpdate = true; f.add = additive; }
    f.sp.material.color.setRGB(tint[0], tint[1], tint[2]); f.sp.material.rotation = Math.random() * 6.28;
    Object.assign(f, { v, life, max: life, from, to, grav }); f.sp.position.set(pos[0], pos[1], pos[2]); f.sp.visible = true;
  };
  // per surface: dust colour, debris colour (CS:S impact effects: a spurt of fine dust, a lingering cloud, chips / splinters / shards, sparks on metal)
  const WHITE = [1, 1, 1], DIRT = [[0.9, 0.76, 0.55], [0.5, 0.4, 0.28]];
  const SURF = { concrete: [[0.86, 0.84, 0.8], [0.45, 0.43, 0.4]], tile: [[0.92, 0.92, 0.9], [0.6, 0.58, 0.55]], wood: [[0.72, 0.6, 0.45], [0.55, 0.38, 0.2]],
    metal: [[0.6, 0.6, 0.62], [0.3, 0.3, 0.32]], glass: [[0.85, 0.9, 0.95], [0.85, 0.92, 1]], sand: DIRT, dirt: DIRT, grass: [[0.75, 0.7, 0.5], [0.35, 0.4, 0.2]], gravel: DIRT };
  // the Source bullet impact sounds per surface (physics/*_impact_bullet<1..n>, from the CS:GO install: tools/players.mjs copies them)
  const SAND = ['physics/surfaces/sand_impact_bullet', 4];
  const IMPACT_SOUND = { concrete: ['physics/concrete/concrete_impact_bullet', 4], tile: ['physics/surfaces/tile_impact_bullet', 4], wood: ['physics/wood/wood_solid_impact_bullet', 5],
    metal: ['physics/metal/metal_solid_impact_bullet', 4], glass: ['physics/glass/glass_impact_bullet', 4], sand: SAND, dirt: SAND, grass: SAND, gravel: SAND };
  function impactFx(pos, n, surface) {
    const [snd, variants] = IMPACT_SOUND[surface] ?? IMPACT_SOUND.concrete; playAt(snd + (1 + ((Math.random() * variants) | 0)), pos, 0.6, 'impact');
    const [dust, chip] = SURF[surface] ?? SURF.concrete, rnd = Math.random;
    const out = (k, spread) => [n[0] * k + (rnd() - 0.5) * spread, n[1] * k + (rnd() - 0.5) * spread, n[2] * k + (rnd() - 0.5) * spread];
    const p = [pos[0] + n[0] * 2, pos[1] + n[1] * 2, pos[2] + n[2] * 2];
    for (let i = 0; i < 4; i++) spawnFx(dustTex, false, p, out(180 + rnd() * 160, 70), 0.22 + rnd() * 0.12, 2, 9 + rnd() * 5, 120, dust); // the spurt off the wall
    spawnFx(dustTex, false, p, out(70, 40), 0.7 + rnd() * 0.3, 6, 34, -25, dust); // the cloud, drifting up
    spawnFx(dustTex, false, p, out(30, 30), 1.1 + rnd() * 0.4, 5, 28, -15, dust);
    if (surface === 'metal') {
      for (let i = 0; i < 10; i++) spawnFx(sparkTex, true, p, out(200 + rnd() * 220, 340), 0.1 + rnd() * 0.18, 1.2 + rnd(), 0.4, 600);
    } else {
      const shards = surface === 'glass' ? 8 : surface === 'wood' ? 8 : 6; // splinters / shards / chips, falling
      for (let i = 0; i < shards; i++) spawnFx(chipTex, surface === 'glass', p, out(120 + rnd() * 140, 230), 0.45 + rnd() * 0.35, 0.9 + rnd() * 1.2, 0.8, 650, chip);
    }
  }
  // a pane breaking: shards over its whole area, falling and tumbling (glass glints additively), plus a little dust
  // a pane breaking: real shards (flat jagged triangles of glass, or splinters for wood) over its whole area, tumbling down onto the
  // floor under it, where they lie a moment and fade; plus a little dust
  const shardGeos = Array.from({ length: 6 }, () => { // a few irregular sliver shapes, ~1 unit across (scaled per shard)
    const r = Math.random, g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute([-0.5 + r() * 0.3, -0.5, 0, 0.5, -0.4 + r() * 0.5, 0, -0.2 + r() * 0.6, 0.6 + r() * 0.4, 0], 3));
    return g;
  });
  const glassShardMat = new THREE.MeshBasicMaterial({ color: 0xcfe4ee, transparent: true, opacity: 0.75, side: THREE.DoubleSide, depthWrite: false });
  const woodShardMat = new THREE.MeshBasicMaterial({ color: 0x7a5a38, side: THREE.DoubleSide });
  const shards = [], SHARD_LIFE = 3.5;
  function shatter(box, glass = true) {
    const [lo, hi] = box, mid = [0, 1, 2].map((k) => (lo[k] + hi[k]) / 2), rnd = Math.random;
    const area = Math.max((hi[0] - lo[0]) * (hi[2] - lo[2]), (hi[1] - lo[1]) * (hi[2] - lo[2])), n = Math.min(60, 10 + area / 70);
    const floor = trace(world, mid, [mid[0], mid[1], lo[2] - 600], [0, 0, 0], [0, 0, 0], bulletLimit).end[2] + 0.3; // where they come to rest
    for (let i = 0; i < n; i++) {
      let s = shards.find((x) => !x.mesh.visible);
      if (!s) { if (shards.length >= 240) break; s = { mesh: new THREE.Mesh(shardGeos[0]), glassMat: glassShardMat.clone() }; worldRoot.add(s.mesh); shards.push(s); } // each shard fades on its own
      const m = s.mesh, size = glass ? 1.5 + rnd() * 4 : 1 + rnd() * 3;
      m.geometry = shardGeos[(rnd() * shardGeos.length) | 0]; m.material = glass ? s.glassMat : woodShardMat;
      m.scale.set(size, glass ? size : size * 0.35, 1); m.visible = true;
      m.position.set(...[0, 1, 2].map((k) => lo[k] + rnd() * (hi[k] - lo[k])));
      m.rotation.set(rnd() * 6.28, rnd() * 6.28, rnd() * 6.28);
      Object.assign(s, { v: [(rnd() - 0.5) * 140, (rnd() - 0.5) * 140, rnd() * 80], spin: [(rnd() - 0.5) * 20, (rnd() - 0.5) * 20, (rnd() - 0.5) * 20], life: SHARD_LIFE + rnd(), floor, rest: false });
    }
    const [dust] = SURF[glass ? 'glass' : 'wood'];
    for (let i = 0; i < 3; i++) spawnFx(dustTex, false, mid, [(rnd() - 0.5) * 40, (rnd() - 0.5) * 40, 10], 0.9, 8, 34, -15, dust);
  }
  function stepShards(dt) {
    for (const s of shards) {
      const m = s.mesh;
      if (!m.visible) continue;
      if ((s.life -= dt) <= 0) { m.visible = false; continue; }
      if (!s.rest) {
        s.v[2] -= 800 * dt;
        m.position.x += s.v[0] * dt; m.position.y += s.v[1] * dt; m.position.z += s.v[2] * dt;
        m.rotation.x += s.spin[0] * dt; m.rotation.y += s.spin[1] * dt; m.rotation.z += s.spin[2] * dt;
        if (m.position.z <= s.floor) { m.position.z = s.floor; m.rotation.x = 0; m.rotation.y = 0; s.rest = true; } // lands flat
      }
      if (m.material.transparent) m.material.opacity = 0.75 * Math.min(1, s.life / 0.8); // fades out at the end
    }
  }
  function stepFx(dt) {
    for (const f of fx) {
      if (!f.sp.visible) continue;
      if ((f.life -= dt) <= 0) { f.sp.visible = false; fxIdle.push(f); continue; }
      const k = 1 - f.life / f.max; f.v[2] -= f.grav * dt;
      if (f.grav < 0) { f.v[0] *= 1 - dt * 2.5; f.v[1] *= 1 - dt * 2.5; } // clouds slow down in the air
      f.sp.position.x += f.v[0] * dt; f.sp.position.y += f.v[1] * dt; f.sp.position.z += f.v[2] * dt;
      f.sp.scale.setScalar(f.from + (f.to - f.from) * k); f.sp.material.opacity = 1 - k * k;
    }
  }
  const surfaceAt = (pos, n) => { const r = trace(world, [pos[0] + n[0] * 2, pos[1] + n[1] * 2, pos[2] + n[2] * 2], [pos[0] - n[0] * 4, pos[1] - n[1] * 4, pos[2] - n[2] * 4], [0, 0, 0], [0, 0, 0], bulletLimit); return surfaces?.[surfOf?.[r.entry] ?? 0] ?? 'concrete'; };
  const addHole = (pos, n, surface = surfaceAt(pos, n)) => { // pos/n in Source space; worldRoot converts to three space
    impactFx(pos, n, surface);
    let h = holes[holeNext];
    if (!h) { h = new THREE.Mesh(holeGeo); worldRoot.add(h); holes[holeNext] = h; }
    holeNext = (holeNext + 1) % 64;
    const kind = HOLE_OF[surface] ?? 'concrete';
    h.material = holeMats[kind][(Math.random() * 5) | 0]; h.scale.set(HOLE_SIZE[kind], HOLE_SIZE[kind], 1); h.visible = true;
    h.position.set(pos[0] + n[0] * 0.15, pos[1] + n[1] * 0.15, pos[2] + n[2] * 0.15);
    h.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), new THREE.Vector3(n[0], n[1], n[2]));
    h.rotateZ(Math.random() * 6.28);
  };

  // a new round wipes them; a broken window takes its holes with it (box: [min, max] in Source space)
  const clearHoles = (box) => { for (const h of holes) if (!box || h.position.toArray().every((v, k) => v >= box[0][k] && v <= box[1][k])) h.visible = false; };

  // ---------- state ----------
  const ammo = Object.fromEntries(ORDER.map((k) => [k, { mag: WEAPONS[k].mag, reserve: WEAPONS[k].reserve }]));
  const s = { cur: initial.weapon, last: 'knife', pin: null, throwing: null, planting: false, clickAt: 0, nextFire: 0, deployEnd: 0, reload: null, flashUntil: 0, burst: {}, burstLeft: 0, burstNext: 0, last: null, stats: { shots: 0, hits: 0, hs: 0, kills: 0 }, shots: 0, decayAt: 0, acc: 0.9, lastFire: -10, dir: 1, zoom: 0, punch: [0, 0], held: false, wasHeld: false, bob: 0, emptyClicked: false };
  const now = () => performance.now() / 1000;
  const def = () => WEAPONS[s.cur];

  const hudUpdate = () => {
    const d = def(), a = ammo[s.cur];
    hud.setAmmo(d.mag ? a.mag : null, d.mag ? a.reserve : null);
    hud.setScope(!!s.zoom);
  };
  const applySpeed = () => { player.maxSpeed = s.zoom ? 150 : def().speed; };
  const setZoom = (z) => { s.zoom = z; applySpeed(); hudUpdate(); };

  let owned = new Set(initial.owned); // the server owns the loadout (buy menu); we mirror it
  const showList = () => hud.showWeapons([...owned].map((k) => ({ key: k, slot: WEAPONS[k].slot, icon: WEAPONS[k].icon })).sort((a, b) => a.slot - b.slot), s.cur);
  const bySlot = (slot) => ORDER.find((k) => owned.has(k) && WEAPONS[k].slot === slot);
  function select(key) {
    if (key === s.cur || !WEAPONS[key] || !owned.has(key)) return;
    if (!vms[key]) { loadVm(key).then(() => select(key)); return; }
    net.send({ t: 'weapon', w: key });
    vms[s.cur].group.visible = false; s.last = s.cur; s.cur = key; vms[key].group.visible = true;
    playAct(key, 'ACT_VM_DRAW');
    stopPlant(); s.reload = null; s.pin = null; s.throwing = null; s.zoom = 0; s.resumeZoom = 0; s.burstLeft = 0; s.deployEnd = now() + def().deploy; s.nextFire = s.deployEnd; s.shots = 0; s.acc = def().accuracy.start ?? 0.9;
    applySpeed(); hudUpdate(); showList();
    if (def().sounds.deploy) play(def().sounds.deploy, 0.5);
  }
  vms[s.cur].group.visible = true; playAct(s.cur, 'ACT_VM_DRAW'); s.deployEnd = now() + def().deploy; applySpeed(); hudUpdate();
  // loadout pushed by the server after buys / respawns: new weapons come with full ammo, lost ones are dropped
  function setLoadout(list, current) {
    const next = new Set(list);
    let gained = false;
    for (const k of next) if (!owned.has(k)) { gained = true; ammo[k] = { mag: WEAPONS[k].mag, reserve: WEAPONS[k].reserve }; loadVm(k); }
    owned = next; if (gained) showList();
    if (!owned.has(s.cur)) select(current && owned.has(current) ? current : owned.has(s.last) ? s.last : bySlot(2) ?? 'knife');
    else if (gained && current && current !== s.cur && owned.has(current)) select(current); // a purchase / pickup switches to the new weapon
  }

  function startReload() {
    const d = def(), a = ammo[s.cur], t = now();
    if (!d.mag || s.reload || a.mag >= d.mag || a.reserve <= 0 || t < s.deployEnd) return;
    setZoom(0); s.resumeZoom = 0;
    if (d.shell) { s.reload = { shell: true, next: t + d.reload, end: 0 }; playAct(s.cur, 'ACT_SHOTGUN_RELOAD_START', 'ACT_VM_RELOAD'); return; }
    s.reload = { start: t, end: t + d.reload, played: 0 };
    playAct(s.cur, 'ACT_VM_RELOAD');
  }
  function finishReload() {
    const d = def(), a = ammo[s.cur], take = Math.min(d.mag - a.mag, a.reserve);
    a.mag += take; a.reserve -= take; s.reload = null; hudUpdate();
  }
  function shellReload(t, d, a) { // one shell per d.shell seconds, then the pump
    const r = s.reload;
    if (!r.end && t >= r.next) {
      a.mag++; a.reserve--; hudUpdate(); play(d.sounds.shellSound, 0.6); r.next = t + d.shell;
      if (a.mag >= d.mag || a.reserve <= 0) { r.end = t + d.shell; playAct(s.cur, 'ACT_SHOTGUN_RELOAD_FINISH', 'ACT_VM_IDLE'); } else playAct(s.cur, 'ACT_VM_RELOAD');
    } else if (r.end && t >= r.end) { s.reload = null; if (d.sounds.pump) play(d.sounds.pump, 0.6); }
  }

  const viewDir = (yaw, pitch) => { const cp = Math.cos(pitch); return [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)]; };
  const rayTo = (from, dir, dist) => {
    const r = trace(world, from, [from[0] + dir[0] * dist, from[1] + dir[1] * dist, from[2] + dir[2] * dist], [0, 0, 0], [0, 0, 0], bulletLimit);
    return r.normal && !r.startSolid ? { pos: r.end, n: r.normal } : null;
  };
  // one bullet: follows the wall-bang path, leaves a hole at every surface it meets, stops at the first body (the server re-checks the damage)
  // the hit report: the ray and the server tick we were looking at let the server rewind the target and check it (lag compensation)
  const hitMsg = (body, eye, dir, extra) => ({ t: 'hit', target: body.bot.id, group: body.group, bone: body.bone, w: s.cur, o: eye.map((v) => Math.round(v * 10) / 10), d: dir.map((v) => Math.round(v * 1e4) / 1e4), rt: targets().renderTick(), ...extra });
  function shootRay(eye, dir, d, hits) { // returns where the bullet first stopped or hit (others draw the tracer to it)
    let first = null, walls = 0;
    for (const seg of march(ctx, eye, dir, 8192, d).segments) {
      const body = targets()?.hitTest(seg.from, dir, seg.len);
      if (body) {
        targets().feedback(body, seg.from, dir); hits.push(hitMsg(body, eye, dir));
        s.last = { dist: Math.round(seg.start + body.dist), walls, group: body.group };
        return first ?? seg.from.map((v, i) => v + dir[i] * body.dist);
      }
      if (seg.impact) {
        addHole(seg.impact.pos, seg.impact.n, seg.impact.surface); first ??= seg.impact.pos;
        if (seg.impact.exit) { addHole(seg.impact.exit.pos, seg.impact.exit.n, seg.impact.surface); walls++; }
      } else first ??= seg.from.map((v, i) => v + dir[i] * seg.len);
    }
    s.last = { dist: first ? Math.round(Math.hypot(first[0] - eye[0], first[1] - eye[1], first[2] - eye[2])) : 8192, walls, group: null };
    return first;
  }

  // ---- CS:S accuracy / spread (m_flAccuracy) ----
  // accuracy for the next shot; `t` is the shot time, shots = m_iShotsFired *including* that shot
  const accuracyAt = (d, shots, t) => {
    const a = d.accuracy;
    if (a.kind === 'shots') return Math.min(a.max, Math.pow(shots, a.pow) / a.div + a.base);
    if (a.kind === 'time') return Math.min(a.max, Math.max(a.min, s.acc - (a.window - (t - s.lastFire)) * a.rate));
    return 1;
  };
  // cone size in tan units for the current movement state
  function spreadAt(d, acc) {
    const sp = d.spread, term = sp.term === 'inv' ? 1 - acc : acc, speed = Math.hypot(player.v[0], player.v[1]);
    const val = ([c, k]) => c + k * term;
    let v;
    if (!player.onGround) v = sp.jumpApex && s.zoom && Math.abs(player.v[2]) < 30 ? val(sp.stand) : val(sp.air); // Scout jump-shot at the top of the jump
    else if (speed > sp.moveSpeed) v = val(sp.move);
    else if (sp.slow && speed > sp.slowSpeed) v = val(sp.slow);
    else if (sp.duck && player.ducked) v = val(sp.duck);
    else v = val(sp.stand);
    if (sp.unscoped && !s.zoom) v += sp.unscoped;
    return v;
  }
  const crosshairDeg = () => { const d = def(); if (d.melee) return 0; const t = now(); return (Math.atan(spreadAt(d, accuracyAt(d, d.accuracy.kind === 'shots' ? Math.max(s.shots, 0) : 0, t))) * 180) / Math.PI; };

  // CWeaponCSBase::KickBack: up kick grows with shots fired, lateral kick flips direction at random
  function kickBack(k) { // the fixed spray pattern: where the view is after this shot, scaled for the current stance
    const moving = Math.hypot(player.v[0], player.v[1]) > 5, air = !player.onGround; // CS:S tests these in this order
    const r = k.airFirst ? (air ? k.air : moving ? k.move : player.ducked ? k.duck : k.stand) : (moving ? k.move : air ? k.air : player.ducked ? k.duck : k.stand);
    const [up, yaw] = k.pts[Math.min(s.shots - 1, k.pts.length - 1)];
    s.punch = [up * (r.upMax / k.stand.upMax), yaw * (r.latMax / k.stand.latMax)];
  }

  const tri = () => Math.random() - 0.5 + (Math.random() - 0.5); // FX_FireBullets: sum of two uniforms

  function fire(alt = false, burstShot = false) {
    const d = def(), a = ammo[s.cur], t = now(), eye = player.eye;
    // exact cadence while the trigger stays down (CS: m_flNextPrimaryAttack += cycle), not frame-quantised; a fresh click starts a new
    // rhythm from now, otherwise the time since the last burst would be "caught up" as 2-3 extra bullets in one frame
    if (!burstShot) s.nextFire = (s.wasHeld && t - s.nextFire < 0.3 ? s.nextFire : t) + d.cycle;
    if (d.melee) { // knife
      if (alt) s.nextFire = t + d.stabCycle; // the stab is slower than the slash
      const range = alt ? d.stabRange : d.melee, dir = viewDir(player.yaw + s.punch[1] * rad, player.pitch + s.punch[0] * rad), hit = rayTo(eye, dir, range);
      const body = targets()?.hitTest(eye, dir, range);
      if (body) { targets().feedback(body, eye, dir); net.send(hitMsg(body, eye, dir, { alt: alt ? 1 : 0 })); }
      else if (hit) { addHole(hit.pos, hit.n); play(d.sounds.hitWall, 0.7); } else play(d.sounds.fire, 0.6);
      const slashes = alt ? findSeqs(vms[s.cur], 'ACT_VM_SECONDARYATTACK').concat(vms[s.cur].seqs.filter((q) => /stab/i.test(q.name))) : findSeqs(vms[s.cur], 'ACT_VM_HITCENTER').filter((q) => /slash/.test(q.name));
      if (slashes.length) vms[s.cur].anim = { seq: slashes[Math.floor(Math.random() * slashes.length)], start: t };
      return;
    }
    const burst = d.burst && s.burst[s.cur];
    if (burst && !burstShot) { s.burstLeft = d.burst.n - 1; s.burstNext = t + d.burst.gap; s.nextFire = t + d.burst.cycle; } // the other rounds follow on their own
    a.mag--; hudUpdate();
    s.shots++;
    const acc = accuracyAt(d, s.shots, t); s.acc = acc; s.lastFire = t;
    const spread = spreadAt(d, acc) * (burst ? d.burst.spread : 1), hits = [];
    // aim = view angles + current punch; then the triangular spread offset along right/up (FX_FireBullets)
    const ay = player.yaw + s.punch[1] * rad, ap = player.pitch + s.punch[0] * rad, fwd = viewDir(ay, ap);
    const right = [Math.sin(ay), -Math.cos(ay), 0], up = [-Math.sin(ap) * Math.cos(ay), -Math.sin(ap) * Math.sin(ay), Math.cos(ap)];
    for (let i = 0; i < (d.pellets ?? 1); i++) {
      const x = tri() * spread, y = tri() * spread; // each shotgun pellet gets its own offset
      let dir = [fwd[0] + right[0] * x + up[0] * y, fwd[1] + right[1] * x + up[1] * y, fwd[2] + right[2] * x + up[2] * y]; const dl = Math.hypot(...dir); dir = dir.map((v) => v / dl);
      const end = shootRay(eye, dir, d, hits); s.lastEnd = i === 0 ? end : s.lastEnd;
    }
    if (d.recoil.type === 'kickback') kickBack(d.recoil); else if (d.recoil.type === 'punch') s.punch[0] += d.recoil.pitch;
    s.flashUntil = t + 0.06; s.flashRoll = null;
    playAct(s.cur, a.mag === 0 ? 'ACT_VM_DRYFIRE' : 'ACT_VM_PRIMARYATTACK', 'ACT_VM_PRIMARYATTACK');
    net.send({ t: 'fire', w: s.cur, to: s.lastEnd?.map((v) => Math.round(v)) }); // others hear the shot and see its tracer
    for (const h of hits) net.send(h); // after the shot: the server only accepts hits from shots it has seen
    s.stats.shots++; if (hits.length) { s.stats.hits++; if (hits.some((h) => h.group === 1)) s.stats.hs++; }
    play(d.sounds.fire, 0.75);
    if (d.scope && d.sounds.bolt) { s.resumeZoom = s.zoom; setZoom(0); } // AWP / Scout: unscoped while the bolt is worked, then back in (CS:S m_bResumeZoom); auto-snipers stay scoped
    if (d.sounds.bolt && a.mag > 0) setTimeout(() => play(d.sounds.bolt[1], 0.5), d.sounds.bolt[0] * 1000);
  }

  function startPin(button) { // grenade: hold to keep the pin pulled, release to throw (LMB = full throw, RMB = lob)
    s.pin = { button, power: button === 0 ? 1 : 0.45, started: now() };
    playAct(s.cur, s.cur === 'molotov' ? 'ACT_VM_LIGHT' : 'ACT_VM_PULLPIN');
    if (def().sounds.pin) play(def().sounds.pin, 0.5);
  }
  function release() {
    const pin = s.pin, delay = s.cur === 'molotov' ? LIGHT_TIME - (now() - pin.started) : 0;
    if (delay > 0) {
      if (!pin.queued) {
        pin.queued = true;
        setTimeout(() => { if (s.pin === pin && alive() && document.pointerLockElement) finishThrow(); }, delay * 1000);
      }
      return;
    }
    finishThrow();
  }
  function finishThrow() {
    const key = s.cur, power = s.pin.power;
    s.pin = null; const pendingThrow = s.throwing = { end: now() + 0.7 };
    playAct(key, 'ACT_VM_THROW');
    setTimeout(() => { if (s.throwing === pendingThrow && alive()) net.send({ t: 'throw', w: key, power }); }, 220); // cancelled if the player dies or switches weapons
  }

  // ---------- input ----------
  // C4: hold the trigger inside a bombsite to plant (the server times it and roots you in place); G drops it
  function stopPlant() { if (!s.planting) return; s.planting = false; net.send({ t: 'plant', on: false }); if (vms[s.cur]) playAct(s.cur, 'ACT_VM_IDLE'); }
  addEventListener('mousedown', (e) => {
    if (!document.pointerLockElement || uiOpen() || !alive()) return; // dead / spectating: clicks pick who to watch, they don't shoot
    audio();
    if (def().c4) { if (e.button === 0 && now() >= s.deployEnd && !s.planting) { s.planting = true; s.clickAt = now(); net.send({ t: 'plant', on: true }); playAct(s.cur, 'ACT_VM_PRIMARYATTACK'); } return; }
    if (def().grenade) { if ((e.button === 0 || e.button === 2) && !s.pin && !s.throwing && now() >= s.deployEnd) startPin(e.button); return; }
    if (e.button === 0) { s.held = true; trigger(now()); } // shoot on the click, not on the next frame
    if (e.button === 2 && def().melee && now() >= s.nextFire && now() >= s.deployEnd) { fire(true); return; } // knife: right click stabs
    if (e.button === 2 && def().burst && !s.reload) { // CS:S: right click switches the Glock / FAMAS to three-round bursts and back
      const on = (s.burst[s.cur] = !s.burst[s.cur]); hud.notice(on ? 'Switched to Burst-Fire mode' : def().auto ? 'Switched to automatic' : 'Switched to semi-automatic'); return;
    }
    if (e.button === 2) { const d = def(); if (d.scope && !s.reload && now() >= s.deployEnd) { if (s.resumeZoom) { s.resumeZoom = 0; return; } setZoom(s.zoom === 0 ? 1 : s.zoom === 1 ? 2 : 0); play('zoom', 0.5); } } // right click during the bolt: stay unscoped
  });
  addEventListener('mouseup', (e) => {
    if (e.button === 0) { s.held = false; stopPlant(); }
    if (s.pin && e.button === s.pin.button) release();
  });
  document.addEventListener('pointerlockchange', () => { s.held = false; stopPlant(); if (s.pin) { s.pin = null; playAct(s.cur, 'ACT_VM_IDLE'); } });
  addEventListener('contextmenu', (e) => e.preventDefault());
  addEventListener('keydown', (e) => {
    if (!alive() || e.repeat || uiOpen()) return;
    const n = Number(e.code.match(/^Digit([1-7])$/)?.[1] ?? 0);
    if (n === 4) { // cycle: the next owned grenade after the current one (the first when none is out)
      const mine = GRENADES.filter((k) => owned.has(k)), i = mine.indexOf(s.cur);
      if (mine.length) select(mine[(i + 1) % mine.length]);
    } else if (n) { const k = n <= 3 ? bySlot(n) : n === 5 ? 'c4' : n === 6 ? 'smokegrenade' : GRENADES.find((g) => owned.has(g) && WEAPONS[g].grenade === 'fire'); if (k && owned.has(k)) select(k); } // 6 = smoke, 7 = incendiary
    else if (is('lastweapon', e.code)) select(s.last);
    else if (is('reload', e.code)) startReload();
    else if (is('drop', e.code) && (s.cur === 'c4' || def().slot === 1 || def().slot === 2)) { stopPlant(); net.send({ t: 'drop' }); }
  });

  // The firing decision: called on the mouse click itself (no waiting for the next frame) and every frame. Several shots may be due in
  // one call when the frame rate is lower than the fire rate, so the gun keeps its exact rhythm at any fps.
  function trigger(t) {
    const d = def(), a = ammo[s.cur];
    if (d.grenade || d.c4) { s.wasHeld = s.held; return; }
    while (s.burstLeft > 0 && t >= s.burstNext) { if (a.mag <= 0) { s.burstLeft = 0; break; } s.burstLeft--; s.burstNext += d.burst.gap; fire(false, true); }
    for (let n = 0; n < 3 && s.held && (d.auto || !s.wasHeld) && !s.reload && t >= s.nextFire; n++) { // semi-auto needs a fresh click
      if (d.mag && a.mag <= 0) { if (!s.emptyClicked) { play(d.sounds.empty, 0.5); s.emptyClicked = true; } if (a.reserve > 0) startReload(); break; }
      s.emptyClicked = false; fire();
      s.wasHeld = true;
    }
    if (!s.held) s.emptyClicked = false;
    s.wasHeld = s.held;
  }

  function showFlash(key, t, until, zoom) {
    const mz = poseViewModel(key, t);
    if (t < until && !zoom && mz) {
      flash.position.copy(mz).applyMatrix4(vms[key].group.matrix).add(holder.position);
      if (!s.flashRoll) { s.flashRoll = [Math.random() * 6.28, Math.random() * 6.28, 0.7 + Math.random() * 0.5]; } // fixed for the whole flash so it doesn't strobe
      flash.rotation.z = s.flashRoll[0]; flash.scale.setScalar(s.flashRoll[2]); flash.visible = true;
      flashStar.position.copy(flash.position); flashStar.rotation.z = s.flashRoll[1]; flashStar.scale.setScalar(s.flashRoll[2]); flashStar.visible = true;
    } else { flash.visible = flashStar.visible = false; s.flashRoll = null; }
  }
  function setSpectate(wKey, dt = 0, speed = 0) {
    if (!wKey || !WEAPONS[wKey]) {
      if (s.specCur) {
        if (vms[s.specCur]) vms[s.specCur].group.visible = false;
        if (vms[s.cur]) vms[s.cur].group.visible = true;
        s.specCur = null; s.specFlashUntil = 0; flash.visible = flashStar.visible = false;
      }
      return;
    }
    if (s.zoom) setZoom(0);
    if (!vms[wKey]) { loadVm(wKey); holder.visible = false; return; }
    if (s.specCur !== wKey) {
      if (s.specCur && vms[s.specCur]) vms[s.specCur].group.visible = false;
      if (vms[s.cur]) vms[s.cur].group.visible = false;
      s.specCur = wKey; vms[wKey].group.visible = true; playAct(wKey, 'ACT_VM_DRAW');
    }
    const sp = speed / 250;
    s.bob += dt * sp * 9.5;
    holder.position.set(Math.sin(s.bob) * 0.1 * Math.min(sp, 1.2), Math.sin(s.bob * 2) * 0.08 * Math.min(sp, 1.2), 0);
    holder.visible = true;
    showFlash(wKey, now(), s.specFlashUntil ?? 0, false);
  }
  function spectatorFire(wKey) {
    const key = wKey ?? s.specCur;
    if (!key || !vms[key]) return;
    playAct(key, 'ACT_VM_PRIMARYATTACK');
    if (!WEAPONS[key]?.melee && !WEAPONS[key]?.grenade) { s.specFlashUntil = now() + 0.06; s.flashRoll = null; }
  }

  // ---------- per-frame ----------
  function update(dt) {
    if (s.specCur) setSpectate(null);
    const t = now(), d = def(), a = ammo[s.cur];
    // view punch decay (Source DecayPunchAngle, sped up 4x so the aim snaps back to the starting point quickly)
    const len = Math.hypot(s.punch[0], s.punch[1]); // the view holds its pattern position while firing and recovers afterwards
    if (len > 0 && t > s.lastFire + (d.cycle ?? 0.1) + 0.05) { const nl = Math.max(len - (40 + len * 4) * dt, 0); s.punch = [s.punch[0] * (nl / len), s.punch[1] * (nl / len)]; }
    // m_iShotsFired winds back one step per 22 ms, starting 0.4 s after the last shot, while the trigger is up
    if (!s.held && s.wasHeld && s.shots > 0) { s.shots = d.accuracy.kind === 'shots' ? Math.min(s.shots, 15) : 0; s.decayAt = t + 0.4; }
    if (!s.held && s.shots > 0 && t > s.decayAt) { // catch up if the frame was long
      const steps = Math.min(s.shots, Math.floor((t - s.decayAt) / 0.0225) + 1);
      s.shots -= steps; s.decayAt += steps * 0.0225;
    }
    stepFx(dt); stepShards(dt);
    hud.setSpread(Math.tan((crosshairDeg() * Math.PI) / 180), fov(73.74)); // fov(): the zoom-aware vertical fov (73.74 = CS:S 90 at 4:3)

    if (uiOpen()) s.held = false;
    if (s.throwing && t >= s.throwing.end) { // next grenade of the same kind comes up, if any are left
      s.throwing = null;
      if (owned.has(s.cur)) { playAct(s.cur, 'ACT_VM_DRAW'); s.deployEnd = t + 0.8; }
    }
    if (s.reload?.shell) { if (s.held && a.mag > 0 && !s.reload.end) s.reload = null; else shellReload(t, d, a); } // pulling the trigger interrupts the loading
    else if (s.reload) {
      const el = t - s.reload.start;
      for (let i = s.reload.played; i < (d.sounds.reload?.length ?? 0); i++) if (el >= d.sounds.reload[i][0]) { play(d.sounds.reload[i][1], 0.6); s.reload.played = i + 1; }
      if (t >= s.reload.end) finishReload();
    }
    if (s.planting && t - s.clickAt > 0.42) { play(d.sounds.click, 0.6); s.clickAt = t; } // typing the code
    if (s.resumeZoom && t >= s.nextFire && !s.reload) { setZoom(s.resumeZoom); s.resumeZoom = 0; }
    trigger(t);

    // ---------- view model: baked animation + a little walk bob ----------
    const sp = Math.hypot(player.v[0], player.v[1]) / 250;
    s.bob += dt * (player.onGround ? sp : 0) * 9.5;
    const bobAmt = player.onGround ? Math.min(sp, 1.2) : 0;
    const dyaw = ((player.yaw - (s.lastYaw ?? player.yaw) + Math.PI * 3) % (Math.PI * 2)) - Math.PI, dpitch = player.pitch - (s.lastPitch ?? player.pitch);
    s.lastYaw = player.yaw; s.lastPitch = player.pitch;
    const k = dt > 0 ? Math.min(1, dt * 14) : 0, lim = (v) => Math.max(-0.7, Math.min(0.7, v));
    s.swayX = (s.swayX ?? 0) + (lim(dt > 0 ? (dyaw / dt) * 0.05 : 0) - (s.swayX ?? 0)) * k;   // turning right: the gun trails left
    s.swayY = (s.swayY ?? 0) + (lim(dt > 0 ? (-dpitch / dt) * 0.04 : 0) - (s.swayY ?? 0)) * k; // looking up: it trails down
    holder.position.set(Math.sin(s.bob) * 0.12 * bobAmt + s.swayX, Math.sin(s.bob * 2) * 0.1 * bobAmt + s.swayY, 0);
    holder.visible = !s.zoom;
    showFlash(s.cur, t, s.flashUntil, s.zoom);
  }

  function render(aspect) {
    camera.fov = (2 * Math.atan(Math.tan((VM_FOV * rad) / 2) * 0.75)) / rad; camera.aspect = aspect; camera.updateProjectionMatrix();
    renderer.clearDepth(); renderer.render(scene, camera);
  }
  // vertical fov for the current zoom level (scope values are horizontal degrees at 4:3, like the weapon scripts)
  const fov = (normal) => (s.zoom ? (2 * Math.atan(Math.tan((def().scope[s.zoom - 1] * rad) / 2) * 0.75)) / rad : normal);

  const debug = () => {
    const d = def(), speed = Math.hypot(player.v[0], player.v[1]);
    const stance = !player.onGround ? 'air' : speed > (d.spread?.moveSpeed ?? 140) ? 'moving' : player.ducked ? 'crouched' : speed > 5 ? 'slow' : 'standing';
    return { weapon: s.cur, shots: s.shots, acc: s.acc, spread: crosshairDeg(), punch: s.punch, stance, speed, velMod: player.velMod, burst: !!s.burst[s.cur], last: s.last, stats: s.stats };
  };
  function refill() { // new round: every gun loaded, full reserve (CS:S restocks survivors at round start)
    for (const k of owned) ammo[k] = { mag: WEAPONS[k].mag, reserve: WEAPONS[k].reserve };
    s.reload = null; s.pin = null; s.throwing = null; s.emptyClicked = false; hudUpdate();
  }
  return { debug, update, render, setSpectate, spectatorFire, punch: () => s.punch, fov, select, setLoadout, refill, state: s, ammo, holes, addHole, clearHoles, shatter, owned: () => owned };
}
