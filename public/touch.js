// Touch controls overlay for phones and tablets: virtual movement joystick (left),
// drag-to-aim + aim-while-firing (right), context-aware action buttons, tappable weapon bar,
// top utility bar (Menu / Scores / Team / Buy), and spectator controls.
import { WEAPONS, GRENADES } from './weapon-defs.js';

import { isTouchDevice } from './mobile.js';

const SHORT_NAME = {
  glock: 'Glock', usp: 'USP', p228: 'P228', deagle: 'Deagle', elite: 'Elites', fiveseven: '5-7',
  m3: 'M3', xm1014: 'XM1014', mac10: 'MAC10', tmp: 'TMP', mp5: 'MP5', ump45: 'UMP', p90: 'P90',
  galil: 'Galil', famas: 'FAMAS', ak47: 'AK47', m4a1: 'M4A1', aug: 'AUG', sg552: 'SG552',
  scout: 'Scout', sg550: 'SG550', g3sg1: 'G3SG1', awp: 'AWP', m249: 'M249', knife: 'Knife',
  hegrenade: 'HE', flashbang: 'Flash', smokegrenade: 'Smoke', molotov: 'Molo', incgrenade: 'Incen', c4: 'C4',
};

export function createTouchControls({
  player, weapons, getSettings, getYou, getRound, uiOpen, isJoined, nearBomb,
  onUseStart, onUseStop, onMenu, onTeam, onBuy, onChat, onScoresToggle, onSpecNext, onSpecView, onWakeAudio, onEnterPlay,
}) {
  const root = document.createElement('div');
  root.id = 'touch-ui';
  root.innerHTML = `
    <div id="touch-top">
      <button type="button" class="t-pill" data-act="menu">Pause</button>
      <button type="button" class="t-pill" data-act="scores">Scores</button>
      <button type="button" class="t-pill" data-act="team">Équipe</button>
      <button type="button" class="t-pill" data-act="chat">Chat</button>
      <button type="button" class="t-pill t-buy" data-act="buy">Acheter</button>
      <button type="button" class="t-pill" data-act="more" aria-expanded="false" aria-controls="touch-more">Plus</button>
    </div>
    <div id="touch-more" hidden>
      <button type="button" data-extra="scores">Scores</button><button type="button" data-extra="team">Équipe</button>
      <button type="button" data-extra="chat">Discussion</button><button type="button" data-extra="drop">Lâcher l’arme</button>
      <button type="button" data-extra="inspect">Inspecter</button><button type="button" data-extra="close">Fermer</button>
    </div>
    <div id="touch-move-zone">
      <div id="touch-joy"><div id="touch-knob"></div></div>
    </div>
    <div id="touch-look-zone"></div>
    <button type="button" id="touch-fire-l" class="t-btn t-fire" aria-label="Tirer">TIRER</button>
    <div id="touch-actions">
      <button type="button" id="touch-use" class="t-btn t-sm">UTILISER</button>
      <button type="button" id="touch-drop" class="t-btn t-sm">LÂCHER</button>
      <button type="button" id="touch-inspect" class="t-btn t-sm" aria-label="Inspect weapon">LOOK</button>
      <button type="button" id="touch-alt" class="t-btn t-sm">ALT</button>
      <button type="button" id="touch-reload" class="t-btn t-sm">RECHARGER</button>
      <button type="button" id="touch-duck" class="t-btn t-sm">ACCROUPI</button>
      <button type="button" id="touch-jump" class="t-btn t-sm">SAUTER</button>
      <button type="button" id="touch-fire-r" class="t-btn t-fire">TIRER</button>
    </div>
    <div id="touch-weapons"></div>
    <div id="touch-spec">
      <button type="button" class="t-pill" data-spec="view">Changer de vue</button>
      <button type="button" class="t-pill" data-spec="next">Joueur suivant</button>
    </div>
  `;
  document.body.append(root);

  const moreEl = root.querySelector('#touch-more'), moreBtn = root.querySelector('[data-act="more"]');
  const closeMore = () => { moreEl.hidden = true; moreBtn.setAttribute('aria-expanded', 'false'); };
  const moveZone = root.querySelector('#touch-move-zone');
  const lookZone = root.querySelector('#touch-look-zone');
  const joyEl = root.querySelector('#touch-joy');
  const knobEl = root.querySelector('#touch-knob');
  const fireL = root.querySelector('#touch-fire-l');
  const fireR = root.querySelector('#touch-fire-r');
  const useBtn = root.querySelector('#touch-use');
  const dropBtn = root.querySelector('#touch-drop');
  const inspectBtn = root.querySelector('#touch-inspect');
  const altBtn = root.querySelector('#touch-alt');
  const reloadBtn = root.querySelector('#touch-reload');
  const duckBtn = root.querySelector('#touch-duck');
  const jumpBtn = root.querySelector('#touch-jump');
  const actionsEl = root.querySelector('#touch-actions');
  const weaponsEl = root.querySelector('#touch-weapons');
  const buyBtn = root.querySelector('[data-act="buy"]');
  const scoresBtn = root.querySelector('[data-act="scores"]');
  const specEl = root.querySelector('#touch-spec');

  let touchedRecently = false;
  let scoresOpen = false;
  let duckToggle = false;
  let jumpPulse = false;

  // Active touch tracking by identifier so multi-touch never conflicts.
  const joy = { id: null, ox: 0, oy: 0, f: 0, s: 0, w: 0 };
  const look = { id: null, x: 0, y: 0 };
  const fireTouch = { id: null, btn: null, x: 0, y: 0 };
  let useTouchId = null;

  const isEnabled = () => {
    const m = getSettings().touchMode ?? 'auto';
    if (m === 'on') return true;
    if (m === 'off') return false;
    return isTouchDevice() || touchedRecently;
  };
  const isActive = () => isEnabled() && isJoined() && !uiOpen() && moreEl.hidden;

  // Detect any touch automatically when touchMode === 'auto'.
  addEventListener('touchstart', () => {
    touchedRecently = true;
    onWakeAudio?.();
  }, { passive: true, capture: true });

  const resetInputs = () => {
    joy.id = null; joy.f = joy.s = joy.w = 0;
    look.id = null;
    if (fireTouch.id !== null) {
      fireTouch.id = null;
      fireTouch.btn?.classList.remove('active');
      fireTouch.btn = null;
      weapons.primaryUp();
    }
    if (useTouchId !== null) {
      useTouchId = null;
      useBtn.classList.remove('active');
      onUseStop();
    }
    jumpPulse = false;
    duckToggle = false; duckBtn.setAttribute('aria-pressed', 'false');
    joyEl.classList.remove('active');
    joyEl.style.left = ''; joyEl.style.top = '';
    knobEl.style.transform = 'translate(0px, 0px)';
  };

  // Saved independently for portrait and landscape; normalized coordinates survive resizing.
  const layoutKey = () => innerWidth >= innerHeight ? 'touchLayoutLandscape' : 'touchLayoutPortrait';
  let cachedLayoutKey = '', cachedLayout = {};
  const readLayout = () => {
    const key = layoutKey();
    if (key === cachedLayoutKey) return cachedLayout;
    cachedLayoutKey = key;
    try { cachedLayout = Object.fromEntries(Object.entries(JSON.parse(localStorage.getItem(key)) ?? {}).filter(([, pos]) => Array.isArray(pos) && pos.length === 2 && pos.every(Number.isFinite))); }
    catch { cachedLayout = {}; }
    return cachedLayout;
  };
  const buttons = [...root.querySelectorAll('.t-btn')];
  let lastLayoutSignature = '', editor = null;
  const clampPosition = (x, y, size = 70) => {
    const mx = Math.min(0.45, (size / 2 + 12) / innerWidth), my = Math.min(0.45, (size / 2 + 12) / innerHeight);
    return [Math.max(mx, Math.min(1 - mx, x)), Math.max(my, Math.min(1 - my, y))];
  };
  function applyLayout(layout = readLayout()) {
    const scale = Math.max(0.75, Math.min(1.4, Number(getSettings().touchScale) || 1));
    const signature = JSON.stringify([layout, scale, innerWidth, innerHeight]);
    if (signature === lastLayoutSignature) return;
    lastLayoutSignature = signature;
    for (const button of buttons) {
      button.style.scale = String(scale);
      const pos = layout[button.id];
      if (Array.isArray(pos) && pos.length === 2 && pos.every(Number.isFinite)) {
        const [x, y] = clampPosition(pos[0], pos[1], 80 * scale);
        Object.assign(button.style, { position: 'fixed', left: `${x * 100}%`, top: `${y * 100}%`, right: 'auto', bottom: 'auto', translate: '-50% -50%' });
      } else {
        for (const property of ['position', 'left', 'top', 'right', 'bottom', 'translate']) button.style[property] = '';
      }
    }
  }
  function editLayout(onClose = () => {}) {
    if (editor) return;
    resetInputs();
    const originalDisplay = root.style.display;
    root.style.display = 'block'; actionsEl.style.display = 'flex';
    // Measure the existing CSS layout as the starting point, including currently hidden actions.
    const previous = buttons.map((b) => b.style.display);
    buttons.forEach((b) => { b.style.display = 'flex'; });
    applyLayout({});
    const defaults = Object.fromEntries(buttons.map((b) => { const r = b.getBoundingClientRect(); return [b.id, clampPosition((r.left + r.width / 2) / innerWidth, (r.top + r.height / 2) / innerHeight)]; }));
    buttons.forEach((b, i) => { b.style.display = previous[i]; });
    root.style.display = originalDisplay; applyLayout();
    const key = layoutKey();
    let draft = { ...defaults, ...readLayout() }, dragging = null;
    editor = document.createElement('div'); editor.className = 'touch-editor';
    editor.setAttribute('role', 'dialog'); editor.setAttribute('aria-label', 'Touch button layout');
    editor.innerHTML = '<div class="editor-toolbar"><span>Glisse les boutons · Disposition pour cette orientation</span><button data-edit="save">Enregistrer</button><button data-edit="reset">Réinitialiser</button><button data-edit="cancel">Annuler</button></div>';
    const paint = () => { for (const target of editor.querySelectorAll('[data-target]')) { const [x, y] = clampPosition(...draft[target.dataset.target]); target.style.left = `${x * 100}%`; target.style.top = `${y * 100}%`; } };
    for (const b of buttons) {
      const target = document.createElement('button'); target.className = 'layout-target'; target.dataset.target = b.id;
      target.textContent = b.textContent; target.setAttribute('aria-label', 'Move ' + b.textContent);
      editor.append(target);
    }
    const finish = (save) => {
      if (save) try { localStorage.setItem(key, JSON.stringify(draft)); } catch {}
      removeEventListener('orientationchange', rotated);
      editor.remove(); editor = null; cachedLayoutKey = ''; lastLayoutSignature = ''; applyLayout(); onClose();
    };
    editor.addEventListener('pointerdown', (e) => {
      const target = e.target.closest('[data-target]'); if (!target) return;
      dragging = target; target.setPointerCapture(e.pointerId); e.preventDefault();
    });
    editor.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      draft[dragging.dataset.target] = clampPosition(e.clientX / innerWidth, e.clientY / innerHeight); paint(); e.preventDefault();
    });
    editor.addEventListener('pointerup', () => { dragging = null; });
    editor.addEventListener('pointercancel', () => { dragging = null; });
    editor.addEventListener('click', (e) => {
      const action = e.target.dataset.edit;
      if (action === 'save') finish(true);
      else if (action === 'cancel') finish(false);
      else if (action === 'reset') { draft = { ...defaults }; paint(); }
    });
    // Rotation closes without saving rather than accidentally writing landscape positions to portrait.
    const rotated = () => { if (editor) finish(false); removeEventListener('orientationchange', rotated); };
    addEventListener('orientationchange', rotated, { once: true });
    document.body.append(editor); paint();
  }

  // ---------- movement joystick ----------
  const JOY_MAX = 46;
  const updateJoy = (x, y) => {
    let dx = x - joy.ox, dy = y - joy.oy;
    const dist = Math.hypot(dx, dy);
    if (dist > JOY_MAX) { dx *= JOY_MAX / dist; dy *= JOY_MAX / dist; }
    knobEl.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    const norm = Math.min(dist / JOY_MAX, 1);
    if (norm < 0.2) { joy.f = 0; joy.s = 0; joy.w = 0; return; }
    const nx = dx / JOY_MAX, ny = -dy / JOY_MAX;
    joy.f = Math.abs(ny) > 0.28 ? Math.sign(ny) : 0;
    joy.s = Math.abs(nx) > 0.28 ? Math.sign(nx) : 0;
    joy.w = norm < 0.62 ? 1 : 0; // inner ring walks silently, outer ring runs
  };

  moveZone.addEventListener('touchstart', (e) => {
    if (!isActive() || joy.id !== null) return;
    const t = e.changedTouches[0]; if (!t) return;
    e.preventDefault();
    onEnterPlay?.();
    joy.id = t.identifier;
    const rect = moveZone.getBoundingClientRect();
    // Anchor joystick under the initial thumb press within the left zone.
    const lx = Math.max(58, Math.min(rect.width - 58, t.clientX - rect.left));
    const ly = Math.max(58, Math.min(rect.height - 58, t.clientY - rect.top));
    joyEl.style.left = lx + 'px';
    joyEl.style.top = ly + 'px';
    joy.ox = t.clientX; joy.oy = t.clientY;
    joyEl.classList.add('active');
    updateJoy(t.clientX, t.clientY);
  }, { passive: false });

  // ---------- look drag (and aim-while-firing on Fire buttons) ----------
  const applyLookDelta = (dx, dy) => {
    const s = getSettings();
    const fovScale = weapons.fov(73.74) / 73.74;
    const k = 0.0042 * (s.sens / 2.5) * (s.touchSens ?? 1) * fovScale;
    player.yaw -= dx * k;
    player.pitch = Math.max(-1.55, Math.min(1.55, player.pitch - dy * k * (s.invert ? -1 : 1)));
  };

  lookZone.addEventListener('touchstart', (e) => {
    if (!isActive() || look.id !== null) return;
    const t = e.changedTouches[0]; if (!t) return;
    e.preventDefault();
    onEnterPlay?.();
    look.id = t.identifier;
    look.x = t.clientX; look.y = t.clientY;
  }, { passive: false });

  const bindFireBtn = (btn) => {
    btn.addEventListener('touchstart', (e) => {
      if (!isActive() || fireTouch.id !== null) return;
      const t = e.changedTouches[0]; if (!t) return;
      e.preventDefault(); e.stopPropagation();
      onEnterPlay?.();
      fireTouch.id = t.identifier;
      fireTouch.btn = btn;
      fireTouch.x = t.clientX; fireTouch.y = t.clientY;
      btn.classList.add('active');
      weapons.primaryDown();
    }, { passive: false });
  };
  bindFireBtn(fireR);
  bindFireBtn(fireL);

  addEventListener('touchmove', (e) => {
    if (!isActive()) return;
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        e.preventDefault();
        updateJoy(t.clientX, t.clientY);
      } else if (t.identifier === look.id) {
        e.preventDefault();
        applyLookDelta(t.clientX - look.x, t.clientY - look.y);
        look.x = t.clientX; look.y = t.clientY;
      } else if (t.identifier === fireTouch.id) {
        e.preventDefault();
        applyLookDelta(t.clientX - fireTouch.x, t.clientY - fireTouch.y);
        fireTouch.x = t.clientX; fireTouch.y = t.clientY;
      }
    }
  }, { passive: false });

  const endTouches = (e) => {
    for (const t of e.changedTouches) {
      if (t.identifier === joy.id) {
        joy.id = null; joy.f = joy.s = joy.w = 0;
        joyEl.classList.remove('active');
        joyEl.style.left = ''; joyEl.style.top = '';
        knobEl.style.transform = 'translate(0px, 0px)';
      } else if (t.identifier === look.id) {
        look.id = null;
      } else if (t.identifier === fireTouch.id) {
        fireTouch.id = null;
        fireTouch.btn?.classList.remove('active');
        fireTouch.btn = null;
        weapons.primaryUp();
      } else if (t.identifier === useTouchId) {
        useTouchId = null;
        useBtn.classList.remove('active');
        onUseStop();
      }
    }
  };
  addEventListener('touchend', endTouches, { passive: true });
  addEventListener('touchcancel', endTouches, { passive: true });

  // ---------- single-tap / hold action buttons ----------
  const stopBtn = (el, onStart, onEnd) => {
    el.addEventListener('touchstart', (e) => {
      if (!isActive() || el.disabled) return;
      e.preventDefault(); e.stopPropagation();
      onWakeAudio?.();
      el.classList.add('active');
      onStart(e);
    }, { passive: false });
    if (onEnd) {
      const finish = (e) => { e.stopPropagation(); el.classList.remove('active'); onEnd(e); };
      el.addEventListener('touchend', finish, { passive: true });
      el.addEventListener('touchcancel', finish, { passive: true });
    } else {
      const unpress = () => el.classList.remove('active');
      el.addEventListener('touchend', unpress, { passive: true });
      el.addEventListener('touchcancel', unpress, { passive: true });
    }
  };

  stopBtn(jumpBtn, () => { jumpPulse = true; }, () => { jumpPulse = false; });
  stopBtn(duckBtn, () => { duckToggle = !duckToggle; });
  stopBtn(reloadBtn, () => { weapons.reload(); });
  stopBtn(dropBtn, () => { weapons.drop(); });
  stopBtn(inspectBtn, () => { weapons.inspect(); });
  stopBtn(altBtn, () => { weapons.secondaryDown(); }, () => { weapons.secondaryUp(); });

  useBtn.addEventListener('touchstart', (e) => {
    if (!isActive() || useTouchId !== null) return;
    const t = e.changedTouches[0]; if (!t) return;
    e.preventDefault(); e.stopPropagation();
    useTouchId = t.identifier;
    useBtn.classList.add('active');
    onUseStart();
  }, { passive: false });

  // Top utility bar & spectator pills (use touchstart/click safely without double-firing)
  const tap = (el, fn) => {
    let touched = false;
    el.addEventListener('touchstart', (e) => {
      touched = true;
      e.preventDefault(); e.stopPropagation();
      onWakeAudio?.();
      fn(e);
    }, { passive: false });
    el.addEventListener('click', (e) => {
      if (touched) { touched = false; return; }
      e.stopPropagation();
      fn(e);
    });
  };

  tap(root.querySelector('[data-act="menu"]'), () => { resetInputs(); scoresOpen = false; onScoresToggle(false); onMenu(); });
  tap(scoresBtn, () => { scoresOpen = !scoresOpen; scoresBtn.classList.toggle('active', scoresOpen); onScoresToggle(scoresOpen); });
  tap(root.querySelector('[data-act="team"]'), () => { resetInputs(); scoresOpen = false; onScoresToggle(false); onTeam(); });
  tap(root.querySelector('[data-act="chat"]'), () => { resetInputs(); scoresOpen = false; onScoresToggle(false); onChat?.(); });
  tap(buyBtn, () => { resetInputs(); scoresOpen = false; onScoresToggle(false); onBuy(); });
  tap(root.querySelector('[data-spec="view"]'), () => { onSpecView(); });
  tap(root.querySelector('[data-spec="next"]'), () => { onSpecNext(); });

  // Bottom weapon bar
  tap(weaponsEl, (e) => {
    const btn = e.target.closest('[data-wep]');
    if (btn) weapons.select(btn.dataset.wep);
  });

  tap(moreBtn, () => { const opening = moreEl.hidden; resetInputs(); moreEl.hidden = !opening; moreBtn.setAttribute('aria-expanded', String(opening)); });
  tap(moreEl, (e) => {
    const action = e.target.closest('[data-extra]')?.dataset.extra; if (!action) return;
    closeMore(); resetInputs();
    if (action === 'scores') { scoresOpen = !scoresOpen; onScoresToggle(scoresOpen); }
    else if (action === 'team') onTeam(); else if (action === 'chat') onChat?.();
    else if (action === 'drop') weapons.drop(); else if (action === 'inspect') weapons.inspect();
  });
  addEventListener('blur', () => { resetInputs(); closeMore(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { resetInputs(); closeMore(); } });

  // ---------- per-frame UI sync ----------
  let lastWepSig = '';
  let lastAlt = null;
  let lastAlive = null;
  let lastWasUi = false;

  function update() {
    if (editor) { root.style.display = 'none'; return; }
    const enabled = isEnabled();
    document.body.classList.toggle('touch-mode', enabled);
    if (!enabled) {
      root.style.display = 'none';
      resetInputs();
      return;
    }

    applyLayout();
    const simple = getSettings().touchSimple !== false;
    root.classList.toggle('simple-controls', simple);
    moreBtn.hidden = !simple;
    if (!simple) closeMore();
    const active = isEnabled() && isJoined() && !uiOpen();
    if (!active && lastWasUi !== true) resetInputs();
    lastWasUi = !active;
    root.style.display = active ? 'block' : 'none';
    if (!active) { closeMore(); return; }

    const you = getYou();
    const alive = !!you.alive;
    if (lastAlive && !alive) duckToggle = false;
    lastAlive = alive;

    const showLeftFire = !simple && !!(getSettings().touchLeftFire ?? true);
    moveZone.style.display = alive ? 'block' : 'none';
    actionsEl.style.display = alive ? 'flex' : 'none';
    fireL.style.display = alive && showLeftFire ? 'flex' : 'none';
    weaponsEl.style.display = alive ? 'flex' : 'none';
    buyBtn.style.display = alive ? 'inline-flex' : 'none';
    specEl.style.display = alive ? 'none' : 'flex';

    if (!alive) return;

    const cur = weapons.state.cur;
    const def = WEAPONS[cur];
    const alt = weapons.hasAlt();
    const altLabel = alt === 'scope' ? (weapons.isZoomed() ? `ZOOM ${weapons.isZoomed()}x` : 'SCOPE')
      : alt === 'burst' ? 'BURST'
      : alt === 'stab' ? 'STAB'
      : alt === 'lob' ? 'LOB' : '';
    if (altLabel !== lastAlt) {
      lastAlt = altLabel;
      altBtn.style.display = altLabel ? 'flex' : 'none';
      altBtn.textContent = altLabel;
    }

    const canRel = weapons.canReload();
    reloadBtn.style.display = def?.mag ? 'flex' : 'none';
    reloadBtn.classList.toggle('dim', !canRel); reloadBtn.disabled = !canRel;
    if (getSettings().touchAutoReload !== false && moreEl.hidden && def?.mag && weapons.ammo[cur]?.mag === 0 && canRel && getRound().phase === 'live') weapons.reload();

    const canDrop = cur === 'c4' || def?.slot === 1 || def?.slot === 2;
    dropBtn.style.display = !simple && canDrop ? 'flex' : 'none';
    inspectBtn.style.display = !simple && (def?.mag || def?.melee) ? 'flex' : 'none';

    const defuseReady = nearBomb();
    useBtn.textContent = defuseReady ? 'DÉSAMORCER' : 'UTILISER';
    useBtn.setAttribute('aria-label', defuseReady ? 'Maintenir pour désamorcer' : 'Maintenir pour utiliser');
    useBtn.classList.toggle('hot', defuseReady);

    duckBtn.classList.toggle('active', duckToggle); duckBtn.setAttribute('aria-pressed', String(duckToggle));
    fireR.textContent = def?.c4 ? 'POSER' : def?.grenade ? 'LANCER' : 'TIRER';
    fireL.textContent = fireR.textContent;

    const phase = getRound().phase;
    buyBtn.classList.toggle('hot', phase === 'freeze');

    // Rebuild tappable weapon slots only when inventory or active weapon changes.
    const owned = [...weapons.owned()];
    const sig = cur + '|' + owned.join(',');
    if (sig !== lastWepSig) {
      lastWepSig = sig;
      const ordered = [];
      for (const slot of [1, 2, 3]) {
        const k = owned.find((w) => WEAPONS[w]?.slot === slot);
        if (k) ordered.push(k);
      }
      for (const g of GRENADES) if (owned.includes(g)) ordered.push(g);
      if (owned.includes('c4')) ordered.push('c4');
      weaponsEl.innerHTML = ordered.map((k) => {
        const label = SHORT_NAME[k] ?? WEAPONS[k]?.name ?? k;
        return `<button type="button" class="t-wep${k === cur ? ' cur' : ''}" data-wep="${k}">${label}</button>`;
      }).join('');
    }
  }

  return {
    isEnabled,
    isActive,
    isEditing: () => !!editor,
    editLayout,
    getMove: () => !isActive() ? { f: 0, s: 0, j: 0, d: 0, w: 0 } : ({ f: joy.f, s: joy.s, j: jumpPulse ? 1 : 0, d: duckToggle ? 1 : 0, w: joy.w }),
    reset: resetInputs,
    update,
  };
}
