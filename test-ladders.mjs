import assert from 'node:assert/strict';
import {Player,makeWorld,TICK} from './public/physics.js';
const box=(a,b)=>[...a,...b,1,0,0,b[0],-1,0,0,-a[0],0,1,0,b[1],0,-1,0,-a[1],0,0,1,b[2],0,0,-1,-a[2]];
const floor=box([-1000,-1000,-32],[1000,1000,0]), wall=box([0,-64,0],[800,64,128]);
const ladder={min:[-2,-16,0],max:[0,16,128]};
const world=makeWorld([floor,wall],[ladder]);
const run=(p,s,input)=>{for(let i=0;i<Math.round(s/TICK);i++)p.tick(input);};
const p=new Player(world,[-18,0,0.1]);p.yaw=0;
run(p,.4,{fwd:1});assert(p.o[2]>50&&p.onLadder,'forward climbs a ladder');
const z=p.o[2];run(p,.2,{});assert(Math.abs(p.o[2]-z)<.1,'release input holds position');
run(p,.2,{fwd:-1});assert(p.o[2]<z-25,'backward descends');
p.tick({jump:true});assert(!p.onLadder&&p.v[0]<-100,'jump detaches away from the wall');
run(p,.15,{fwd:1});assert(!p.onLadder,'jump has a reattach cooldown');
const top=new Player(world,[-18,0,.1]);run(top,2,{fwd:1});assert(top.o[0]>16&&top.o[2]>=128,'forward exits onto the top platform');
const side=new Player(world,[-18,0,50]);side.onLadder=true;run(side,.5,{side:1});assert(!side.onLadder,'strafe leaves the ladder at its edge');
const bare=new Player(makeWorld([floor,wall]),[-18,0,.1]);run(bare,1,{fwd:1});assert(bare.o[2]<1,'ordinary walls cannot be climbed');
const bottom=new Player(world,[-18,0,50]);bottom.onLadder=true;run(bottom,1,{fwd:-1});assert(!bottom.onLadder&&bottom.onGround&&bottom.o[0]<-30,'backward leaves the ladder at ground level');
const ceiling=box([-64,-64,140],[64,64,160]);const blocked=new Player(makeWorld([floor,wall,ceiling],[ladder]),[-18,0,.1]);run(blocked,2,{fwd:1});assert(blocked.o[2]<80,'a ceiling blocks ascent and top transfer');
console.log('ladders ok: climb, hang, descend, jump, cooldown, top exit, sideways detach, ordinary walls');


// Check the imported ladder volumes against real collision on every available map.
const {default:fs}=await import('node:fs');
const {default:path}=await import('node:path');
const {bspLadders}=await import('./tools/ladder-data.mjs');
const {fillMirageAmmo}=await import('./tools/mirage-ammo.mjs');
const mapRoot=path.join(import.meta.dirname,'public/maps');let total=0,maps=0;
for(const name of fs.readdirSync(mapRoot)) {
  const file=path.join(mapRoot,name,'world.json');if(!fs.existsSync(file))continue;
  const j=JSON.parse(fs.readFileSync(file));assert(Array.isArray(j.ladders),'ladder metadata exists: '+name);maps++;
  const w=makeWorld(j.collision.concat(j.playerOnly??[]),j.ladders);
  for(const l of j.ladders) {
    let climbed=false;
    for(const axis of [0,1])for(const sign of [-1,1]) {
      const o=l.min.map((x,k)=>(x+l.max[k])/2);o[axis]=(sign<0?l.min[axis]:l.max[axis])+sign*17.9;o[2]=(l.min[2]+l.max[2])/2;
      const q=new Player(w,o);q.yaw=axis===0?(sign<0?0:Math.PI):(sign<0?Math.PI/2:-Math.PI/2);
      if(q.tr(o,o).startSolid)continue;run(q,24*TICK,{fwd:1});
      if(q.o[2]>o[2]+15)climbed=true;
    }
    assert(climbed,'a clear side of the real ladder can be climbed: '+name+' '+JSON.stringify(l));total++;
  }
  if(name==='GO-Mirage') {
    const sourceBsp=path.join(import.meta.dirname,'../exports/asset-import/mapcs/MIRAGE MAP/de_mirage_csgo_new.bsp');
    if(fs.existsSync(sourceBsp))assert.deepEqual(j.ladders,bspLadders(fs.readFileSync(sourceBsp)));
    for(const [i,l] of j.ladders.entries()) {
      const axis=i===0?0:1,sign=i===0?-1:1,o=l.min.map((x,k)=>(x+l.max[k])/2);o[axis]=(sign<0?l.min[axis]:l.max[axis])+sign*17.9;o[2]=l.min[2]+.1;
      const q=new Player(w,o);q.yaw=i===0?0:-Math.PI/2;run(q,3,{fwd:1});
      assert(!q.onLadder&&q.onGround&&q.o[2]>l.max[2]-36,'Mirage ladder exits onto a clear landing');
    }
    assert.equal(j.props.find(g=>/Artillery02/.test(g.name)).count,150408,'all nine shell racks contain their ammunition geometry');
  }
}
const cage={model:'models/props/de_inferno/bomb_shells_1_wood.mdl',o:[0,0,0],a:[0,90,0]};
const pallet={model:'models/props/de_inferno/shell_pallet.mdl',o:[.5,0,0],a:[0,0,0]};
const props=[cage,pallet];assert.equal(fillMirageAmmo(props),1);assert.equal(pallet.model,cage.model.replace('_wood','_metal'));assert.equal(fillMirageAmmo(props),0,'never duplicate an existing rack');assert(props.includes(cage),'wooden cage remains intact');
console.log('map assets ok: '+total+' real ladder volumes on '+maps+' maps; both Mirage top exits; nine complete shell racks');
