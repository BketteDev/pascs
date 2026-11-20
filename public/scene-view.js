// Source is Z-up; Three.js cameras and backgrounds are Y-up.
export function faceSourceCamera(camera, x, y, z, forward) {
  camera.position.set(x, z, -y);
  camera.lookAt(x + forward[0], z + forward[2], -(y + forward[1]));
}
export function syncSkyCamera(skyCamera, camera, sky, eye) {
  skyCamera.quaternion.copy(camera.quaternion);
  if (sky) skyCamera.position.set(sky.origin[0] + eye[0] / sky.scale, sky.origin[2] + eye[2] / sky.scale, -(sky.origin[1] + eye[1] / sky.scale));
  else skyCamera.position.set(0, 0, 0);
}
