import * as THREE from 'three';

let loading, launcher, projectile;

export function loadRocketModels(loadTex) {
  return loading ??= (async () => {
    const [manifest, bin] = await Promise.all([
      fetch('weapons/weapons.json').then((r) => r.json()),
      fetch('weapons/rocket.bin').then((r) => { if (!r.ok) throw new Error('Missing RPG-7 assets'); return r.arrayBuffer(); }),
    ]);
    const make = (meshes) => {
      const group = new THREE.Group();
      for (const m of meshes) {
        const geo = new THREE.BufferGeometry();
        for (const [attr, key, size] of [['position', 'pos', 3], ['normal', 'nrm', 3], ['uv', 'uv', 2]]) {
          geo.setAttribute(attr, new THREE.BufferAttribute(new Float32Array(bin, m[key], m.count * size), size));
        }
        const mat = new THREE.MeshBasicMaterial({ color: 0xdddddd, side: THREE.DoubleSide });
        if (m.tex) loadTex('weapons/tex/' + m.tex, (map) => { mat.map = map; mat.needsUpdate = true; });
        group.add(new THREE.Mesh(geo, mat));
      }
      return group;
    };
    launcher = make(manifest.rocket.dropped);
    projectile = make(manifest.rocket.world);
    for (const mesh of projectile.children) mesh.geometry.rotateZ(Math.PI / 2); // ZIP missile points along -Y; flight effects expect +X.
  })();
}

export function createRocketModel(inFlight = false) {
  return (inFlight ? projectile : launcher).clone(true);
}
