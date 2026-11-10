// The CS:S scoreboard (hold Tab): map name, the two team scores, then per team: avatar, name, score (frags), deaths, latency.
// There are no profile pictures, so the avatar is the team badge. Dead players are dimmed; our own row is outlined.
const esc = (s) => String(s).replace(/[<>&"]/g, '');
export function createScoreboard({ getRoster, getRound, getMyId, mapName }) {
  const el = document.getElementById('scoreboard');
  let shown = false, last = 0;
  const team = (id, title) => {
    const list = getRoster().filter((p) => p.team === id).sort((a, b) => (b.k ?? 0) - (a.k ?? 0) || (a.dt ?? 0) - (b.dt ?? 0));
    const rows = list.map((p) => `<tr class="${p.alive ? '' : 'dead'}${p.id === getMyId() ? ' me' : ''}">
      <td><img src="ui/badge_${id}.png" alt=""></td><td class="nm">${esc(p.name)}</td><td>${p.alive ? '' : 'DEAD'}</td>
      <td>${p.k ?? 0}</td><td>${p.dt ?? 0}</td><td>${p.bot ? 'BOT' : p.pg ?? 0}</td></tr>`).join('');
    return `<div class="sb-team ${id}"><div class="sb-title">${title}<span>${list.filter((p) => p.alive).length} / ${list.length} Players Alive</span></div>
      <table><tr class="hd"><th></th><th class="nm">Player</th><th></th><th>Score</th><th>Deaths</th><th>Latency</th></tr>${rows}</table></div>`;
  };
  function render() {
    const r = getRound();
    el.innerHTML = `<div class="sb-top"><span>${esc(mapName)}</span><b class="ct">${r.scores?.ct ?? 0}</b><b class="t">${r.scores?.t ?? 0}</b><span>Round ${r.number ?? 1}</span></div>
      <div class="sb-cols">${team('ct', 'Counter-Terrorists')}${team('t', 'Terrorists')}</div>`;
  }
  return {
    show(on) { shown = on; el.style.display = on ? 'block' : 'none'; if (on) render(); },
    update() { if (shown && performance.now() - last > 250) { last = performance.now(); render(); } }, // live while held
  };
}
