// DOM interaction tests; no WebGL, browser download or large map required on Termux.
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { MAPS, mapDetails, mapFolder } from './public/maps.js';
import { deviceDefaults } from './public/mobile.js';
const { window } = parseHTML('<!doctype html><html lang="fr"><body><div id="buymenu"></div></body></html>');
const storage = new Map([['playerName', 'Alice'], ['guideSeen', '1']]);
Object.assign(globalThis, {
  window, document: window.document, innerWidth: 800, innerHeight: 400,
  localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)) },
  addEventListener: window.addEventListener.bind(window), removeEventListener: window.removeEventListener.bind(window),
  requestAnimationFrame: () => 1, cancelAnimationFrame() {},
  fetch: async () => ({ ok: true, json: async () => ({}) }),
});
window.matchMedia = (q) => ({ matches: q === '(pointer: coarse)' });
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { maxTouchPoints: 1, language: 'fr' } });
document.pointerLockElement = null; document.fonts = { load: async () => [], check: () => false };
const click = (el) => { assert(el, 'click target exists'); el.dispatchEvent(new window.Event('click', { bubbles: true, cancelable: true })); };
const touchEvent = (el, type, id = 1, x = 100, y = 100) => {
  const event = new window.Event(type, { bubbles: true, cancelable: true }); event.changedTouches = [{ identifier: id, clientX: x, clientY: y }]; el.dispatchEvent(event);
};
const { createMainMenu, loadSettings } = await import('./public/menu.js');
const settings = loadSettings();
assert.equal(settings.renderScale, 0.75); assert(settings.texLow && settings.legibleHud);
assert.equal(deviceDefaults({ renderScale: 1 }, false).renderScale, 1);
let plays = 0;
const menu = createMainMenu({ inGame: () => false, onPlay: () => plays++, onSettings() {}, onQuit() {} });
menu.open(); click(document.querySelector('[data-a=play]')); assert.equal(plays, 1);
menu.open(); menu.options();
assert.equal(document.querySelector('[role=tab][aria-selected=true]').dataset.t, 'Touch', 'mobile settings open directly to touch controls');
click(document.querySelector('[data-t="Accessibilité"]'));
assert(document.querySelector('[data-k=darkFlash]')); assert(document.querySelector('[data-k=highContrast]'));
click(document.querySelector('[data-b=cancel]')); menu.close();

const { createBuyMenu, suggestedPurchases } = await import('./public/buy.js');
const state = { team: 'ct', money: 800, armor: 0, owned: ['usp', 'knife'], gr: {}, alive: true };
const sent = [];
const shop = createBuyMenu({ net: { send: (m) => sent.push(m) }, getState: () => state, canOpen: () => true, isMobile: () => true });
assert.deepEqual(suggestedPurchases(state), [{ id: 'kevlar', price: 650 }]);
shop.open();
const first = document.querySelector('.mobile-buy'); shop.refresh(); assert.equal(document.querySelector('.mobile-buy'), first, 'idle refresh preserves buttons under the player’s finger');
click(document.querySelector('[data-shop=recommended]')); assert.deepEqual(sent.at(-1), { t: 'buy', item: 'kevlar' });
click(document.querySelector('[data-choice="1"]')); // Heavy, including RPG
const rocket = [...document.querySelectorAll('[data-choice]')].find((b) => b.textContent.includes('RPG'));
assert(rocket?.disabled, 'unaffordable RPG disabled in the mobile shop');
state.money = 6000; shop.refresh();
const affordable = [...document.querySelectorAll('[data-choice]')].find((b) => b.textContent.includes('RPG'));
assert(!affordable.disabled); click(affordable); assert.equal(sent.at(-1).item, 'rocket');
click(document.querySelector('[data-shop=close]')); assert(!shop.isOpen());
for (const team of ['t', 'ct']) for (const money of [0, 200, 650, 800, 1500, 3000, 6000]) {
  const picks = suggestedPurchases({ ...state, team, money });
  assert(picks.reduce((sum, item) => sum + item.price, 0) <= money, 'recommended equipment stays within the visible budget');
  assert(!picks.some((p) => team === 't' && p.id === 'defuser'));
}

