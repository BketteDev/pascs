// The ` key (the console key; ² on AZERTY): crosshair settings, a live debug readout (recoil, accuracy, movement state, the last bullet,
// your shooting stats) and weapon tuning: edit the current weapon's config as JSON, export / import all of them.
// Tuning changes this client only (recoil, spread, fire rate as you feel it); damage and rate-of-fire checks stay the server's.
import { WEAPONS } from './weapon-defs.js';

const XH_DEFAULT = { color: '#32fa32', alpha: 1, length: 6, thickness: 2, gap: 3, outline: 0, dot: false, dynamic: true };
const ORIGINAL = structuredClone(WEAPONS);
const load = (k, fallback) => { try { return JSON.parse(localStorage.getItem(k)) ?? fallback; } catch { return fallback; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: settings last this session */ } };

export function createDevPanel({ hud, weapons, range }) {
  const panel = document.getElementById('devpanel'), out = document.getElementById('debugout');
  let xh = { ...XH_DEFAULT, ...load('crosshair', {}) }, open = false, showDebug = load('debugOverlay', range);
  const tuned = load('weaponTuning', {}); // per-weapon overrides kept across reloads
  for (const [k, v] of Object.entries(tuned)) if (WEAPONS[k]) Object.assign(WEAPONS[k], v);
  hud.setCrosshair(xh);

  const slider = (k, label, min, max, step) => `<label>${label} <input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}"></label>`;
  panel.innerHTML = `<h3>Crosshair</h3>
    <label>Colour <input type="color" data-k="color"></label>
    ${slider('alpha', 'Alpha', 0.1, 1, 0.05)}${slider('length', 'Length', 0, 20, 1)}${slider('thickness', 'Thickness', 1, 6, 1)}${slider('gap', 'Gap', -4, 20, 1)}${slider('outline', 'Outline', 0, 2, 1)}
    <label>Centre dot <input type="checkbox" data-k="dot"></label>
    <label>Dynamic (gap follows the spread) <input type="checkbox" data-k="dynamic"></label>
    <button data-a="xhreset">Default crosshair</button>
    <h3>Debug</h3>
    <label>Show recoil / accuracy / stats readout <input type="checkbox" id="dbgshow"></label>
    <button data-a="stats">Reset stats</button>
    <h3>Weapon tuning: <span id="tunename"></span></h3>
    <div class="hint">Your client only. Apply takes effect on the next shot.</div>
    <textarea id="tunejson" spellcheck="false"></textarea>
    <button data-a="apply">Apply</button><button data-a="reset">Reset weapon</button><button data-a="export">Export all</button><button data-a="import">Import</button>
    <input type="file" id="tunefile" accept=".json,application/json" hidden>
    <div class="hint" id="tunemsg"></div>`;
  const $ = (id) => document.getElementById(id), msg = (t) => { $('tunemsg').textContent = t; };
  const syncInputs = () => {
    for (const el of panel.querySelectorAll('[data-k]')) { if (el.type === 'checkbox') el.checked = !!xh[el.dataset.k]; else el.value = xh[el.dataset.k]; }
    $('dbgshow').checked = showDebug;
  };
  panel.addEventListener('input', (e) => {
    const k = e.target.dataset.k;
    if (k) { xh[k] = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'color' ? e.target.value : Number(e.target.value); hud.setCrosshair(xh); save('crosshair', xh); }
    if (e.target.id === 'dbgshow') { showDebug = e.target.checked; save('debugOverlay', showDebug); }
  });
  const cur = () => weapons.state.cur;
  const remember = (k) => { tuned[k] = WEAPONS[k]; save('weaponTuning', tuned); };
  const fill = () => { $('tunename').textContent = WEAPONS[cur()].name; $('tunejson').value = JSON.stringify(WEAPONS[cur()], null, 1); };
  panel.addEventListener('click', (e) => {
    const a = e.target.dataset.a;
    if (a === 'xhreset') { xh = { ...XH_DEFAULT }; hud.setCrosshair(xh); save('crosshair', xh); syncInputs(); }
    else if (a === 'stats') Object.assign(weapons.state.stats, { shots: 0, hits: 0, hs: 0, kills: 0 });
    else if (a === 'apply') {
      try { const v = JSON.parse($('tunejson').value); if (typeof v !== 'object' || !v) throw new Error('not an object'); Object.assign(WEAPONS[cur()], v); remember(cur()); msg('Applied.'); }
      catch (err) { msg('Not valid JSON: ' + err.message); }
    } else if (a === 'reset') { const k = cur(); for (const f of Object.keys(WEAPONS[k])) delete WEAPONS[k][f]; Object.assign(WEAPONS[k], structuredClone(ORIGINAL[k])); delete tuned[k]; save('weaponTuning', tuned); fill(); msg('Back to the default.'); }
    else if (a === 'export') {
      const url = URL.createObjectURL(new Blob([JSON.stringify(WEAPONS, null, 1)], { type: 'application/json' }));
      Object.assign(document.createElement('a'), { href: url, download: 'weapons.json' }).click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } else if (a === 'import') $('tunefile').click();
  });
  $('tunefile').addEventListener('change', async (e) => {
    const file = e.target.files[0]; e.target.value = '';
    if (!file) return;
    try {
      const all = JSON.parse(await file.text()), keys = Object.keys(all).filter((k) => WEAPONS[k] && typeof all[k] === 'object');
      for (const k of keys) { Object.assign(WEAPONS[k], all[k]); remember(k); }
      fill(); msg(`Imported ${keys.length} weapons.`);
    } catch (err) { msg('Import failed: ' + err.message); }
  });
  function toggle(on) {
    open = on; panel.style.display = on ? 'block' : 'none';
    if (on) { syncInputs(); fill(); msg(''); document.exitPointerLock?.(); }
  }
  addEventListener('keydown', (e) => {
    if (e.code !== 'Backquote' || e.target.tagName === 'TEXTAREA' || e.repeat) return;
    e.preventDefault(); toggle(!open);
  });

  const f = (v, n = 2) => (Number.isFinite(v) ? v.toFixed(n) : '-');
  const GROUPS = { 1: 'head', 2: 'chest', 3: 'stomach', 4: 'left arm', 5: 'right arm', 6: 'left leg', 7: 'right leg' };
  function update() {
    out.style.display = showDebug ? 'block' : 'none';
    if (!showDebug) return;
    const d = weapons.debug(), st = d.stats, l = d.last;
    out.textContent = `${WEAPONS[d.weapon]?.name}${d.burst ? '  [burst]' : ''}
shots fired  ${d.shots}      accuracy ${f(d.acc, 3)}
spread       ${f(d.spread)} deg
recoil       pitch ${f(d.punch[0])}  yaw ${f(d.punch[1])}
movement     ${d.stance}  ${Math.round(d.speed)} u/s${d.velMod < 1 ? `  tagged ${f(d.velMod)}` : ''}
last bullet  ${l ? `${l.dist} u, ${l.walls} wall${l.walls === 1 ? '' : 's'}, ${l.group ? GROUPS[l.group] ?? 'body' : 'miss'}` : '-'}
stats        ${st.shots} shots  ${st.hits} hits (${st.shots ? Math.round((st.hits / st.shots) * 100) : 0}%)  ${st.hs} hs (${st.hits ? Math.round((st.hs / st.hits) * 100) : 0}%)  ${st.kills} kills`;
  }
  return { isOpen: () => open, update };
}
