import * as THREE from 'three';
import { Player, TICK, makeWorld, trace } from './physics.js';
import { createWeapons } from './weapons.js';
import { createPlayers } from './players.js';
import { play, playAt, setListener, preload, setOcclusion, setVolumes } from './audio.js';
import { WEAPONS } from './weapon-defs.js';
import { createHud } from './hud.js';
import { connectToServer } from './net.js';
import { createBuyMenu } from './buy.js';
import { createTeamMenu } from './team.js';
import { createGrenades } from './grenades.js';
import { createBombs } from './bomb.js';
import { createDevPanel } from './devpanel.js';
import { createScoreboard } from './scoreboard.js';
import { createMainMenu, loadSettings } from './menu.js';
import { binds, is } from './binds.js';
import { createMovers } from './movers.js';
import { createAmbience } from './ambience.js';

const q = new URLSearchParams(location.search);
const MAP_NAME = /^[a-z0-9_]+$/.test(window.__map ?? '') ? window.__map : 'de_dust2'; // the server's map (server.config.json): public/maps/<name>/; also picks the map's agents (agents.js)
document.title = 'CS:S Web - ' + MAP_NAME;
// loading screen: staged progress, hidden once every texture has reached the GPU
const loadingEl = document.getElementById('loading');
const setLoad = (pct) => { document.getElementById('loadfill').style.width = pct + '%'; }; // the loading screen is just the agent and this bar
setLoad(5, 'Loading map...');
const gain = Number(q.get('gain') ?? 1.0); // lightmap overbright, tweak with ?gain=
const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace; // Source's pipeline is gamma-space; keep all math raw
const pixelRatio = (scale) => Math.min(devicePixelRatio, 2) * scale; // Options > Video > Render scale: fewer pixels for weaker GPUs
renderer.setPixelRatio(pixelRatio(loadSettings().renderScale));
renderer.autoClear = false; // two passes: 3D skybox, then the world
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene(), skyScene = new THREE.Scene();
const FOV = 73.74; // CS:S fov 90 @4:3 -> 73.74 vertical (Hor+)
const camera = new THREE.PerspectiveCamera(FOV, 1, 2, 20000), skyCamera = new THREE.PerspectiveCamera(FOV, 1, 1, 200000);
const resize = () => {
  renderer.setSize(innerWidth, innerHeight);
  for (const c of [camera, skyCamera]) { c.aspect = innerWidth / innerHeight; c.updateProjectionMatrix(); }
};
addEventListener('resize', resize); resize();

// ---------- assets ----------
const base = `maps/${MAP_NAME}/`;
const [world, bin, lmTex] = await Promise.all([ // map geometry + lightmap
  fetch(base + 'world.json').then((r) => r.json()),
  fetch(base + 'world.bin').then((r) => r.arrayBuffer()),
  new THREE.TextureLoader().loadAsync(base + 'lightmap.png'),
]);
lmTex.colorSpace = THREE.NoColorSpace; lmTex.flipY = false; lmTex.generateMipmaps = false; lmTex.minFilter = THREE.LinearFilter;
renderer.initTexture(lmTex);
const white = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1); white.needsUpdate = true;
const loader = new THREE.TextureLoader();
const texCache = new Map();
let texPending = 0, texDone = 0;
const TEX_LOW = loadSettings().texLow;
const loadTex = (file, apply) => { // file = URL relative to the page; shared per file; uploaded to the GPU on load so turning around never stalls a frame
  if (!texCache.has(file)) {
    const waiting = [apply];
    texCache.set(file, waiting); texPending++;
    loader.load(file, (t) => {
      if (TEX_LOW && t.image.width > 64) { // Options > Video > Low texture quality: half size each way, a quarter of the video memory
        const c = document.createElement('canvas'); c.width = t.image.width >> 1; c.height = t.image.height >> 1;
        c.getContext('2d').drawImage(t.image, 0, 0, c.width, c.height); t.image = c;
      }
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.flipY = false; t.colorSpace = THREE.NoColorSpace; t.anisotropy = TEX_LOW ? 1 : 8;
      renderer.initTexture(t); texCache.set(file, t); waiting.forEach((fn) => fn(t)); texDone++;
    });
  } else if (Array.isArray(texCache.get(file))) texCache.get(file).push(apply);
  else apply(texCache.get(file));
};

// Source linear fog by view depth: f = clamp((depth - start) / (end - start), 0, maxDensity); applied in gamma space like the engine.
export const FOG_GLSL = `
  uniform vec3 fogColor; uniform vec3 fogRange; varying float vDepth;
  vec3 applyFog(vec3 c) { return fogRange.y > fogRange.x ? mix(c, fogColor, clamp((vDepth - fogRange.x) / (fogRange.y - fogRange.x), 0.0, fogRange.z)) : c; }`;
const worldVS = `
  attribute vec2 lmuv; varying vec2 vUv; varying vec2 vLm; varying float vDepth; varying vec3 vWorld;
  void main() { vUv = uv; vLm = lmuv; vWorld = (modelMatrix * vec4(position, 1.0)).xyz; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`;
