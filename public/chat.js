// CS:S-style team (U) and global (Y) text chat, with touch-friendly scope toggle and send/close buttons.
const TEAM_COLOR = { ct: '#99ccff', t: '#ff4040', spec: '#c8ccd2' };
const MAX_LINES = 30;
const FADE_MS = 8000;

export function createChat({ net, onOpen, onClose }) {
  const log = document.createElement('div');
  log.id = 'chat-log';
  const box = document.createElement('form');
  box.id = 'chat-box';
  box.innerHTML = `
    <button type="button" class="ch-scope" title="Switch All / Team">ALL</button>
    <input type="text" class="ch-in" maxlength="140" autocomplete="off" enterkeyhint="send">
    <button type="submit" class="ch-send">Send</button>
    <button type="button" class="ch-close" aria-label="Close">&#10005;</button>
  `;
  document.body.append(log, box);

  const scopeBtn = box.querySelector('.ch-scope');
  const input = box.querySelector('.ch-in');
  const closeBtn = box.querySelector('.ch-close');
  let shown = false;
  let scope = 'all';
  let fadeTimer = 0;

  const syncScope = () => {
    const team = scope === 'team';
    scopeBtn.textContent = team ? 'TEAM' : 'ALL';
    scopeBtn.classList.toggle('team', team);
    input.placeholder = team ? 'Say to team...' : 'Say to all...';
  };
  syncScope();

  const scheduleFade = () => {
    clearTimeout(fadeTimer);
    if (shown) return;
    fadeTimer = setTimeout(() => { if (!shown) log.classList.remove('vis'); }, FADE_MS);
  };

  function add(msg) {
    if (!msg || typeof msg.text !== 'string') return;
    const row = document.createElement('div');
    row.className = 'ch-msg' + (msg.scope === 'team' ? ' team' : '');

    if (msg.scope === 'team') {
      const tag = document.createElement('span');
      tag.className = 'ch-tag';
      tag.textContent = '(TEAM) ';
      row.append(tag);
    }
    if (msg.team === 'spec' || !msg.alive) {
      const st = document.createElement('span');
      st.className = 'ch-dead';
      st.textContent = msg.team === 'spec' ? '*SPEC* ' : '*DEAD* ';
      row.append(st);
    }
    const nm = document.createElement('span');
    nm.className = 'ch-name';
    nm.style.color = TEAM_COLOR[msg.team] ?? '#eee';
    nm.textContent = String(msg.name || 'Player');

    const body = document.createElement('span');
    body.className = 'ch-text';
    body.textContent = ': ' + msg.text;

    row.append(nm, body);
    log.append(row);
    while (log.children.length > MAX_LINES) log.firstChild.remove();
    log.scrollTop = log.scrollHeight;
    log.classList.add('vis');
    scheduleFade();
  }

  function open(nextScope) {
    if (nextScope === 'all' || nextScope === 'team') scope = nextScope;
    syncScope();
    shown = true;
    clearTimeout(fadeTimer);
    log.classList.add('vis');
    log.classList.add('open');
    box.style.display = 'flex';
    onOpen?.();
    setTimeout(() => input.focus(), 0);
  }

  function close(restorePlay = true) {
    if (!shown) return;
    shown = false;
    input.value = '';
    input.blur();
    box.style.display = 'none';
    log.classList.remove('open');
    scheduleFade();
    onClose?.(restorePlay);
  }

  scopeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    scope = scope === 'all' ? 'team' : 'all';
    syncScope();
    input.focus();
  });

  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    close(true);
  });

  box.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = input.value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 140);
    if (text) net.send({ t: 'chat', scope, text });
    close(true);
  });

  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.code === 'Escape') {
      e.preventDefault();
      close(true);
    } else if (e.code === 'Tab') {
      e.preventDefault();
      scope = scope === 'all' ? 'team' : 'all';
      syncScope();
    }
  });

  for (const ev of ['touchstart', 'touchend', 'mousedown']) {
    box.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
  }

  return { add, open, close, isOpen: () => shown };
}
