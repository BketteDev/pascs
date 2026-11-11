import * as THREE from 'three';

const templates = new Map();
// Original low-poly models; shared geometry keeps thrown and held bottles inexpensive.
export function createIncendiaryModel(key) {
  if (!templates.has(key)) {
    const model = new THREE.Group(), bottle = key === 'molotov';
    const part = (geometry, color, y, z = 0) => {
      const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color }));
      mesh.position.set(0, y, z); model.add(mesh); return mesh;
    };
    part(new THREE.CylinderGeometry(bottle ? 1.8 : 2.5, bottle ? 2.2 : 2.5, 8, 10), bottle ? 0x52632d : 0xa63e25, 0);
    part(new THREE.CylinderGeometry(bottle ? 0.8 : 2, bottle ? 1.8 : 2, 2, 10), bottle ? 0x637337 : 0x514d42, 5);
    part(new THREE.CylinderGeometry(0.75, 0.75, 2, 8), 0x716240, 6.5);
    part(new THREE.CylinderGeometry(bottle ? 2.23 : 2.53, bottle ? 2.23 : 2.53, 2.5, 10), bottle ? 0xc6b58c : 0xe6bc6c, -0.5);
    if (bottle) {
      const wick = part(new THREE.BoxGeometry(1.1, 3, 0.8), 0xbfa784, 8);
      wick.rotation.z = -0.4;
      part(new THREE.ConeGeometry(0.8, 2.6, 6), 0xffa43d, 10);
    } else part(new THREE.BoxGeometry(1, 2, 1), 0x282b26, 7);
    templates.set(key, model);
  }
  return templates.get(key).clone(true);
}
