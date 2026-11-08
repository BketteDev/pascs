// Source soundscapes -> a plain description the client plays (public/ambience.js).
// A map's env_soundscape entities are zones (origin, radius, soundscape name, position0..7 = info_target names); the soundscape scripts
// (scripts/soundscapes_*.vsc, listed in soundscapes_manifest.txt) say what each one plays: looping beds, looping sounds pinned to one of
// the zone's positions, random one-shots, and nested soundscapes ("playsoundscape", optionally moved onto a position).
import { readGameFile } from './content.mjs';

/** Valve KeyValues text -> [[key, value | children]] (keys repeat, so pairs rather than an object). */
export function parseKeyValues(text) {
  const tokens = [];
  for (const m of text.replace(/\/\/[^\n]*/g, '').matchAll(/"([^"]*)"|([{}])|([^\s{}"]+)/g)) tokens.push(m[2] ? { brace: m[2] } : { s: m[1] ?? m[3] });
  let i = 0;
  const block = () => {
    const out = [];
    while (i < tokens.length) {
      const t = tokens[i++];
      if (t.brace === '}') return out;
      if (t.brace) continue;
      const v = tokens[i];
      if (v?.brace === '{') { i++; out.push([t.s.toLowerCase(), block()]); }
      else if (v && !v.brace) { i++; if (/^\[.*\]$/.test(tokens[i]?.s ?? '')) i++; out.push([t.s.toLowerCase(), v.s]); } // [$WIN32]-style conditions dropped
    }
    return out;
  };
  return block();
}
const get = (kv, k) => kv.find(([key]) => key === k)?.[1];

let defs = null;
const extra = [];
/** Scripts a map ships itself (e.g. scripts/soundscapes_cs_agency.txt in its pak), read on top of the manifest's. */
export const addSoundscapeScripts = (...files) => { extra.push(...files); defs = null; };
function soundscapeDefs() { // name (lower case) -> body, from every script the manifest lists
  if (defs) return defs;
  defs = new Map();
  const manifest = readGameFile('scripts/soundscapes_manifest.txt');
  const files = [...(manifest ? [...manifest.toString('latin1').matchAll(/"file"\s+"([^"]+)"/g)].map((m) => m[1]) : []), ...extra];
  for (const f of files) {
    const t = readGameFile(f);
    if (t) for (const [name, body] of parseKeyValues(t.toString('latin1'))) if (Array.isArray(body)) defs.set(name, body);
  }
  return defs;
}

// SNDLVL_xxdB -> how far it carries (units): ~600 at 50 dB, doubling every ~10 dB, like Source's attenuation
const reachOf = (sl) => { const db = Number(String(sl ?? '').match(/(\d+)/)?.[1] ?? 75); return Math.round(600 * 2 ** ((db - 50) / 10)); };
const wav = (w) => String(w).replace(/^[\^)(#*@<>!?$&~`+%]+/, '').replace(/\\/g, '/').toLowerCase();
const range = (v, d) => { const n = String(v ?? d).split(',').map(Number); return [n[0], n[1] ?? n[0]]; };

/** Flatten one soundscape: [{ loop | random, waves, volume [lo,hi], time [lo,hi], pos (index into the zone's positions) | null, reach }] */
// CS:S soundscape names whose script only exists in CS:GO's remade form (the CS:GO install is where the scripts come from)
const ALIAS = { 'office.garagea': 'office.indoor_garage_01', 'office.outdoorsa': 'office.outdoor_01', 'office.indoorsa': 'office.indoor_main_01' };
export function flatten(name, pos = null, gain = 1, depth = 0, out = []) {
  const body = soundscapeDefs().get(name.toLowerCase()) ?? soundscapeDefs().get(ALIAS[name.toLowerCase()]);
  if (!body || depth > 6) return out;
  for (const [k, v] of body) {
    if (!Array.isArray(v)) continue;
    const vol = range(get(v, 'volume'), 1).map((x) => x * gain), at = get(v, 'position') ?? pos;
    if (k === 'playlooping') { const w = wav(get(v, 'wave') ?? ''); if (w && !w.includes('null.wav')) out.push({ loop: 1, waves: [w], volume: vol, pos: at === undefined || at === null ? null : Number(at), reach: reachOf(get(v, 'soundlevel')) }); }
    else if (k === 'playrandom') {
      const rnd = get(v, 'rndwave'), waves = Array.isArray(rnd) ? rnd.filter(([kk]) => kk === 'wave').map(([, w]) => wav(w)).filter((w) => !w.includes('null.wav')) : [];
      if (waves.length) out.push({ random: 1, waves, volume: vol, time: range(get(v, 'time'), '10,20'), pos: at === undefined || at === null ? null : Number(at), reach: reachOf(get(v, 'soundlevel')) });
    } else if (k === 'playsoundscape') {
      const over = get(v, 'positionoverride');
      flatten(get(v, 'name') ?? '', over !== undefined ? Number(over) : pos, gain * range(get(v, 'volume'), 1)[0], depth + 1, out);
    }
  }
  return out;
}
