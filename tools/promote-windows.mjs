import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createMovers } from '../public/movers.js';
import { makeWorld, trace } from '../public/physics.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public/maps');

const GLASS_PROP = /(?:^|\|)(?:window_farmhouse_glass|BreakableWindowGlass)$/i;
const GLASS_GROUP = /(?:^|\/)glass\/(?:offwndwc|glasswindow007a|glasswindow044a|unbreakable|glass01_|blinds_illuminated)/i;

// Recover convex piece { pts, planes } from a baked collision entry so movers.js can break & reset it cleanly.
function pieceFromEntry(e) {
  const planes = [];
  for (let i = 6; i < e.length; i += 4) {
    const p = [e[i], e[i + 1], e[i + 2], e[i + 3]];
    if (!planes.some((q) => q.every((v, k) => Math.abs(v - p[k]) < 1e-4))) planes.push(p);
  }
  const pts = [];
  for (let i = 0; i < planes.length; i++) for (let j = i + 1; j < planes.length; j++) for (let k = j + 1; k < planes.length; k++) {
    const [a0, b0, c0, d0] = planes[i], [a1, b1, c1, d1] = planes[j], [a2, b2, c2, d2] = planes[k];
    const det = a0 * (b1 * c2 - b2 * c1) - b0 * (a1 * c2 - a2 * c1) + c0 * (a1 * b2 - a2 * b1);
    if (Math.abs(det) < 1e-5) continue;
    const x = (d0 * (b1 * c2 - b2 * c1) - b0 * (d1 * c2 - d2 * c1) + c0 * (d1 * b2 - d2 * b1)) / det;
    const y = (a0 * (d1 * c2 - d2 * c1) - d0 * (a1 * c2 - a2 * c1) + c0 * (a1 * d2 - a2 * d1)) / det;
    const z = (a0 * (b1 * d2 - b2 * d1) - b0 * (a1 * d2 - a2 * d1) + d0 * (a1 * b2 - a2 * b1)) / det;
    if (planes.every((p) => p[0] * x + p[1] * y + p[2] * z <= p[3] + 0.05) &&
        !pts.some((q) => Math.abs(q[0] - x) < 0.05 && Math.abs(q[1] - y) < 0.05 && Math.abs(q[2] - z) < 0.05)) {
      pts.push([x, y, z]);
    }
  }
  return { pts, planes };
}

function triCentroidAndNormal(pos, t) {
  const o = t * 9;
  const cx = (pos[o] + pos[o + 3] + pos[o + 6]) / 3;
  const cy = (pos[o + 1] + pos[o + 4] + pos[o + 7]) / 3;
  const cz = (pos[o + 2] + pos[o + 5] + pos[o + 8]) / 3;
  const ax = pos[o + 3] - pos[o], ay = pos[o + 4] - pos[o + 1], az = pos[o + 5] - pos[o + 2];
  const bx = pos[o + 6] - pos[o], by = pos[o + 7] - pos[o + 1], bz = pos[o + 8] - pos[o + 2];
  const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
  const nl = Math.hypot(nx, ny, nz) || 1;
  return { c: [cx, cy, cz], n: [nx / nl, ny / nl, nz / nl] };
}

