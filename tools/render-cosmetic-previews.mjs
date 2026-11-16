// Bake inventory thumbnails in Chrome after importing the viewmodels.
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

async function render(THREE) {
  const jobs = await fetch('/jobs').then((r) => r.json());
  const defaults = await fetch('/weapons/weapons.json').then((r) => r.json());
  const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
  renderer.setSize(400, 200);
  const readback = document.createElement('canvas');
  readback.width = 400; readback.height = 200;
  const pixels = readback.getContext('2d', { willReadFrequently: true });
  const camera = new THREE.OrthographicCamera();
  camera.up.set(0, 0, 1);
  const scene = new THREE.Scene();
  const light = new THREE.DirectionalLight(0xffffff, 2.2);
  light.position.set(1, -2, 3);
  scene.add(light, new THREE.HemisphereLight(0xf4f8ff, 0x9da6ac, 1.6));
  const textures = new THREE.TextureLoader();
  const arm = /arm_|_arm\.|v_hands|glove|handwrap|fingers|sleeve|bountyhunter|lighttrails/i;

  for (const { id, weapon, model, paints } of jobs) {
    const gloves = weapon === 'gloves';
    const base = model ? '/cosmetics/' + model : '/weapons/' + weapon;
    const [info, bin] = await Promise.all([
      model ? fetch(base + '.json').then((r) => r.json()) : defaults[weapon],
      fetch(base + (model ? '.bin.gz' : '.bin')).then((r) => model
        ? new Response(r.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer()
        : r.arrayBuffer()),
    ]);
    const idle = info.sequences.find((q) => q.activity === 'ACT_VM_IDLE_SILENCED')
      ?? info.sequences.find((q) => q.activity === 'ACT_VM_IDLE');
    if (!idle) throw new Error(id + ' has no idle pose');
    const pose = new Float32Array(bin, idle.skin, info.bones * 12);
    const bones = Array.from({ length: info.bones }, () => new THREE.Bone());
    const skeleton = new THREE.Skeleton(bones);
    // The animation buffer contains the bind-adjusted skin matrices.
    if (!gloves) bones.forEach((bone, i) => bone.matrixWorld.set(...pose.subarray(i * 12, (i + 1) * 12), 0, 0, 0, 1));
    const group = new THREE.Group();
    const meshes = info.meshes.filter((m) => gloves ? !m.forearm : !arm.test(m.material));
    for (const m of meshes) {
      const geom = new THREE.BufferGeometry();
      for (const [name, data, size] of [
        ['position', 'pos', 3], ['normal', 'nrm', 3], ['uv', 'uv', 2], ['skinIndex', 'bi', 4], ['skinWeight', 'bw', 4],
      ]) geom.setAttribute(name, new THREE.BufferAttribute(new Float32Array(bin, m[data], m.count * size), size));
      if (gloves) {
        // Bring the hands closer in the thumbnail without changing the in-game pose.
        const positions = geom.attributes.position;
        for (let i = 0; i < positions.count; i++) {
          const x = positions.getX(i);
          positions.setX(i, x - Math.sign(x) * 14);
        }
      }
      if (m.indexCount) geom.setIndex(new THREE.BufferAttribute(new Uint32Array(bin, m.idx, m.indexCount), 1));
      const file = paints?.[m.material] ?? m.tex;
      const map = file ? await textures.loadAsync((model ? '/cosmetics/' : '/weapons/tex/') + file) : null;
      if (map) { map.flipY = false; map.wrapS = map.wrapT = THREE.RepeatWrapping; map.colorSpace = THREE.SRGBColorSpace; map.anisotropy = 8; }
      const mat = new THREE.MeshLambertMaterial({ map, alphaTest: m.alpha === 1 ? 0.5 : 0, transparent: m.alpha === 2, depthWrite: m.alpha !== 2, side: model ? THREE.FrontSide : THREE.DoubleSide });
      const mesh = new THREE.SkinnedMesh(geom, mat);
      mesh.bindMode = THREE.DetachedBindMode;
      mesh.bind(skeleton, new THREE.Matrix4());
      mesh.frustumCulled = false;
      group.add(mesh);
    }

    scene.add(group);
    const bounds = new THREE.Box3().setFromObject(group, true);
    if (bounds.isEmpty()) throw new Error(id + ' has no weapon meshes');
    const center = bounds.getCenter(new THREE.Vector3()), extent = bounds.getSize(new THREE.Vector3()).length();
    camera.up.set(0, 0, gloves ? -1 : 1);
    const draw = (direction) => {
      camera.position.copy(center).addScaledVector(new THREE.Vector3(...direction).normalize(), extent * 2);
      camera.lookAt(center);
      camera.updateMatrixWorld();
      const screen = bounds.clone().applyMatrix4(camera.matrixWorldInverse).getSize(new THREE.Vector3());
      const height = Math.max(screen.y, screen.x / 2) * 0.57;
      Object.assign(camera, { left: -height * 2, right: height * 2, top: height, bottom: -height, near: 0.1, far: extent * 4 });
      camera.updateProjectionMatrix();
      renderer.render(scene, camera);
      return height;
    };
    let view = gloves ? [0, -1, 0.14] : [0.18, -1, 0.32];
    if (weapon === 'knife') { // Find the broad side of each blade in its idle pose.
      let area = 0;
      for (const direction of [view, [-1, -0.22, 0.28], [0.85, -0.8, 0.25], [0.24, -0.4, 1]]) {
        const height = draw(direction);
        pixels.clearRect(0, 0, 400, 200);
        pixels.drawImage(renderer.domElement, 0, 0);
        const rgba = pixels.getImageData(0, 0, 400, 200).data;
        let coverage = 0;
        for (let i = 3; i < rgba.length; i += 4) coverage += rgba[i];
        const projectedArea = coverage * height ** 2;
        if (projectedArea > area) { view = direction; area = projectedArea; }
      }
    }
    draw(view);
    const blob = await new Promise((resolve) => renderer.domElement.toBlob(resolve, 'image/webp', 0.93));
    if (!blob || blob.type !== 'image/webp') throw new Error('WebP export unavailable');
    const saved = await fetch('/preview/' + id, { method: 'POST', body: blob });
    if (!saved.ok) throw new Error('Could not save ' + id);
    group.removeFromParent();
    for (const mesh of group.children) { mesh.geometry.dispose(); mesh.material.map?.dispose(); mesh.material.dispose(); }
    skeleton.dispose();
  }
}

const chrome = process.argv[2] ?? 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const publicDir = path.resolve(import.meta.dirname, '../public');
const output = path.join(publicDir, 'cosmetics/previews');
const catalog = JSON.parse(await fs.readFile(path.join(publicDir, 'cosmetics/catalog.json'), 'utf8'));
const jobs = Object.entries(catalog).flatMap(([weapon, items]) => [
  ...(weapon === 'gloves' ? [] : [{ id: 'default-' + weapon, weapon }]),
  ...items.map(({ id, model, textures }) => ({ id, weapon, model, paints: textures })),
]);
const pending = new Set(jobs.map(({ id }) => id));
if (pending.size !== jobs.length || !jobs.length || jobs.some(({ id }) => !/^[\w-]+$/.test(id))) throw new Error('Invalid thumbnail IDs');
await fs.mkdir(output, { recursive: true });

const page = `<meta charset="utf-8"><script type="module">
import * as THREE from '/three.js';
await (${render})(THREE).catch((error) => fetch('/error', { method: 'POST', body: String(error.stack || error) }));
</script>`;
const three = path.resolve(import.meta.dirname, '../node_modules/three/build/three.module.js');
const types = { '.png': 'image/png', '.json': 'application/json', '.bin': 'application/octet-stream', '.gz': 'application/octet-stream' };
const { promise: done, resolve, reject } = Promise.withResolvers();
const server = http.createServer(async (req, res) => {
  const url = req.url;
  if (req.method === 'POST') {
    const id = url.replace(/^\/preview\//, '');
    if (!pending.has(id) && url !== '/error') return res.writeHead(404).end();
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > 512 * 1024) throw new Error('Invalid thumbnail size');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      if (url === '/error') throw new Error(data.toString());
      if (data.toString('ascii', 8, 12) !== 'WEBP') throw new Error('Invalid thumbnail format for ' + id);
      await fs.writeFile(path.join(output, id + '.webp'), data);
      res.writeHead(204).end();
      pending.delete(id);
      if (!pending.size) resolve();
    } catch (error) { res.writeHead(500).end(); reject(error); }
    return;
  }
  if (url === '/') return res.writeHead(200, { 'Content-Type': 'text/html' }).end(page);
  if (url === '/jobs') return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(jobs));
  if (url === '/three.js') return createReadStream(three).pipe(res.writeHead(200, { 'Content-Type': 'text/javascript' }));
  if (!/^\/(?:cosmetics\/(?:models|tex)\/|weapons\/(?:tex\/)?)[\w.-]+$/.test(url)) return res.writeHead(404).end();
  const stream = createReadStream(path.join(publicDir, url.slice(1)));
  stream.on('error', () => res.writeHead(404).end());
  stream.on('open', () => stream.pipe(res.writeHead(200, { 'Content-Type': types[path.extname(url)] ?? 'application/octet-stream' })));
});

const temp = await fs.realpath(tmpdir());
const profile = await fs.mkdtemp(path.join(temp, 'pascs-previews-'));
await new Promise((ok, fail) => server.on('error', fail).listen(0, '127.0.0.1', ok));
const browser = spawn(chrome, [
  '--headless=new', '--disable-background-networking', '--enable-unsafe-swiftshader', '--no-first-run',
  '--user-data-dir=' + profile, 'http://127.0.0.1:' + server.address().port,
], { stdio: 'ignore', windowsHide: true });
browser.once('error', reject);
browser.once('exit', (code) => reject(new Error('Chrome exited before previews finished (' + code + ')')));
const timeout = setTimeout(() => reject(new Error('Thumbnail rendering timed out')), 180_000);
try {
  await done;
  console.log('Rendered ' + jobs.length + ' inventory thumbnails.');
} finally {
  clearTimeout(timeout);
  browser.kill();
  server.close();
  if (path.dirname(profile) === temp && path.basename(profile).startsWith('pascs-previews-')) {
    await fs.rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}
