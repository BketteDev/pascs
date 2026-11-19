// Preserve Source ladder volumes separately from solid collision, for shared player prediction.
import {parseVmf, parseSides, sidePolygon} from './vmf-export.mjs';
const bounds=(points)=>({min:[0,1,2].map(k=>Math.min(...points.map(p=>p[k]))),max:[0,1,2].map(k=>Math.max(...points.map(p=>p[k])))});
const fromSides=(sides)=>bounds(sides.flatMap((_,i)=>sidePolygon(sides,i)));
export function vmfLadders(text) {
  const tree=typeof text==='string'?parseVmf(text):text, ladders=[];
  for(const node of tree.kids) {
    const cls=node.props.get('classname')??'';
    if(cls==='func_ladder'&&node.props.get('StartDisabled')==='1')continue;
    for(const solid of node.kids.filter(k=>k.name==='solid')) {
      const sides=parseSides(solid);
      if(cls==='func_ladder'||sides.some(s=>/ladder/i.test(s.material)))ladders.push(fromSides(sides));
    }
    if(cls==='func_useableladder') {
      const vec=s=>(s??'').trim().split(/\s+/).map(Number);
      const a=vec(node.props.get('point0')),b=vec(node.props.get('point1'));
      if(a.length===3&&b.length===3&&[...a,...b].every(Number.isFinite)) {
        const l=bounds([a,b]);for(const k of [0,1]){l.min[k]-=8;l.max[k]+=8;}ladders.push(l);
      }
    }
  }
  return ladders.filter(l=>[...l.min,...l.max].every(Number.isFinite));
}
export function bspLadders(b) {
  if(b.toString('latin1',0,4)!=='VBSP')throw new Error('Expected a VBSP map');
  const lump=i=>{const o=b.readInt32LE(8+i*16),n=b.readInt32LE(12+i*16);if(b.readInt32LE(20+i*16))throw new Error('Compressed BSP ladder lump '+i);return b.subarray(o,o+n);};
  const planes=lump(1),brushes=lump(18),sides=lump(19),ladders=[];
  for(let o=0;o<brushes.length;o+=12) {
    if(!(brushes.readInt32LE(o+8)&0x20000000))continue;
    const first=brushes.readInt32LE(o),n=brushes.readInt32LE(o+4),pl=[];
    for(let j=0;j<n;j++){const p=sides.readUInt16LE((first+j)*8)*20;pl.push({n:[0,4,8].map(k=>planes.readFloatLE(p+k)),d:planes.readFloatLE(p+12)});}
    ladders.push(fromSides(pl));
  }
  return ladders.filter(l=>[...l.min,...l.max].every(Number.isFinite));
}
