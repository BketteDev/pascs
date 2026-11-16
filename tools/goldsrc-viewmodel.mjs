// GoldSrc studio model v10 reader for the Printstream viewmodels.
import fs from 'node:fs';
import { eulerQuat, mul34, quatMatrix } from './mdl.mjs';

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0];

export function loadGoldSrc(file) {
  const b = fs.readFileSync(file);
  const i = (o) => b.readInt32LE(o), f = (o) => b.readFloatLE(o);
  const string = (o, n) => b.toString('latin1', o, o + n).split('\0')[0];
  const xyz = (o) => [f(o), f(o + 4), f(o + 8)];
  if (string(0, 4) !== 'IDST' || i(4) !== 10) throw new Error('Not a GoldSrc studio model');
  const textures = Array.from({ length: i(180) }, (_, k) => {
    const o = i(184) + k * 80, W = i(o + 68), H = i(o + 72), data = i(o + 76);
    return { name: string(o, 64), W, H, data, flags: i(o + 64) };
  });
  const firstSkin = i(200);
  const bones = Array.from({ length: i(140) }, (_, k) => {
    const o = i(144) + k * 112;
    return { parent: i(o + 32), poseToBone: IDENTITY, value: Array.from({ length: 6 }, (_, j) => f(o + 64 + j * 4)), scale: Array.from({ length: 6 }, (_, j) => f(o + 88 + j * 4)) };
  });

  const meshes = [];
  for (let part = 0; part < i(204); part++) {
    const body = i(208) + part * 76;
    if (!i(body + 64)) continue;
    const model = i(body + 72);
    const verts = i(model + 88), vertBones = i(model + 84), normals = i(model + 100);
    for (let k = 0; k < i(model + 72); k++) {
      const o = i(model + 76) + k * 20, texture = textures[b.readUInt16LE(firstSkin + 2 * i(o + 8))];
      if (texture.flags & 2) continue; // chrome and animated overlays are composited by GoldSrc
      const mesh = { material: texture.name, texture, pos: [], nrm: [], uv: [], bi: [], bw: [] };
      const emit = ([v, n, s, t]) => {
        mesh.pos.push(...xyz(verts + v * 12)); mesh.nrm.push(...xyz(normals + n * 12));
        mesh.uv.push(s / texture.W, t / texture.H);
        mesh.bi.push(b[vertBones + v], 0, 0, 0); mesh.bw.push(1, 0, 0, 0);
      };
      let cmd = i(o + 4);
      for (;;) {
        const count = b.readInt16LE(cmd); cmd += 2;
        if (!count) break;
        const corners = Array.from({ length: Math.abs(count) }, () => {
          const v = [0, 2, 4, 6].map((offset) => b.readInt16LE(cmd + offset)); cmd += 8; return v;
        });
        for (let j = 2; j < corners.length; j++) {
          // GoldSrc keeps clockwise faces. Reverse both fans and strips for three.js.
          const [a, b] = count < 0 ? [0, j - 1] : j % 2 ? [j - 1, j - 2] : [j - 2, j - 1];
          for (const index of [a, j, b]) emit(corners[index]);
        }
      }
      if (mesh.pos.length) meshes.push(mesh);
    }
  }

  const activities = [
    [/^idle/i, 'ACT_VM_IDLE'], [/^draw/i, 'ACT_VM_DRAW'], [/^reload/i, 'ACT_VM_RELOAD'],
    [/^(shoot|fire)/i, 'ACT_VM_PRIMARYATTACK'], [/^slash/i, 'ACT_VM_HITCENTER'],
    [/^(stab|heavy)/i, 'ACT_VM_SECONDARYATTACK'], [/^inspect(?!_unsil)/i, 'ACT_VM_INSPECT'],
  ];
  const anims = [], sequences = [];
  for (let j = 0; j < i(164); j++) {
    const o = i(168) + j * 176, name = string(o, 32), group = i(o + 156);
    const act = activities.find(([pattern]) => pattern.test(name))?.[1];
    if (group !== 0 || !act) continue;
    const groupBase = i(i(176) + 100);
    sequences.push({ name, activity: act, anim: anims.length });
    anims.push({ index: i(o + 124) + groupBase, fps: f(o + 32), frames: i(o + 56), loop: !!(i(o + 36) & 1) });
  }

  function channel(start, frame) {
    let o = start, k = frame;
    for (let span = 0; span < 4096; span++) {
      const valid = b[o], total = b[o + 1];
      if (!total || valid > total) throw new Error('Bad GoldSrc channel span');
      if (k < total) return valid ? b.readInt16LE(o + 2 * Math.min(k + 1, valid)) : 0;
      k -= total; o += (valid + 1) * 2;
    }
    throw new Error('GoldSrc channel exceeds frame bounds');
  }
  function boneToWorld(anim, frame) {
    const world = [];
    bones.forEach((bone, index) => {
      const o = anim.index + index * 12;
      const value = bone.value.map((base, k) => {
        const offset = b.readUInt16LE(o + 2 * k);
        return base + (offset ? channel(o + offset, frame) * bone.scale[k] : 0);
      });
      const m = quatMatrix(eulerQuat(value.slice(3)), value.slice(0, 3));
      world.push(bone.parent < 0 ? m : mul34(world[bone.parent], m));
    });
    return world;
  }
  function pixels(texture) {
    const { W, H, data, flags } = texture, rgba = Buffer.alloc(W * H * 4);
    const palette = data + W * H;
    for (let n = 0; n < W * H; n++) {
      const index = b[data + n], offset = palette + index * 3;
      rgba.set([b[offset], b[offset + 1], b[offset + 2], (flags & 64) && index === 255 ? 0 : 255], n * 4);
    }
    return { W, H, rgba };
  }
  const attachments = Array.from({ length: i(212) }, (_, k) => {
    const o = i(216) + k * 88, [x, y, z] = xyz(o + 40);
    return { bone: i(o + 36), local: [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z] };
  });
  return { meshes, bones, anims, sequences, boneToWorld, pixels, attachments };
}
