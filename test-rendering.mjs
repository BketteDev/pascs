import assert from 'node:assert/strict';
import * as THREE from 'three';
import fs from 'node:fs';
import {MAPS,PLAYABLE_MAPS,selectableMaps,mapFolder} from './public/maps.js';
import {faceSourceCamera,syncSkyCamera} from './public/scene-view.js';
import {emitDisplacement,emitOverlay} from './tools/vmf-export.mjs';
assert.equal(PLAYABLE_MAPS.length,10);
assert.deepEqual(selectableMaps(['GO-Mirage','de_mirage','de_mirage_csgo_new','GO-Bank','de_bank','Source-Office'],'csgo'),['GO-Mirage']);
assert.deepEqual(selectableMaps(['cs_office','Source-Office','GO-Italy','de_dust2','Source-Dust2'],'css'),['Source-Office']);
assert.equal(mapFolder('de_mirage'),'GO-Mirage');
const camera=new THREE.PerspectiveCamera(),skyCamera=new THREE.PerspectiveCamera();
for(const sky of [null,{origin:[32,48,80],scale:16}])for(const yaw of [0,.7,2.9,5.4])for(const pitch of [-1.5,-.5,0,.9,1.5]){
 const eye=[100,200,300],f=[Math.cos(pitch)*Math.cos(yaw),Math.cos(pitch)*Math.sin(yaw),Math.sin(pitch)];
 faceSourceCamera(camera,...eye,f);syncSkyCamera(skyCamera,camera,sky,eye);
 const ray=new THREE.Vector3(0,0,-1).applyQuaternion(skyCamera.quaternion);
 assert(ray.distanceTo(new THREE.Vector3(f[0],f[2],-f[1]))<1e-8,'sky and world rays share the Source/Three basis');
 assert(skyCamera.quaternion.angleTo(camera.quaternion)<1e-7);
 assert(skyCamera.position.distanceTo(sky?new THREE.Vector3(32+100/16,80+300/16,-(48+200/16)):new THREE.Vector3())<1e-8);
}
const row=(name,size,values)=>({name,props:new Map(Array.from({length:size},(_,i)=>['row'+i,values])),kids:[]});
const disp={props:new Map([['power','1'],['elevation','7'],['startposition','[0 0 0]']]),kids:[row('normals',3,'0 0 1 0 0 1 0 0 1'),row('distances',3,'0 0 0'),row('offsets',3,'5 0 0 5 0 0 5 0 0')]};
const bucket={pos:[],uv:[],texW:512,texH:512};
assert(emitDisplacement(bucket,[[0,0,0],[10,0,0],[10,10,0],[0,10,0]],{disp,n:[0,0,1]},[[1,0,0,0,1],[0,1,0,0,1]]));
assert(bucket.pos.every((v,i)=>i%3!==2||v===7),'displacement elevation is preserved');
assert.equal(Math.min(...bucket.uv.filter((_,i)=>i%2===0)),0,'UVs stay on the undisplaced base surface');
assert.equal(Math.max(...bucket.uv.filter((_,i)=>i%2===0)),10/512);
const overlay=new Map(),face={n:[0,0,1],d:10,poly:[[0,0,10],[2,0,10],[2,2,10],[0,2,10]]};
const decal={props:new Map(Object.entries({material:'__qa_missing_alpha',BasisOrigin:'0 0 100',BasisU:'1 0 0',BasisV:'0 1 0',BasisNormal:'0 0 1',uv0:'-1 -1 0',uv1:'-1 3 0',uv2:'3 3 0',uv3:'3 -1 0',sides:'1'}))};
assert(emitOverlay(decal,()=>true,overlay,new Map([['1',face]])));
for(const group of overlay.values())for(let i=0;i<group.pos.length;i+=3){
 assert(group.pos[i]>=0&&group.pos[i]<=2&&group.pos[i+1]>=0&&group.pos[i+1]<=2,'overlay clipped to its supporting face');
 assert(Math.abs(group.pos[i+2]-10.08)<1e-8,'overlay projected onto its supporting plane');
}
const overpass=JSON.parse(fs.readFileSync(new URL('./public/maps/GO-Overpass/world.json',import.meta.url)));
const water=overpass.groups.find(g=>g.name==='liquids/overpasswater');
assert.equal(water.alpha,2,'water retains its transparent Source texture');
assert(fs.readFileSync(new URL('./public/maps/GO-Overpass/tex/'+water.tex,import.meta.url)).readUInt32BE(16)>4,'water is not a flat fallback');
const pak='C:/Program Files (x86)/Steam/steamapps/common/Counter-Strike Global Offensive/game/csgo/pak01_dir.vpk';
if(fs.existsSync(pak)){
 const {loadCs2Model}=await import('./tools/cs2mdl.mjs');
 for(const m of ['models/props_urban/curb_straight001_64.mdl','models/props_foliage/urban_bush02.mdl']){
  const full=loadCs2Model(m,0,Infinity),capped=loadCs2Model(m,0,1);assert(full&&capped);assert.deepEqual(capped.meshes,full.meshes,'thin props keep exact topology and UVs');
 }
}
console.log('rendering regression checks: canonical-only maps, disabled entries, 40 sky views, displacement elevation/base UVs, exact thin-prop geometry');
