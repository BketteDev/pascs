// Converts a decompiled Source map (.vmf) to GLB: brush geometry (plane clipping + displacements) and prop_static models.
// Usage: node tools/vmf-export.mjs <map.vmf> <out.glb>
// Textures/models are looked up in the CS:S content (CS:GO shares many material and model names); anything missing becomes a flat colour.
// Algorithm references: Source-Asset-Viewer/vmf.js (same brush/displacement conventions).
import fs from 'fs';
import path from 'path';
import { writeGlb } from './glb.mjs';
import { loadModel } from './mdl.mjs';
import { hasCs2Model, loadCs2Model } from './cs2mdl.mjs';
import { readGameFile, modelBase } from './content.mjs';
import { png, vtfToRgba } from './vtf.mjs';

const CONTENT = path.resolve(import.meta.dirname, '..', '..', 'content', 'css_content');

// ---------- VMF text -> tree ----------
function parseVmf(text) {
  const root = { name: 'root', props: new Map(), kids: [] }, stack = [root];
  let pending = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line === '{') { const node = { name: pending, props: new Map(), kids: [] }; stack.at(-1).kids.push(node); stack.push(node); pending = null; }
    else if (line === '}') stack.pop();
    else if (line[0] === '"') { const m = line.match(/^"([^"]*)"\s+"(.*)"$/); if (m) stack.at(-1).props.set(m[1], m[2]); }
    else pending = line;
  }
  return root;
}

// ---------- vector helpers ----------
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => mul(a, 1 / (len(a) || 1));
const lerp = (a, b, t) => add(a, mul(sub(b, a), t));
const nums = (s) => s.replace(/[()\[\]]/g, ' ').trim().split(/\s+/).map(Number);

