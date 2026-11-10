// Tiny static server: public/ plus three.js from node_modules at /vendor/.
import http from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import zlib from 'zlib';
import { WebSocketServer } from 'ws';
import { createGame } from './server/game.mjs';

const pub = path.join(import.meta.dirname, 'public');
const vendor = path.join(import.meta.dirname, 'node_modules', 'three', 'build');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.png': 'image/png', '.mp3': 'audio/mpeg' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (url === '/api/maps') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(builtMaps()));
  if (url === '/api/admin' && req.method === 'POST') return admin(req, res);
  if (url === '/api/info') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ map: config.map, mode: config.mode ?? 'classic', teamSize: game.teamSize, maxPlayers: game.maxPlayers }));
  const [dir, rel] = url.startsWith('/vendor/') ? [vendor, url.slice(8)] : [pub, url === '/' ? 'index.html' : url];
  const file = path.join(dir, rel);
  if (!file.startsWith(dir)) return res.writeHead(403).end(); // block ../ escapes
  serve(req, res, file);
});
// Static files: revalidated by ETag (a reload re-downloads nothing that didn't change) and gzipped when that pays off: map geometry
// (world.bin) shrinks ~6x. Each file is compressed once into .gzcache (next to the code, never into the mounted assets) and reused.
const GZIP = new Set(['.bin', '.json', '.js', '.html', '.css']), gzDir = path.join(import.meta.dirname, '.gzcache'), gzJobs = new Map();
function gzipped(file, st) { // -> path of an up-to-date gzip copy
  const out = path.join(gzDir, crypto.createHash('sha1').update(file).digest('hex') + '.gz');
  try { if (fs.statSync(out).mtimeMs >= st.mtimeMs) return Promise.resolve(out); } catch { /* not cached yet */ }
  if (!gzJobs.has(out)) gzJobs.set(out, fs.promises.readFile(file).then((data) => new Promise((ok, fail) => zlib.gzip(data, { level: 6 }, (e, z) => (e ? fail(e) : ok(z)))))
    .then(async (z) => { await fs.promises.mkdir(gzDir, { recursive: true }); await fs.promises.writeFile(out + '.tmp', z); await fs.promises.rename(out + '.tmp', out); return out; })
    .finally(() => gzJobs.delete(out)));
  return gzJobs.get(out);
}
function serve(req, res, file) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.writeHead(404).end('not found');
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`, head = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', ETag: etag, 'Cache-Control': 'no-cache', Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, head).end();
    const send = (f, extra) => fs.createReadStream(f).on('error', () => res.destroy()).pipe(res.writeHead(200, { ...head, ...extra }));
    if (!GZIP.has(path.extname(file)) || !/\bgzip\b/.test(req.headers['accept-encoding'] ?? '')) return send(file, { 'Content-Length': st.size });
    gzipped(file, st).then((gz) => send(gz, { 'Content-Encoding': 'gzip', 'Content-Length': fs.statSync(gz).size }), () => send(file, { 'Content-Length': st.size }));
  });
}
// One game per server run, set in server.config.json: { port, map, teamSize } (teamSize = players per team, bots fill empty slots; null = the map's default)
const configFile = path.join(import.meta.dirname, 'server.config.json'); // optional: Docker passes the same settings as environment variables
const config = { port: 6767, map: 'de_dust2', teamSize: null, ...(fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {}) };
if (process.env.PORT) config.port = Number(process.env.PORT); // environment overrides, e.g. PORT=7000 MAP=de_inferno TEAM_SIZE=1 npm start
if (process.env.MAP) config.map = process.env.MAP;
if (process.env.TEAM_SIZE) config.teamSize = Number(process.env.TEAM_SIZE);
if (process.env.ADMIN_PASSWORD) config.adminPassword = process.env.ADMIN_PASSWORD;
if (process.env.MODE) config.mode = process.env.MODE; // 'range': shooting range (target bots, no rounds)
const builtMaps = () => fs.readdirSync(path.join(pub, 'maps')).filter((m) => fs.existsSync(path.join(pub, 'maps', m, 'world.json')));
if (!builtMaps().includes(config.map)) { console.error(`map "${config.map}" is not built: public/maps/${config.map}/world.json is missing (npm run build)`); process.exit(1); }
const wss = new WebSocketServer({ server, path: '/game' });
const newGame = () => createGame({ mapDir: path.join(pub, 'maps', config.map), teamSize: config.teamSize, maxPlayers: config.maxPlayers, bots: config.bots !== false, range: config.mode === 'range' });
let game = newGame();
// map / team size / max players change: a fresh game; everyone is disconnected with code 4000 and their page reloads into it
function restart({ map, teamSize, maxPlayers, bots }) {
  game.stop();
  for (const ws of wss.clients) ws.close(4000, 'map change');
  Object.assign(config, { map, teamSize, maxPlayers, bots });
  game = newGame();
  console.log(`admin: ${map}, ${game.teamSize}v${game.teamSize}, max ${game.maxPlayers} players, bots ${game.bots ? 'on' : 'off'}`);
}
// Server Admin (main menu): POST { password } checks it; + { list: true } the players, { kick: id }, or { map, teamSize, maxPlayers, bots } restarts. Password = adminPassword in server.config.json; no password set = admin off.
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
function admin(req, res) {
  let body = '';
  req.on('data', (c) => { body += c; if (body.length > 4096) req.destroy(); });
  req.on('end', () => {
    const reply = (code, msg, extra) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify({ ok: code === 200, msg, ...extra }));
    let m; try { m = JSON.parse(body); } catch { return reply(400, 'bad request'); }
    if (!config.adminPassword) return reply(403, 'admin is off: set adminPassword in server.config.json');
    if (!crypto.timingSafeEqual(digest(m.password), digest(config.adminPassword))) return reply(401, 'wrong password');
    if (m.list) return reply(200, 'ok', { players: game.players(), bots: game.bots });
    if (m.kick !== undefined) return game.kick(Number(m.kick)) ? reply(200, 'kicked') : reply(404, 'no such player');
    if (m.map === undefined) return reply(200, 'ok'); // login check only
    const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
    if (!builtMaps().includes(m.map)) return reply(400, 'unknown map');
    if (!int(m.teamSize, 1, 16)) return reply(400, 'team size must be 1-16');
    if (!int(m.maxPlayers, 1, 32)) return reply(400, 'max players must be 1-32');
    if (typeof m.bots !== 'boolean') return reply(400, 'bots must be on or off');
    reply(200, 'restarting...'); restart(m);
  });
}
wss.on('connection', (ws) => { if (!game.connect(ws)) ws.close(1013, 'server full'); });
server.listen(config.port, '0.0.0.0', () => {
  const lan = Object.values(os.networkInterfaces()).flat().filter((i) => i.family === 'IPv4' && !i.internal).map((i) => `http://${i.address}:${config.port}`);
  console.log(`${config.map}, ${game.range ? 'shooting range, ' + game.teamSize + ' targets' : game.teamSize + 'v' + game.teamSize}, 128 Hz
  you:     http://localhost:${config.port}
  friends: ${lan.join('  ') || '(no network found)'}  (allow Node through the Windows firewall / forward the port for friends outside your network)`);
});
