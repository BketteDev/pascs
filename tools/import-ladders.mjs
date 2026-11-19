// Refresh only ladder metadata: preserve existing geometry, textures, movers and navigation.
import fs from 'node:fs';
import path from 'node:path';
import {bspLadders,vmfLadders} from './ladder-data.mjs';
const root=path.resolve(import.meta.dirname,'../..'),maps=path.join(root,'web/public/maps');
const css=new Set(['de_dust2','de_inferno','cs_office','de_nuke']);
for(const dir of fs.readdirSync(maps,{withFileTypes:true})) {
  const worldFile=path.join(maps,dir.name,'world.json');
  if(!dir.isDirectory()||!fs.existsSync(worldFile))continue;
  const source=dir.name==='de_mirage_csgo_new'?path.join(root,'exports/asset-import/mapcs/MIRAGE MAP/de_mirage_csgo_new.bsp'):
    css.has(dir.name)?path.join(root,'content/maps',dir.name+'.bsp'):path.join(root,'reference/decompiled-csgo-maps',dir.name+'_d.vmf');
  const ladders=source.endsWith('.bsp')?bspLadders(fs.readFileSync(source)):vmfLadders(fs.readFileSync(source,'latin1'));
  const world=JSON.parse(fs.readFileSync(worldFile));world.ladders=ladders;
  fs.writeFileSync(worldFile,JSON.stringify(world));console.log(dir.name+': '+ladders.length+' ladders ('+path.basename(source)+')');
}
