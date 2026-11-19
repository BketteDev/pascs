// The ZIP pairs some wooden cages with a bare pallet instead of the full shell rack.
export function fillMirageAmmo(props) {
  let added=0;
  for(const cage of props.filter(p=>/bomb_shells_[12]_wood\.mdl$/i.test(p.model))) {
    const metal=cage.model.replace(/_wood\.mdl$/i,'_metal.mdl');
    const near=p=>Math.hypot(...p.o.map((v,k)=>v-cage.o[k]))<2;
    if(props.some(p=>p.model.toLowerCase()===metal.toLowerCase()&&near(p)))continue;
    const pallet=props.find(p=>/\/shell_pallet\.mdl$/i.test(p.model)&&near(p));
    if(pallet){pallet.model=metal;pallet.a=cage.a;added++;}
  }
  return added;
}