function isSafeTwoSidedPane(bw, blim, world, idx, sampleNormal) {
  const e = world.collision[idx];
  const dx = e[3] - e[0], dy = e[4] - e[1], dz = e[5] - e[2];
  const surf = world.surfaces?.[world.surfOf?.[idx] ?? 0] ?? 'concrete';
  const minD = Math.min(dx, dy, dz), maxD = Math.max(dx, dy, dz);
  // Window panes are thin sheets (<=16u thick, or de_lake/agency angled glass panes)
  if (!(minD <= 6 || (surf === 'glass' && minD <= 42 && maxD <= 100 && dz >= 20))) return false;
  if (maxD > 350 || maxD < 20) return false;

  const mid = [(e[0] + e[3]) / 2, (e[1] + e[4]) / 2, (e[2] + e[5]) / 2];
  let n;
  if (dx <= 6 && dx < dy && dx < dz) n = [1, 0, 0];
  else if (dy <= 6 && dy < dx && dy < dz) n = [0, 1, 0];
  else if (dz <= 6 && dz < dx && dz < dy) n = [0, 0, 1];
  else {
    const l = Math.hypot(sampleNormal[0], sampleNormal[1]) || 1;
    n = [sampleNormal[0] / l, sampleNormal[1] / l, 0];
  }

  for (const sign of [1, -1]) {
    const dir = n.map((v) => v * sign);
    const p6 = mid.map((v, k) => v + dir[k] * 6);
    if (trace(bw, p6, p6, [0, 0, 0], [0, 0, 0], blim).startSolid) return false;
    // Allow close foliage/prop on one side ONLY if above/around is playable (skip concrete/wall within 20u)
    const reach = trace(bw, p6, p6.map((v, k) => v + dir[k] * 120), [0, 0, 0], [0, 0, 0], blim);
    const hitSurf = reach.entry >= 0 ? (world.surfaces?.[world.surfOf?.[reach.entry] ?? 0] ?? '') : '';
    if (reach.fraction * 120 < 20 && hitSurf !== 'sand' && hitSurf !== 'glass') return false;
    const pDrop = mid.map((v, k) => v + dir[k] * 36);
    const flStart = trace(bw, pDrop, pDrop, [0, 0, 0], [0, 0, 0], blim).startSolid ? mid.map((v, k) => v + dir[k] * 18) : pDrop;
    const drop = trace(bw, flStart, [flStart[0], flStart[1], flStart[2] - 500], [0, 0, 0], [0, 0, 0], blim).fraction * 500;
    if (drop >= 450) return false;
  }
  return true;
}

function sliceCopy(src, startTri, tris, stride, isGroup) {
  // Pack selected triangles into contiguous Float32 arrays per attribute.
  const out = {};
  const attrs = isGroup ? [['pos', 3], ['uv', 2], ['lm', 2]] : [['pos', 3], ['nrm', 3], ['uv', 2], ['col', 3]];
  for (const [key, comp] of attrs) {
    const srcArr = new Float32Array(src.bin.buffer, src.bin.byteOffset + src.item[key], src.item.count * comp);
    const dst = new Float32Array(tris.length * 3 * comp);
    for (let i = 0; i < tris.length; i++) {
      const t = tris[i], off = t * 3 * comp;
      dst.set(srcArr.subarray(off, off + 3 * comp), i * 3 * comp);
    }
    out[key] = dst;
  }
  return out;
}

function writeKeptTriangles(bin, item, keptTris, isGroup) {
  const attrs = isGroup ? [['pos', 3], ['uv', 2], ['lm', 2]] : [['pos', 3], ['nrm', 3], ['uv', 2], ['col', 3]];
  for (const [key, comp] of attrs) {
    const arr = new Float32Array(bin.buffer, bin.byteOffset + item[key], item.count * comp);
    const copy = new Float32Array(arr);
    for (let i = 0; i < keptTris.length; i++) {
      const t = keptTris[i], off = t * 3 * comp;
      arr.set(copy.subarray(off, off + 3 * comp), i * 3 * comp);
    }
  }
  item.count = keptTris.length * 3;
}

