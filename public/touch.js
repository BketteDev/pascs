// Touch controls overlay for phones and tablets: virtual movement joystick (left),
// drag-to-aim + aim-while-firing (right), context-aware action buttons, tappable weapon bar,
// top utility bar (Menu / Scores / Team / Buy), and spectator controls.
import { WEAPONS, GRENADES } from './weapon-defs.js';

const IS_TOUCH_DEVICE = () => (typeof window !== 'undefined') && (
  window.matchMedia?.('(pointer: coarse)').matches || ((navigator.maxTouchPoints ?? 0) > 0 && !window.matchMedia?.('(pointer: fine)').matches)
);

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
      <button type="button" class="t-pill" data-act="menu">Menu</button>
      <button type="button" class="t-pill" data-act="scores">Tab</button>
      <button type="button" class="t-pill" data-act="team">Team</button>
      <button type="button" class="t-pill" data-act="chat">Chat</button>
      <button type="button" class="t-pill t-buy" data-act="buy">$ Buy</button>
    </div>
    <div id="touch-move-zone">
      <div id="touch-joy"><div id="touch-knob"></div></div>
    </div>
    <div id="touch-look-zone"></div>
    <button type="button" id="touch-fire-l" class="t-btn t-fire" aria-label="Fire">FIRE</button>
    <div id="touch-actions">
      <button type="button" id="touch-use" class="t-btn t-sm">USE</button>
      <button type="button" id="touch-drop" class="t-btn t-sm">DROP</button>
      <button type="button" id="touch-alt" class="t-btn t-sm">ALT</button>
      <button type="button" id="touch-reload" class="t-btn t-sm">RELOAD</button>
      <button type="button" id="touch-duck" class="t-btn t-sm">CROUCH</button>
      <button type="button" id="touch-jump" class="t-btn t-sm">JUMP</button>
      <button type="button" id="touch-fire-r" class="t-btn t-fire">FIRE</button>
    </div>
    <div id="touch-weapons"></div>
    <div id="touch-spec">
      <button type="button" class="t-pill" data-spec="view">1st / 3rd</button>
      <button type="button" class="t-pill" data-spec="next">Next Player</button>
    </div>
  `;
  document.body.append(root);

  const moveZone = root.querySelector('#touch-move-zone');
  const lookZone = root.querySelector('#touch-look-zone');
  const joyEl = root.querySelector('#touch-joy');
  const knobEl = root.querySelector('#touch-knob');
  const fireL = root.querySelector('#touch-fire-l');
  const fireR = root.querySelector('#touch-fire-r');
  const useBtn = root.querySelector('#touch-use');
  const dropBtn = root.querySelector('#touch-drop');
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
    return IS_TOUCH_DEVICE() || touchedRecently;
  };
  const isActive = () => isEnabled() && isJoined() && !uiOpen();

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
    joyEl.classList.remove('active');
    joyEl.style.left = ''; joyEl.style.top = '';
    knobEl.style.transform = 'translate(0px, 0px)';
  };

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

  // ---------- per-frame UI sync ----------
  let lastWepSig = '';
  let lastAlt = null;
  let lastAlive = null;
  let lastWasUi = false;

  function update() {
    const enabled = isEnabled();
    document.body.classList.toggle('touch-mode', enabled);
    if (!enabled) {
      root.style.display = 'none';
      resetInputs();
      return;
    }

    const active = isActive();
    if (!active && lastWasUi !== true) resetInputs();
    lastWasUi = !active;
    root.style.display = active ? 'block' : 'none';
    if (!active) return;

    const you = getYou();
    const alive = !!you.alive;
    if (lastAlive && !alive) duckToggle = false;
    lastAlive = alive;

    const showLeftFire = !!(getSettings().touchLeftFire ?? true);
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
    reloadBtn.classList.toggle('dim', !canRel);

    const canDrop = cur === 'c4' || def?.slot === 1 || def?.slot === 2;
    dropBtn.style.display = canDrop ? 'flex' : 'none';

    const defuseReady = nearBomb();
    useBtn.textContent = defuseReady ? 'DEFUSE' : 'USE';
    useBtn.classList.toggle('hot', defuseReady);

    duckBtn.classList.toggle('active', duckToggle);
    fireR.textContent = def?.c4 ? 'PLANT' : def?.grenade ? 'THROW' : 'FIRE';
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
    getMove: () => ({ f: joy.f, s: joy.s, j: jumpPulse ? 1 : 0, d: duckToggle ? 1 : 0, w: joy.w }),
    reset: resetInputs,
    update,
  };
}
