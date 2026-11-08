// WebAudio for the game's .wav files (paths relative to sound/, without extension), mixed for competitive play:
//  play(name, volume)               -> flat (UI, own weapon, own footsteps, hit feedback)
//  playAt(name, pos, volume, kind)  -> positional, heard from where it happens:
//    - HRTF 3D placement of a mono fold of the sound (stereo files would blur the direction)
//    - a fixed, per-kind distance curve: full volume up close, silent past a hard range, so loudness reads as distance
//    - graded occlusion: each wall between you and it (up to 3) dulls and quiets it; a sound just around a corner stays nearly clear
//    - an elevation cue on top of HRTF: brighter from above, darker from below
//  Everything runs through a master limiter, so a firefight never clips and buries the quiet cues.
let ctx = null, master = null, ambienceBus = null, out = null, volumes = { master: 1, ambience: 1 };
const AMBIENCE_BASE = 0.25; // the map's ambience sits well under footsteps and gunfire
export let ambienceLevel = AMBIENCE_BASE; // x the Options slider
/** Options > Audio: game volume (everything) and ambient sound volume. */
export function setVolumes(v) {
  volumes = { ...volumes, ...v }; ambienceLevel = AMBIENCE_BASE * volumes.ambience;
  if (out) out.gain.value = volumes.master;
  if (ambienceBus) ambienceBus.gain.value = ambienceLevel;
}
const buffers = new Map();

export const audio = () => {
  if (ctx) return ctx;
  ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' }); // smallest output buffer
  master = ctx.createDynamicsCompressor(); // a gentle limiter: loud moments are held down instead of clipping
  master.threshold.value = -10; master.knee.value = 6; master.ratio.value = 6; master.attack.value = 0.002; master.release.value = 0.2;
  out = ctx.createGain(); out.gain.value = volumes.master; master.connect(out).connect(ctx.destination);
  ambienceBus = ctx.createGain(); ambienceBus.gain.value = ambienceLevel; ambienceBus.connect(master);
  return ctx;
};
const load = (name) => {
  if (!buffers.has(name)) buffers.set(name, fetch(/\.(wav|mp3)$/.test(name) ? `sound/${name}` : `sound/${name}.wav`).then((r) => r.arrayBuffer()).then((b) => audio().decodeAudioData(b)));
  return buffers.get(name);
};

/** Decode sounds ahead of time so the first shot / hit / reload plays instantly instead of waiting for a download + decode. */
export const preload = (...names) => { for (const n of names) load(n).catch(() => {}); };

export async function play(name, volume = 0.7) {
  try {
    const c = audio();
    if (c.state === 'suspended') c.resume();
    const src = c.createBufferSource(), gain = c.createGain();
    src.buffer = await load(name); gain.gain.value = volume;
    src.connect(gain).connect(master); src.start();
  } catch { /* sound is optional */ }
}

// Source (x, y, z up) -> three audio space (x, z, -y); the listener follows the camera
let ear = [0, 0, 0];
export function setListener(eye, yaw, pitch) {
  ear = eye;
  const c = ctx; if (!c) return;
  const L = c.listener, cp = Math.cos(pitch), f = [cp * Math.cos(yaw), Math.sin(pitch), -cp * Math.sin(yaw)];
  const set = (p, v) => { if (p.setValueAtTime) p.setValueAtTime(v, c.currentTime); else p.value = v; };
  if (L.positionX) {
    set(L.positionX, eye[0]); set(L.positionY, eye[2]); set(L.positionZ, -eye[1]);
    set(L.forwardX, f[0]); set(L.forwardY, f[1]); set(L.forwardZ, f[2]); set(L.upX, 0); set(L.upY, 1); set(L.upZ, 0);
  } else { L.setPosition(eye[0], eye[2], -eye[1]); L.setOrientation(f[0], f[1], f[2], 0, 1, 0); }
}

