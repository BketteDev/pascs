// Shared ammunition rules; all times are seconds on the server's simulation clock.
import { WEAPONS } from './weapon-defs.js';
export const freshAmmo = (key) => ({ mag: WEAPONS[key].mag, reserve: WEAPONS[key].reserve });
export function advanceAmmo(ammo, key, time) {
  const a = ammo[key], w = WEAPONS[key];
  if (!a?.reload) return;
  while (a.reload && time + 1e-8 >= a.reload.at) {
    const take = Math.min(w.shell ? 1 : w.mag - a.mag, a.reserve);
    a.mag += take; a.reserve -= take;
    if (!w.shell || a.mag >= w.mag || a.reserve <= 0) delete a.reload;
    else a.reload.at += w.shell;
  }
}
export function reloadAmmo(ammo, key, time) {
  const a = ammo[key], w = WEAPONS[key];
  if (!a || !w.mag || a.reload || a.mag >= w.mag || a.reserve <= 0) return false;
  a.reload = { at: time + w.reload }; return true;
}
export function consumeAmmo(ammo, key, time) {
  advanceAmmo(ammo, key, time);
  const a = ammo[key], w = WEAPONS[key];
  if (!a || a.mag <= 0 || (a.reload && !w.shell)) return false;
  delete a.reload; a.mag--; return true;
}
