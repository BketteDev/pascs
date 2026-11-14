import { fireIcon } from './fire-icon.js';
// CS:S-style HUD: rotating radar (top-left), death notices (top-right), health / armor / ammo panels (bottom),
// and the dynamic green crosshair. All DOM + one canvas; styling lives in index.html.
const TEAM_COLOR = { ct: 'rgb(153,204,255)', t: 'rgb(255,64,64)', h: 'rgb(235,235,235)' };
const NOTICE_TIME = 6; // hud_deathnotice_time
const RADAR_SIZE = 220, RADAR_UNITS = 2200; // pixels, world units across the radar

const wallbangIcon = `<svg viewBox="0 0 24 24" width="20" height="20"><path fill="#fff" d="M10 2h4v20h-4z" opacity=".55"/><path fill="#fff" d="M1 11h7l-2-3h3l3 4-3 4H6l2-3H1zM15 11h4l2-2v6l-2-2h-4z"/></svg>`; // the bullet went through a wall (CS:GO's penetration icon)
// letters of CS:S's icon fonts (csd: filled icons for the kill feed and weapon selection), as in its hud_textures.txt
export const GLYPH = { usp45: 'a', ak47: 'b', glock18: 'c', tmp: 'd', aug: 'e', deserteagle: 'f', hegrenade: 'h', g3sg1: 'i', knife: 'j', m3: 'k', mac10: 'l', p90: 'm', scout: 'n', sg550: 'o',
  ump45: 'q', awp: 'r', elites: 's', famas: 't', fiveseven: 'u', galil: 'v', m4a1: 'w', mp5: 'x', p228: 'y', m249: 'z', sg552: 'A', xm1014: 'B', c4: 'I', skull: 'C' }; // skull: the world killed them (a fall, a hurt trigger)