// How far each kind of sound carries (units): full volume within `ref`, then down to silence at `max` along (1 - x)^exp.
// Footsteps carry about as far as in CS (~1100 units), gunshots across the map, gear (deploy / reload / zoom) only up close.
export const KINDS = {
  step: { ref: 110, max: 1150, exp: 1.6 },
  land: { ref: 110, max: 1000, exp: 1.6 },
  shot: { ref: 250, max: 7000, exp: 1.15 },
  gear: { ref: 80, max: 650, exp: 1.6 },
  impact: { ref: 80, max: 1300, exp: 1.5 },
  bounce: { ref: 100, max: 1300, exp: 1.5 },
  blast: { ref: 300, max: 6000, exp: 1.0 },
  bomb: { ref: 150, max: 2200, exp: 1.2 },
  world: { ref: 150, max: 1800, exp: 1.4 }, // doors, glass, hostages
  ambient: { ref: 200, max: 2500, exp: 1.3 }, // the map's random ambience (birds, dogs, creaks)
};
export const distanceGain = (d, kind = 'world') => { const k = KINDS[kind] ?? KINDS.world; return d <= k.ref ? 1 : Math.max(0, 1 - (d - k.ref) / (k.max - k.ref)) ** k.exp; };

// walls between the listener and a sound: (ear, pos) -> 0..3 (fractions = partly around a corner); the game supplies the world trace
let occlusion = () => 0;
export const setOcclusion = (fn) => { occlusion = fn; };

/** Positional one-shot. `kind` picks its distance curve (KINDS). */
export async function playAt(name, pos, volume = 0.7, kind = 'world') {
  try {
    const c = audio();
    if (c.state === 'suspended') c.resume();
    const dx = pos[0] - ear[0], dy = pos[1] - ear[1], dz = pos[2] - ear[2], d = Math.hypot(dx, dy, dz);
    const g = distanceGain(d, kind);
    if (g <= 0.001) return; // out of range: not heard at all
    const walls = occlusion(ear, pos);
    const src = c.createBufferSource(), gain = c.createGain(), pan = c.createPanner(), lp = c.createBiquadFilter(), tilt = c.createBiquadFilter();
    src.buffer = await load(name);
    gain.gain.value = volume * g * 0.6 ** walls;
    // dullness = distance (air soaks up highs) and walls (each one takes a big bite out of the top end)
    lp.type = 'lowpass'; lp.frequency.value = Math.max(Math.min(20000 / (1 + d / 2500), 20000 * 0.2 ** walls), 450);
    // elevation: a high shelf tipped up for sounds above you, down for sounds below (on top of what HRTF already gives)
    const elev = Math.atan2(dz, Math.hypot(dx, dy) || 1);
    tilt.type = 'highshelf'; tilt.frequency.value = 4500; tilt.gain.value = Math.max(-7, Math.min(4, elev * 7));
    pan.channelCount = 1; pan.channelCountMode = 'explicit'; pan.channelInterpretation = 'speakers'; // fold to mono before placing
    pan.panningModel = 'HRTF'; pan.distanceModel = 'linear'; pan.rolloffFactor = 0; // distance is ours (above): the panner only places it
    if (pan.positionX) { pan.positionX.value = pos[0]; pan.positionY.value = pos[2]; pan.positionZ.value = -pos[1]; } else pan.setPosition(pos[0], pos[2], -pos[1]);
    src.connect(lp).connect(tilt).connect(gain).connect(pan).connect(master); src.start();
  } catch { /* sound is optional */ }
}

/** A looping sound on the ambience bus: a bed everywhere (pos null) or placed in 3D. setGain(v) glides there; stop() fades it out. */
export async function startLoop(name, pos = null) {
  const c = audio(), src = c.createBufferSource(), gain = c.createGain();
  gain.gain.value = 0;
  try { src.buffer = await load(name); } catch { return { setGain() {}, stop() {} }; }
  src.loop = true;
  let out = gain;
  if (pos) {
    const pan = c.createPanner();
    pan.channelCount = 1; pan.channelCountMode = 'explicit'; pan.panningModel = 'HRTF'; pan.distanceModel = 'linear'; pan.rolloffFactor = 0;
    if (pan.positionX) { pan.positionX.value = pos[0]; pan.positionY.value = pos[2]; pan.positionZ.value = -pos[1]; } else pan.setPosition(pos[0], pos[2], -pos[1]);
    gain.connect(pan); out = pan;
  }
  src.connect(gain); out.connect(ambienceBus); src.start(0, Math.random() * src.buffer.duration); // random phase: no two loops in lockstep
  return {
    setGain(v, glide = 0.4) { gain.gain.setTargetAtTime(v, c.currentTime, glide); },
    stop(fade = 1.5) { gain.gain.setTargetAtTime(0, c.currentTime, fade / 3); setTimeout(() => { try { src.stop(); } catch {} }, fade * 1000 + 100); },
  };
}
export const listenerPos = () => ear;