const { createTouchControls } = await import('./public/touch.js');
let reloads = 0, fire = 0, dropped = 0, used = 0, alive = true, nearBomb = false;
const weapons = {
  state: { cur: 'usp', reload: null }, ammo: { usp: { mag: 12, reserve: 100 } }, fov: () => 73.74,
  primaryDown: () => fire++, primaryUp: () => fire--, secondaryDown() {}, secondaryUp() {},
  canReload: () => !weapons.state.reload && weapons.ammo.usp.mag < 12,
  reload: () => { reloads++; weapons.state.reload = {}; }, drop: () => dropped++, inspect() {},
  owned: () => new Set(['usp', 'knife']), select() {}, hasAlt: () => false, isZoomed: () => 0,
};
const controls = createTouchControls({ player: { yaw: 0, pitch: 0 }, weapons, getSettings: () => settings, getYou: () => ({ ...state, alive }), getRound: () => ({ phase: 'live' }), uiOpen: () => false, isJoined: () => true, nearBomb: () => nearBomb, onUseStart: () => used++, onUseStop: () => used--, onMenu() {}, onTeam() {}, onBuy() {}, onScoresToggle() {}, onSpecNext() {}, onSpecView() {} });
controls.update(); assert(document.querySelector('#touch-ui').classList.contains('simple-controls'));
assert.equal(document.querySelector('#touch-drop').style.display, 'none');
assert.equal(document.querySelector('#touch-fire-l').style.display, 'none');
click(document.querySelector('[data-act=more]')); assert(!controls.isActive());
click(document.querySelector('[data-extra=drop]')); assert.equal(dropped, 1); assert(controls.isActive());
touchEvent(document.querySelector('#touch-fire-r'), 'touchstart'); assert.equal(fire, 1);
touchEvent(document.querySelector('#touch-fire-r'), 'touchend'); assert.equal(fire, 0);
touchEvent(document.querySelector('#touch-duck'), 'touchstart'); controls.update(); assert.equal(document.querySelector('#touch-duck').getAttribute('aria-pressed'), 'true');
window.dispatchEvent(new window.Event('blur')); controls.update(); assert.equal(controls.getMove().d, 0, 'backgrounding releases a crouch toggle');
weapons.ammo.usp.mag = 0; controls.update(); controls.update(); assert.equal(reloads, 1, 'automatic reload starts once');
nearBomb = true; controls.update(); assert.match(document.querySelector('#touch-use').getAttribute('aria-label'), /désamorcer/);
alive = false; controls.update(); assert.equal(document.querySelector('#touch-actions').style.display, 'none');

const { createTeamMenu } = await import('./public/team.js');
let picked = false;
const team = createTeamMenu({ net: { send: (m) => sent.push(m) }, getState: () => ({ team: 'spec' }), getRoster: () => [], drawPortrait() {}, mapName: 'GO-Mirage', onPick: () => picked = true });
team.open(); click(document.querySelector('.tm-auto')); assert(picked); assert.deepEqual(sent.at(-1), { t: 'team', team: 'ct' });
assert.equal(MAPS.length, 13); assert.equal(new Set(MAPS.map((m) => m.directory)).size, 13);
for (const m of MAPS) { assert.equal(mapFolder(m.id), m.directory); assert.equal(mapDetails(m.directory).id, m.id); assert(m.directory.startsWith({css:'Source-',csgo:'GO-',valorant:'Valorant-'}[m.game])); }
assert.equal(mapFolder('../secrets'), undefined);
storage.set('adminPass','qa');
globalThis.fetch=async (url)=>({ok:true,json:async()=>url.startsWith('/api/maps')?
 {css:['cs_office','Source-Office','de_split','de_dust2'],csgo:['de_mirage','GO-Mirage','de_overpass'],valorant:['Valorant-Split','de_split','de_split_d']}:
 url==='/api/info'?{map:'Valorant-Split'}:{ok:true,players:[]}});
const adminMenu=createMainMenu({inGame:()=>false,onPlay(){},onSettings(){},onQuit(){}});
adminMenu.open();await new Promise(r=>setTimeout(r,0));
const adminRoot=[...document.querySelectorAll('#mainmenu')].at(-1);
click(adminRoot.querySelector('[data-a=admin]'));await new Promise(r=>setTimeout(r,0));
const gameSelect=adminRoot.querySelector('[data-a=game]'),mapSelect=adminRoot.querySelector('[data-a=map]');
assert.match(gameSelect.textContent,/Valorant \(1\)/);
assert.equal(gameSelect.querySelector('[selected]').getAttribute('value'),'valorant');
assert.deepEqual([...mapSelect.querySelectorAll('option')].map(o=>o.textContent),['Valorant-Split']);
for(const [game,maps]of [['css',['Source-Office']],['csgo',['GO-Mirage']],['valorant',['Valorant-Split']]]){
 gameSelect.onchange({target:{value:game}});
 assert.deepEqual([...mapSelect.querySelectorAll('option')].map(o=>o.textContent),maps);
}
adminMenu.close();
console.log('UI ok: mobile defaults, accessible options, native buy buttons/budget, simple controls, multi-touch release, auto reload, one-tap team, map naming/aliases');