// ---------- brush -> polygons ----------
function parseSides(solid) {
  const sides = solid.kids.filter((k) => k.name === 'side').map((sd) => {
    const p = nums(sd.props.get('plane'));
    const pts = [[p[0], p[1], p[2]], [p[3], p[4], p[5]], [p[6], p[7], p[8]]];
    return { pts, material: (sd.props.get('material') ?? '').toLowerCase(), u: sd.props.get('uaxis'), v: sd.props.get('vaxis'), disp: sd.kids.find((k) => k.name === 'dispinfo') };
  });
  const all = sides.flatMap((s) => s.pts), c = mul(all.reduce((a, p) => add(a, p), [0, 0, 0]), 1 / (all.length || 1));
  for (const s of sides) { // outward normal: the brush centre lies behind every plane
    let n = norm(cross(sub(s.pts[2], s.pts[0]), sub(s.pts[1], s.pts[0])));
    if (dot(n, sub(c, s.pts[0])) > 0) n = mul(n, -1);
    s.n = n; s.d = dot(n, s.pts[0]);
  }
  return sides;
}
function clip(poly, n, d) { // keep n.x <= d (Sutherland-Hodgman)
  const out = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], da = dot(n, a) - d, db = dot(n, b) - d;
    if (da <= 0.01) out.push(a);
    if ((da < -0.01 && db > 0.01) || (da > 0.01 && db < -0.01)) out.push(lerp(a, b, da / (da - db)));
  }
  return out;
}
function sidePolygon(sides, i) { // CCW seen from outside the brush
  const s = sides[i], ref = Math.abs(s.n[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const ax = norm(cross(s.n, ref)), ay = cross(s.n, ax), o = mul(s.n, s.d), R = 65536;
  let poly = [add(add(o, mul(ax, -R)), mul(ay, -R)), add(add(o, mul(ax, R)), mul(ay, -R)), add(add(o, mul(ax, R)), mul(ay, R)), add(add(o, mul(ax, -R)), mul(ay, R))];
  for (let j = 0; j < sides.length && poly.length > 2; j++) if (j !== i) poly = clip(poly, sides[j].n, sides[j].d);
  // dedupe near-identical points
  return poly.filter((p, k) => len(sub(p, poly[(k + 1) % poly.length])) > 0.02);
}

// ---------- materials ----------
const SKIP = /^(tools\/|toolsnodraw)/;
const texCache = new Map();
function material(name) { // -> { png, w, h, alpha } or null
  if (texCache.has(name)) return texCache.get(name);
  let out = null;
  try {
    let vmt = readGameFile('materials/' + name + '.vmt'), t = '';
    for (let depth = 0; vmt && depth < 8; depth++) {
      const text = vmt.toString('latin1').toLowerCase().replace(/\\/g, '/');
      t += text + '\n';
      const include = text.match(/\binclude"?\s+"?([^"\s]+)"?/)?.[1];
      vmt = include ? readGameFile(include.startsWith('materials/') ? include : 'materials/' + include) : null;
    }
    if (t) {
      const base = t.match(/"?\$basetexture"?\s+"?([^"\s]+)"?/)?.[1];
      const vtfData = base && readGameFile('materials/' + base + '.vtf');
      if (vtfData) {
        const { W, H, rgba } = vtfToRgba(vtfData);
        const flag = (key) => t.match(new RegExp(`\\$${key}"?\\s+"?([01])\\b`))?.[1] === '1';
        const alpha = flag('alphatest') ? 'MASK' : flag('translucent') ? 'BLEND' : 'OPAQUE';
        let data = rgba, ch = 4;
        if (alpha === 'OPAQUE') { ch = 3; data = Buffer.alloc(W * H * 3); for (let i = 0; i < W * H; i++) rgba.copy(data, i * 3, i * 4, i * 4 + 3); }
        out = { png: png(W, H, ch, data), w: W, h: H, alpha };
      }
    }
  } catch { out = null; }
  texCache.set(name, out);
  return out;
}
const hashColor = (name) => { let h = 2166136261; for (const c of name) h = Math.imul(h ^ c.charCodeAt(0), 16777619); const r = (h >>> 0) & 255, g = (h >>> 8) & 255, b = (h >>> 16) & 255; return [0.35 + r / 640, 0.35 + g / 640, 0.35 + b / 640, 1]; };
const GLASS = /glass|window/;

// ---------- output buckets ----------
const parts = new Map(); // key -> { name, material, pos, uv }
function bucket(name, target) {
  if (!target.has(name)) {
    const mat = material(name.replace(/^(?:prop|overlay):/, '')), glass = GLASS.test(name); // prop / overlay buckets
    target.set(name, { name, texW: mat?.w ?? 512, texH: mat?.h ?? 512, pos: [], uv: [], material: { name, color: glass && !mat ? [0.6, 0.8, 0.9, 0.35] : hashColor(name), png: mat?.png, alpha: mat?.alpha ?? (glass && !mat ? 'BLEND' : 'OPAQUE'), doubleSided: !!mat && mat.alpha !== 'OPAQUE' } });
  }
  return target.get(name);
}
function emitTri(b, tri, uvAxes) {
  if (len(cross(sub(tri[1], tri[0]), sub(tri[2], tri[0]))) < 1e-3) return;
  for (const p of tri) {
    b.pos.push(...p);
    if (uvAxes) {
      const [ua, va] = uvAxes;
      b.uv.push((dot(p, ua.slice(0, 3)) / ua[4] + ua[3]) / b.texW, (dot(p, va.slice(0, 3)) / va[4] + va[3]) / b.texH);
    } else b.uv.push(0, 0);
  }
}
const parseAxis = (s) => { const m = s.match(/\[([^\]]*)\]\s*([-\d.e]+)/); const v = m[1].trim().split(/\s+/).map(Number); return [v[0], v[1], v[2], v[3], Number(m[2]) || 0.25]; };

// ---------- displacement ----------
const rowsOf = (node, key, perRow) => {
  const grid = node?.kids.find((k) => k.name === key); if (!grid) return null;
  return [...grid.props.entries()].filter(([k]) => /^row\d+$/.test(k)).sort((a, b) => Number(a[0].slice(3)) - Number(b[0].slice(3))).map(([, v]) => { const n = v.trim().split(/\s+/).map(Number), out = []; for (let i = 0; i < n.length; i += perRow) out.push(n.slice(i, i + perRow)); return out; });
};
function emitDisplacement(b, poly, side, uvAxes) {
  const disp = side.disp, power = Number(disp.props.get('power')), N = (1 << power) + 1;
  if (poly.length !== 4) return false;
  const start = nums(disp.props.get('startposition')), cw = [...poly].reverse(); // Source orders face corners clockwise
  const s = cw.reduce((best, p, i) => (len(sub(p, start)) < len(sub(cw[best], start)) ? i : best), 0), c = [0, 1, 2, 3].map((i) => cw[(s + i) % 4]);
  const normals = rowsOf(disp, 'normals', 3), dist = rowsOf(disp, 'distances', 1), offs = rowsOf(disp, 'offsets', 3);
  const P = [];
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const flat = lerp(lerp(c[0], c[1], y / (N - 1)), lerp(c[3], c[2], y / (N - 1)), x / (N - 1));
    let p = flat;
    if (normals && dist) p = add(p, mul(normals[y][x], dist[y][x][0]));
    if (offs) p = add(p, offs[y][x]);
    P.push({ p, flat });
  }
  const face = (i, j, k) => { // CCW relative to the plane normal
    const a = P[i].flat, bb = P[j].flat, cc = P[k].flat, n = cross(sub(bb, a), sub(cc, a));
    const tri = dot(n, side.n) >= 0 ? [i, j, k] : [i, k, j];
    emitTri(b, tri.map((q) => P[q].p), uvAxes); // uv from displaced position is fine for untextured/stretched use
  };
  for (let y = 0; y < N - 1; y++) for (let x = 0; x < N - 1; x++) { const a = y * N + x, bb = a + 1, d = a + N, e = d + 1; face(a, bb, e); face(a, e, d); }
  return true;
}

// ---------- solids ----------
let brushCount = 0, dispCount = 0, skipped = 0;
function emitSolid(solid, target = parts) {
  const sides = parseSides(solid);
  if (sides.length < 4) return;
  brushCount++;
  const hasDisp = sides.some((x) => x.disp); // VBSP discards every non-displacement face on a displacement brush
  sides.forEach((side, i) => {
    if (hasDisp && !side.disp) { skipped++; return; }
    if (SKIP.test(side.material) || !side.material) { skipped++; return; }
    const poly = sidePolygon(sides, i);
    if (poly.length < 3) return;
    const b = bucket(side.material, target), uvAxes = side.u && side.v ? [parseAxis(side.u), parseAxis(side.v)] : null;
    if (side.disp) { dispCount++; if (emitDisplacement(b, poly, side, uvAxes)) return; }
    // fan triangulation; the polygon is counter-clockwise seen from outside
    for (let k = 1; k < poly.length - 1; k++) emitTri(b, [poly[0], poly[k], poly[k + 1]], uvAxes);
  });
}

// ---------- props ----------
const rotation = ([pitch, yaw, roll]) => {
  const d = Math.PI / 180, sp = Math.sin(pitch * d), cp = Math.cos(pitch * d), sy = Math.sin(yaw * d), cy = Math.cos(yaw * d), sr = Math.sin(roll * d), cr = Math.cos(roll * d);
  return [[cp * cy, sr * sp * cy - cr * sy, cr * sp * cy + sr * sy], [cp * sy, sr * sp * sy + cr * cy, cr * sp * sy - sr * cy], [-sp, sr * cp, cr * cp]];
};
const applyM = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
// shortcut: CS:GO props missing from local CS:S/CS2 content map to dimension-verified Source 1 / CS2 equivalents; remove if legacy CS:GO .mdl pack is added
const PROP_SUBS = {
  'models/props_vehicles/van.mdl': 'models/props/cs_militia/van.mdl',
  'models/props_vehicles/van001a.mdl': 'models/props/cs_militia/van.mdl',
  'models/props_vehicles/van_glass.mdl': 'models/props/cs_militia/van_glass.mdl',
  'models/props_vehicles/hmmwv.mdl': 'models/props_vehicles/van.mdl',
  'models/props_vehicles/truck_low_flatbed.mdl': 'models/de_overpass/vehicles/flatnose_truck_bed/flatnose_truck_bed_1.mdl',
  'models/props_junk/dumpster.mdl': 'models/props_junk/dumpster_2.mdl',
  'models/props_mill/mill_railing_64.mdl': 'models/props/de_inferno/railing04.mdl',
  'models/props_urban/fence001_64.mdl': 'models/props_urban/fence001_128.mdl',
  'models/props_lab/powerbox02b.mdl': 'models/props/de_dust/hr_dust/dust_electrical_powerbox/dust_electrical_powerbox.mdl',
  'models/props/de_house/swat_van.mdl': 'models/props/cs_militia/van.mdl',
  'models/props/de_house/swat_van_generic.mdl': 'models/props/cs_militia/van.mdl',
  'models/props/props_crates/wooden_crate_64x64.mdl': 'models/props/de_dust/du_crate_64x64.mdl',
  'models/props/props_crates/wooden_crate_64x64_dirt.mdl': 'models/props/de_dust/du_crate_64x64.mdl',
  'models/props/props_crates/wooden_crate_64x64_bleach.mdl': 'models/props/de_dust/du_crate_64x64.mdl',
  'models/props/props_crates/wooden_crate_32x64.mdl': 'models/props/de_dust/hr_dust/dust_crates/dust_crate_style_02_32x64x64.mdl',
  'models/props/props_crates/wooden_crate_32x64_side.mdl': 'models/props/de_dust/hr_dust/dust_crates/dust_crate_style_01_64x32x64.mdl',
  'models/props/de_dust/hr_dust/dust_crates/dust_crate_style_02_32x32x32.mdl': 'models/props/cs_militia/crate_extrasmallmill.mdl',
  'models/props/de_dust/dust_rusty_barrel.mdl': 'models/props_c17/oildrum001.mdl',
  'models/props/de_vertigo/pallet_01.mdl': 'models/props_junk/wood_pallet001a.mdl',
  'models/props/de_dust/pallet02.mdl': 'models/props_junk/wood_pallet001a.mdl',
  'models/props/de_mirage/bench_a.mdl': 'models/props/de_inferno/bench_wood.mdl',
  'models/props/de_inferno/bench_wood_new.mdl': 'models/props/de_inferno/bench_wood.mdl',
  'models/props_urban/bench001.mdl': 'models/props/de_inferno/bench_concrete.mdl',
  'models/props/de_aztec/grasstuft01.mdl': 'models/props_foliage/shrub_01a.mdl',
  'models/props/de_aztec/grasstuft02.mdl': 'models/props_foliage/shrub_01a.mdl',
  'models/props_debris/plaster_floorpile001a.mdl': 'models/cs_italy/nature/debris/nature_debris_pile_1.mdl',
  'models/props_debris/corner_rubble1.mdl': 'models/cs_italy/nature/debris/nature_debris_pile_1.mdl',
  'models/props_highway/corrugated_panel_03.mdl': 'models/props_highway/corrugated_panel_02.mdl',
  'models/props/de_piranesi/pi_5gallonbucket02.mdl': 'models/de_overpass/junk/plasticbucket001/plasticbucket001.mdl',
  'models/props_debris/barricade_short03a.mdl': 'models/cs_italy/italy_barricade/italy_barricade.mdl',
  'models/props_debris/barricade_short02a.mdl': 'models/cs_italy/italy_barricade/italy_barricade.mdl',
  'models/props_debris/barricade_tall01a.mdl': 'models/cs_italy/italy_barricade/italy_barricade.mdl',
  'models/props_fortifications/concrete_wall001_140_reference.mdl': 'models/props_fortifications/police_barrier001_128_reference.mdl',
  'models/props_fortifications/barricade_razorwire001_128_reference.mdl': 'models/props_fortifications/police_barrier001_128_reference.mdl',
  'models/props_urban/curb_straight001_512.mdl': 'models/props_urban/curb_straight001_256.mdl',
  'models/props_urban/curb_ramp001_256.mdl': 'models/props_urban/curb_straight001_256.mdl',
  'models/props_urban/curb_curve001_64.mdl': 'models/props_urban/curb_curve002_64.mdl',
  'models/props_street/parking_bumper_01.mdl': 'models/props_urban/curb_straight001_128.mdl',
  'models/props_urban/fence_cover001_64.mdl': 'models/props/de_dust/hr_dust/dust_fences/dust_chainlink_fence_cover_001_64.mdl',
  'models/props_c17/fence01a.mdl': 'models/props_urban/fence001_128.mdl',
  'models/props_wasteland/exterior_fence002c.mdl': 'models/props_urban/fence001_128.mdl',
  'models/props_urban/fence003_128.mdl': 'models/props_urban/fence001_128.mdl',
  'models/props_urban/fence002_64.mdl': 'models/props_urban/fence001_128.mdl',
  'models/props_urban/fence002_256.mdl': 'models/props_urban/fence_gate002_256.mdl',
  'models/props_urban/fence001_256.mdl': 'models/props_urban/fence_gate002_256.mdl',
  'models/props_foliage/urban_tree_giant01_medium.mdl': 'models/props_foliage/tree_city01.mdl',
  'models/props_foliage/urban_streettree01_medium.mdl': 'models/props_foliage/tree_city01.mdl',
  'models/props_foliage/mall_tree_medium01.mdl': 'models/props_foliage/mall_tree_large01.mdl',
  'models/props_foliage/urban_bush_angled_256.mdl': 'models/props_foliage/bushes_tropical_straight01.mdl',
  'models/props_foliage/urban_bush_angled_128.mdl': 'models/props_foliage/urban_bush02.mdl',
  'models/props_foliage/urban_bush_angled_64.mdl': 'models/props_foliage/urban_bush02.mdl',
  'models/props_foliage/urban_hedge_256_128_high.mdl': 'models/de_overpass/foliage/hedge/hedge_128a.mdl',
  'models/props_foliage/bushes_tropical_large01.mdl': 'models/props_foliage/bushes_tropical_straight01.mdl',
  'models/props_foliage/mall_bush02.mdl': 'models/props_foliage/urban_bush02.mdl',
  'models/props_foliage/mall_fern01.mdl': 'models/cs_italy/foliage/fern/fern_plant_1.mdl',
  'models/props_foliage/mall_pot_square01.mdl': 'models/cs_italy/props/planter/italy_flower_pot_1.mdl',
  'models/props_foliage/urban_vine02.mdl': 'models/props/cs_militia/vine_wall2.mdl',
  'models/props_foliage/urban_vine03.mdl': 'models/props/cs_militia/vine_wall2.mdl',
  'models/props_windows/brick_window03_pillar.mdl': 'models/props/de_inferno/brickpillara.mdl',
  'models/props_windows/window_urban_bars_med.mdl': 'models/cs_italy/italy_window_bars.mdl',
  'models/props_urban/chimney002.mdl': 'models/props_urban/chimney001.mdl',
  'models/props_urban/chimney004_02.mdl': 'models/props/de_inferno/chimney01.mdl',
  'models/props_urban/chimney006_02.mdl': 'models/props/de_inferno/chimney02.mdl',
  'models/props_urban/chimney007.mdl': 'models/props/de_inferno/chimney01.mdl',
  'models/props_urban/parkinglot_light001.mdl': 'models/props_urban/streetlight001.mdl',
  'models/props_rooftop/vent_large1.mdl': 'models/props_rooftop/hotel_rooftop_equip003.mdl',
  'models/props_rooftop/hotel_rooftop_equip002.mdl': 'models/props_rooftop/hotel_rooftop_equip003.mdl',
  'models/props_fairgrounds/traffic_barrel.mdl': 'models/props/de_vertigo/trafficcone_clean.mdl',
  'models/props_junk/trafficcone001a.mdl': 'models/de_overpass/construction/traffic_cone_1.mdl',
  'models/props_junk/glassbottle01a.mdl': 'models/props/cs_militia/bottle01.mdl',
  'models/props_junk/garbage_glassbottle002a.mdl': 'models/props/cs_militia/bottle01.mdl',
  'models/props/props_utilities/electric_cables06.mdl': 'models/cs_italy/props/rubble/electric_cables_1.mdl',
  'models/props_lab/powerbox03a.mdl': 'models/props/de_dust/hr_dust/dust_electrical_powerbox/dust_electrical_powerbox.mdl',
  'models/props_equipment/phone_booth.mdl': 'models/props/hr_massive/survival_phone_booth/survival_phone_booth.mdl',
  'models/props/cs_assault/fencewarehouse_rail_64.mdl': 'models/props/de_inferno/railing04.mdl',
  'models/props_urban/railing04small.mdl': 'models/props/de_inferno/railing04.mdl',
  'models/props_urban/railing04med.mdl': 'models/props/de_inferno/railing04.mdl',
  'models/props_mill/stair_railing_long.mdl': 'models/props/de_inferno/hr_i/inferno_stair_railing/inferno_stair_railing.mdl',
  'models/props_mill/stair_railing_short.mdl': 'models/props/de_inferno/hr_i/inferno_stair_railing/inferno_stair_railing.mdl',
  'models/props_pipes/hotel_pipe004.mdl': 'models/props_pipes/hotel_pipe001.mdl',
  'models/props_pipes/concrete_pipe001b.mdl': 'models/props/de_train/de_train_drainage_pipe.mdl',
  'models/props_urban/light_fixture01.mdl': 'models/props_urban/emergency_light001.mdl',
  'models/props_lighting/lightfixture04_off.mdl': 'models/props_urban/emergency_light001.mdl',
  'models/props_lighting/lightfixture04.mdl': 'models/props_urban/emergency_light001.mdl',
  'models/props_c17/light_cagelight02_on.mdl': 'models/props_urban/emergency_light001.mdl',
  'models/props_doors/doorglassmain01_small.mdl': 'models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001.mdl',
  'models/props_urban/outhouse_door001.mdl': 'models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001.mdl',
  'models/props_downtown/metal_door_112.mdl': 'models/props/de_nuke/hr_nuke/metal_door_001/metal_door_001.mdl',
};
let s1Base = null;
function findS1Base(model) {
  if (!s1Base) {
    s1Base = new Map();
    const walk = (d) => {
      if (!fs.existsSync(d)) return;
      for (const f of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name.endsWith('.mdl')) {
          const b = f.name.slice(0, -4).toLowerCase();
          if (!s1Base.has(b)) s1Base.set(b, 'models/' + path.relative(path.join(CONTENT, 'models'), p).replace(/\\/g, '/').toLowerCase());
        }
      }
    };
    walk(path.join(CONTENT, 'models'));
  }
  const base = model.slice(model.lastIndexOf('/') + 1, -4);
  return s1Base.get(base) ?? null;
}
function resolveModelBase(model) {
  const raw = [model, model.endsWith('_static.mdl') ? model.replace(/_static\.mdl$/, '.mdl') : null].filter(Boolean);
  for (const c of raw) { const b = modelBase(c); if (b) return { resolved: c, base: b }; }
  for (const c of raw) if (hasCs2Model(c)) return { resolved: c, base: null, cs2: true };
  if (model.endsWith('_glass.mdl') && !resolveModelBase(model.replace(/_glass\.mdl$/, '.mdl'))) return null;
  const sub = PROP_SUBS[model];
  if (sub) {
    const b = modelBase(sub); if (b) return { resolved: sub, base: b };
    if (hasCs2Model(sub)) return { resolved: sub, base: null, cs2: true };
  }
  const s1 = findS1Base(model);
  if (s1) { const b = modelBase(s1); if (b) return { resolved: s1, base: b }; }
  return null;
}
const models = new Map();
let propsPlaced = 0; const propsMissing = new Map();
function emitProp(ent, cap, target = parts) {
  const model = (ent.props.get('model') ?? '').replace(/\\/g, '/').toLowerCase();
  if (!model.endsWith('.mdl')) return null;
  const skin = Number(ent.props.get('skin') ?? 0), key = `${model}#${skin}#${cap ?? ''}`;
  if (!models.has(key)) {
    const res = resolveModelBase(model);
    if (!res) models.set(key, null);
    else { try { const m = res.cs2 ? loadCs2Model(res.resolved, skin, cap) : loadModel(res.base, skin); models.set(key, m ? { m, ...res } : null); } catch { models.set(key, null); } }
  }
  const hit = models.get(key);
  if (!hit?.m.meshes.some((mesh) => mesh.pos.length)) { propsMissing.set(model, (propsMissing.get(model) ?? 0) + 1); return null; }
  const { m, base, resolved } = hit;
  propsPlaced++;
  const scale = Number(ent.props.get('modelscale') ?? ent.props.get('uniformscale') ?? 1) || 1;
  const o = nums(ent.props.get('origin') ?? '0 0 0'), M = rotation(nums(ent.props.get('angles') ?? '0 0 0'));
  for (const mesh of m.meshes) {
    const cds = mesh.cd.length ? mesh.cd : [''];
    const matName = (cds[0] + mesh.material).replace(/\\/g, '/').toLowerCase();
    const found = cds.map((c) => (c + mesh.material).replace(/\\/g, '/').toLowerCase()).find((n) => material(n)) ?? matName;
    const b = bucket('prop:' + found, target);
    b.name = 'prop:' + found; b.texW = b.texH = 1; // model UVs are already 0..1
    for (let i = 0; i < mesh.pos.length; i += 3) {
      const p = scale === 1 ? mesh.pos.slice(i, i + 3) : [mesh.pos[i] * scale, mesh.pos[i + 1] * scale, mesh.pos[i + 2] * scale];
      b.pos.push(...add(applyM(M, p), o));
    }
    for (const uv of mesh.uv) b.uv.push(uv);
  }
  const isDoor = ent.props.get('classname') === 'prop_door_rotating';
  return { m, model: resolved, rawModel: model, base, o, M, scale, solid: isDoor ? 0 : Number(ent.props.get('solid') ?? 6) };
}