const worldFS = `
  uniform sampler2D map; uniform sampler2D lm; uniform float gain, cutoff, opacity; varying vec2 vUv; varying vec2 vLm; varying vec3 vWorld; ${FOG_GLSL}
  #ifdef ENV
  uniform samplerCube envMap; uniform vec3 envTint;
  #endif
  void main() {
    vec4 t = texture2D(map, vUv); if (t.a < cutoff) discard;
    vec3 c = t.rgb * max(texture2D(lm, vLm).rgb * 2.0, vec3(0.42)) * gain; // x2: mat_overbright
    #ifdef ENV
    // Source's $envmap on glass: the sky mirrored in it, stronger at grazing angles (face normal from the screen-space derivatives)
    vec3 v = normalize(vWorld - cameraPosition), n = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (dot(n, v) > 0.0) n = -n;
    c += envTint * textureCube(envMap, reflect(v, n)).rgb * (0.25 + 0.75 * pow(1.0 - max(dot(-v, n), 0.0), 3.0)) * 0.8;
    #endif
    gl_FragColor = vec4(applyFog(c), t.a * opacity);
  }`;
// Props carry baked per-vertex lighting (leaf ambient cube + sun, encoded exactly like the lightmaps), so the same x2 overbright applies.
const propVS = `
  attribute vec3 col; varying vec2 vUv; varying vec3 vCol; varying float vDepth;
  void main() { vUv = uv; vCol = col; vec4 mv = modelViewMatrix * vec4(position, 1.0); vDepth = -mv.z; gl_Position = projectionMatrix * mv; }`;
const propFS = `
  uniform sampler2D map; uniform float gain, cutoff; varying vec2 vUv; varying vec3 vCol; ${FOG_GLSL}
  void main() { vec4 t = texture2D(map, vUv); if (t.a < cutoff) discard; gl_FragColor = vec4(applyFog(t.rgb * max(vCol * 2.0, vec3(0.42)) * gain), t.a); }`;
const fogUniforms = (f) => ({ fogColor: { value: new THREE.Color(...(f?.color ?? [0, 0, 0])) }, fogRange: { value: new THREE.Vector3(f?.start ?? 0, f?.end ?? 0, f?.max ?? 1) } });
const worldFog = fogUniforms(world.fog), skyFog = fogUniforms(world.skyFog);

const skyCube = { value: null }; // the sky cube map, mirrored in glass (set once the sky is loaded)
function addGroups(root, groups, kind, fog = worldFog, opacity = 1) { // opacity: the entity's renderamt (translucent panes)
  for (const g of groups) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, g.pos, g.count * 3), 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bin, g.uv, g.count * 2), 2));
    const isProp = kind === 'prop';
    if (isProp) geo.setAttribute('col', new THREE.BufferAttribute(new Float32Array(bin, g.col, g.count * 3), 3));
    else geo.setAttribute('lmuv', new THREE.BufferAttribute(new Float32Array(bin, g.lm, g.count * 2), 2));
    const env = !isProp && g.env;
    const mat = new THREE.ShaderMaterial({
      defines: env ? { ENV: 1 } : {},
      uniforms: { map: { value: white }, lm: { value: lmTex }, gain: { value: gain }, cutoff: { value: g.alpha === 1 ? 0.5 : 0 }, opacity: { value: opacity }, ...fog, ...(env ? { envMap: skyCube, envTint: { value: new THREE.Vector3(...g.env) } } : {}) },
      vertexShader: isProp ? propVS : worldVS, fragmentShader: isProp ? propFS : worldFS,
      transparent: g.alpha === 2 || opacity < 1, depthWrite: opacity === 1, side: isProp || q.has('dbl') ? THREE.DoubleSide : THREE.FrontSide, // model windings are not trusted
    });
    if (g.tex) loadTex(base + 'tex/' + g.tex, (t) => { mat.uniforms.map.value = t; });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false; // few big meshes covering the whole map; culling per material group isn't worth it
    root.add(mesh);
  }
}
const worldRoot = new THREE.Group(); worldRoot.rotation.x = -Math.PI / 2; scene.add(worldRoot); // Source z-up -> three y-up
addGroups(worldRoot, world.groups, 'world'); if (!q.has('noprops')) addGroups(worldRoot, world.props, 'prop');

// 3D skybox: distant scenery built at 1/scale around sky_camera, drawn behind the world from a scaled camera.
const sky = world.sky;
if (sky) {
  const skyRoot = new THREE.Group(); skyRoot.rotation.x = -Math.PI / 2; skyScene.add(skyRoot);
  addGroups(skyRoot, sky.groups, 'world', skyFog); addGroups(skyRoot, sky.props, 'prop', skyFog);
}
// Source sky faces: ft=+x bk=-x lf=+y rt=-y up=+z dn=-z; with (x,y,z)->(x,z,-y) cube order px,nx,py,ny,pz,nz = ft,bk,up,dn,rt,lf.
skyScene.background = new THREE.CubeTextureLoader().setPath(base + 'sky/').load(['ft', 'bk', 'up', 'dn', 'rt', 'lf'].map((f) => f + '.png'));
skyScene.background.colorSpace = THREE.NoColorSpace;
skyCube.value = skyScene.background;

