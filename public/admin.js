// F4 admin menu: password (server.config.json "adminPassword") + map, team size and max players. The server checks the password on every request.
export function createAdminMenu() {
  const el = document.getElementById('adminmenu');
  el.innerHTML = '<b>Admin</b><input type="password" placeholder="Admin password" autocomplete="current-password"><label>Map <select></select></label><label>Team size (bots fill) <input type="number" min="1" max="16" class="ts"></label><label>Max players (humans) <input type="number" min="1" max="32" class="mp"></label><button>Apply (everyone reloads)</button><small></small>';
  const [teamSize, maxPlayers] = [el.querySelector('.ts'), el.querySelector('.mp')];
  const [pass, select, button, status] = [el.querySelector('input'), el.querySelector('select'), el.querySelector('button'), el.querySelector('small')];
  try { pass.value = sessionStorage.getItem('adminPass') ?? ''; } catch {}
  button.onclick = async () => {
    status.textContent = '...';
    const r = await fetch('/api/admin', { method: 'POST', body: JSON.stringify({ password: pass.value, map: select.value, teamSize: Number(teamSize.value), maxPlayers: Number(maxPlayers.value) }) }).then((x) => x.json()).catch(() => ({ msg: 'server unreachable' }));
    status.textContent = r.msg;
    if (r.ok) try { sessionStorage.setItem('adminPass', pass.value); } catch {}
  };
  pass.onkeydown = (e) => { if (e.key === 'Enter') button.click(); };
  return {
    isOpen: () => el.style.display === 'flex',
    async open() {
      el.style.display = 'flex'; status.textContent = ''; pass.focus();
      const [maps, info] = await Promise.all([fetch('/api/maps').then((r) => r.json()).catch(() => []), fetch('/api/info').then((r) => r.json()).catch(() => ({}))]);
      teamSize.value = info.teamSize ?? ''; maxPlayers.value = info.maxPlayers ?? '';
      select.innerHTML = maps.map((m) => `<option${m === window.__map ? ' selected' : ''}>${m}</option>`).join('');
    },
    close() { el.style.display = 'none'; },
  };
}