function emitOverlay(ent, hasAlphaTex, target, faces) {
  const mat = (ent.props.get('material') ?? '').replace(/\\/g, '/').toLowerCase().trim();
  if (!mat || SKIP.test(mat)) return false;
  const s1 = material(mat);
  if (!(s1 ? s1.alpha !== 'OPAQUE' : hasAlphaTex?.(mat))) return false;
  const bo = ent.props.get('BasisOrigin'), bu = ent.props.get('BasisU'), bv = ent.props.get('BasisV'), bn = ent.props.get('BasisNormal');
  if (!bo || !bu || !bv || !bn) return false;
  const O = nums(bo), U = nums(bu), V = nums(bv), N = norm(nums(bn));
  const order = Math.min(Math.max(Number(ent.props.get('RenderOrder') ?? 0) || 0, 0), 4);
  const off = 0.08 + order * 0.04;
  const q = ['uv0', 'uv1', 'uv2', 'uv3'].map((k) => ent.props.get(k)).filter(Boolean).map(nums);
  if (q.length !== 4) return false;
  const P = q.map(([u, v, w]) => add(add(add(O, mul(U, u)), mul(V, v)), mul(N, w || 0)));
  const u0 = Number(ent.props.get('StartU') ?? 0), u1 = Number(ent.props.get('EndU') ?? 1);
  const v0 = Number(ent.props.get('StartV') ?? 0), v1 = Number(ent.props.get('EndV') ?? 1);
  const T = [[u0, v0], [u0, v1], [u1, v1], [u1, v0]];
  const b = bucket('overlay:' + mat, target);
  const before = b.pos.length;
  b.name = 'overlay:' + mat; b.texW = b.texH = 1;
  for (const id of new Set((ent.props.get('sides') ?? '').trim().split(/\s+/))) {
    const face = faces.get(id);
    if (!face || dot(face.n, N) < 0.1) continue;
    const { poly, n, d } = face;
    let decal = P.map((p, i) => ({ p: add(p, mul(N, (d - dot(n, p)) / dot(n, N))), uv: T[i] }));
    for (let i = 0; i < poly.length && decal.length >= 3; i++) {
      const a = poly[i], edge = cross(sub(poly[(i + 1) % poly.length], a), n);
      const next = [];
      for (let j = 0; j < decal.length; j++) {
        const u = decal[j], v = decal[(j + 1) % decal.length];
        const du = dot(edge, sub(u.p, a)), dv = dot(edge, sub(v.p, a));
        if (du <= 0) next.push(u);
        if ((du <= 0) !== (dv <= 0)) {
          const t = du / (du - dv);
          next.push({ p: lerp(u.p, v.p, t), uv: u.uv.map((x, k) => x + (v.uv[k] - x) * t) });
        }
      }
      decal = next;
    }
    for (let i = 1; i + 1 < decal.length; i++) {
      const tri = [decal[0], decal[i], decal[i + 1]];
      const area = dot(cross(sub(tri[1].p, tri[0].p), sub(tri[2].p, tri[0].p)), n);
      if (Math.abs(area) < 1e-3) continue;
      if (area < 0) [tri[1], tri[2]] = [tri[2], tri[1]];
      for (const v of tri) { b.pos.push(...add(v.p, mul(n, off))); b.uv.push(...v.uv); }
    }
  }
  return b.pos.length > before;
}