// ---------- player ----------
// Player collision = solids + grates + player-clips (the latter are listed last); bullets ignore everything from bulletLimit on.
const playerWorld = makeWorld(world.collision.concat(world.playerOnly ?? []));
const player = new Player(playerWorld);
// Doors and breakable glass: their collision follows the server's state (so prediction matches), their meshes turn / slide / vanish with it
const movers = createMovers(playerWorld, world.movers);
const moverViews = movers.defs.map((d) => {
  const outer = new THREE.Group(), inner = new THREE.Group();
  outer.position.set(...d.pivot); inner.position.set(-d.pivot[0], -d.pivot[1], -d.pivot[2]); // turn about the hinge
  outer.add(inner); worldRoot.add(outer);
  addGroups(inner, d.groups, 'world', worldFog, d.opacity ?? 1); addGroups(inner, d.props, 'prop');
  return outer;
});
movers.defs.forEach((d, i) => { if (d.parent >= 0) moverViews[d.parent].children[0].add(moverViews[i]); }); // glass in a door turns with it
const clearPane = (i) => { // the holes and blood on a pane go with it
  const pts = movers.defs[i]?.pieces.flatMap((p) => p.pts) ?? [], box = [0, 1].map((hi) => [0, 1, 2].map((k) => (hi ? Math.max : Math.min)(...pts.map((p) => p[k])) + (hi ? 2 : -2)));
  if (pts.length) { weapons?.clearHoles(box); players?.clearDecals(box); weapons?.shatter(box, movers.defs[i].glass); }
};
function setMover(i, v) {
  if (movers.state[i] === v) return;
  movers.apply(i, v);
  const d = movers.defs[i], view = moverViews[i];
  if (d.breakable) view.visible = !v;
  else if (d.slide) view.position.set(d.pivot[0] + d.slide[0] * v, d.pivot[1] + d.slide[1] * v, d.pivot[2] + d.slide[2] * v);
  else view.rotation.z = (v * Math.PI) / 180;
}
// Own movement is predicted locally with the same code the server runs, then reconciled against each snapshot (see onSnap).
const PLAYER_FIELDS = ['onGround', 'ducked', 'ducking', 'ducktime', 'stamina', 'oldJump', 'oldDuck', 'eyeZ', 'velMod'];
let you = { team: 'ct', money: 800, armor: 0, hp: 100, alive: 1, owned: ['knife', 'usp'], weapon: 'usp' };
let roundState = { phase: 'freeze', alive: { ct: 5, t: 5 }, scores: { ct: 0, t: 0 }, number: 1, left: 5 };
const applyServerState = (y) => { player.o = [...y.o]; player.v = [...y.v]; for (const f of PLAYER_FIELDS) player[f] = y[f]; };
if (q.get('pos')) { // debug: ?pos=x,y,z&yaw=deg&pitch=deg&freeze (only meaningful with ?freeze, otherwise the server wins)
  player.o = q.get('pos').split(',').map(Number);
  player.yaw = (Number(q.get('yaw') ?? 0) * Math.PI) / 180; player.pitch = (Number(q.get('pitch') ?? 0) * Math.PI) / 180;
  player.prev = { o: [...player.o], eyeZ: 64 };
}

