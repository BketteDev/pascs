// Minimal glTF 2.0 binary (.glb) writer for static meshes.
// writeGlb(file, { name, parts: [{ name, material: { name, color:[r,g,b,a], png?:Buffer, alpha?:'OPAQUE'|'MASK'|'BLEND', doubleSided? }, pos:number[], uv?:number[] }] })
// Positions are given in Source units (z-up); they are written in metres, y-up: (x, y, z) -> (x, z, -y) * 0.0254.
import fs from 'fs';

const SCALE = 0.0254;
const pad4 = (n) => (n + 3) & ~3;

export function writeGlb(file, { name, parts }) {
  const chunks = [], views = [], accessors = [], images = [], textures = [], materials = [], meshes = [], nodes = [];
  let offset = 0;
  const addView = (buf, target) => {
    const start = pad4(offset);
    chunks.push(Buffer.alloc(start - offset), buf); offset = start + buf.length;
    views.push({ buffer: 0, byteOffset: start, byteLength: buf.length, ...(target ? { target } : {}) });
    return views.length - 1;
  };
  const matIndex = new Map(), texIndex = new Map();
  const material = (m) => {
    const key = m.name + '|' + (m.png ? 'tex' : m.color.join(','));
    if (matIndex.has(key)) return matIndex.get(key);
    const mat = { name: m.name, pbrMetallicRoughness: { baseColorFactor: m.color, metallicFactor: 0, roughnessFactor: 1 }, doubleSided: !!m.doubleSided };
    if (m.png) {
      if (!texIndex.has(m.name)) {
        images.push({ bufferView: addView(m.png), mimeType: 'image/png' });
        textures.push({ source: images.length - 1 });
        texIndex.set(m.name, textures.length - 1);
      }
      mat.pbrMetallicRoughness.baseColorTexture = { index: texIndex.get(m.name) };
      mat.pbrMetallicRoughness.baseColorFactor = [1, 1, 1, m.color[3] ?? 1];
    }
    if (m.alpha && m.alpha !== 'OPAQUE') mat.alphaMode = m.alpha;
    if (m.alpha === 'MASK') mat.alphaCutoff = 0.5;
    materials.push(mat);
    matIndex.set(key, materials.length - 1);
    return materials.length - 1;
  };
  const accessor = (view, type, count, min, max) => {
    accessors.push({ bufferView: view, componentType: 5126, count, type, ...(min ? { min, max } : {}) });
    return accessors.length - 1;
  };

  let tris = 0;
  for (const part of parts) {
    const n = part.pos.length / 3;
    if (!n) continue;
    const P = new Float32Array(n * 3), N = new Float32Array(n * 3);
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (let i = 0; i < n; i++) {
      const x = part.pos[i * 3], y = part.pos[i * 3 + 1], z = part.pos[i * 3 + 2];
      const gx = x * SCALE, gy = z * SCALE, gz = -y * SCALE;
      P[i * 3] = gx; P[i * 3 + 1] = gy; P[i * 3 + 2] = gz;
      lo[0] = Math.min(lo[0], gx); lo[1] = Math.min(lo[1], gy); lo[2] = Math.min(lo[2], gz);
      hi[0] = Math.max(hi[0], gx); hi[1] = Math.max(hi[1], gy); hi[2] = Math.max(hi[2], gz);
    }
    for (let t = 0; t + 2 < n; t += 3) { // flat normals (the winding is counter-clockwise from the front)
      const a = t * 3, b = a + 3, c = a + 6;
      const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2], vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; const l = Math.hypot(nx, ny, nz);
      if (l < 1e-12) { nx = 0; ny = 1; nz = 0; } else { nx /= l; ny /= l; nz /= l; } // degenerate triangle: any unit normal
      for (const k of [a, b, c]) { N[k] = nx; N[k + 1] = ny; N[k + 2] = nz; }
    }
    tris += n / 3;
    const attrs = { POSITION: accessor(addView(Buffer.from(P.buffer), 34962), 'VEC3', n, lo, hi), NORMAL: accessor(addView(Buffer.from(N.buffer), 34962), 'VEC3', n) };
    if (part.uv) attrs.TEXCOORD_0 = accessor(addView(Buffer.from(new Float32Array(part.uv).buffer), 34962), 'VEC2', n);
    meshes.push({ name: part.name, primitives: [{ attributes: attrs, material: material(part.material), mode: 4 }] });
    nodes.push({ name: part.name, mesh: meshes.length - 1 });
  }
  const bin = Buffer.concat(chunks);
  const json = Buffer.from(JSON.stringify({
    asset: { version: '2.0', generator: 'css-web exporter' },
    scene: 0, scenes: [{ name, nodes: nodes.map((_, i) => i) }], nodes, meshes, materials,
    ...(textures.length ? { textures, images } : {}), accessors, bufferViews: views, buffers: [{ byteLength: bin.length }],
  }));
  const jsonPad = Buffer.alloc(pad4(json.length) - json.length, 0x20), binPad = Buffer.alloc(pad4(bin.length) - bin.length);
  const total = 12 + 8 + json.length + jsonPad.length + 8 + bin.length + binPad.length;
  const head = Buffer.alloc(12); head.write('glTF', 0, 'latin1'); head.writeUInt32LE(2, 4); head.writeUInt32LE(total, 8);
  const ch = (len, type) => { const b = Buffer.alloc(8); b.writeUInt32LE(len, 0); b.write(type, 4, 'latin1'); return b; };
  fs.writeFileSync(file, Buffer.concat([head, ch(json.length + jsonPad.length, 'JSON'), json, jsonPad, ch(bin.length + binPad.length, 'BIN\0'), bin, binPad]));
  return { tris, parts: nodes.length, materials: materials.length, bytes: total };
}
