import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {gzipSync} from 'node:zlib';
const fixture=path.join(import.meta.dirname,'public/__qa_geometry_'+process.pid+'.bin'),data=Buffer.from('geometry fallback integrity '.repeat(100));
const disabledMaps=['Source-Dust2','de_dust2','GO-Bank','de_bank','GO-ShortNuke','de_shortnuke','GO-ShortDust','de_shortdust','GO-Overpass','de_overpass'];
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
fs.writeFileSync(fixture+'.gz',gzipSync(data));
const server=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,PORT:String(port),MAP:'de_mirage_csgo_new',TEAM_SIZE:'1',ADMIN_PASSWORD:'qa-map-migration'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';server.stderr.on('data',b=>log+=b);const base='http://127.0.0.1:'+port;
try{
  let ready=false;for(let i=0;i<50;i++){try{const r=await fetch(base+'/api/info');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready,'static test server started: '+log);
  const info=await fetch(base+'/api/info').then(r=>r.json()); assert.equal(info.map,'GO-Mirage','legacy MAP environment resolves to canonical folder');
  const maps=await fetch(base+'/api/maps?grouped=1').then(r=>r.json());
  assert.deepEqual(maps,{css:['Source-Inferno','Source-Nuke','Source-Office'],csgo:['GO-Agency','GO-Italy','GO-Lake','GO-Mirage']});
  for(const map of [...maps.css,...maps.csgo]){const asset=await fetch(base+'/maps/'+map+'/world.json');assert.equal(asset.status,200);await asset.body.cancel();}
  assert(maps.css.every(m=>m.startsWith('Source-'))); assert(maps.csgo.every(m=>m.startsWith('GO-')));
  const canonical=await fetch(base+'/maps/Source-Office/world.json'),legacy=await fetch(base+'/maps/cs_office/world.json');
  assert.equal(canonical.status,200);assert.equal(legacy.status,200);assert.deepEqual(await canonical.json(),await legacy.json(),'old asset URLs remain compatible');
  for(const disabled of disabledMaps){
    assert.equal((await fetch(base+'/maps/'+disabled+'/world.json')).status,410);
    const start=spawnSync(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,MAP:disabled},encoding:'utf8',windowsHide:true,timeout:5000});
    assert.equal(start.status,1);assert.match(start.stderr,/is disabled/,'disabled maps cannot start a game');
  }
  assert(![...maps.css,...maps.csgo].some(m=>/Bank|Dust2|^de_|^cs_/.test(m)));
  const html=await fetch(base+'/').then(r=>r.text());assert(html.includes('ui/accessibility.css'));assert(html.includes('class="vg-button"'));
  const result=await fetch(base+'/api/admin',{method:'POST',body:JSON.stringify({password:'qa-map-migration',map:'cs_office',teamSize:1,maxPlayers:2,bots:false})});assert.equal(result.status,200);
  assert.equal((await fetch(base+'/api/info').then(r=>r.json())).map,'Source-Office','admin accepts legacy map names');
  for(const map of disabledMaps)assert.equal((await fetch(base+'/api/admin',{method:'POST',body:JSON.stringify({password:'qa-map-migration',map})})).status,400,'admin rejects disabled maps');
  const url=base+'/'+path.basename(fixture);
  const gzip=await fetch(url,{headers:{'Accept-Encoding':'gzip'}});assert.equal(gzip.status,200);assert.equal(gzip.headers.get('content-encoding'),'gzip');assert.deepEqual(Buffer.from(await gzip.arrayBuffer()),data,'browser transparently decodes packed geometry');
  const raw=await fetch(url,{headers:{'Accept-Encoding':'identity'}});assert.equal(raw.status,200);assert.equal(raw.headers.get('content-encoding'),null);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),data,'clients without gzip also receive raw geometry');
  const cached=await fetch(url,{headers:{'If-None-Match':raw.headers.get('etag')}});assert.equal(cached.status,304);
  console.log('maps and static assets ok: canonical folders, legacy config/asset/admin aliases, packed-only .bin, gzip/identity integrity, ETag revalidation');
}finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.unlinkSync(fixture+'.gz');}
