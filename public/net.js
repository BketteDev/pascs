// WebSocket link to the authoritative game server (server/game.mjs).
export function connectToServer({ name, map, onSnap, onNotice = () => {} }) {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/game?map=${encodeURIComponent(map)}`);
  const net = { id: null, tickRate: 128, send: (o) => ws.readyState === 1 && ws.send(JSON.stringify(o)), connected: false, lastMsg: performance.now() }; // lastMsg: when the server last said anything (the connection warning)
  net.ready = new Promise((resolve, reject) => {
    ws.onopen = () => { net.connected = true; net.send({ t: 'join', name, team: 'spec' }); }; // in the main menu we watch; JOIN GAME picks a team
    ws.onerror = () => reject(new Error('cannot reach the game server'));
    ws.onclose = (e) => { net.connected = false; net.kicked = e.code === 4001; // kicked by the admin if (e.code === 4000) return location.reload(); // admin changed the map
    if (net.id === null) reject(new Error('server full')); };
    ws.onmessage = (m) => {
      net.lastMsg = performance.now();
      const d = JSON.parse(m.data);
      if (d.t === 'welcome') { net.id = d.id; net.tickRate = d.tickRate; }
      else if (d.t === 'notice') onNotice(String(d.text));
      else if (d.t === 'snap') { if (net.id !== null && !net.first) { net.first = d; resolve(d); } onSnap(d, performance.now() / 1000); }
    };
  });
  return net;
}
