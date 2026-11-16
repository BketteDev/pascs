// Cosmetic choices belong to this browser. Entries are available as soon as their catalogue is served.
let catalog;
let equipped;
try { equipped = new Map(Object.entries(JSON.parse(localStorage.getItem('cosmetics') ?? '{}'))); }
catch { equipped = new Map(); }

export function loadCosmetics() {
  catalog ??= fetch('cosmetics/catalog.json').then((r) => r.ok ? r.json() : {}).catch(() => ({}));
  return catalog;
}

export const equippedCosmetic = (weapon) => equipped.get(weapon) ?? 'default';

export function equipCosmetic(weapon, id) {
  equipped.set(weapon, id);
  try { localStorage.setItem('cosmetics', JSON.stringify(Object.fromEntries(equipped))); }
  catch { /* still equipped for this session */ }
}
