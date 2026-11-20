// CS:GO-style radial buy menu (B); stays open after a purchase, right click goes back. Category ring first, then the items of one category; the mouse (pointer-locked, so we track a virtual
// cursor from movementX/Y) picks the wedge under it, click or number key buys. The server validates every purchase.
import { WEAPONS, BUY, canCarryGrenade } from './weapon-defs.js';
import { fireIcon } from './fire-icon.js';
import { GLYPH, glyphMid } from './hud.js';
import { is } from './binds.js';

const R0 = 92, R1 = 250;
const W = 660, C = W / 2;
const polar = (r, a) => [C + r * Math.sin(a), C - r * Math.cos(a)]; // a: radians clockwise from 12 o'clock

// an item's icon: guns from CS:S's weapon icon font (csd), armour from its HUD font (t vest, u vest + helmet), a picture for the rest
const ICON_PX = 50;
function icon(it, x, y) {
  if (WEAPONS[it.id]?.grenade === 'fire') return fireIcon(it.id, 48, x - 24, y - 24);
  const font = it.glyph ? "'Counter-Strike'" : GLYPH[it.icon] ? 'csd' : null, ch = it.glyph ?? GLYPH[it.icon];
  if (!font) return `<image href="ui/icons/${it.icon}.png" x="${x - 52}" y="${y - 24}" width="104" height="52" preserveAspectRatio="xMidYMid meet"/>`;
  return `<text x="${x}" y="${(y + glyphMid(font, ch) * ICON_PX).toFixed(1)}" class="gl" style="font-family: ${font}; font-size: ${ICON_PX}px">${ch}</text>`;
}
// A visible, one-tap proposal; the server still validates each individual purchase.
export function suggestedPurchases(st) {
  let money = st.money;
  const result = [], owned = st.owned ?? [];
  const add = (id, price = WEAPONS[id]?.price) => { if (money >= price) { result.push({ id, price }); money -= price; } };
  if (!owned.some((id) => WEAPONS[id]?.slot === 1)) {
    for (const id of [st.team === 'ct' ? 'm4a1' : 'ak47', 'mp5']) if (money >= WEAPONS[id].price) { add(id); break; }
  }
  if (st.armor < 100) { if (money >= 1000) add('vesthelm', 1000); else add('kevlar', 650); }
  else if (!st.helmet) add('vesthelm', 350);
  if (st.team === 'ct' && !st.kit) add('defuser', 200);
  return result;
}
export function createBuyMenu({ net, getState, canOpen = () => !!document.pointerLockElement, isMobile = () => false }) {
  const el = document.getElementById('buymenu');
  let mobileSignature = '';
  let level = null, hover = -1, cx = 0, cy = 0; // level: null closed, -1 categories, n = BUY[n]
  const mine = (it) => !it.team || it.team === getState().team; // the other team's weapons are not shown at all
  const entries = () => (level === -1 ? BUY.map((c) => { const it = c.items.find(mine) ?? c.items[0]; return { label: c.cat, icon: it.icon, glyph: it.glyph, cat: true }; }) : BUY[level].items.filter(mine));
  const usable = (it) => {
    const st = getState();
    if (it.cat) return true;
    if (it.team && it.team !== st.team) return false;
    if (st.money < it.price) return false;
    if (it.id === 'kevlar') return st.armor < 100;
    if (it.id === 'defuser') return !st.kit;
    if (it.id === 'vesthelm') return !(st.armor >= 100 && st.helmet);
    const w = WEAPONS[it.id];
    return w.grenade ? canCarryGrenade(st.gr ?? {}, it.id) : !st.owned.includes(it.id);
  };
  function render() {
    if (isMobile()) { renderMobile(); return; }
    el.classList.remove('mobile-shop');
    const list = entries(), n = list.length, step = (Math.PI * 2) / n, st = getState();
    let svg = `<circle cx="${C}" cy="${C}" r="${R1}" class="disc"/>`;
    list.forEach((it, i) => {
      const mid = i * step, a0 = mid - step / 2, a1 = mid + step / 2, big = step > Math.PI ? 1 : 0;
      const [x0, y0] = polar(R1, a0), [x1, y1] = polar(R1, a1), [x2, y2] = polar(R0, a1), [x3, y3] = polar(R0, a0);
      const ok = usable(it), cls = `${ok ? '' : 'off'} ${i === hover ? 'hot' : ''}`;
      const [ix, iy] = polar((R0 + R1) / 2 + 4, mid), [bx, by] = polar(R1 - 20, mid);
      const afford = it.price == null || st.money >= it.price;
      svg += `<g class="${cls}"><path class="wedge" d="M${x0} ${y0} A${R1} ${R1} 0 ${big} 1 ${x1} ${y1} L${x2} ${y2} A${R0} ${R0} 0 ${big} 0 ${x3} ${y3} Z"/>` +
        `<text x="${ix}" y="${iy - 30}" class="nm">${it.name ?? it.label}</text>` +
        icon(it, ix, iy) +
        (it.price != null ? `<text x="${ix}" y="${iy + 42}" class="pr${afford ? '' : ' bad'}">$${it.price}</text>` : '') +
        (it.team ? `<image href="ui/badge_${it.team}.png" x="${bx - 11}" y="${by - 11}" width="22" height="22" opacity=".9"/>` : '') + '</g>';
      svg += `<line x1="${x2}" y1="${y2}" x2="${x1}" y2="${y1}" class="sep"/>`; // thin divider on the wedge's trailing edge
    });
    // centre badge (a star in a ring) with the wedge numbers around it, like the CS:GO wheel
    svg += `<circle cx="${C}" cy="${C}" r="${R0 - 6}" class="core"/><image href="ui/badge_${st.team}.png" x="${C - 42}" y="${C - 56}" width="84" height="84"/>` +
      list.slice(0, 9).map((_, i) => { const [x, y] = polar(R0 - 22, i * step + step / 2 - 0.0); return `<text x="${x}" y="${y + 4}" class="key">${i + 1}</text>`; }).join('') +
      `<text x="${C}" y="${C + 50}" class="money">$${st.money}</text>` +
      (document.pointerLockElement
        ? `<circle cx="${C + cx}" cy="${C + cy}" r="5" class="dot"/>`
        : `<text x="${C}" y="${C + 68}" class="key">${level === -1 ? 'CLOSE' : 'BACK'}</text>`);
    el.innerHTML = `<svg viewBox="0 0 ${W} ${W}" width="${W}" height="${W}">${svg}</svg>`;
  }
  function renderMobile() {
    const st = getState(), signature = JSON.stringify([level, st.money, st.armor, st.helmet, st.kit, st.owned, st.gr]);
    el.classList.add('mobile-shop');
    if (signature === mobileSignature) return;
    mobileSignature = signature;
    const names = { Pistols: 'Pistolets', Heavy: 'Armes lourdes', SMGs: 'Mitraillettes', Rifles: 'Fusils', Gear: 'Équipement' };
    const picks = suggestedPurchases(st), total = picks.reduce((sum, p) => sum + p.price, 0);
    const label = (id) => WEAPONS[id]?.name ?? ({ vesthelm: 'Gilet + casque', kevlar: 'Gilet', defuser: 'Kit de désamorçage' })[id];
    el.innerHTML = `<section class="mobile-buy" role="dialog" aria-label="Acheter de l’équipement">
      <header><button type="button" data-shop="back">${level === -1 ? 'Fermer' : 'Retour'}</button><h2>${level === -1 ? 'Acheter' : (names[BUY[level].cat] ?? BUY[level].cat)}</h2><strong aria-label="Argent disponible">$${st.money}</strong></header>
      ${level === -1 && picks.length ? `<button type="button" class="buy-recommended" data-shop="recommended">Équipement conseillé · $${total}<small>${picks.map((p) => label(p.id)).join(' + ')}</small></button>` : ''}
      <div class="mobile-buy-grid">${entries().map((it, i) => {
        const ok = usable(it), status = it.cat ? 'Voir les armes' : st.money < it.price ? 'Solde insuffisant' : !ok ? 'Déjà équipé / limite atteinte' : `$${it.price}`;
        return `<button type="button" data-choice="${i}" ${ok ? '' : 'disabled'}><span>${it.cat ? (names[it.label] ?? it.label) : it.name}</span><small>${status}</small></button>`;
      }).join('')}</div><footer><button type="button" data-shop="close">Reprendre la partie</button></footer></section>`;
  }
  const open = () => { mobileSignature = ''; level = -1; hover = -1; cx = cy = 0; el.style.display = 'block'; el.classList.add('open'); render(); };
  const close = () => { level = null; el.style.display = 'none'; el.classList.remove('open'); };
  const back = () => { if (level === -1) close(); else { level = -1; hover = -1; render(); } };
  function choose(i) {
    const it = entries()[i];
    if (!it) return;
    if (it.cat) { level = i; hover = -1; render(); } else if (usable(it)) { net.send({ t: 'buy', item: it.id }); render(); } // stays open: buy more, right click / 0 to go back
  }
  function aim() { // wedge under the virtual cursor
    const n = entries().length, d = Math.hypot(cx, cy);
    if (d < R0 * 0.7) return -1;
    const a = (Math.atan2(cx, -cy) + Math.PI * 2) % (Math.PI * 2), step = (Math.PI * 2) / n;
    return Math.floor((a + step / 2) / step) % n;
  }
  function wedgeAt(clientX, clientY) {
    const svgEl = el.querySelector('svg');
    if (!svgEl) return { idx: -1, outside: true };
    const r = svgEl.getBoundingClientRect();
    const scale = W / (r.width || W);
    const x = (clientX - r.left) * scale - C, y = (clientY - r.top) * scale - C, d = Math.hypot(x, y);
    if (d < R0) return { idx: -1, outside: false };
    if (d > R1 + 24) return { idx: -1, outside: true };
    const n = entries().length, a = (Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2), step = (Math.PI * 2) / n;
    return { idx: Math.floor((a + step / 2) / step) % n, outside: false };
  }
  addEventListener('mousemove', (e) => {
    if (level === null || !document.pointerLockElement) return;
    e.stopPropagation();
    cx += e.movementX; cy += e.movementY;
    const d = Math.hypot(cx, cy); if (d > R1) { cx *= R1 / d; cy *= R1 / d; }
    const h = aim(); hover = h; render();
  }, { capture: true });
  addEventListener('mousedown', (e) => {
    if (level === null || !document.pointerLockElement) return;
    e.stopPropagation(); e.preventDefault();
    if (e.button === 2) { back(); return; } // right click: back a level (closes from the top)
    if (e.button !== 0) return;
    if (hover >= 0) choose(hover); else back();
  }, { capture: true });
  let touchHandled = false;
  el.addEventListener('touchstart', (e) => {
    if (level === null || document.pointerLockElement || isMobile()) return;
    const t = e.changedTouches[0]; if (!t) return;
    const hit = wedgeAt(t.clientX, t.clientY);
    if (hit.idx !== hover) { hover = hit.idx; render(); }
  }, { passive: true });
  el.addEventListener('touchend', (e) => {
    if (level === null || document.pointerLockElement || isMobile()) return;
    const t = e.changedTouches[0]; if (!t) return;
    touchHandled = true;
    e.preventDefault(); e.stopPropagation();
    const hit = wedgeAt(t.clientX, t.clientY);
    if (hit.outside) close();
    else if (hit.idx >= 0) choose(hit.idx);
    else back();
  }, { passive: false });
  el.addEventListener('click', (e) => {
    if (level === null || document.pointerLockElement) return;
    if (isMobile()) {
      const button = e.target.closest?.('button'); if (!button || button.disabled) return;
      e.stopPropagation();
      if (button.dataset.choice !== undefined) choose(Number(button.dataset.choice));
      else if (button.dataset.shop === 'close') close();
      else if (button.dataset.shop === 'back') back();
      else if (button.dataset.shop === 'recommended') { for (const item of suggestedPurchases(getState())) net.send({ t: 'buy', item: item.id }); }
      return;
    }
    if (touchHandled) { touchHandled = false; return; }
    e.stopPropagation();
    const hit = wedgeAt(e.clientX, e.clientY);
    if (hit.outside) close();
    else if (hit.idx >= 0) choose(hit.idx);
    else back();
  });
  addEventListener('keydown', (e) => {
    if (e.repeat) return;
    if (is('buy', e.code)) { if (level !== null) close(); else if (canOpen()) open(); e.preventDefault(); return; } // opens only while playing (not from the main menu)
    if (level === null) return;
    if (e.code === 'Escape') { close(); return; }
    const d = e.code.match(/^Digit(\d)$/)?.[1];
    if (d === undefined) return;
    e.preventDefault(); e.stopPropagation();
    if (Number(d) === 0) back(); else choose(Number(d) - 1);
  }, { capture: true });
  document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement) close(); });
  return { open, close, isOpen: () => level !== null, refresh: () => { if (level !== null) render(); } };
}