setLoad(45, 'Loading weapons...');
setLoad(30, 'Connecting to the game server...');
const hud = createHud({ player, overview: { ...(world.overview ?? { pos_x: 0, pos_y: 0, scale: 8 }), src: base + 'overview.png' }, getBots: () => players?.bots ?? [], getTeam: () => you.team, getBomb: () => lastBomb });
const pending = []; // usercmds the server has not acknowledged yet: { cmd, o } (o = our predicted position after the cmd)
const hurtEl = document.getElementById('hurt');
let lastBomb = null, bombs = null, defuseHeld = false;
const plantBeeps = new Map(); // planter id -> interval of the arming beeps
let deadAt = 0, killedBy = '', specIdx = 0; // local death: death cam on our body, then spectating teammates
let seq = 0, snapEvents = [], buyMenu = null, teamMenu = null, grenades = null, roster = [], flashUntil = 0, flashDur = 1, players = null, weapons = null; // players/weapons exist only after their assets load; snapshots can arrive earlier
const WIN_TEXT = { ct: 'Counter-Terrorists Win!', t: 'Terrorists Win!' };
const surfaceSound = (surface) => `player/footsteps/${surface}${1 + Math.floor(Math.random() * 4)}`;
// walls between the listener and a sound (audio.js grades occlusion by them): up to 3 surfaces along the straight line. If that line is
// blocked but a path just beside the source is open (a corner, a door frame), it counts as half a wall, so sound around corners stays readable.
const NOBOX = [0, 0, 0], solidAt = (p) => trace(playerWorld, p, p, NOBOX, NOBOX, world.collision.length).startSolid;
function lineWalls(a, b) {
  const len = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) || 1, u = [0, 1, 2].map((k) => (b[k] - a[k]) / len);
  let walls = 0, from = a;
  while (walls < 3) {
    const r = trace(playerWorld, from, b, NOBOX, NOBOX, world.collision.length);
    if (r.fraction >= 1 && !r.startSolid) break;
    walls++;
    let p = r.end, k = 0; // through the wall: step on until out of the solid (thick walls count once, up to 128 units)
    do { p = p.map((v, i) => v + u[i] * 16); } while (++k < 8 && solidAt(p));
    if ((b[0] - p[0]) * u[0] + (b[1] - p[1]) * u[1] + (b[2] - p[2]) * u[2] <= 0) break; // stepped past the sound
    from = p;
  }
  return walls;
}
const ambience = createAmbience({ ambience: world.ambience, visible: (a, b) => trace(playerWorld, a, b, NOBOX, NOBOX, world.collision.length).fraction > 0.99 });
setOcclusion((ear, pos) => {
  const src = [pos[0], pos[1], pos[2] + 24], w = lineWalls(ear, src);
  if (!w) return 0;
  const dx = src[0] - ear[0], dy = src[1] - ear[1], l = Math.hypot(dx, dy) || 1, sx = (-dy / l) * 64, sy = (dx / l) * 64;
  for (const o of [[sx, sy, 0], [-sx, -sy, 0], [0, 0, 64]]) { // open space right beside it: heard around the edge
    const q = [src[0] + o[0], src[1] + o[1], src[2] + o[2]];
    if (!solidAt(q) && !lineWalls(ear, q) && !lineWalls(q, src)) return Math.min(w, 0.5);
  }
  return w;
});
const cmdInput = (c) => ({ fwd: c.f, side: c.s, jump: !!c.j, duck: !!c.d, walk: !!c.w });
function handleEvent(ev, now) {
  if (ev.id === net.id && ['deploy', 'shot', 'planting', 'defusing'].includes(ev.e)) return; // our own sounds are played locally
  if (ev.e === 'step') { if (ev.id === net.id) play(surfaceSound(ev.s), ev.land ? 0.55 : 0.35); else playAt(surfaceSound(ev.s), ev.o, (ev.land ? 0.85 : 0.6) * (players?.byId.get(ev.id)?.team === you.team ? 0.5 : 1), ev.land ? 'land' : 'step'); } // our own steps: flat, a little quieter
  else if (ev.e === 'door') playAt(ev.open ? 'doors/default_move' : 'doors/door_wood_close1', ev.o, 0.7, 'world');
  else if (ev.e === 'break') { clearPane(ev.i); playAt(ev.glass ? `physics/glass/glass_sheet_break${1 + Math.floor(Math.random() * 2)}` : 'physics/wood/wood_plank_break1', ev.o, 0.9, 'world'); }
  else if (ev.e === 'deploy') { const snd = WEAPONS[ev.w]?.sounds.deploy; if (snd) playAt('weapons/' + snd, ev.o, 0.5, 'gear'); }
  else if (ev.e === 'shot') { const snd = WEAPONS[ev.w]?.sounds.fire; if (snd) playAt('weapons/' + snd, [ev.o[0], ev.o[1], ev.o[2] + 56], 0.9, 'shot'); players?.shotFx(ev, weapons.addHole); }
  else if (ev.e === 'round') { if (ev.phase === 'live') play(['radio/go', 'radio/letsgo', 'radio/locknload', 'radio/moveout'][(Math.random() * 4) | 0], 0.8); // CS:S's round-start radio call
    if (ev.phase === 'freeze') { weapons?.refill(); weapons?.clearHoles(); players?.clearDecals(); } if (ev.phase === 'over' && ev.winner) play(ev.winner === 'ct' ? 'radio/ctwin' : 'radio/terwin', 0.9); } // "Counter-Terrorists win" / "Terrorists win"
  else if (ev.e === 'planting') { // the arming beeps of someone planting, until they finish or let go
    clearInterval(plantBeeps.get(ev.id)); let n = 0;
    plantBeeps.set(ev.id, setInterval(() => { if (++n > 7) clearInterval(plantBeeps.get(ev.id)); else playAt('weapons/c4/c4_click', ev.o, 0.7, 'bomb'); }, 420));
  }
  else if (ev.e === 'plantcancel') clearInterval(plantBeeps.get(ev.id));
  else if (ev.e === 'planted') { for (const t of plantBeeps.values()) clearInterval(t); play('radio/bombpl', 0.9); playAt('weapons/c4/c4_plant', ev.o, 0.8, 'bomb'); }
  else if (ev.e === 'bombpickup') { if (ev.id === net.id) play('items/itempickup', 0.7); }
  else if (ev.e === 'defusing') playAt('weapons/c4/c4_disarm', ev.o, 0.8, 'bomb');
  else if (ev.e === 'defused') { play('radio/bombdef', 0.9); playAt('weapons/c4/c4_disarm', ev.o, 0.9, 'bomb'); }
  else if (ev.e === 'bombexplode') {
    playAt('weapons/c4/c4_explode1', ev.o, 1.4, 'blast'); bombs?.explode(ev.o, now);
    setTimeout(() => playAt('weapons/c4/c4_exp_deb' + (1 + (Math.random() * 2 | 0)), ev.o, 1, 'blast'), 700); // falling debris
    const d = Math.hypot(ev.o[0] - player.o[0], ev.o[1] - player.o[1], ev.o[2] - player.o[2]);
    if (d < 1800) { flashUntil = now + 0.25 + (1 - d / 1800) * 0.6; flashDur = 0.9; } // the blast lights up the screen
  }
  else if (ev.e === 'hurt') { // we got hit: aim punch (CS:S kicks the view on damage) and a red arc toward the shooter
    if (ev.to !== net.id) return;
    const ang = Math.atan2(ev.from[1] - player.o[1], ev.from[0] - player.o[0]) - player.yaw, k = Math.min(ev.dmg / 40, 1);
    hud.damageFrom(ang, k);
    player.velMod = 0.5; // tagged (the server does the same; predicting it avoids a correction)
    const pu = weapons.state.punch; pu[0] = Math.min(pu[0] + 1.5 + k * 2, 8); pu[1] += (Math.random() - 0.5) * 2 * (0.5 + k);
  }
  else if (ev.e === 'bounce') { const snd = WEAPONS[ev.w]?.sounds.bounce; if (snd) playAt('weapons/' + snd, ev.o, 0.7, 'bounce'); }
  else if (ev.e === 'explode') { const snd = WEAPONS[ev.w]?.sounds.explode; if (snd) playAt('weapons/' + snd, ev.o, 1, 'blast'); grenades?.pop(ev); }
  else if (ev.e === 'flash') { if (ev.to === net.id) { flashUntil = now + ev.dur; flashDur = ev.dur; } }
  else if (ev.e === 'hostage') { // used: "let's go" / "I'll stay here", from the hostage
    const pick = (a) => a[(Math.random() * a.length) | 0];
    playAt(ev.by ? 'hostage/huse/' + pick(['getouttahere', 'illfollow', 'letsdoit', 'letsgo']) : 'hostage/hunuse/' + pick(['comeback', 'dontleaveme', 'illstayhere', 'notleaveme', 'yeahillstay']), ev.o, 0.9, 'world');
  }
  else if (ev.e === 'rescued') { play('radio/rescued', 0.7); if (ev.by === net.id) hud.notice('Hostage rescued: +$1000'); }
  else if (ev.e === 'death') {
    players?.onDeath(ev, now, player.yaw);
    if (ev.killer === net.id && ev.victim !== net.id) weapons.state.stats.kills++;
    if (ev.victim === net.id) { // our own death
      const k = ev.killer === net.id ? null : players?.byId.get(ev.killer);
      killedBy = ev.w === 'c4' ? 'the bomb' : ev.killer === net.id ? 'yourself' : k?.name ?? 'the world';
      if (!deadAt) deadAt = now;
    }
    const killer = ev.killer === net.id ? { name: net.name, team: you.team } : players?.byId.get(ev.killer);
    const victim = ev.victim === net.id ? { name: net.name, team: you.team } : players?.byId.get(ev.victim);
    hud.kill({ killer: killer?.name ?? 'World', killerTeam: killer?.team ?? 't', victim: victim?.name ?? 'Player', victimTeam: victim?.team ?? 'ct', icon: ev.w === 'world' ? 'skull' : WEAPONS[ev.w]?.icon, headshot: ev.hs, wallbang: ev.wb, local: ev.killer === net.id });
  }
}
function onSnap(d, arrival) {
  d.mv?.forEach((v, i) => setMover(i, v));
  players?.applySnapshot(d, arrival);
  const y = d.you, jumped = Math.hypot(y.o[0] - player.o[0], y.o[1] - player.o[1], y.o[2] - player.o[2]) > 150;
  // reconcile: compare where we predicted to be at the acknowledged cmd with where the server says we were; replay the rest on a mismatch
  const i = pending.findIndex((p) => p.cmd.seq === y.ack);
  if (i >= 0) {
    const predicted = pending[i].o; pending.splice(0, i + 1);
    if (Math.hypot(predicted[0] - y.o[0], predicted[1] - y.o[1], predicted[2] - y.o[2]) > 0.25) {
      applyServerState(y);
      for (const p of pending) { player.tick(cmdInput(p.cmd)); p.o = [...player.o]; }
    }
  } else if (jumped && !q.has('freeze')) { applyServerState(y); pending.length = 0; } // ?freeze: the camera stays where ?pos put it
  if (jumped) { player.yaw = y.yaw ?? player.yaw; player.pitch = 0; player.prev = { o: [...player.o], eyeZ: player.eyeZ }; } // respawn: take the spawn position and view
  if (y.hp < you.hp && y.alive) { hurtEl.style.opacity = Math.min(0.55, (you.hp - y.hp) / 60 + 0.18); setTimeout(() => { hurtEl.style.opacity = 0; }, 90); }
  if (you.alive && !y.alive && !deadAt) deadAt = arrival; // died (the death event may come a moment later)
  if (!you.alive && y.alive) { deadAt = 0; killedBy = ''; specIdx = 0; players?.removeSelf(net.id); weapons.state.held = false; } // respawned: our body goes away
  if (y.kit && !you.kit) play('items/defuser_equip', 0.8); // bought a defuse kit
  you = y; roundState = d.round;
  hud.setStats({ money: y.money, hp: y.hp, armor: y.armor, helmet: y.helmet });
  const reasonText = d.round.reason === 'bombed' ? 'Target Successfully Bombed!\n' : d.round.reason === 'defused' ? 'The Bomb Has Been Defused!\n'
    : d.round.reason === 'rescued' ? 'All Hostages have been rescued!\n' : d.round.reason === 'time' && d.round.winner === 't' ? 'Hostages have not been rescued!\n' : '';
  hud.setRound({ alive: d.round.alive, time: d.round.left, phase: d.round.phase, scores: d.round.scores, banner: d.round.phase === 'over' ? reasonText + (WIN_TEXT[d.round.winner] ?? '') : '', number: d.round.number, team: y.team, bomb: d.round.bomb });
  lastBomb = d.bomb ?? null; bombs?.sync(d.bomb, arrival);
  hud.setBomb({ carrying: y.alive && y.owned.includes('c4'), inSite: y.inSite, act: y.act });
  if (defuseHeld && (!y.alive || d.bomb?.s !== 'planted')) stopDefuse();
  weapons?.setLoadout(y.owned, y.weapon);
  grenades?.sync(d.gr ?? [], d.smokes ?? []);
  roster = d.ents; buyMenu?.refresh(); teamMenu?.refresh();
  for (const e of d.ev) snapEvents.push(e);
}
const netWarn = document.getElementById('netwarn');
const PLAYER_NAME = window.__name || 'Player'; // asked for in index.html before the game loads
const net = connectToServer({ name: PLAYER_NAME, map: MAP_NAME, onSnap, onNotice: (text) => hud.notice(text) });
net.name = PLAYER_NAME;
const scoreboard = createScoreboard({ getRoster: () => roster, getRound: () => roundState, getMyId: () => net.id, mapName: MAP_NAME });
try { await net.ready; } catch (e) { setLoad(30, 'Cannot join: the server is full or not running (npm start)'); throw e; }
you = net.first.you; if (!(q.get('pos') && q.has('freeze'))) { applyServerState(you); player.yaw = you.yaw ?? 0; player.prev = { o: [...player.o], eyeZ: player.eyeZ }; }
let devPanel = null;
// ---------- main menu (Join / Resume, Options, Quit) over the live game; Esc opens it while playing, Esc in it leaves fullscreen ----------
let joined = false, settings = loadSettings();
function applySettings(s) {
  settings = { ...settings, ...s };
  setVolumes({ master: settings.master, ambience: settings.ambience });
  renderer.domElement.style.filter = settings.brightness === 1 ? '' : `brightness(${settings.brightness})`;
  if (renderer.getPixelRatio() !== pixelRatio(settings.renderScale)) renderer.setPixelRatio(pixelRatio(settings.renderScale));
  document.getElementById('info').style.display = settings.showFps || q.has('debug') ? 'block' : 'none';
  if (s.crosshair) hud.setCrosshair(s.crosshair);
  if (s.name) { net.name = s.name; net.send({ t: 'name', name: s.name }); }
}
const mainMenu = createMainMenu({
  inGame: () => joined,
  onPlay: () => { if (joined) startPlay(); else teamMenu.open(); },
  onQuit: () => { document.exitFullscreen?.().catch(() => {}); window.close(); location.href = 'about:blank'; }, // a tab the user opened can't close itself: leave the game instead
  onSettings: applySettings,
});
const uiOpen = () => !!(buyMenu?.isOpen() || teamMenu?.isOpen() || devPanel?.isOpen() || mainMenu.isOpen());
weapons = await createWeapons({ loadTex, player, world: playerWorld, bulletLimit: world.collision.length, surfOf: world.surfOf, surfaces: world.surfaces, worldRoot, hud, renderer, targets: () => players, net, uiOpen, alive: () => !!you.alive, initial: { owned: you.owned, weapon: you.weapon } });
devPanel = createDevPanel({ hud, weapons, range: window.__mode === 'range' });
grenades = await createGrenades({ worldRoot, loadTex });
bombs = await createBombs({ worldRoot, loadTex, playAt });
setLoad(65, 'Loading players...');
players = await createPlayers({ loadTex, worldRoot, world: playerWorld, bulletLimit: world.collision.length, gain, play, fog: worldFog, light: world.light, skyBrush: new Set(world.skyBrushIdx ?? []), fogGlsl: FOG_GLSL, getMyTeam: () => you.team, getMyId: () => net.id, mapName: MAP_NAME });
players.applySnapshot(net.first, performance.now() / 1000);
player.others = players.solids;
buyMenu = createBuyMenu({ net, getState: () => you });
teamMenu = createTeamMenu({ net, getState: () => you, getRoster: () => roster, drawPortrait: players.drawPortrait, mapName: MAP_NAME, onPick: () => { joined = true; startPlay(); } });
await new Promise((done) => { // wait for textures (capped so a missing file can't hang the screen)
  const t0 = performance.now();
  const tick = () => {
    setLoad(70 + Math.round((30 * texDone) / Math.max(texPending, 1)), `Loading textures (${texDone}/${texPending})...`);
    if (texDone >= texPending || performance.now() - t0 > 15000) done(); else setTimeout(tick, 100);
  };
  tick();
});
preload('player/headshot1', 'player/headshot2', 'player/damage1', 'player/damage2', 'player/damage3', 'player/kevlar1', 'player/kevlar2', 'player/kevlar3',
  'weapons/c4/c4_beep1', 'weapons/c4/c4_click', 'weapons/c4/c4_disarm', 'radio/bombpl', 'radio/bombdef', 'radio/ctwin', 'radio/terwin'); // hit / bomb / round sounds play without delay
