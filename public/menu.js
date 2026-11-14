// The CS:S main menu: logo top left, a column of text buttons over the live game (the map behind it, the spectator camera running),
// and the Options window in CS:S's olive VGUI style (tabs, sliders, OK / Cancel / Apply). One server only: JOIN GAME joins it.
// Settings live in localStorage ('settings', plus 'crosshair', 'playerName', 'binds', 'adminPass') and are handed to onSettings.
// With a valid admin password (Options > Multiplayer) an ADMIN item opens the server admin window (map, team size, max players).
import { ACTIONS, DEFAULT_BINDS, binds, setBinds, keyName } from './binds.js';
export const DEFAULTS = { sens: 2.5, invert: false, master: 1, ambience: 1, brightness: 1, showFps: false, renderScale: 1, texLow: false };
const XH_DEFAULT = { color: '#32fa32', alpha: 1, length: 6, thickness: 2, gap: 3, outline: 0, dot: false, dynamic: true };
const load = (k, d) => { try { const v = JSON.parse(localStorage.getItem(k)); return v && typeof v === 'object' ? { ...d, ...v } : { ...d }; } catch { return { ...d }; } };
const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked: this session only */ } };
export const loadSettings = () => load('settings', DEFAULTS);
export const loadCrosshair = () => load('crosshair', XH_DEFAULT);
// admin: the password (Options > Multiplayer) is checked by the server; while it is valid the main menu shows ADMIN
const loadAdminPass = () => { try { return localStorage.getItem('adminPass') ?? ''; } catch { return ''; } };
const adminPost = (body) => fetch('/api/admin', { method: 'POST', body: JSON.stringify(body) }).then((r) => r.json()).catch(() => ({ ok: false, msg: 'server unreachable' }));
export const loadName = () => { try { return localStorage.getItem('playerName') ?? ''; } catch { return ''; } };
const esc = (t) => String(t).replace(/[<>&"]/g, '');

export function createMainMenu({ onPlay, onQuit, onSettings, inGame }) {
  const el = document.createElement('div'); el.id = 'mainmenu'; document.body.append(el);
  el.innerHTML = `<div class="mm-logo"><b>COUNTER-STRIKE</b><span>SOURCE</span></div><div class="mm-items"></div><div class="mm-win" hidden></div>`;
  const items = el.querySelector('.mm-items'), win = el.querySelector('.mm-win');
  let shown = false, adminOk = false;
  if (loadAdminPass()) adminPost({ password: loadAdminPass() }).then((r) => { adminOk = !!r.ok; if (shown) renderItems(); }); // still valid on this server?
  function renderItems() {
    const list = [[inGame() ? 'Resume Game' : 'Join Game', 'play'], ['Options', 'options'], ...(adminOk ? [['Admin', 'admin']] : []), ['Quit', 'quit']];
    items.innerHTML = list.map(([t, a]) => `<div class="mm-item" data-a="${a}">${t}</div>`).join('');
  }
  items.addEventListener('click', (e) => {
    const a = e.target.closest('[data-a]')?.dataset.a;
    if (a === 'play') { if (!loadName()) nameWindow(); else { close(); onPlay(); } }
    else if (a === 'options') optionsWindow();
    else if (a === 'admin') adminWindow();
    else if (a === 'quit') onQuit();
  });

  // ---- windows (CS:S VGUI look) ----
  const frame = (title, body, buttons) => {
    win.hidden = false;
    win.innerHTML = `<div class="vg-title">${title}<i data-b="cancel">&#10005;</i></div><div class="vg-body">${body}</div><div class="vg-buttons">${buttons.map(([t, b]) => `<button data-b="${b}">${t}</button>`).join('')}</div>`;
  };
  const closeWin = () => { win.hidden = true; win.innerHTML = ''; win.onclick = null; };
  function nameWindow() { // first JOIN GAME: pick a name (it is remembered; Options > Multiplayer changes it later)
    frame('Player Name', '<label class="vg-row">Name <input class="vg-text" maxlength="24" autocomplete="nickname"></label>', [['OK', 'ok'], ['Cancel', 'cancel']]);
    const input = win.querySelector('input'); input.focus();
    const ok = () => { const n = input.value.trim().slice(0, 24); if (!n) return; try { localStorage.setItem('playerName', n); } catch {} onSettings({ name: n }); closeWin(); close(); onPlay(); };
    input.onkeydown = (e) => { if (e.key === 'Enter') ok(); };
    win.onclick = (e) => { const b = e.target.dataset.b; if (b === 'ok') ok(); else if (b === 'cancel') closeWin(); };
  }
  let capture = null; // Keyboard tab: the action waiting for its new key
  addEventListener('keydown', (e) => {
    if (!capture) return;
    e.preventDefault(); e.stopImmediatePropagation();
    const { action, draft, redraw } = capture;
    capture = null;
    if (e.code !== 'Escape') { for (const k of Object.keys(draft.binds)) if (draft.binds[k] === e.code) draft.binds[k] = ''; draft.binds[action] = e.code; } // a key does one thing: its old action is unbound
    redraw();
  }, { capture: true });

  function optionsWindow() {
    const s = loadSettings(), draft = { ...s, name: loadName(), adminPass: loadAdminPass(), binds: { ...binds }, xh: loadCrosshair() };
    const pct = (v) => Math.round(v * 100) + '%', px = (v) => v + ' px';
    const FMT = { sens: (v) => Number(v).toFixed(2), master: pct, ambience: pct, brightness: pct, renderScale: pct, 'xh.alpha': pct, 'xh.length': px, 'xh.thickness': px, 'xh.gap': px, 'xh.outline': px };
    const val = (k) => (k.startsWith('xh.') ? draft.xh[k.slice(3)] : draft[k]);
    const slider = (k, label, min, max, step) => `<label class="vg-row">${label}<input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${val(k)}"><output>${FMT[k](val(k))}</output></label>`;
    const check = (k, label) => `<label class="vg-row vg-check"><input type="checkbox" data-k="${k}" ${val(k) ? 'checked' : ''}>${label}</label>`;
    const preview = () => { const x = draft.xh, o = x.outline ? `box-shadow: 0 0 0 ${x.outline}px #000;` : '', bar = (st) => `<i style="position:absolute;background:${x.color};${o}${st}"></i>`, L = x.length, T = x.thickness, G = x.gap;
      return `<div class="vg-preview" style="opacity:${x.alpha}">${bar(`left:${-T / 2}px;top:${-G - L}px;width:${T}px;height:${L}px`)}${bar(`left:${-T / 2}px;top:${G}px;width:${T}px;height:${L}px`)}${bar(`top:${-T / 2}px;left:${-G - L}px;height:${T}px;width:${L}px`)}${bar(`top:${-T / 2}px;left:${G}px;height:${T}px;width:${L}px`)}${x.dot ? bar(`left:${-T / 2}px;top:${-T / 2}px;width:${T}px;height:${T}px`) : ''}</div>`; };
    const TABS = {
      Keyboard: () => `<div class="vg-keys">${ACTIONS.map(([a, label]) => `<div class="vg-key"><span>${label}</span><button data-bind="${a}" class="${capture?.action === a ? 'wait' : ''}">${capture?.action === a ? 'Press a key...' : keyName(draft.binds[a])}</button></div>`).join('')}</div>` +
        '<div class="vg-row vg-note">Click an action, then press its new key (Esc cancels). Weapons: 1-6. <button data-b="keydefaults">Use defaults</button></div>',
      Mouse: () => slider('sens', 'Mouse sensitivity', 0.2, 10, 0.05) + check('invert', 'Reverse mouse'),
      Crosshair: () => `<div class="vg-xh"><div>${`<label class="vg-row">Color<input type="color" data-k="xh.color" value="${draft.xh.color}"><span></span></label>`}${slider('xh.alpha', 'Opacity', 0.1, 1, 0.01)}${slider('xh.length', 'Length', 1, 20, 1)}${slider('xh.thickness', 'Thickness', 1, 6, 1)}${slider('xh.gap', 'Gap', 0, 15, 1)}${slider('xh.outline', 'Outline', 0, 2, 1)}` +
        `${check('xh.dot', 'Center dot')}${check('xh.dynamic', 'Dynamic (opens with movement and firing)')}</div><div class="vg-previewbox">${preview()}</div></div>`,
      Audio: () => slider('master', 'Game volume', 0, 1, 0.01) + slider('ambience', 'Ambient sound volume', 0, 1, 0.01),
      Video: () => slider('brightness', 'Brightness', 0.6, 1.6, 0.01) + slider('renderScale', 'Render scale (lower = faster)', 0.5, 1, 0.05) +
        check('texLow', 'Low texture quality (less video memory; after a reload)') + check('showFps', 'Show frame rate and position'),
      Multiplayer: () => `<label class="vg-row">Player name<input class="vg-text" data-k="name" maxlength="24" value="${esc(draft.name)}"><span></span></label>` +
        `<label class="vg-row">Admin password<input class="vg-text" type="password" data-k="adminPass" autocomplete="current-password" value="${esc(draft.adminPass)}"><output class="vg-admin">${adminOk ? 'OK' : ''}</output></label>`,
    };
    let tab = 'Keyboard';
    const draw = () => {
      frame('Options', `<div class="vg-tabs">${Object.keys(TABS).map((t) => `<span class="${t === tab ? 'on' : ''}" data-t="${t}">${t}</span>`).join('')}</div><div class="vg-page">${TABS[tab]()}</div>`, [['OK', 'ok'], ['Cancel', 'cancel'], ['Apply', 'apply']]);
      win.querySelector('.vg-page').oninput = (e) => {
        const k = e.target.dataset.k; if (!k) return;
        const v = e.target.type === 'checkbox' ? e.target.checked : e.target.type === 'range' ? Number(e.target.value) : e.target.value;
        if (k.startsWith('xh.')) draft.xh[k.slice(3)] = v; else draft[k] = v;
        const out = e.target.parentElement.querySelector('output'); if (out) out.textContent = FMT[k](v);
        const box = win.querySelector('.vg-previewbox'); if (box) box.innerHTML = preview();
      };
    };
    const apply = () => {
      const next = Object.fromEntries(Object.keys(DEFAULTS).map((k) => [k, draft[k]]));
      save('settings', next); save('crosshair', draft.xh); setBinds(draft.binds);
      const name = String(draft.name ?? '').trim().slice(0, 24);
      if (name) try { localStorage.setItem('playerName', name); } catch {}
      onSettings({ ...next, crosshair: { ...draft.xh }, name: name || undefined });
      const pass = String(draft.adminPass ?? '');
      if (pass !== loadAdminPass() || (pass && !adminOk)) adminPost({ password: pass }).then((r) => { // the server says whether it's right
        adminOk = !!(pass && r.ok);
        try { if (adminOk || !pass) localStorage.setItem('adminPass', pass); } catch {}
        const out = win.querySelector('.vg-admin'); if (out) out.textContent = !pass ? '' : adminOk ? 'OK' : 'Wrong password';
        renderItems();
      });
    };
    draw();
    win.onclick = (e) => {
      if (e.target.dataset.t) { tab = e.target.dataset.t; capture = null; draw(); return; }
      if (e.target.dataset.bind) { capture = { action: e.target.dataset.bind, draft, redraw: draw }; draw(); return; }
      const b = e.target.dataset.b;
      if (b === 'keydefaults') { draft.binds = { ...DEFAULT_BINDS }; draw(); }
      else if (b === 'apply') apply(); else if (b === 'ok') { apply(); closeWin(); } else if (b === 'cancel') { capture = null; closeWin(); }
    };
  }

  async function adminWindow() { // server admin, HL2 / VGUI style: map, team size, max players (applying restarts the game for everyone)
    frame('Server Admin', '<div class="vg-page"><div class="vg-row">Loading...</div></div>', [['Apply', 'apply'], ['Close', 'cancel']]);
    const [maps, info, roster] = await Promise.all([fetch('/api/maps').then((r) => r.json()).catch(() => []), fetch('/api/info').then((r) => r.json()).catch(() => ({})), adminPost({ password: loadAdminPass(), list: true })]);
    if (win.hidden) return;
    frame('Server Admin', `<div class="vg-page">
      <label class="vg-row">Map<select data-a="map">${maps.map((m) => `<option${m === info.map ? ' selected' : ''}>${esc(m)}</option>`).join('')}</select><span></span></label>
      <label class="vg-row">Team size (bots fill)<input class="vg-text" type="number" min="1" max="16" data-a="teamSize" value="${info.teamSize ?? 5}"><span></span></label>
      <label class="vg-row">Max players<input class="vg-text" type="number" min="1" max="32" data-a="maxPlayers" value="${info.maxPlayers ?? 10}"><span></span></label>
      <label class="vg-row vg-check"><input type="checkbox" data-a="bots" ${roster.bots !== false ? 'checked' : ''}>Bots fill the empty slots</label>
      <div class="vg-players">${(roster.players ?? []).map((p) => `<div class="vg-player"><span>${esc(p.name)}</span><small>${p.team === 'spec' ? 'spectator' : p.team.toUpperCase()} · ${p.ping} ms</small><button data-kick="${p.id}">Kick</button></div>`).join('') || '<div class="vg-player"><small>No players connected</small></div>'}</div>
      <div class="vg-row vg-note">Applying restarts the game on the new settings: everyone reloads into it.<span></span><output class="vg-status"></output></div></div>`, [['Apply', 'apply'], ['Close', 'cancel']]);
    win.onclick = async (e) => {
      if (e.target.dataset.kick) { const r = await adminPost({ password: loadAdminPass(), kick: Number(e.target.dataset.kick) }); if (r.ok) e.target.closest('.vg-player').remove(); else win.querySelector('.vg-status').textContent = r.msg; return; }
      const b = e.target.dataset.b;
      if (b === 'cancel') { closeWin(); return; }
      if (b !== 'apply') return;
      const v = (k) => win.querySelector(`[data-a="${k}"]`).value, status = win.querySelector('.vg-status');
      status.textContent = '...';
      const r = await adminPost({ password: loadAdminPass(), map: v('map'), teamSize: Number(v('teamSize')), maxPlayers: Number(v('maxPlayers')), bots: win.querySelector('[data-a="bots"]').checked });
      status.textContent = r.msg ?? (r.ok ? 'ok' : 'failed');
    };
  }

  function open() { shown = true; renderItems(); el.classList.toggle('title', !inGame()); el.style.display = 'block'; document.body.classList.add('inmenu'); } // body.inmenu hides the HUD
  function close() { shown = false; closeWin(); el.style.display = 'none'; document.body.classList.remove('inmenu'); }
  return { open, close, options: () => optionsWindow(), capturing: () => !!capture, isOpen: () => shown, windowOpen: () => !win.hidden, closeWindow: closeWin };
}
