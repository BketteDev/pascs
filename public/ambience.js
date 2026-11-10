// The map's ambience, played like Source's soundscapes: the listener is in the nearest env_soundscape zone it is inside and can see
// (the last one stays until another takes over); that soundscape's looping beds, its loops pinned to the zone's positions and its random
// one-shots play, crossfading when the zone changes. Looping ambient_generic sounds play where they stand. All of it on the ambience bus,
// kept under gameplay sounds (audio.js ambienceLevel).
import { startLoop, playAt, listenerPos, ambienceLevel } from './audio.js';

export function createAmbience({ ambience, visible }) {
  const { zones = [], scapes = {}, ambients = [] } = ambience ?? {};
  let current = null, loops = [], randoms = [], nextCheck = 0;
  const far = (o, reach) => { const e = listenerPos(), d = Math.hypot(o[0] - e[0], o[1] - e[1], o[2] - e[2]); return Math.max(0, 1 - d / reach) ** 1.4; };

  // ambient_generic loops: always on, heard by distance
  const fixed = ambients.map((a) => ({ a, h: startLoop(a.wave, a.everywhere ? null : a.o) }));

  async function enter(zone) {
    for (const l of loops) l.h.then((h) => h.stop());
    loops = []; randoms = [];
    const t = performance.now() / 1000;
    for (const el of scapes[zone.name] ?? []) {
      const pos = el.pos === null ? null : zone.pos[el.pos];
      if (el.pos !== null && !pos) continue; // the zone doesn't set that position
      if (el.loop) loops.push({ el, pos, h: startLoop(el.waves[0], pos) });
      else randoms.push({ el, pos, next: t + el.time[0] + Math.random() * (el.time[1] - el.time[0]) });
    }
  }

  function update(now) {
    if (now >= nextCheck) { // which zone are we in: nearest whose radius we're inside and whose centre we can see
      nextCheck = now + 0.5;
      const e = listenerPos();
      let best = null, bestD = Infinity;
      for (const z of zones) {
        const d = Math.hypot(z.o[0] - e[0], z.o[1] - e[1], z.o[2] - e[2]);
        if ((z.r < 0 || d <= z.r) && d < bestD && visible(e, z.o)) { best = z; bestD = d; }
      }
      if (best && best.name !== current?.name) { current = best; enter(best); }
    }
    for (const l of loops) { const v = (l.el.volume[0] + l.el.volume[1]) / 2; l.h.then((h) => h.setGain(l.pos ? v * far(l.pos, l.el.reach) : v)); }
    for (const f of fixed) f.h.then((h) => h.setGain(f.a.everywhere ? f.a.volume : f.a.volume * far(f.a.o, f.a.reach)));
    for (const r of randoms) {
      if (now < r.next) continue;
      r.next = now + r.el.time[0] + Math.random() * (r.el.time[1] - r.el.time[0]);
      const e = listenerPos(), ang = Math.random() * Math.PI * 2, dist = 300 + Math.random() * 600; // unpinned ones come from somewhere around you
      const at = r.pos ?? [e[0] + Math.cos(ang) * dist, e[1] + Math.sin(ang) * dist, e[2] + 100 + Math.random() * 200];
      const vol = r.el.volume[0] + Math.random() * (r.el.volume[1] - r.el.volume[0]);
      playAt(r.el.waves[(Math.random() * r.el.waves.length) | 0], at, vol * ambienceLevel, 'ambient');
    }
  }
  return { update };
}
