import * as THREE from 'three';

const templates = new Map();
const ASSETS = 'equipment-models/';
let loading;

export function loadIncendiaryModels(loadTex) {
  loading ??= fetch(ASSETS + 'models.json').then((r) => r.json()).then((models) => Promise.all(Object.entries(models).map(async ([key, parts]) => {
    const response = await fetch(ASSETS + key + '.bin');
    if (!response.ok) throw new Error(`Unable to load ${key} model (${response.status})`);
    const bin = await response.arrayBuffer(), model = new THREE.Group();
    for (const m of parts) {
      const geo = new THREE.BufferGeometry();
      const normals = new Float32Array(bin, m.nrm, m.count * 3);
      const colors = new Float32Array(normals.length);
      // The viewmodel scene has no lights. Bake a little directional shading into the original mesh.
      for (let i = 0; i < normals.length; i += 3) {
        const light = m.transparent ? 1 : 0.66 + 0.34 * Math.max(0, normals[i] * 0.35 + normals[i + 1] * 0.65 + normals[i + 2] * 0.67);
        colors.fill(light, i, i + 3);
      }
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(bin, m.pos, m.count * 3), 3));
      geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
      geo.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(bin, m.uv, m.count * 2), 2));
      geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      geo.setIndex(new THREE.BufferAttribute(new Uint16Array(bin, m.idx, m.indices), 1));
      const material = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: m.transparent, depthWrite: !m.transparent, side: m.transparent ? THREE.DoubleSide : THREE.FrontSide });
      loadTex(ASSETS + m.texture, (map) => { material.map = map; material.needsUpdate = true; });
      model.add(new THREE.Mesh(geo, material));
    }
    templates.set(key, model);
  })));
  return loading;
}

export function createIncendiaryModel(key) {
  return templates.get(key).clone(true);
}
