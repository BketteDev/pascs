import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createServer} from 'node:net';
import {spawn} from 'node:child_process';
import {gzipSync} from 'node:zlib';
const fixture=path.join(import.meta.dirname,'public/__qa_geometry_'+process.pid+'.bin'),data=Buffer.from('geometry fallback integrity '.repeat(100));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
fs.writeFileSync(fixture+'.gz',gzipSync(data));
const server=spawn(process.execPath,['server.mjs'],{cwd:import.meta.dirname,env:{...process.env,PORT:String(port),MAP:'de_mirage_csgo_new',TEAM_SIZE:'1'},windowsHide:true,stdio:['ignore','pipe','pipe']});
let log='';server.stderr.on('data',b=>log+=b);const base='http://127.0.0.1:'+port;
try{
  let ready=false;for(let i=0;i<50;i++){try{const r=await fetch(base+'/api/info');if(r.ok){ready=true;break;}}catch{}await new Promise(r=>setTimeout(r,100));}assert(ready,'static test server started: '+log);
  const url=base+'/'+path.basename(fixture);
  const gzip=await fetch(url,{headers:{'Accept-Encoding':'gzip'}});assert.equal(gzip.status,200);assert.equal(gzip.headers.get('content-encoding'),'gzip');assert.deepEqual(Buffer.from(await gzip.arrayBuffer()),data,'browser transparently decodes packed geometry');
  const raw=await fetch(url,{headers:{'Accept-Encoding':'identity'}});assert.equal(raw.status,200);assert.equal(raw.headers.get('content-encoding'),null);assert.deepEqual(Buffer.from(await raw.arrayBuffer()),data,'clients without gzip also receive raw geometry');
  const cached=await fetch(url,{headers:{'If-None-Match':raw.headers.get('etag')}});assert.equal(cached.status,304);
  console.log('static assets ok: packed-only .bin, gzip/identity integrity, ETag revalidation');
}finally{server.kill();await new Promise(r=>server.exitCode!==null?r():server.once('exit',r));fs.unlinkSync(fixture+'.gz');}
