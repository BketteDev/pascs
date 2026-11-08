// CS:GO-style team selection: the two teams side by side (title, "N Players - N bots", the map's agent standing in front of the team
// emblem), each team's roster down its own screen edge, Spectate / Auto Select bottom right. Opens after loading and on M.
// Picking (click, or 1 CT / 2 T / 5 auto / 6 spectate) sends {t:'team'} when it differs, closes and hands over to `onPick`.
const TEAMS = [
  { id: 't', title: 'Terrorists' },
  { id: 'ct', title: 'Counter-Terrorists' },
];
const TEAM_NAME = { ct: 'Counter-Terrorist', t: 'Terrorist' };
const esc = (t) => String(t).replace(/[<>&"]/g, '');
export function createTeamMenu({ net, getState, getRoster, drawPortrait, mapName, onPick }) {
  const el = document.createElement('div'); el.id = 'teammenu'; document.body.append(el);
  let shown = false, lastDraw = 0, raf = 0;
  const col = (t) => `<div class="tm-col ${t.id}" data-team="${t.id}"><div class="tm-head"><b>${t.title}</b><span class="tm-count"></span></div>` +
    `<div class="tm-disc"><img class="tm-emblem" src="ui/badge_${t.id}.png" alt=""><canvas width="380" height="520"></canvas></div></div>`;
  el.innerHTML = `<div class="tm-status"></div><div class="tm-side t"></div><div class="tm-side ct"></div>` +
    `<div class="tm-row">${col(TEAMS[0])}${col(TEAMS[1])}</div><div class="tm-note"></div>` +
    '<div class="tm-foot"><div class="tm-btn" data-team="spec"><svg viewBox="0 0 24 24"><rect x="2" y="6" width="14" height="12" rx="2"/><path d="M16 10l6-3v10l-6-3z"/></svg>Spectate</div>' +
    '<div class="tm-btn" data-team="auto"><svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-2.3-5.6"/><path d="M20 4v5h-5"/></svg>Auto Select</div></div>';
  const cols = Object.fromEntries(TEAMS.map((t) => [t.id, el.querySelector(`.tm-col.${t.id}`)]));
  const sides = { t: el.querySelector('.tm-side.t'), ct: el.querySelector('.tm-side.ct') };
  function roster() { // only text changes, so the portrait canvases keep running
    const list = getRoster(), mine = getState().team;
    el.querySelector('.tm-status').textContent = `${esc(mapName)} · ${mine === 'spec' ? 'Spectating' : 'Playing on team ' + TEAM_NAME[mine]}`;
    for (const t of TEAMS) {
      const mem = list.filter((p) => p.team === t.id), bots = mem.filter((p) => p.bot).length, humans = mem.length - bots, c = cols[t.id];
      c.classList.toggle('mine', t.id === mine);
      c.querySelector('.tm-count').textContent = `${humans} Player${humans === 1 ? '' : 's'} - ${bots} bot${bots === 1 ? '' : 's'}`;
      const humansOf = (team) => list.filter((x) => x.team === team && !x.bot).length;
      const full = t.id !== mine && (mine === 'spec' ? humansOf(t.id) > humansOf(t.id === 'ct' ? 't' : 'ct') : humansOf(t.id) >= humansOf(mine)); // joining would unbalance the teams
      c.classList.toggle('full', full);
      sides[t.id].innerHTML = mem.map((p) => `<div class="tm-p"><img src="ui/badge_${t.id}.png" alt="">${esc(p.name)}${p.bot ? ' <s>BOT</s>' : ''}</div>`).join('');
    }
    const lone = TEAMS.find((t) => !list.some((p) => p.team === t.id));
    el.querySelector('.tm-note').textContent = lone ? 'You have no opponent' : '';
  }
  function frame() {
    if (!shown) return;
    for (const t of TEAMS) drawPortrait(t.id, cols[t.id].querySelector('canvas'), performance.now() / 1000);
    raf = requestAnimationFrame(frame);
  }
  const fit = () => { el.style.zoom = Math.min(1, innerHeight / 760, innerWidth / 1100); };
  addEventListener('resize', fit);
  const open = () => { shown = true; el.style.display = 'flex'; fit(); roster(); cancelAnimationFrame(raf); frame(); };
  const close = () => { shown = false; el.style.display = 'none'; cancelAnimationFrame(raf); };
  function pick(team) {
    const st = getState();
    if (team === 'auto') { // the smaller team (fewer humans), else stay where the server balanced us
      const list = getRoster(), n = (id) => list.filter((p) => p.team === id && !p.bot).length;
      team = st.team !== 'spec' ? st.team : n('ct') <= n('t') ? 'ct' : 't';
    }
    if (cols[team]?.classList.contains('full')) return; // the server would refuse it anyway
    if (team !== st.team) net.send({ t: 'team', team });
    close(); onPick();
  }
  el.addEventListener('click', (e) => { const t = e.target.closest('[data-team]')?.dataset.team; if (t) pick(t); });
  addEventListener('keydown', (e) => {
    if (!shown || e.repeat) return;
    if (e.code === 'Escape') close();
    else if (e.code === 'Digit1') pick('ct'); else if (e.code === 'Digit2') pick('t'); else if (e.code === 'Digit5') pick('auto'); else if (e.code === 'Digit6') pick('spec');
    else return;
    e.preventDefault(); e.stopPropagation();
  }, { capture: true });
  return { open, close, isOpen: () => shown, refresh() { if (shown && performance.now() - lastDraw > 250) { lastDraw = performance.now(); roster(); } } };
}