// ---------- main ----------
export { parseVmf, parseSides, sidePolygon, emitSolid, emitProp, emitOverlay, resolveModelBase, parts, propsMissing, SKIP };
if (path.resolve(process.argv[1] ?? '') === path.resolve(import.meta.filename)) {
const [vmfFile, outFile] = process.argv.slice(2);
if (!vmfFile || !outFile) { console.log('usage: node tools/vmf-export.mjs <map.vmf> <out.glb>'); process.exit(1); }
const tree = parseVmf(fs.readFileSync(vmfFile, 'latin1'));
for (const node of tree.kids) {
  if (node.name === 'world') node.kids.filter((k) => k.name === 'solid').forEach((s) => emitSolid(s));
  else if (node.name === 'entity') {
    const cls = node.props.get('classname') ?? '';
    if (/^prop_(static|dynamic|physics|detail)/.test(cls)) emitProp(node);
    else if (!/^(trigger_|func_buyzone|func_bomb_target|func_hostage_rescue|func_areaportal|func_occluder|func_clip|func_nav|func_precipitation)/.test(cls)) node.kids.filter((k) => k.name === 'solid').forEach((s) => emitSolid(s));
  }
}
fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
const r = writeGlb(path.resolve(outFile), { name: path.basename(vmfFile, '.vmf'), parts: [...parts.values()] });
const textured = [...parts.values()].filter((p) => p.material.png).length;
console.log(`${path.basename(vmfFile)}: ${brushCount} brushes (${dispCount} displacements), ${propsPlaced} props (${propsMissing.size} models not in content), ${r.tris} triangles, ${textured}/${r.parts} textured meshes, ${(r.bytes / 1e6).toFixed(1)} MB`);
}
