// Reconnect with a per-tab token; the server reserves the player for 30 seconds.
export function connectToServer({ name, map, onSnap, onNotice = () => {}, onChat = () => {}, onResume = () => {} }) {
  let ws, retryTimer, watchdog, attempts = 0, stopped = false, resuming = false;
  let token = null;
  const storageKey = 'resume:' + location.host + ':' + map;
  try { token = sessionStorage.getItem(storageKey); } catch {}
  const net = { id: null, tickRate: 128, snapshotRate: 32, connected: false, reconnecting: false, lastMsg: performance.now(), actionSeq: 0, ammoShots: [] };
  net.send = (o) => {
    if (!net.connected || ws?.readyState !== 1 || ws.bufferedAmount > 64 * 1024) return false;
    if (['fire', 'reload', 'weapon'].includes(o.t)) {
      o = { ...o, aq: ++net.actionSeq };
      if (o.t === 'fire') net.ammoShots.push({ seq: o.aq, w: o.w });
    }
    ws.send(JSON.stringify(o)); return true;
  };
  let readyResolve, readyReject;
  net.ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const forget = () => { token = null; try { sessionStorage.removeItem(storageKey); } catch {} };
  const schedule = () => {
    if (stopped || retryTimer) return;
    net.reconnecting = true;
    retryTimer = setTimeout(() => { retryTimer = null; open(); }, Math.min(500 * 2 ** Math.min(attempts++, 4), 5000));
  };
  function open() {
    if (stopped) return;
    const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/game`);
    ws = socket; net.lastMsg = performance.now();
    const handshakeTimeout = setTimeout(() => socket.close(), 10000);
    socket.onopen = () => { socket.send(JSON.stringify({ t: 'join', name: net.name ?? name, team: 'spec', resume: token })); };
    socket.onerror = () => {}; // onclose owns retry; transient errors must not reject the initial load.
    socket.onclose = (e) => {
      clearTimeout(handshakeTimeout);
      if (ws !== socket) return;
      net.connected = false;
      if (e.code === 4000) { forget(); location.reload(); return; }
      if ([4001, 4002, 1000].includes(e.code)) {
        stopped = true; net.reconnecting = false; net.kicked = e.code === 4001; net.ended = e.code === 4002 ? 'Session opened in another connection' : 'Disconnected'; forget();
        if (!net.first) readyReject(new Error(net.kicked ? 'You were kicked' : net.ended));
        return;
      }
      if (e.code === 1013 && !net.first) { stopped = true; net.reconnecting = false; readyReject(new Error('Server full: try again shortly')); return; }
      schedule();
    };
    socket.onmessage = (m) => {
      if (ws !== socket) return;
      let d; try { d = JSON.parse(m.data); } catch { return; }
      net.lastMsg = performance.now();
      if (d.t === 'welcome') {
        clearTimeout(handshakeTimeout); attempts = 0;
        resuming = !!net.first || !!d.resumed;
        if (!d.resumed) { net.actionSeq = 0; net.ammoShots = []; }
        net.id = d.id; net.tickRate = d.tickRate; net.snapshotRate = d.snapshotRate ?? 32;
        token = d.resume; try { if (token) sessionStorage.setItem(storageKey, token); } catch {}
      } else if (d.t === 'notice') onNotice(String(d.text));
      else if (d.t === 'chat') onChat(d);
      else if (d.t === 'snap' && net.id !== null) {
        net.actionSeq = Math.max(net.actionSeq, d.you.ammoAck ?? 0);
        net.ammoShots = net.ammoShots.filter((s) => s.seq > (d.you.ammoAck ?? 0));
        if (resuming) { net.ammoShots = []; onResume(d); resuming = false; }
        net.connected = true; net.reconnecting = false;
        if (!net.first) { net.first = d; readyResolve(d); }
        onSnap(d, performance.now() / 1000);
      }
    };
  }
  const reconnectNow = () => {
    if (stopped || retryTimer) return;
    if (performance.now() - net.lastMsg > 8000) {
      if (ws?.readyState === 1 || ws?.readyState === 0) ws.close();
      else { clearTimeout(retryTimer); retryTimer = null; open(); }
    }
  };
  watchdog = setInterval(reconnectNow, 2000);
  const wake = () => { if (!document.hidden) reconnectNow(); };
  addEventListener('online', reconnectNow); document.addEventListener('visibilitychange', wake);
  net.close = () => { stopped = true; clearTimeout(retryTimer); clearInterval(watchdog); removeEventListener('online', reconnectNow); document.removeEventListener('visibilitychange', wake); ws?.close(1000, 'leaving'); };
  open();
  return net;
}
