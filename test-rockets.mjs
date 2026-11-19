import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
import {createGame} from './server/game.mjs';
import {WEAPONS,GRENADE} from './public/weapon-defs.js';
const box=(a,b)=>[...a,...b,1,0,0,b[0],-1,0,0,-a[0],0,1,0,b[1],0,-1,0,-a[1],0,0,1,b[2],0,0,-1,-a[2]];
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'pascs-rockets-'));
fs.writeFileSync(path.join(dir,'world.json'),JSON.stringify({collision:[box([-1000,-1000,-32],[1000,1000,0]),box([300,-1000,0],[308,1000,300])],spawns:{ct:[{o:[-700,0,1],yaw:0}],t:[{o:[700,0,1],yaw:180}]}}));
fs.writeFileSync(path.join(dir,'nav.json'),JSON.stringify({nodes:[],edges:[]}));
const savedNow=performance.now,savedInterval=globalThis.setInterval,savedClear=globalThis.clearInterval;
let clock=0,game;const timers=new Set(),clients=[];
performance.now=()=>clock;
globalThis.setInterval=(fn,delay)=>{const t={fn,delay,next:clock+delay};timers.add(t);return t;};
globalThis.clearInterval=t=>timers.delete(t);
const advance=s=>{const end=clock+s*1000;for(;clock<end;clock++)for(const t of timers)if(clock>=t.next){t.next+=t.delay;t.fn();}};
try {
  game=createGame({mapDir:dir,bots:false,teamSize:6});
  function player(team,o){const ws=new EventEmitter(),c={events:[],id:0};ws.readyState=1;ws.ping=()=>ws.emit('pong');ws.send=raw=>{const m=JSON.parse(raw);if(m.t==='welcome')c.id=m.id;else if(m.t==='snap')c.events.push(...m.ev);};c.send=m=>ws.emit('message',JSON.stringify(m));assert(game.connect(ws));c.send({t:'join',name:'Splash test',team});c.ent=game.ents.get(c.id);clients.push({ws,...c});return c;}
  const shooter=player('t'),near=player('ct'),far=player('ct'),shielded=player('ct'),outside=player('ct'),friend=player('t');
  advance(5.1);
  for(const [c,team,o]of [[shooter,'t',[0,0,1]],[near,'ct',[240,60,1]],[far,'ct',[100,150,1]],[shielded,'ct',[340,0,1]],[outside,'ct',[-100,100,1]],[friend,'t',[240,-80,1]]]){Object.assign(c.ent,{team,alive:true,health:200,armor:0});Object.assign(c.ent.p,{o,v:[0,0,0],yaw:0,pitch:0});}
  shooter.ent.money=WEAPONS.rocket.price;shooter.send({t:'buy',item:'rocket'});shooter.send({t:'fire',w:'rocket'});advance(.25);
  const boom=shooter.events.find(e=>e.e==='explode'&&e.w==='rocket');assert(boom,'rocket exploded on geometry');
  const damage=c=>200-c.ent.health;
  assert(damage(near)>0&&damage(far)>0,'one explosion hurts two enemies outside its flight path');
  assert(damage(near)>damage(far),'splash decreases with distance');
  for(const c of [near,far]){const chest=c.ent.p.o.map((v,i)=>v+(i===2?36:0)),distance=Math.hypot(...chest.map((v,i)=>v-boom.o[i]));assert(Math.abs(damage(c)-140*(1-distance/GRENADE.heRadius))<.02,'linear splash damage matches actual explosion distance');}
  assert.equal(damage(shielded),0,'solid wall blocks splash');assert.equal(damage(outside),0,'outside the 350-unit radius is safe');assert.equal(damage(friend),0,'teammates are protected');assert(damage(shooter)>0,'shooter can hurt himself');
  console.log('rocket splash ok: two indirect victims, near='+damage(near).toFixed(2)+' HP, far='+damage(far).toFixed(2)+' HP; radius='+GRENADE.heRadius+'; wall/outside/teammate protected; self damage');
}finally{game?.stop();for(const c of clients){c.ws.readyState=3;c.ws.emit('close');}performance.now=savedNow;globalThis.setInterval=savedInterval;globalThis.clearInterval=savedClear;fs.rmSync(dir,{recursive:true});}
