// Sequential child processes release each map's collision/geometry memory before the next map on Termux.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { MAPS } from './public/maps.js';
for (const map of MAPS) {
  const child = spawnSync(process.execPath, ['tools/audit-maps.mjs', map.directory], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
  assert.equal(child.status, 0, `${map.directory}: ${child.stderr}`);
  const r = JSON.parse(child.stdout);
  assert.equal(r.geometry.nonFinite + r.geometry.invalidGeometry + r.geometry.trailingBytes, 0, `${r.map}: geometry`);
  assert.deepEqual(r.missingTextures, [], `${r.map}: missing textures`);
  assert.deepEqual(r.nav.invalidEdges, [], `${r.map}: invalid navigation edges`);
  assert.equal(r.nav.blockedNodes, 0, `${r.map}: embedded navigation nodes`);
  for (const [team, spawns] of Object.entries(r.spawns)) for (const s of spawns) {
    assert(s.ground && !s.stuck && s.escape > 32 && s.nav >= 0, `${r.map}: spawn ${team}/${s.i}: ${JSON.stringify(s)}`);
  }
  // Graphs are directed: Agency's helipad is an intentional one-way drop.
  assert(r.nav.ctToT || r.nav.tToCT, `${r.map}: teams cannot meet`);
  for (const objective of r.objectives) {
    assert(objective.nodes && objective.ct && objective.t, `${r.map}: inaccessible objective ${objective.i}`);
    assert(objective.hostages?.every(Boolean) ?? true, `${r.map}: hostage cannot reach rescue ${objective.i}`);
  }
  console.log(`${r.map}: geometry, textures, ${Object.values(r.spawns).flat().length} spawns, ${r.nav.nodes} navigation nodes and ${r.objectives.length} objectives OK`);
}
console.log('All 12 maps passed gameplay and asset checks (rendering requires a browser).');