const SELECT_GLYPH = { ...GLYPH, c4: undefined }; // filled csd icons; flash and smoke have none there, so they keep their pictures; the bomb uses the HUD font's C4
// the icon glyphs are drawn well above the baseline, each by its own amount: measure the ink and shift it to the row's middle
for (const f of ['csd']) document.fonts.load(`10px ${f}`, 'a');
const shiftCache = {}, measure = document.createElement('canvas').getContext('2d');
/** Where a glyph's ink is centred, in em above its baseline (for SVG text, which sits on its baseline). */
export function glyphMid(font, ch) {
  if (!document.fonts.check(`10px ${font}`, ch)) return 0.35;
  measure.font = `100px ${font}`; const m = measure.measureText(ch);
  return (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 200;
}
function glyphShift(font, ch) { // em to move the glyph down
  const key = font + ch; if (key in shiftCache) return shiftCache[key];
  if (!document.fonts.check(`10px ${font}`, ch)) return 0; // not loaded yet: try again next time
  measure.font = `100px ${font}`; const m = measure.measureText(ch);
  return (shiftCache[key] = ((m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) - (m.fontBoundingBoxAscent - m.fontBoundingBoxDescent)) / 200);
}
const glyph = (font, ch, size) => `<span style="font: ${size}px ${font}; display: inline-block; line-height: 1; height: 1em; transform: translateY(${glyphShift(font, ch).toFixed(3)}em)">${ch}</span>`;
const knifeIcon = `<svg viewBox="0 0 64 20" width="64" height="20"><path fill="#fff" d="M2 9 L40 4 Q48 4 50 9 L50 11 Q48 15 40 15 L6 11 Z M50 6 h4 v8 h-4z M54 7 h9 v6 h-9z"/></svg>`;

export function createHud({ player, overview, getBots, getTeam, getBomb = () => null }) {
  const $ = (id) => document.getElementById(id);
  const feed = $('feed'), ammoEl = $('ammo'), reserveEl = $('reserve'), ammoBox = $('ammobox'), scopeEl = $('scope'), cross = $('cross');

  // ---------- death notices ----------
  function kill({ killer, killerTeam, victim, victimTeam, icon, headshot, wallbang, local }) {
    const row = document.createElement('div');
    row.className = 'notice' + (local ? ' local' : '');
    const name = (n, t) => `<span style="color:${TEAM_COLOR[t]}">${n.replace(/[<>&]/g, '')}</span>`;
    const ch = GLYPH[icon ?? 'knife'], weapon = icon === 'molotov' || icon === 'incgrenade' ? fireIcon(icon, 28) : ch ? glyph('csd', ch, 28) : icon ? `<img src="ui/icons/${icon}.png" alt="">` : knifeIcon;
    row.innerHTML = `${name(killer, killerTeam)}${weapon}${wallbang ? wallbangIcon : ''}${headshot ? glyph('csd', 'D', 28) : ''}${name(victim, victimTeam)}`;
    feed.append(row);
    while (feed.children.length > 5) feed.firstChild.remove();
    setTimeout(() => row.remove(), NOTICE_TIME * 1000);
  }

  // ---------- ammo / scope ----------
  function setAmmo(mag, reserve) {
    ammoBox.style.display = mag === null ? 'none' : '';
    ammoEl.textContent = mag ?? ''; reserveEl.textContent = reserve ?? '';
  }
  const setScope = (on) => { scopeEl.style.display = on ? 'block' : 'none'; cross.style.display = on ? 'none' : ''; };

  // ---------- weapon selection list (right edge, shown for a moment after switching or buying) ----------
  const wsel = $('wsel'); let wselTimer = 0;
  function showWeapons(list, cur) {
    wsel.innerHTML = list.map((w) => {
      const icon = w.icon ?? 'knife';
      let image;
      if (icon === 'molotov' || icon === 'incgrenade') {
        const label = icon === 'molotov' ? 'Molotov' : 'Incendiary Grenade';
        image = `<span class="w-fire" role="img" aria-label="${label}" style="--icon: url('/equipment-icons/${icon}.svg')"></span>`;
      } else if (icon === 'c4') {
        image = glyph("'Counter-Strike'", 'd', 34);
      } else if (SELECT_GLYPH[icon]) {
        image = glyph('csd', SELECT_GLYPH[icon], 34);
      } else {
        image = `<img src="ui/icons/${icon}.png" alt="" onerror="this.replaceWith('Knife')">`;
      }
      return `<div class="w${w.key === cur ? ' cur' : ''}"><span>${w.slot}</span>${image}</div>`;
    }).join('');
    wsel.style.opacity = 1; clearTimeout(wselTimer); wselTimer = setTimeout(() => { wsel.style.opacity = 0; }, 2200);
  }

  // ---------- round bar: players standing per team, round clock, scores, win banner ----------
  const bar = { ct: $('standct'), t: $('standt'), time: $('roundtime'), score: $('roundscore'), banner: $('banner'), box: $('roundbar') };
  function setRound({ alive, time, phase, scores, banner, number, team, bomb }) {
    bar.ct.textContent = alive.ct; bar.t.textContent = alive.t;
    const m = Math.floor(time / 60), sec = Math.floor(time % 60);
    bar.time.textContent = `${m}:${String(sec).padStart(2, '0')}`;
    bar.time.classList.toggle('low', !bomb && phase === 'live' && time < 10);
    bar.box.classList.toggle('bomb', !!bomb); // planted: CS:S hides the clock; a blinking bomb takes its place
    bar.score.textContent = `${phase === 'freeze' ? 'Freeze time  -  ' : ''}Round ${number}   CT ${scores.ct}  -  ${scores.t} T`;
    bar.banner.textContent = banner; bar.banner.style.display = banner ? 'block' : 'none';
    bar.banner.style.color = banner.includes('Counter-Terrorists Win') ? TEAM_COLOR.ct : TEAM_COLOR.t;
    bar.box.dataset.team = team;
  }

  const moneyEl = $('money'), healthEl = $('health'), armorEl = $('armor'), armorIcon = $('armoricon'); // armour glyph (HUD font): 'a' kevlar, 'l' kevlar + helmet
  function setStats({ money, hp, armor, helmet }) { moneyEl.textContent = '$ ' + money; healthEl.textContent = hp; armorEl.textContent = armor; armorIcon.textContent = helmet ? 'l' : 'a'; healthEl.parentElement.classList.toggle('low', hp <= 25); }

  // ---------- bomb: carrier icon (green in a bombsite), plant / defuse progress ----------
  const c4El = $('c4icon'), actEl = $('actbar'), actFill = $('actfill'), actText = $('acttext');
  let actStart = 0, actLen = 1, actKey = null;
  function setBomb({ carrying, inSite, act }) {
    c4El.style.display = carrying ? 'block' : 'none'; c4El.classList.toggle('insite', !!inSite);
    if (!act) { actKey = null; actEl.style.display = 'none'; return; }
    const t = performance.now() / 1000, start = t - act.p * act.len; // progress runs smoothly between snapshots
    if (act.k !== actKey || Math.abs(start - actStart) > 0.15) { actStart = start; actLen = act.len; }
    actKey = act.k; actText.textContent = act.k === 'plant' ? 'Planting the bomb...' : 'Defusing the bomb...'; actEl.style.display = 'block';
  }

  // ---------- radar ----------
  const canvas = $('radar'), g = canvas.getContext('2d');
  canvas.width = canvas.height = RADAR_SIZE * devicePixelRatio;
  const img = new Image(); img.src = overview.src ?? 'ui/overview.png';
  let tinted = null; // the CS:S radar is a green-tinted, high-contrast overview
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const cg = c.getContext('2d'); cg.filter = 'grayscale(1) sepia(1) hue-rotate(50deg) saturate(1.8) brightness(.5) contrast(1.3)'; cg.drawImage(img, 0, 0);
    tinted = c;
  };
  // overview image pixel of a world position (resource/overviews/<map>.txt convention, 1024px image)
  const toPx = (x, y) => [(x - overview.pos_x) / overview.scale, (overview.pos_y - y) / overview.scale];
  function drawRadar() {
    if (actKey) actFill.style.width = Math.min(100, ((performance.now() / 1000 - actStart) / actLen) * 100) + '%';
    const s = devicePixelRatio, R = RADAR_SIZE * s, zoom = R / (RADAR_UNITS / overview.scale);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, R, R);
    g.fillStyle = 'rgba(0,14,0,0.55)'; g.fillRect(0, 0, R, R);
    const [px, py] = toPx(player.o[0], player.o[1]);
    // rotate so the view direction points up
    g.save();
    g.translate(R / 2, R / 2); g.rotate(player.yaw - Math.PI / 2); g.scale(zoom, zoom); g.translate(-px, -py);
    g.globalAlpha = 0.9; if (tinted) g.drawImage(tinted, 0, 0, 1024, 1024); g.globalAlpha = 1;
    for (const b of getBots()) { // enemies show once spotted (visible), corpses as an X
      if (!b.dead && !b.spotted) continue;
      const [bx, by] = toPx(b.dead && b.ragdoll ? b.ragdoll.P[0][0] : b.origin[0], b.dead && b.ragdoll ? b.ragdoll.P[0][1] : b.origin[1]);
      g.save(); g.translate(bx, by); g.rotate(-(player.yaw - Math.PI / 2)); g.scale(1 / zoom, 1 / zoom);
      g.fillStyle = g.strokeStyle = TEAM_COLOR[b.team]; g.lineWidth = 2 * s;
      if (b.dead) { g.beginPath(); g.moveTo(-4 * s, -4 * s); g.lineTo(4 * s, 4 * s); g.moveTo(4 * s, -4 * s); g.lineTo(-4 * s, 4 * s); g.stroke(); }
      else { g.beginPath(); g.arc(0, 0, 3.5 * s, 0, Math.PI * 2); g.fill(); }
      g.restore();
    }
    const bm = getBomb(), team = getTeam(); // the bomb: Ts always know where it is, everyone sees it once planted
    if (bm?.o && (bm.s === 'planted' || (team === 't' && (bm.s === 'dropped' || bm.s === 'carried')))) {
      const [bx, by] = toPx(bm.o[0], bm.o[1]), on = bm.s !== 'planted' || performance.now() % 600 < 360;
      g.save(); g.translate(bx, by); g.rotate(-(player.yaw - Math.PI / 2)); g.scale(1 / zoom, 1 / zoom);
      if (on) {
        g.fillStyle = bm.s === 'planted' ? 'rgba(230,30,20,0.95)' : 'rgba(255,180,30,0.95)'; g.font = `${16 * s}px 'Counter-Strike'`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('d', 0, 0); // the HUD font's C4
      }
      g.restore();
    }
    g.restore();
    // view cone (what the local player is looking at)
    const cone = g.createRadialGradient(R / 2, R / 2, 0, R / 2, R / 2, R * 0.42);
    cone.addColorStop(0, 'rgba(255,255,255,0.35)'); cone.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = cone; g.beginPath(); g.moveTo(R / 2, R / 2); g.arc(R / 2, R / 2, R * 0.42, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); g.closePath(); g.fill();
    // local player: arrow at the centre
    g.fillStyle = TEAM_COLOR[getTeam()]; g.strokeStyle = '#000'; g.lineWidth = s;
    g.beginPath(); g.moveTo(R / 2, R / 2 - 7 * s); g.lineTo(R / 2 + 5 * s, R / 2 + 5 * s); g.lineTo(R / 2, R / 2 + 2 * s); g.lineTo(R / 2 - 5 * s, R / 2 + 5 * s); g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(0,0,0,0.6)'; g.lineWidth = 2 * s; g.strokeRect(s, s, R - 2 * s, R - 2 * s);
  }

  // ---------- hit marker: the crosshair flashes red for a moment (bigger and brighter on a headshot) ----------
  let markerTimer = 0;
  function hitMarker(head) {
    cross.classList.remove('hit', 'head'); void cross.offsetWidth; cross.classList.add('hit'); if (head) cross.classList.add('head');
    clearTimeout(markerTimer); markerTimer = setTimeout(() => cross.classList.remove('hit', 'head'), 180);
  }

  // ---------- crosshair: gap follows the weapon's current spread (cl_dynamiccrosshair) ----------
  // the crosshair gap is the real bullet spread on screen: tan(spread) over tan(half the vertical fov), in pixels
  function setSpread(spreadTan, vfovDeg) {
    const px = (spreadTan / Math.tan((vfovDeg * Math.PI) / 360)) * (innerHeight / 2);
    cross.style.setProperty('--gap', Math.min(xh.gap + (xh.dynamic ? px : 0), 90).toFixed(1) + 'px');
  }
  // crosshair look (devpanel.js): colour, alpha, length, thickness, gap, black outline, centre dot; dynamic = the gap follows the spread
  let xh = { gap: 3, dynamic: true };
  function setCrosshair(c) {
    xh = c;
    for (const [k, v] of [['--len', c.length], ['--th', c.thickness], ['--ol', c.outline]]) cross.style.setProperty(k, v + 'px');
    cross.style.setProperty('--col', c.color); cross.style.opacity = c.alpha; cross.classList.toggle('dot', !!c.dot);
  }
  // centre-screen message ("Switched to Burst-Fire mode", server notices)
  const noticeEl = $('notice');
  function notice(text) { noticeEl.textContent = text; noticeEl.style.opacity = 1; clearTimeout(noticeEl.t); noticeEl.t = setTimeout(() => { noticeEl.style.opacity = 0; }, 3500); }
  // CS:S damage indicator: the screen edge on the side the damage came from glows red (front = top, behind = bottom), then fades.
  // angle: direction of the attacker relative to where we look (0 = ahead, + = to the left)
  const edges = { top: $('dmg-top'), bottom: $('dmg-bottom'), left: $('dmg-left'), right: $('dmg-right') };
  function damageFrom(angle, strength) {
    const c = Math.cos(angle), sn = Math.sin(angle), k = 0.45 + 0.55 * strength;
    const amt = { top: Math.max(0, c), bottom: Math.max(0, -c), left: Math.max(0, sn), right: Math.max(0, -sn) };
    for (const [side, el] of Object.entries(edges)) {
      if (amt[side] < 0.25) continue;
      el.style.transition = 'none'; el.style.opacity = Math.min(1, amt[side] * k * 1.3);
      void el.offsetWidth; el.style.transition = 'opacity 1.4s ease-in'; el.style.opacity = 0;
    }
  }
  return { notice, setCrosshair, damageFrom, setBomb, hitMarker, showWeapons, kill, setAmmo, setScope, setSpread, setRound, setStats, update: drawRadar };
}