setLoad(100, 'Ready');
loadingEl.style.opacity = 0; setTimeout(() => loadingEl.remove(), 450);
applySettings({});
if ((!q.has('shot') && !q.has('freeze')) || q.has('menu')) { mainMenu.open(); if (q.has('options')) mainMenu.options(); } // ?menu (&options): open it in screenshot runs too
if (q.get('wep')) weapons.select(q.get('wep')); // debug: ?wep=ak47&autofire (hold the trigger)
if (q.has('autofire')) weapons.state.held = true;
const flashEl = document.getElementById('flash');
const keys = new Set();
let wheelJump = false; // a wheel notch counts as the jump button being down for exactly one usercmd
const info = document.getElementById('info');
if (q.has('debug')) info.style.display = 'block'; // ?debug: fps / speed / position line
addEventListener('keydown', (e) => {
  if (e.code === 'Escape' && !e.repeat) { // fullscreen + keyboard lock deliver Esc here: it opens the menu instead of leaving fullscreen
    e.preventDefault();
    if (mainMenu.capturing()) return; // Esc cancels a rebind, handled by the Keyboard tab
    if (mainMenu.isOpen()) { if (mainMenu.windowOpen()) mainMenu.closeWindow(); else document.exitFullscreen?.().catch(() => {}); } // Esc in the menu: out of fullscreen
    else if (!buyMenu?.isOpen() && !teamMenu?.isOpen() && !devPanel?.isOpen()) { document.exitPointerLock(); mainMenu.open(); }
    return;
  }
  if (mainMenu.isOpen()) return; // the menu (and the Keyboard tab's rebinding) owns the keyboard
  if (e.target.closest?.('input, textarea, select')) return; // typing in a menu field is not game input
  if (document.pointerLockElement) e.preventDefault(); // while playing, game keys must not trigger browser shortcuts (Ctrl+D bookmark, Ctrl+S, F5, Ctrl+plus zoom...)
  keys.add(e.code);
  if (is('team', e.code) && !teamMenu.isOpen()) { document.exitPointerLock(); teamMenu.open(); }
  if (is('use', e.code) && !e.repeat && !defuseHeld && you.alive && you.team === 'ct' && lastBomb?.s === 'planted' && document.pointerLockElement) { // hold E on the bomb to defuse
    const b = lastBomb.o;
    if (Math.hypot(b[0] - player.o[0], b[1] - player.o[1], (b[2] - player.o[2]) * 0.5) < 80) { defuseHeld = true; net.send({ t: 'defuse', on: true }); play('weapons/c4/c4_disarm', 0.7); }
  }
  else if (is('use', e.code) && !e.repeat && !defuseHeld && you.alive && document.pointerLockElement) net.send({ t: 'use' }); // hostages: follow me / stay here
  if (e.code === 'Space' || is('jump', e.code)) e.preventDefault();
}, { capture: true });
// Scroll-wheel jump (+jump/-jump in one frame), the classic bhop bind. Must be a non-passive listener or the browser
// ignores preventDefault, and Ctrl+scroll zooms the page.
addEventListener('wheel', (e) => { if (document.pointerLockElement) e.preventDefault(); wheelJump = true; }, { passive: false });
for (const ev of ['gesturestart', 'gesturechange', 'contextmenu', 'auxclick']) addEventListener(ev, (e) => { if (document.pointerLockElement) e.preventDefault(); }, { passive: false });
function stopDefuse() { if (!defuseHeld) return; defuseHeld = false; net.send({ t: 'defuse', on: false }); }
addEventListener('mousedown', (e) => { if (document.pointerLockElement && !you.alive && deadAt && e.button === 0) specIdx++; }); // dead: click to watch the next player
addEventListener('keyup', (e) => { keys.delete(e.code); if (is('use', e.code)) stopDefuse(); if (is('scores', e.code)) scoreboard.show(false); });
addEventListener('keydown', (e) => { if (is('scores', e.code) && !mainMenu.isOpen()) { e.preventDefault(); if (!e.repeat) scoreboard.show(true); } }); // hold Tab: scoreboard
addEventListener('blur', () => scoreboard.show(false));
addEventListener('blur', () => { keys.clear(); stopDefuse(); });
// Raw mouse input: no OS pointer acceleration, which is what made fast 180s feel uneven.
const lockPointer = () => {
  const el = renderer.domElement;
  try {
    const p = el.requestPointerLock({ unadjustedMovement: true });
    if (p?.catch) p.catch(() => { try { el.requestPointerLock(); } catch { /* ignored */ } });
  } catch { try { el.requestPointerLock(); } catch { /* ignored */ } }
};
// Pointer lock must be requested straight from the click (user gesture), so it comes first and never waits on anything.
// Fullscreen + Keyboard Lock (Chromium) then also capture Ctrl+W / Ctrl+T / Ctrl+N; if refused, play continues windowed.
const startPlay = () => {
  lockPointer();
  if (!q.has('windowed')) document.documentElement.requestFullscreen({ navigationUI: 'hide' }).then(() => navigator.keyboard?.lock()).catch(() => {});
};
// no Esc screen: Esc just frees the mouse, and clicking the game takes it back (unless a menu is open)
renderer.domElement.addEventListener('click', () => { if (!document.pointerLockElement && !uiOpen()) startPlay(); });
document.addEventListener('pointerlockchange', () => { keys.clear(); if (!document.pointerLockElement && joined && !uiOpen()) mainMenu.open(); }); // windowed: the browser's Esc frees the mouse; show the menu
addEventListener('mousemove', (e) => {
  if (!document.pointerLockElement || uiOpen()) return;
  const k = ((0.022 * settings.sens * Math.PI) / 180) * (weapons.fov(FOV) / FOV); // m_yaw * sensitivity (Options > Mouse), scaled down while zoomed
  player.yaw -= e.movementX * k;
  player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - e.movementY * k * (settings.invert ? -1 : 1)));
});

