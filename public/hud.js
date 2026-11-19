import { fireIcon } from './fire-icon.js';
// CS:S-style HUD: rotating radar (top-left), death notices (top-right), health / armor / ammo panels (bottom),
// and the dynamic green crosshair. All DOM + one canvas; styling lives in index.html.
const TEAM_COLOR = { ct: 'rgb(153,204,255)', t: 'rgb(255,64,64)', h: 'rgb(235,235,235)' };
const NOTICE_TIME = 6; // hud_deathnotice_time
const RADAR_SIZE = 220, RADAR_UNITS = 2200; // pixels, world units across the radar

// CS:GO / CS2 killfeed modifier icons (white silhouettes matching the weapon font)
const kfSvg = (vb, w, h, title, body) => `<svg class="kf-ico" viewBox="${vb}" width="${w}" height="${h}" aria-label="${title}"><title>${title}</title>${body}</svg>`;
const KF_ICONS = {
  blind: kfSvg('0 0 24 24', 19, 19, 'Killed while flashed', '<path fill="#fff" d="M12 1l2 5.2L19 3l-2.8 4.8L22 10l-5.5 1.4L19 16l-5-2.2L12 19l-2-5.2L5 16l2.5-4.6L2 10l5.8-2.2L5 3l5 3.2z" opacity=".95"/><circle cx="12" cy="10" r="3" fill="#000"/><circle cx="12" cy="10" r="1.5" fill="#fff"/>'),
  flashAssist: kfSvg('0 0 24 24', 17, 17, 'Flash assist', '<path fill="#fff" d="M12 2l1.6 4.4L18 4l-2 4.2L21 10l-4.6 1.5L18.5 16l-4.5-2-2 4.5-2-4.5-4.5 2 2.1-4.5L3 10l5-1.8L6 4l4.4 2.4z"/>'),
  noscope: kfSvg('0 0 24 24', 19, 19, 'No-scope', '<circle cx="12" cy="12" r="7.5" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="6 3.5"/><path stroke="#fff" stroke-width="2" stroke-linecap="round" d="M12 1v4M12 19v4M1 12h4M19 12h4"/><path fill="#fff" d="M12 8.2l1.1 2.7 2.7 1.1-2.7 1.1-1.1 2.7-1.1-2.7-2.7-1.1 2.7-1.1z"/>'),
  airborne: kfSvg('0 0 24 24', 19, 19, 'Airborne kill', '<circle cx="13" cy="5.5" r="2.3" fill="#fff"/><path fill="#fff" d="M9.5 9.2l4.8-.6 3.2 2.6-1.3 1.5-2.3-1.6-1 3 2.8 2.4-1.3 1.5-3.6-2.7-2.4 2.8-1.5-1.3 2.9-3.6.7-2.5-2.6 1.1-.8-1.6z"/><path fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" d="M5 20.5c3.5-1.5 10.5-1.5 14 0M7.5 22.8c2.6-1 6.4-1 9 0" opacity=".75"/>'),
  thruSmoke: kfSvg('0 0 26 24', 21, 19, 'Through smoke', '<path fill="#fff" opacity=".78" d="M8.5 18h9.5a4.5 4.5 0 0 0 .8-8.9A5.5 5.5 0 0 0 8.2 7.5 4.2 4.2 0 0 0 8.5 18z"/><path fill="#fff" d="M1 11.2h17v2.2H1zM17.5 8.8l7 3.5-7 3.5z"/>'),
  wallbang: kfSvg('0 0 24 24', 20, 19, 'Wallbang', '<path fill="#fff" d="M10 2h4v20h-4z" opacity=".55"/><path fill="#fff" d="M1 10.8h7.5L6.5 8h3l3 4-3 4h-3l2-2.8H1zM15 10.8h4.2L22 9v6l-2.8-1.8H15z"/>'),
  dom: kfSvg('0 0 24 24', 17, 17, 'Dominating', '<path fill="#ffd24a" d="M3 18l1.5-9 4.5 4L12 6l3 7 4.5-4L21 18H3zm1 2h16v2H4v-2z"/>'),
  rev: kfSvg('0 0 24 24', 17, 17, 'Revenge', '<path fill="#ff6b4a" d="M12 2l3 6 6.5 1-4.7 4.5 1.1 6.5L12 17l-5.9 3 1.1-6.5L2.5 9 9 8z"/>'),
};
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
  function kill({ killer, killerTeam, assist, assistTeam, flashAssist, victim, victimTeam, icon, headshot, wallbang, thruSmoke, blind, noscope, airborne, dom, rev, local }) {
    const row = document.createElement('div');
    row.className = 'notice' + (local ? ' local' : '');
    const name = (n, t) => `<span style="color:${TEAM_COLOR[t]}">${n.replace(/[<>&]/g, '')}</span>`;
    const ch = GLYPH[icon ?? 'knife'], weapon = icon === 'molotov' || icon === 'incgrenade' ? fireIcon(icon, 28) : ch ? glyph('csd', ch, 28) : icon ? `<img src="ui/icons/${icon}.png" alt="">` : knifeIcon;
    const pre = `${dom ? KF_ICONS.dom : ''}${rev ? KF_ICONS.rev : ''}${blind ? KF_ICONS.blind : ''}`;
    const asHtml = assist ? `<span class="kf-plus">+</span>${flashAssist ? KF_ICONS.flashAssist : ''}${name(assist, assistTeam ?? killerTeam)}` : '';
    const mods = `${noscope ? KF_ICONS.noscope : ''}${airborne ? KF_ICONS.airborne : ''}${thruSmoke ? KF_ICONS.thruSmoke : ''}${wallbang ? KF_ICONS.wallbang : ''}${headshot ? glyph('csd', 'D', 28) : ''}`;
    row.innerHTML = `${pre}${name(killer, killerTeam)}${asHtml}${weapon}${mods}${name(victim, victimTeam)}`;
    feed.append(row);
    while (feed.children.length > 5) feed.firstChild.remove();
    setTimeout(() => row.remove(), NOTICE_TIME * 1000);
  }

  // ---------- ammo / scope ----------
  let lastAmmo = '', lastScope = null;
  function setAmmo(mag, reserve) {
    const k = `${mag}|${reserve}`;
    if (k === lastAmmo) return;
    lastAmmo = k;
    ammoBox.style.display = mag === null ? 'none' : '';
    ammoEl.textContent = mag ?? ''; reserveEl.textContent = reserve ?? '';
  }
  const setScope = (on) => {
    const b = !!on;
    if (b === lastScope) return;
    lastScope = b;
    scopeEl.style.display = b ? 'block' : 'none'; cross.style.display = b ? 'none' : '';
  };

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
  let lastRoundKey = '', lastStatsKey = '', lastBombKey = '';
  function setRound({ alive, time, phase, scores, banner, number, team, bomb }) {
    const m = Math.floor(time / 60), sec = Math.floor(time % 60), low = !bomb && phase === 'live' && time < 10;
    const key = `${alive.ct}|${alive.t}|${m}:${sec}|${low}|${!!bomb}|${phase}|${number}|${scores.ct}|${scores.t}|${banner}|${team}`;
    if (key === lastRoundKey) return;
    lastRoundKey = key;
    bar.ct.textContent = alive.ct; bar.t.textContent = alive.t;
    bar.time.textContent = `${m}:${String(sec).padStart(2, '0')}`;
    bar.time.classList.toggle('low', low);
    bar.box.classList.toggle('bomb', !!bomb); // planted: CS:S hides the clock; a blinking bomb takes its place
    bar.score.textContent = `${phase === 'freeze' ? 'Freeze time  -  ' : ''}Round ${number}   CT ${scores.ct}  -  ${scores.t} T`;
    bar.banner.textContent = banner; bar.banner.style.display = banner ? 'block' : 'none';
    bar.banner.style.color = banner.includes('Counter-Terrorists Win') ? TEAM_COLOR.ct : TEAM_COLOR.t;
    bar.box.dataset.team = team;
  }

  const moneyEl = $('money'), healthEl = $('health'), armorEl = $('armor'), armorIcon = $('armoricon'); // armour glyph (HUD font): 'a' kevlar, 'l' kevlar + helmet
  function setStats({ money, hp, armor, helmet }) {
    const key = `${money}|${hp}|${armor}|${!!helmet}`;
    if (key === lastStatsKey) return;
    lastStatsKey = key;
    moneyEl.textContent = '$ ' + money; healthEl.textContent = hp; armorEl.textContent = armor; armorIcon.textContent = helmet ? 'l' : 'a'; healthEl.parentElement.classList.toggle('low', hp <= 25);
  }

  // ---------- bomb: carrier icon (green in a bombsite), plant / defuse progress ----------
  const c4El = $('c4icon'), actEl = $('actbar'), actFill = $('actfill'), actText = $('acttext');
  let actStart = 0, actLen = 1, actKey = null;
  function setBomb({ carrying, inSite, act }) {
    const bKey = `${!!carrying}|${!!inSite}|${act?.k ?? ''}`;
    if (bKey !== lastBombKey) {
      lastBombKey = bKey;
      c4El.style.display = carrying ? 'block' : 'none'; c4El.classList.toggle('insite', !!inSite);
      if (!act) { actKey = null; actEl.style.display = 'none'; }
    }
    if (!act) return;
    const t = performance.now() / 1000, start = t - act.p * act.len; // progress runs smoothly between snapshots
    if (act.k !== actKey || Math.abs(start - actStart) > 0.15) { actStart = start; actLen = act.len; }
    actKey = act.k; actText.textContent = act.k === 'plant' ? 'Planting the bomb...' : 'Defusing the bomb...'; actEl.style.display = 'block';
  }

  // ---------- radar ----------
  const canvas = $('radar'), g = canvas.getContext('2d');
  const radarDpr = Math.min(devicePixelRatio, 1.5);
  canvas.width = canvas.height = Math.round(RADAR_SIZE * radarDpr);
  const coneGrad = g.createRadialGradient(canvas.width / 2, canvas.height / 2, 0, canvas.width / 2, canvas.height / 2, canvas.width * 0.42);
  coneGrad.addColorStop(0, 'rgba(255,255,255,0.35)'); coneGrad.addColorStop(1, 'rgba(255,255,255,0)');
  const img = new Image(); img.src = overview.src ?? 'ui/overview.png';
  let tinted = null, lastRadar = 0; // the CS:S radar is a green-tinted, high-contrast overview
  img.onload = () => {
    const c = document.createElement('canvas'); c.width = img.width; c.height = img.height;
    const cg = c.getContext('2d'); cg.filter = 'grayscale(1) sepia(1) hue-rotate(50deg) saturate(1.8) brightness(.5) contrast(1.3)'; cg.drawImage(img, 0, 0);
    tinted = c;
  };
  // overview image pixel of a world position (resource/overviews/<map>.txt convention, 1024px image)
  const toPx = (x, y) => [(x - overview.pos_x) / overview.scale, (overview.pos_y - y) / overview.scale];
  function drawRadar() {
    const nowMs = performance.now();
    if (actKey) actFill.style.width = Math.min(100, ((nowMs / 1000 - actStart) / actLen) * 100) + '%';
    if (nowMs - lastRadar < 33) return; // 30 Hz radar saves 2D canvas compositing overhead every high-FPS frame
    lastRadar = nowMs;
    const s = radarDpr, R = canvas.width, zoom = R / (RADAR_UNITS / overview.scale);
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
      const [bx, by] = toPx(bm.o[0], bm.o[1]), on = bm.s !== 'planted' || nowMs % 600 < 360;
      g.save(); g.translate(bx, by); g.rotate(-(player.yaw - Math.PI / 2)); g.scale(1 / zoom, 1 / zoom);
      if (on) {
        g.fillStyle = bm.s === 'planted' ? 'rgba(230,30,20,0.95)' : 'rgba(255,180,30,0.95)'; g.font = `${16 * s}px 'Counter-Strike'`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText('d', 0, 0); // the HUD font's C4
      }
      g.restore();
    }
    g.restore();
    // view cone (what the local player is looking at)
    g.fillStyle = coneGrad; g.beginPath(); g.moveTo(R / 2, R / 2); g.arc(R / 2, R / 2, R * 0.42, -Math.PI / 2 - 0.55, -Math.PI / 2 + 0.55); g.closePath(); g.fill();
    // local player: arrow at the centre
    g.fillStyle = TEAM_COLOR[team]; g.strokeStyle = '#000'; g.lineWidth = s;
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
  let lastGapStr = '', lastTrStr = '';
  function setSpread(spreadTan, vfovDeg, recoil) {
    const tanHalf = Math.tan((vfovDeg * Math.PI) / 360), halfH = innerHeight / 2;
    const px = (spreadTan / tanHalf) * halfH;
    const gapStr = Math.min(xh.gap + (xh.dynamic ? px : 0), 90).toFixed(1) + 'px';
    if (gapStr !== lastGapStr) { lastGapStr = gapStr; cross.style.setProperty('--gap', gapStr); }
    const rx = xh.followRecoil && recoil ? -(Math.tan((recoil[1] * Math.PI) / 180) / tanHalf) * halfH : 0;
    const ry = xh.followRecoil && recoil ? -(Math.tan((recoil[0] * Math.PI) / 180) / tanHalf) * halfH : 0;
    const trStr = rx || ry ? `translate(${rx.toFixed(1)}px,${ry.toFixed(1)}px)` : '';
    if (trStr !== lastTrStr) { lastTrStr = trStr; cross.style.transform = trStr; }
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
