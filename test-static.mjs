import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
const fixture=path.join(import.meta.dirname,'public/__qa_geometry_'+process.pid+'.bin'),data=Buffer.from('geometry fallback integrity '.repeat(100));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
fs.writeFileSync(fixture+'.gz',gzipSync(data));
const server=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,PORT:String(port),MAP:'de_mirage_csgo_new',TEAM_SIZE:'1',ADMIN_PASSWORD:'qa-map-migration'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';server.stderr.on('data',b=>log+=b);const base='http://127.0.0.1:'+port;
try{
  let ready=false;for(let i=0;i<50;i++){try{const r=await fetch(base+'/api/info');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready,'static test server started: '+log);
  const info=await fetch(base+'/api/info').then(r=>r.json()); assert.equal(info.map,'GO-Mirage','legacy MAP environment resolves to canonical folder');
  const maps=await fetch(base+'/api/maps?grouped=1').then(r=>r.json()); assert.equal(maps.css.length,4); assert.equal(maps.csgo.length,8);
  assert(maps.css.every(m=>m.startsWith('Source-'))); assert(maps.csgo.every(m=>m.startsWith('GO-')));
  const canonical=await fetch(base+'/maps/Source-Dust2/world.json'),legacy=await fetch(base+'/maps/de_dust2/world.json');
  assert.equal(canonical.status,200);assert.equal(legacy.status,200);assert.deepEqual(await canonical.json(),await legacy.json(),'old asset URLs remain compatible');
  const html=await fetch(base+'/').then(r=>r.text());assert(html.includes('ui/accessibility.css'));assert(html.includes('class="vg-button"'));
  const result=await fetch(base+'/api/admin',{method:'POST',body:JSON.stringify({password:'qa-map-migration',map:'de_dust2',teamSize:1,maxPlayers:2,bots:false})});assert.equal(result.status,200);
  assert.equal((await fetch(base+'/api/info').then(r=>r.json())).map,'Source-Dust2','admin accepts legacy map names');
  const url=base+'/'+path.basename(fixture);
  const gzip=await fetch(url,{headers:{'Accept-Encoding':'gzip'}});assert.equal(gzip.status,200);assert.equal(gzip.headers.get('content-encoding'),'gzip');assert.deepEqual(Buffer.from(await gzip.arrayBuffer()),data,'browser transparently decodes packed geometry');
  const raw=await fetch(url,{headers:{'Accept-Encoding':'identity'}});assert.equal(raw.status,200);assert.equal(raw.headers.get('content-encoding'),null);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),data,'clients without gzip also receive raw geometry');
  const cached=await fetch(url,{headers:{'If-None-Match':raw.headers.get('etag')}});assert.equal(cached.status,304);
  console.log('maps and static assets ok: canonical folders, legacy config/asset/admin aliases, packed-only .bin, gzip/identity integrity, ETag revalidation');
}finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.unlinkSync(fixture+'.gz');}