// ---------- loop: 128 Hz usercmds (same tick rate as the server), camera interpolated between ticks ----------
let acc = 0, last = performance.now(), fps = 0, frames = 0, fpsT = last;
const rad = Math.PI / 180;
// Death cam: first a third-person view of our own ragdoll ("Killed by X"), then a chase camera on a living teammate (anyone, if none).
// The mouse still turns the view (it orbits the target); the camera is kept out of walls with a trace.
const deathEl = document.getElementById('deathmsg');
function deathCam(t) {
  const since = t - deadAt, cp = Math.cos(player.pitch);
  let target = null, text = killedBy ? `Killed by ${killedBy}` : 'You will play next round';
  if (since < 3 && you.team !== 'spec') { const me = players.byId.get(net.id); target = me?.ragdoll ? [...me.ragdoll.P[0]] : [player.o[0], player.o[1], player.o[2] + 24]; }
  else {
    const alive = players.bots.filter((b) => !b.dead && !b.self), mates = alive.filter((b) => b.team === you.team), list = mates.length ? mates : alive;
    if (list.length) { const b = list[specIdx % list.length]; target = [b.origin[0], b.origin[1], b.origin[2] + 56]; text = `Spectating ${b.name}  (click: next player)`; }
    else target = [player.o[0], player.o[1], player.o[2] + 24];
  }
  const dist = since < 3 ? 70 + Math.min(since, 1.5) * 40 : 110, lift = since < 3 ? 46 : 14;
  const want = [target[0] - Math.cos(player.yaw) * cp * dist, target[1] - Math.sin(player.yaw) * cp * dist, target[2] - Math.sin(player.pitch) * dist + lift];
  const r = trace(playerWorld, target, want, [-6, -6, -6], [6, 6, 6], world.collision.length), cam = r.end;
  const d = [target[0] - cam[0], target[1] - cam[1], target[2] - cam[2]], l = Math.hypot(...d) || 1;
  deathEl.textContent = text; deathEl.style.display = 'block';
  return [cam, d.map((v) => v / l)];
}
const face = (cam, x, y, z, f) => { cam.position.set(x, z, -y); cam.lookAt(x + f[0], z + f[2], -(y + f[1])); }; // Source (z-up) -> three (y-up)
renderer.compile(scene, camera);
renderer.setAnimationLoop((now) => {
  const dt = Math.min((now - last) / 1000, 0.1); acc += dt; last = now;
  for (; acc >= TICK; acc -= TICK) {
    const cmd = {
      t: 'cmd', seq: ++seq,
      f: (keys.has(binds.forward) ? 1 : 0) - (keys.has(binds.back) ? 1 : 0), s: (keys.has(binds.right) ? 1 : 0) - (keys.has(binds.left) ? 1 : 0),
      j: keys.has(binds.jump) || wheelJump ? 1 : 0, d: keys.has(binds.duck) ? 1 : 0, w: keys.has(binds.walk) ? 1 : 0, yaw: player.yaw, pitch: player.pitch,
    };
    wheelJump = false;
    if (roundState.phase === 'freeze' || !you.alive || weapons.state.planting || defuseHeld || you.act) { cmd.f = cmd.s = cmd.j = 0; } // freeze time / dead / planting / defusing: no moving (the server enforces it too)
    if (!q.has('freeze')) {
      player.tick(cmdInput(cmd));
      pending.push({ cmd, o: [...player.o] }); if (pending.length > 256) pending.shift();
      net.send(cmd);
    }
  }
  const dead = !you.alive && !!deadAt;
  document.body.classList.toggle('dead', dead);
  devPanel.update(); scoreboard.update();
  // like CS:S: a red warning top right once the server goes quiet (snapshots come 128 times a second), counting down cl_timeout
  const quiet = (performance.now() - net.lastMsg) / 1000, left = 60 - quiet;
  netWarn.style.display = !net.connected || quiet > 1 ? 'block' : 'none';
  if (!net.connected || quiet > 1) netWarn.textContent = net.kicked ? 'You were kicked from the server' : `WARNING:  Connection Problem
${left > 0 ? `Auto-disconnect in ${left.toFixed(1)} seconds` : 'Disconnected'}`;
  if (!dead) { weapons.update(dt); deathEl.style.display = 'none'; }
  grenades.update(dt);
  bombs.update(now / 1000);
  flashEl.style.opacity = now / 1000 < flashUntil ? Math.min(1, (flashUntil - now / 1000) / Math.min(flashDur, 2) * 1.6) : 0; // full white, then fades
  for (const ev of snapEvents.splice(0)) handleEvent(ev, now / 1000);
  setListener(!you.alive && deadAt ? [camera.position.x, -camera.position.z, camera.position.y] : player.eye, player.yaw, player.pitch); // dead: hear from the death / spectator camera (three y-up -> Source z-up)
  ambience.update(now / 1000);
  players.update(now / 1000, player.eye);
  hud.update();
  const punch = weapons.punch(), VIEW_KICK = 0.25, yaw = player.yaw + punch[1] * rad * VIEW_KICK, pitch = player.pitch + punch[0] * rad * VIEW_KICK; // the camera only shows a hint of the recoil; bullets still follow the full spray pattern
  const vfov = weapons.fov(FOV);
  for (const c of [camera, skyCamera]) if (c.fov !== vfov) { c.fov = vfov; c.updateProjectionMatrix(); }
  let e = player.eyeAt(acc / TICK), cp = Math.cos(pitch);
  let f = [cp * Math.cos(yaw), cp * Math.sin(yaw), Math.sin(pitch)];
  if (dead) [e, f] = deathCam(now / 1000);
  face(camera, e[0], e[1], e[2], f);
  renderer.clear();
  if (sky) { // sky camera = sky_camera origin + eye / scale
    face(skyCamera, sky.origin[0] + e[0] / sky.scale, sky.origin[1] + e[1] / sky.scale, sky.origin[2] + e[2] / sky.scale, f);
  }
  renderer.render(skyScene, skyCamera);
  renderer.clearDepth();
  if (!q.has('skyonly')) renderer.render(scene, camera); // ?skyonly: debug the 3D skybox
  if (!dead) weapons.render(innerWidth / innerHeight); // no gun in your hands when dead
  frames++;
  if (now - fpsT > 500) { fps = Math.round((frames * 1000) / (now - fpsT)); frames = 0; fpsT = now; }
  info.textContent = `${fps} fps  speed ${Math.hypot(player.v[0], player.v[1]) | 0}/${player.maxSpeed}  stamina ${player.stamina | 0}  pos ${player.o.map(Math.round).join(' ')}  ${you.team.toUpperCase()}`;
});
window.game = { player, camera, world, weapons, players, net, get you() { return you; }, get roundState() { return roundState; }, get lastBomb() { return lastBomb; } };