export function promoteMapWindows(mapName, { dryRun = false } = {}) {
  const mapDir = path.join(ROOT, mapName);
  const worldPath = path.join(mapDir, 'world.json');
  const binPath = path.join(mapDir, 'world.bin');
  const world = JSON.parse(fs.readFileSync(worldPath, 'utf8'));
  const binOrig = fs.readFileSync(binPath);
  const bin = Buffer.from(binOrig);

  // 1) All glass breakables shatter cleanly in one hit.
  let hpFixed = 0;
  for (const mv of world.movers || []) {
    if (mv.breakable && mv.glass) {
      if (mv.health !== 1) hpFixed++;
      mv.health = 1;
      mv.surface = 'glass';
    }
  }

  const moverEntries = new Set();
  for (const mv of world.movers || []) for (const e of mv.entries || []) moverEntries.add(e);

  const bw = makeWorld(world.collision.map((e, i) => (moverEntries.has(i) ? [0, 0, 0, -1, -1, -1] : e)));
  const blim = world.collision.length;

  // Map collision entry index -> { sampleNormal, groupTris: Map<gi, Set<t>>, propTris: Map<pi, Set<t>> }
  const sources = [];
  for (let gi = 0; gi < (world.groups || []).length; gi++) {
    const g = world.groups[gi];
    if (GLASS_GROUP.test(g.name)) sources.push({ isGroup: true, idx: gi, item: g });
  }
  for (let pi = 0; pi < (world.props || []).length; pi++) {
    const p = world.props[pi];
    if (GLASS_PROP.test(p.name)) sources.push({ isGroup: false, idx: pi, item: p });
  }

  const byCol = new Map();
  const safeCache = new Map();

  for (const src of sources) {
    const pos = new Float32Array(bin.buffer, bin.byteOffset + src.item.pos, src.item.count * 3);
    const nTri = src.item.count / 3;
    for (let t = 0; t < nTri; t++) {
      const { c, n } = triCentroidAndNormal(pos, t);
      // Match all candidate unclaimed collision entries containing centroid within 2.5u
      let bestCol = -1, bestScore = 1e9;
      for (let idx = 0; idx < world.collision.length; idx++) {
        if (moverEntries.has(idx)) continue;
        if (/blinds_illuminated/i.test(src.item.name) && world.surfaces?.[world.surfOf?.[idx] ?? 0] !== 'glass') continue;
        const e = world.collision[idx];
        if (c[0] < e[0] - 2.5 || c[0] > e[3] + 2.5 || c[1] < e[1] - 2.5 || c[1] > e[4] + 2.5 || c[2] < e[2] - 2.5 || c[2] > e[5] + 2.5) continue;
        if (!safeCache.has(idx)) safeCache.set(idx, isSafeTwoSidedPane(bw, blim, world, idx, n));
        if (!safeCache.get(idx)) continue;
        const dx = e[3] - e[0], dy = e[4] - e[1], dz = e[5] - e[2];
        const minD = Math.min(dx, dy, dz);
        const midDist = Math.hypot(c[0] - (e[0] + e[3]) / 2, c[1] - (e[1] + e[4]) / 2, c[2] - (e[2] + e[5]) / 2);
        const isGlassSurf = world.surfaces?.[world.surfOf?.[idx] ?? 0] === 'glass' ? 0 : 100;
        const score = isGlassSurf + minD * 10 + midDist * 0.01;
        if (score < bestScore) { bestScore = score; bestCol = idx; }
      }
      if (bestCol < 0) continue;
      if (!byCol.has(bestCol)) byCol.set(bestCol, { groupTris: new Map(), propTris: new Map() });
      const rec = byCol.get(bestCol);
      const map = src.isGroup ? rec.groupTris : rec.propTris;
      if (!map.has(src.idx)) map.set(src.idx, []);
      map.get(src.idx).push(t);
    }
  }

  let glassSurfIdx = world.surfaces.indexOf('glass');
  if (glassSurfIdx < 0) { glassSurfIdx = world.surfaces.length; world.surfaces.push('glass'); }

  const appended = [];
  let cursor = bin.length;
  const allocFloat = (f32) => {
    const off = cursor;
    const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
    appended.push(buf);
    cursor += buf.length;
    return off;
  };

  const removedGroupTris = new Map();
  const removedPropTris = new Map();
  let addedMovers = 0;

  for (const [colIdx, rec] of [...byCol.entries()].sort((a, b) => a[0] - b[0])) {
    const orig = world.collision[colIdx];
    const pc = pieceFromEntry(orig);
    const center = [0, 1, 2].map((k) => (orig[k] + orig[k + 3]) / 2);

    const mGroups = [];
    for (const [gi, tris] of rec.groupTris) {
      const item = world.groups[gi];
      const packed = sliceCopy({ bin, item }, 0, tris, 0, true);
      mGroups.push({
        name: item.name, tex: item.tex, alpha: item.alpha,
        ...(item.env ? { env: item.env } : {}),
        count: tris.length * 3,
        pos: allocFloat(packed.pos), uv: allocFloat(packed.uv), lm: allocFloat(packed.lm),
      });
      if (!removedGroupTris.has(gi)) removedGroupTris.set(gi, new Set());
      for (const t of tris) removedGroupTris.get(gi).add(t);
    }

    const mProps = [];
    for (const [pi, tris] of rec.propTris) {
      const item = world.props[pi];
      const packed = sliceCopy({ bin, item }, 0, tris, 0, false);
      mProps.push({
        name: item.name, tex: item.tex, alpha: item.alpha,
        count: tris.length * 3,
        pos: allocFloat(packed.pos), nrm: allocFloat(packed.nrm), uv: allocFloat(packed.uv), col: allocFloat(packed.col),
      });
      if (!removedPropTris.has(pi)) removedPropTris.set(pi, new Set());
      for (const t of tris) removedPropTris.get(pi).add(t);
    }

    world.surfOf[colIdx] = glassSurfIdx;
    world.movers.push({
      cls: 'func_breakable',
      name: '',
      slave: '',
      parentName: '',
      pivot: center,
      pieces: [pc],
      entries: [colIdx],
      groups: mGroups,
      props: mProps,
      kind: 'break',
      breakable: true,
      health: 1,
      glass: true,
      surface: 'glass',
      center,
    });
    addedMovers++;
  }

  // Strip moved triangles out of static groups/props cleanly
  for (const [gi, remSet] of removedGroupTris) {
    const item = world.groups[gi], nTri = item.count / 3;
    const kept = [];
    for (let t = 0; t < nTri; t++) if (!remSet.has(t)) kept.push(t);
    writeKeptTriangles(bin, item, kept, true);
  }
  for (const [pi, remSet] of removedPropTris) {
    const item = world.props[pi], nTri = item.count / 3;
    const kept = [];
    for (let t = 0; t < nTri; t++) if (!remSet.has(t)) kept.push(t);
    writeKeptTriangles(bin, item, kept, false);
  }
  world.groups = world.groups.filter((g) => g.count > 0);
  world.props = world.props.filter((p) => p.count > 0);

  // Self-check mover integrity via createMovers before committing to disk
  if (addedMovers > 0) {
    const entriesCopy = world.collision.map((e) => [...e]);
    const mv = createMovers({ entries: entriesCopy }, world.movers);
    for (let i = world.movers.length - addedMovers; i < world.movers.length; i++) {
      mv.apply(i, 1);
      if (entriesCopy[world.movers[i].entries[0]].length !== 6) throw new Error(`${mapName} mover#${i} failed break clear`);
      mv.apply(i, 0);
      if (entriesCopy[world.movers[i].entries[0]].length < 10) throw new Error(`${mapName} mover#${i} failed restore`);
    }
  }

  const outBin = appended.length ? Buffer.concat([bin, ...appended]) : bin;
  if (!dryRun && (hpFixed > 0 || addedMovers > 0)) {
    fs.writeFileSync(worldPath, JSON.stringify(world));
    fs.writeFileSync(binPath, outBin);
  }

  return { mapName, hpFixed, addedMovers, totalBreakables: world.movers.filter((m) => m.breakable).length, addedEntries: [...byCol.keys()] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes('--dry-run');
  const args = process.argv.slice(2).filter((a) => a !== '--dry-run');
  const maps = !args.length || args[0] === 'all' ? ['de_dust2', 'de_lake', 'cs_office', 'de_inferno', 'de_nuke', 'cs_agency'] : args;
  for (const m of maps) {
    const res = promoteMapWindows(m, { dryRun });
    console.log(`${dryRun ? '[DRY] ' : ''}${res.mapName}: hpFixed=${res.hpFixed}, addedMovers=${res.addedMovers}, totalBreakables=${res.totalBreakables}, entries=${res.addedEntries.slice(0, 12).join(',')}${res.addedEntries.length > 12 ? ` (+${res.addedEntries.length - 12})` : ''}`);
  }
}
