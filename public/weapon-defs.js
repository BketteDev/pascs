// Weapon data shared by the build (which converts models/sounds), the game and the server.
// Numbers follow the CS:S / 1.6 weapon code (reconstructed from the SDK lineage):
//   accuracy: m_flAccuracy. 'shots' = f(m_iShotsFired): min(max, shots^pow / div + base); 'time' = pistols, recovers with the time
//             since the last shot (start/min/max, rate, window); 'none' = fixed.
//   spread:   cone size in tan units = c + k * term, term = m_flAccuracy ('acc') or (1 - m_flAccuracy) ('inv'), by state: air, moving
//             (speed > moveSpeed), slow (scoped snipers), duck, stand. Bullets get a triangular random offset inside it.
//   recoil:   'kickback' = CWeaponCSBase::KickBack(upBase, latBase, upMod, latMod, upMax, latMax, flip), one set per movement state; 'punch' = flat view punch.
//   pen:      bullet penetration power (see ballistics.js); pellets: shotgun pellet count.
//   damage / rangeMod / armor: CS:S weapon script Damage, RangeModifier, ArmorRatio. upper: the third-person upper-body pose (Idle_Upper_<upper>).
const kick = ([upBase, latBase, upMod, latMod, upMax, latMax, flip]) => ({ upBase, latBase, upMod, latMod, upMax, latMax, flip });
// one KickBack parameter set per state, picked at fire time like CS:S: moving (> 5 u/s), in the air, ducking, standing still
// The spray is a fixed, learnable pattern per gun (every spray goes the same way): the view climbs, then drifts one way, swings back
// the other and so on. `pts[i]` = view punch (pitch up, yaw) in degrees after shot i + 1, built from the standing kick set; moving / crouched /
// airborne states scale it by their own kick maximums. sign -1 drifts left first, +1 right first.
const SWING = [[0, 0], [5, 0], [14, -1], [20, 0.55], [26, -0.85], [32, 0.3], [40, -0.15]]; // yaw template (fraction of the lateral maximum) by shot
const swingAt = (i) => { for (let k = 1; k < SWING.length; k++) if (i <= SWING[k][0]) { const [a, b] = [SWING[k - 1], SWING[k]]; return a[1] + ((b[1] - a[1]) * (i - a[0])) / (b[0] - a[0]); } return SWING.at(-1)[1]; };
const patternPts = (r, sign) => Array.from({ length: 40 }, (_, i) => [r.upMax * (1 - Math.exp(-(i + 1) / 5)), sign * r.latMax * 1.6 * swingAt(i)]);
const kicks = (stand, move, duck, air, airFirst = false, sign = -1) => ({ type: 'kickback', stand: kick(stand), move: kick(move), duck: kick(duck), air: kick(air), airFirst, pts: patternPts(kick(stand), sign) });
const shotsAcc = (pow, div, base, max) => ({ kind: 'shots', pow, div, base, max });
const pistolAcc = (start, min, max, rate, window) => ({ kind: 'time', start, min, max, rate, window });
const rifleSpread = (air, move, stand, moveSpeed = 140) => ({ term: 'acc', moveSpeed, air, move, stand });
const pistolSpread = (air, move, duck, stand) => ({ term: 'inv', moveSpeed: 5, air: [0, air], move: [0, move], duck: [0, duck], stand: [0, stand] });
// AWP / Scout are tuned like CS:GO: dead accurate scoped when (nearly) still, a small window to stop in, the Scout accurate at a jump's apex
const snipeSpread = (air, move, slow, stand, unscoped) => ({ term: 'acc', moveSpeed: 140, air: [air, 0], move: [move, 0], slow: [slow, 0], slowSpeed: 10, duck: [0, 0], stand: [stand, 0], unscoped });
const noGrenadeStats = { mag: 0, reserve: 0, speed: 250, reload: 0, deploy: 1.0, accuracy: { kind: 'none' }, spread: rifleSpread([0, 0], [0, 0], [0, 0], 1e9), recoil: { type: 'none' } };

export const WEAPONS = {
  // ---- pistols ----
  glock: { burst: { n: 3, gap: 0.1, cycle: 0.5, spread: 1.2 }, name: 'Glock 18', icon: 'glock18', slot: 2, model: 'v_pist_glock18', price: 400, team: 't', damage: 25, cycle: 0.15, mag: 20, reserve: 120, speed: 250, reload: 2.2, deploy: 1.0, pen: 1, rangeMod: 0.75, armor: 1.05, upper: 'PISTOL',
    accuracy: pistolAcc(0.9, 0.6, 0.9, 0.275, 0.325), spread: pistolSpread(1.0, 0.165, 0.075, 0.1), recoil: { type: 'punch', pitch: 0.3 },
    sounds: { fire: 'glock/glock18-1', empty: 'clipempty_pistol', deploy: 'glock/glock_slideback', reload: [[0.45, 'glock/glock_clipout'], [1.4, 'glock/glock_clipin'], [1.9, 'glock/glock_sliderelease']] } },
  usp: { name: 'USP', silenced: true, icon: 'usp45', slot: 2, model: 'v_pist_usp', price: 500, team: 'ct', damage: 34, cycle: 0.15, mag: 12, reserve: 100, speed: 250, reload: 2.2, deploy: 1.0, pen: 1, rangeMod: 0.79, armor: 1.0, upper: 'PISTOL',
    accuracy: pistolAcc(0.92, 0.6, 0.92, 0.275, 0.3), spread: pistolSpread(1.3, 0.25, 0.075, 0.1), recoil: { type: 'punch', pitch: 0.35 },
    sounds: { fire: 'usp/usp1', empty: 'clipempty_pistol', deploy: 'usp/usp_slideback', reload: [[0.45, 'usp/usp_clipout'], [1.4, 'usp/usp_clipin'], [1.9, 'usp/usp_sliderelease']] } },
  p228: { name: 'P228', icon: 'p228', slot: 2, model: 'v_pist_p228', price: 600, damage: 40, cycle: 0.15, mag: 13, reserve: 52, speed: 250, reload: 2.7, deploy: 1.0, pen: 1, rangeMod: 0.8, armor: 1.25, upper: 'PISTOL',
    accuracy: pistolAcc(0.9, 0.6, 0.92, 0.3, 0.325), spread: pistolSpread(1.5, 0.255, 0.075, 0.15), recoil: { type: 'punch', pitch: 0.35 },
    sounds: { fire: 'p228/p228-1', empty: 'clipempty_pistol', deploy: 'p228/p228_slidepull', reload: [[0.5, 'p228/p228_clipout'], [1.6, 'p228/p228_clipin'], [2.3, 'p228/p228_sliderelease']] } },
  deagle: { name: 'Desert Eagle', icon: 'deserteagle', slot: 2, model: 'v_pist_deagle', price: 650, damage: 54, cycle: 0.225, mag: 7, reserve: 35, speed: 250, reload: 2.2, deploy: 1.0, pen: 2, rangeMod: 0.81, armor: 1.5, upper: 'PISTOL',
    accuracy: pistolAcc(0.9, 0.55, 0.9, 0.35, 0.4), spread: pistolSpread(1.5, 0.25, 0.115, 0.13), recoil: { type: 'punch', pitch: 0.9 },
    sounds: { fire: 'deagle/deagle-1', empty: 'clipempty_pistol', deploy: 'deagle/de_deploy', reload: [[0.45, 'deagle/de_clipout'], [1.4, 'deagle/de_clipin'], [1.9, 'deagle/de_slideback']] } },
  elite: { name: 'Dual Berettas', icon: 'elites', slot: 2, model: 'v_pist_elite', price: 800, team: 't', damage: 45, cycle: 0.12, mag: 30, reserve: 120, speed: 250, reload: 4.3, deploy: 1.0, pen: 1, rangeMod: 0.75, armor: 1.05, upper: 'ELITES',
    accuracy: pistolAcc(0.88, 0.55, 0.88, 0.275, 0.325), spread: pistolSpread(1.3, 0.175, 0.08, 0.1), recoil: { type: 'punch', pitch: 0.35 },
    sounds: { fire: 'elite/elite-1', empty: 'clipempty_pistol', deploy: 'elite/elite_deploy', reload: [[0.4, 'elite/elite_reloadstart'], [1.2, 'elite/elite_clipout'], [2.0, 'elite/elite_leftclipin'], [3.0, 'elite/elite_rightclipin'], [3.9, 'elite/elite_sliderelease']] } },
  fiveseven: { name: 'Five-SeveN', icon: 'fiveseven', slot: 2, model: 'v_pist_fiveseven', price: 750, team: 'ct', damage: 25, cycle: 0.15, mag: 20, reserve: 100, speed: 250, reload: 2.7, deploy: 1.0, pen: 1, rangeMod: 0.885, armor: 1.5, upper: 'PISTOL',
    accuracy: pistolAcc(0.92, 0.725, 0.92, 0.275, 0.3), spread: pistolSpread(1.5, 0.255, 0.075, 0.15), recoil: { type: 'punch', pitch: 0.3 },
    sounds: { fire: 'fiveseven/fiveseven-1', empty: 'clipempty_pistol', deploy: 'fiveseven/fiveseven_slidepull', reload: [[0.5, 'fiveseven/fiveseven_clipout'], [1.6, 'fiveseven/fiveseven_clipin'], [2.3, 'fiveseven/fiveseven_sliderelease']] } },

  // ---- shotguns (reload one shell at a time) ----
  m3: { name: 'M3', icon: 'm3', slot: 1, model: 'v_shot_m3super90', price: 1700, damage: 26, pellets: 9, cycle: 0.88, mag: 8, reserve: 32, speed: 230, shell: 0.5, reload: 0.5, deploy: 1.0, pen: 0, rangeMod: 0.7, armor: 1.0, upper: 'M3S90',
    accuracy: { kind: 'none' }, spread: rifleSpread([0.0675, 0], [0.0675, 0], [0.0675, 0]), recoil: { type: 'punch', pitch: 3 },
    sounds: { fire: 'm3/m3-1', empty: 'clipempty_rifle', deploy: 'm3/m3_pump', shellSound: 'm3/m3_insertshell', pump: 'm3/m3_pump' } },
  xm1014: { name: 'XM1014', icon: 'xm1014', slot: 1, model: 'v_shot_xm1014', price: 3000, auto: true, damage: 22, pellets: 6, cycle: 0.25, mag: 7, reserve: 32, speed: 240, shell: 0.4, reload: 0.4, deploy: 1.0, pen: 0, rangeMod: 0.7, armor: 1.0, upper: 'XM1014',
    accuracy: { kind: 'none' }, spread: rifleSpread([0.0725, 0], [0.0725, 0], [0.0725, 0]), recoil: { type: 'punch', pitch: 3 },
    sounds: { fire: 'xm1014/xm1014-1', empty: 'clipempty_rifle', shellSound: 'xm1014/xm1014_insertshell' } },

  // ---- submachine guns ----
  mac10: { name: 'MAC-10', icon: 'mac10', slot: 1, model: 'v_smg_mac10', price: 1400, team: 't', auto: true, damage: 29, cycle: 0.075, mag: 30, reserve: 100, speed: 250, reload: 3.15, deploy: 1.0, pen: 1, rangeMod: 0.82, armor: 0.95, upper: 'MAC10',
    accuracy: shotsAcc(3, 200, 0.6, 1.65), spread: rifleSpread([0, 0.375], [0, 0.03], [0, 0.03], 140), recoil: kicks([0.775, 0.425, 0.2, 0.03, 3, 2.75, 9], [0.9, 0.45, 0.25, 0.035, 3.5, 2.75, 7], [0.75, 0.4, 0.175, 0.03, 2.75, 2.5, 10], [1.3, 0.55, 0.4, 0.05, 4.75, 3.75, 5], true),
    sounds: { fire: 'mac10/mac10-1', empty: 'clipempty_rifle', deploy: 'mac10/mac10_boltpull', reload: [[0.6, 'mac10/mac10_clipout'], [1.7, 'mac10/mac10_clipin'], [2.7, 'mac10/mac10_boltpull']] } },
  tmp: { name: 'TMP', icon: 'tmp', slot: 1, model: 'v_smg_tmp', price: 1250, team: 'ct', auto: true, damage: 26, cycle: 0.07, mag: 30, reserve: 120, speed: 250, reload: 2.12, deploy: 1.0, pen: 1, rangeMod: 0.84, armor: 1.0, upper: 'TMP',
    accuracy: shotsAcc(3, 200, 0.55, 1.4), spread: rifleSpread([0, 0.25], [0, 0.03], [0, 0.03], 140), recoil: kicks([0.725, 0.375, 0.15, 0.025, 2.75, 2.25, 9], [0.8, 0.4, 0.2, 0.03, 3, 2.5, 7], [0.7, 0.35, 0.125, 0.025, 2.5, 2, 10], [1.1, 0.5, 0.35, 0.045, 4.5, 3.5, 6], true),
    sounds: { fire: 'tmp/tmp-1', empty: 'clipempty_rifle', reload: [[0.6, 'tmp/tmp_clipout'], [1.4, 'tmp/tmp_clipin']] } },
  mp5: { name: 'MP5', icon: 'mp5', slot: 1, model: 'v_smg_mp5', price: 1500, auto: true, damage: 26, cycle: 0.08, mag: 30, reserve: 120, speed: 250, reload: 2.63, deploy: 1.0, pen: 1, rangeMod: 0.84, armor: 1.0, upper: 'MP5',
    accuracy: shotsAcc(2, 220, 0.45, 0.75), spread: rifleSpread([0, 0.2], [0, 0.04], [0, 0.04], 1e9), recoil: kicks([0.25, 0.175, 0.125, 0.02, 2.25, 1.25, 10], [0.5, 0.275, 0.2, 0.03, 3, 2, 10], [0.225, 0.15, 0.1, 0.015, 2, 1, 10], [0.9, 0.475, 0.35, 0.0425, 5, 3, 6], true, 1),
    sounds: { fire: 'mp5navy/mp5-1', empty: 'clipempty_rifle', reload: [[0.6, 'mp5navy/mp5_clipout'], [1.7, 'mp5navy/mp5_clipin'], [2.3, 'mp5navy/mp5_slideback']] } },
  ump45: { name: 'UMP-45', icon: 'ump45', slot: 1, model: 'v_smg_ump45', price: 1700, auto: true, damage: 30, cycle: 0.105, mag: 25, reserve: 100, speed: 250, reload: 3.5, deploy: 1.0, pen: 1, rangeMod: 0.82, armor: 1.0, upper: 'UMP45',
    accuracy: shotsAcc(2, 210, 0.5, 1.0), spread: rifleSpread([0, 0.24], [0, 0.04], [0, 0.04], 1e9), recoil: kicks([0.275, 0.2, 0.15, 0.02, 2.5, 1.5, 10], [0.55, 0.3, 0.225, 0.03, 3.5, 2.5, 10], [0.25, 0.175, 0.125, 0.02, 2.25, 1.25, 10], [0.125, 0.65, 0.55, 0.0475, 5.5, 4, 10], true, 1),
    sounds: { fire: 'ump45/ump45-1', empty: 'clipempty_rifle', reload: [[0.6, 'ump45/ump45_clipout'], [2.0, 'ump45/ump45_clipin'], [3.0, 'ump45/ump45_boltslap']] } },
  p90: { name: 'P90', icon: 'p90', slot: 1, model: 'v_smg_p90', price: 2350, auto: true, damage: 26, cycle: 0.07, mag: 50, reserve: 100, speed: 245, reload: 3.3, deploy: 1.0, pen: 1, rangeMod: 0.84, armor: 1.5, upper: 'P90',
    accuracy: shotsAcc(2, 175, 0.45, 1.0), spread: rifleSpread([0, 0.3], [0, 0.115], [0, 0.045], 170), recoil: kicks([0.3, 0.225, 0.125, 0.02, 3.25, 1.25, 8], [0.45, 0.3, 0.2, 0.0275, 4, 2.25, 7], [0.275, 0.2, 0.125, 0.02, 3, 1, 9], [0.9, 0.45, 0.35, 0.04, 5.25, 3.5, 4], true),
    sounds: { fire: 'p90/p90-1', empty: 'clipempty_rifle', deploy: 'p90/p90_boltpull', reload: [[0.6, 'p90/p90_clipout'], [2.0, 'p90/p90_clipin'], [2.8, 'p90/p90_cliprelease'], [3.0, 'p90/p90_boltpull']] } },

  // ---- rifles ----
  galil: { rightHanded: true, name: 'Galil', icon: 'galil', slot: 1, model: 'v_rif_galil', price: 2000, team: 't', auto: true, damage: 30, cycle: 0.09, mag: 35, reserve: 90, speed: 215, reload: 2.45, deploy: 1.0, pen: 2, rangeMod: 0.98, armor: 1.55, upper: 'GALIL',
    accuracy: shotsAcc(3, 200, 0.35, 1.25), spread: rifleSpread([0.04, 0.3], [0.04, 0.07], [0, 0.0375]), recoil: kicks([0.65, 0.35, 0.25, 0.015, 3.5, 2.25, 7], [1, 0.45, 0.28, 0.045, 3.75, 3, 7], [0.6, 0.3, 0.2, 0.0125, 3.25, 2, 7], [1.2, 0.5, 0.23, 0.15, 5.5, 3.5, 6]),
    sounds: { fire: 'galil/galil-1', empty: 'clipempty_rifle', deploy: 'galil/galil_boltpull', reload: [[0.6, 'galil/galil_clipout'], [1.6, 'galil/galil_clipin'], [2.1, 'galil/galil_boltpull']] } },
  famas: { burst: { n: 3, gap: 0.075, cycle: 0.55, spread: 1 }, rightHanded: true, name: 'Clarion 5.56', icon: 'famas', slot: 1, model: 'v_rif_famas', price: 2250, team: 'ct', auto: true, damage: 30, cycle: 0.09, mag: 25, reserve: 90, speed: 220, reload: 3.3, deploy: 1.0, pen: 2, rangeMod: 0.96, armor: 1.4, upper: 'FAMAS',
    accuracy: shotsAcc(3, 215, 0.3, 1.0), spread: rifleSpread([0.03, 0.3], [0.03, 0.07], [0, 0.02]), recoil: kicks([0.625, 0.375, 0.25, 0.0125, 3.5, 2.25, 8], [1, 0.45, 0.275, 0.05, 4, 2.5, 7], [0.575, 0.325, 0.2, 0.011, 3.25, 2, 8], [1.25, 0.45, 0.22, 0.18, 5.5, 4, 5]),
    sounds: { fire: 'famas/famas-1', empty: 'clipempty_rifle', deploy: 'famas/famas_forearm', reload: [[0.6, 'famas/famas_clipout'], [1.8, 'famas/famas_clipin'], [2.6, 'famas/famas_forearm']] } },
  ak47: { name: 'AK-47', icon: 'ak47', slot: 1, model: 'v_rif_ak47', price: 2500, team: 't', auto: true, damage: 36, cycle: 0.0955, mag: 30, reserve: 90, speed: 221, reload: 2.45, deploy: 1.0, pen: 2, rangeMod: 0.98, armor: 1.55, upper: 'AK',
    accuracy: shotsAcc(3, 200, 0.35, 1.25), spread: rifleSpread([0.04, 0.4], [0.04, 0.07], [0, 0.0275]), recoil: kicks([1, 0.375, 0.175, 0.0375, 5.75, 1.75, 8], [1.5, 0.45, 0.225, 0.05, 6.5, 2.5, 7], [0.9, 0.35, 0.15, 0.025, 5.5, 1.5, 9], [2, 1, 0.5, 0.35, 9, 6, 5]),
    sounds: { fire: 'ak47/ak47-1', empty: 'clipempty_rifle', deploy: 'ak47/ak47_boltpull', reload: [[0.55, 'ak47/ak47_clipout'], [1.55, 'ak47/ak47_clipin'], [2.2, 'ak47/ak47_boltpull']] } },
  m4a1: { name: 'M4A1', icon: 'm4a1', slot: 1, model: 'v_rif_m4a1', price: 3100, team: 'ct', auto: true, damage: 33, cycle: 0.0875, mag: 30, reserve: 90, speed: 230, reload: 3.05, deploy: 1.0, pen: 2, rangeMod: 0.97, armor: 1.4, upper: 'M4',
    accuracy: shotsAcc(2, 220, 0.3, 1.0), spread: rifleSpread([0.035, 0.4], [0.035, 0.07], [0, 0.02]), recoil: kicks([0.65, 0.35, 0.25, 0.015, 3.5, 2.25, 7], [1, 0.45, 0.28, 0.045, 3.75, 3, 7], [0.6, 0.3, 0.2, 0.0125, 3.25, 2, 7], [1.2, 0.5, 0.23, 0.15, 5.5, 3.5, 6]),
    sounds: { fire: 'm4a1/m4a1_unsil-1', empty: 'clipempty_rifle', deploy: 'm4a1/m4a1_deploy', reload: [[0.6, 'm4a1/m4a1_clipout'], [1.7, 'm4a1/m4a1_clipin'], [2.6, 'm4a1/m4a1_boltpull']] } },
  aug: { name: 'AUG', icon: 'aug', slot: 1, model: 'v_rif_aug', price: 3500, team: 'ct', auto: true, damage: 32, cycle: 0.0825, mag: 30, reserve: 90, speed: 221, reload: 3.3, deploy: 1.0, pen: 2, rangeMod: 0.96, armor: 1.4, upper: 'AUG',
    accuracy: shotsAcc(3, 215, 0.3, 1.0), spread: rifleSpread([0.035, 0.4], [0.035, 0.07], [0, 0.02]), recoil: kicks([0.625, 0.375, 0.25, 0.0125, 3.5, 2.25, 8], [1, 0.45, 0.275, 0.05, 4, 2.5, 7], [0.575, 0.325, 0.2, 0.011, 3.25, 2, 8], [1.25, 0.45, 0.22, 0.18, 5.5, 4, 5]),
    sounds: { fire: 'aug/aug-1', empty: 'clipempty_rifle', deploy: 'aug/aug_boltslap', reload: [[0.6, 'aug/aug_clipout'], [1.8, 'aug/aug_clipin'], [2.6, 'aug/aug_boltpull'], [3.0, 'aug/aug_boltslap']] } },
  sg552: { name: 'SG 552', icon: 'sg552', slot: 1, model: 'v_rif_sg552', price: 3500, team: 't', auto: true, damage: 33, cycle: 0.0825, mag: 30, reserve: 90, speed: 222, reload: 3.0, deploy: 1.0, pen: 2, rangeMod: 0.955, armor: 1.4, upper: 'SG552',
    accuracy: shotsAcc(3, 220, 0.3, 1.0), spread: rifleSpread([0.035, 0.45], [0.035, 0.075], [0, 0.02]), recoil: kicks([0.625, 0.375, 0.25, 0.0125, 4, 2.25, 9], [1, 0.45, 0.28, 0.04, 4.25, 2.5, 7], [0.6, 0.35, 0.2, 0.0125, 3.7, 2, 10], [1.25, 0.45, 0.22, 0.18, 6, 4, 5]),
    sounds: { fire: 'sg552/sg552-1', empty: 'clipempty_rifle', deploy: 'sg552/sg552_boltpull', reload: [[0.6, 'sg552/sg552_clipout'], [1.7, 'sg552/sg552_clipin'], [2.4, 'sg552/sg552_boltpull']] } },

  // ---- sniper rifles ---- (rangeMod 1: no damage falloff with distance, unlike CS:S's 0.98-0.99 - long range is their job)
  scout: { name: 'Scout', icon: 'scout', slot: 1, model: 'v_snip_scout', price: 2750, damage: 75, cycle: 1.25, mag: 10, reserve: 90, speed: 260, reload: 2.0, deploy: 1.0, scope: [40, 15], pen: 2, rangeMod: 1, armor: 1.7, upper: 'SCOUT',
    accuracy: { kind: 'none' }, spread: { ...snipeSpread(0.2, 0.075, 0.008, 0, 0.025), slowSpeed: 45, jumpApex: true }, recoil: { type: 'punch', pitch: 2 },
    sounds: { fire: 'scout/scout_fire-1', empty: 'clipempty_rifle', deploy: 'scout/scout_bolt', bolt: [0.55, 'scout/scout_bolt'], reload: [[0.5, 'scout/scout_clipout'], [1.3, 'scout/scout_clipin']] } },
  sg550: { name: 'SG 550', icon: 'sg550', slot: 1, model: 'v_snip_sg550', price: 4200, team: 'ct', damage: 70, cycle: 0.25, mag: 30, reserve: 90, speed: 210, reload: 3.35, deploy: 1.0, scope: [40, 15], pen: 2, rangeMod: 1, armor: 1.45, upper: 'SG550',
    accuracy: { kind: 'none' }, spread: snipeSpread(0.45, 0.15, 0.06, 0.012, 0.04), recoil: { type: 'punch', pitch: 1.75 },
    sounds: { fire: 'sg550/sg550-1', empty: 'clipempty_rifle', deploy: 'sg550/sg550_boltpull', reload: [[0.6, 'sg550/sg550_clipout'], [2.2, 'sg550/sg550_clipin'], [2.9, 'sg550/sg550_boltpull']] } },
  g3sg1: { name: 'G3SG1', icon: 'g3sg1', slot: 1, model: 'v_snip_g3sg1', price: 5000, team: 't', damage: 80, cycle: 0.25, mag: 20, reserve: 90, speed: 210, reload: 3.5, deploy: 1.0, scope: [40, 15], pen: 3, rangeMod: 1, armor: 1.65, upper: 'G3',
    accuracy: { kind: 'none' }, spread: snipeSpread(0.45, 0.15, 0.06, 0.012, 0.04), recoil: { type: 'punch', pitch: 1.75 },
    sounds: { fire: 'g3sg1/g3sg1-1', empty: 'clipempty_rifle', deploy: 'g3sg1/g3sg1_slide', reload: [[0.6, 'g3sg1/g3sg1_clipout'], [2.4, 'g3sg1/g3sg1_clipin'], [3.0, 'g3sg1/g3sg1_slide']] } },
  awp: { name: 'AWP', icon: 'awp', slot: 1, model: 'v_snip_awp', price: 4750, damage: 115, cycle: 1.455, mag: 10, reserve: 30, speed: 210, reload: 2.5, deploy: 1.4, scope: [40, 10], pen: 3, rangeMod: 1, armor: 1.95, upper: 'AWP',
    accuracy: { kind: 'none' }, spread: { ...snipeSpread(0.85, 0.25, 0.02, 0, 0.08), slowSpeed: 35 }, recoil: { type: 'punch', pitch: 2 },
    sounds: { fire: 'awp/awp1', empty: 'clipempty_rifle', deploy: 'awp/awp_bolt', bolt: [0.55, 'awp/awp_bolt'], reload: [[0.7, 'awp/awp_clipout'], [1.7, 'awp/awp_clipin']] } },

  // ---- machine gun ----
  m249: { rightHanded: true, name: 'M249', icon: 'm249', slot: 1, model: 'v_mach_m249para', price: 5750, auto: true, damage: 35, cycle: 0.08, mag: 100, reserve: 200, speed: 220, reload: 5.7, deploy: 1.4, pen: 2, rangeMod: 0.97, armor: 1.6, upper: 'M249',
    accuracy: shotsAcc(3, 175, 0.4, 0.9), spread: rifleSpread([0.045, 0.5], [0.045, 0.095], [0, 0.03]), recoil: kicks([0.8, 0.35, 0.3, 0.03, 3.75, 3, 9], [1.1, 0.5, 0.3, 0.06, 4, 3, 8], [0.75, 0.325, 0.25, 0.025, 3.5, 2.5, 9], [1.8, 0.65, 0.45, 0.125, 5, 3.5, 8], true),
    sounds: { fire: 'm249/m249-1', empty: 'clipempty_rifle', deploy: 'm249/m249_coverup', reload: [[0.5, 'm249/m249_coverup'], [1.5, 'm249/m249_boxout'], [3.2, 'm249/m249_boxin'], [4.2, 'm249/m249_chain'], [5.0, 'm249/m249_coverdown']] } },

  // ---- melee ----
  knife: { rightHanded: true, upper: 'KNIFE', armor: 1.7, name: 'Knife', slot: 3, model: 'v_knife_t', damage: 25, stab: 50, stabCycle: 1.0, stabRange: 32, cycle: 0.4, mag: 0, reserve: 0, speed: 250, reload: 0, deploy: 1.0, melee: 48, pen: 0,
    accuracy: { kind: 'none' }, spread: rifleSpread([0, 0], [0, 0], [0, 0], 1e9), recoil: { type: 'none' },
    sounds: { fire: 'knife/knife_slash1', hitWall: 'knife/knife_hitwall1', deploy: 'knife/knife_deploy1' } },

  // ---- grenades (thrown, simulated by the server) ----
  hegrenade: { upper: 'GREN', name: 'HE Grenade', icon: 'hegrenade', slot: 4, model: 'v_eq_fraggrenade', world: 'w_eq_fraggrenade_thrown', price: 300, grenade: 'he', max: 1, ...noGrenadeStats, sounds: { explode: 'hegrenade/explode3', bounce: 'hegrenade/he_bounce-1', pin: 'pinpull' } },
  flashbang: { upper: 'GREN', name: 'Flashbang', icon: 'flashbang', slot: 4, model: 'v_eq_flashbang', world: 'w_eq_flashbang_thrown', price: 200, grenade: 'flash', max: 2, ...noGrenadeStats, sounds: { explode: 'flashbang/flashbang_explode1', bounce: 'flashbang/grenade_hit1', pin: 'pinpull' } },
  smokegrenade: { upper: 'GREN', name: 'Smoke Grenade', icon: 'smokegrenade', slot: 4, model: 'v_eq_smokegrenade', world: 'w_eq_smokegrenade_thrown', price: 300, grenade: 'smoke', max: 1, ...noGrenadeStats, sounds: { explode: 'smokegrenade/sg_explode', bounce: 'smokegrenade/grenade_hit1', pin: 'pinpull' } },

  // ---- the bomb (Terrorists get one per round; not for sale) ----
  c4: { upper: 'C4', name: 'C4', icon: 'c4', slot: 5, model: 'v_c4', world: 'w_c4', planted: 'w_c4_planted', c4: true, ...noGrenadeStats,
    sounds: { plant: 'c4/c4_plant', click: 'c4/c4_click', beep: 'c4/c4_beep1', disarm: 'c4/c4_disarm', explode: 'c4/c4_explode1' } },
};
export const ORDER = Object.keys(WEAPONS);
export const DEFAULT_PISTOL = { ct: 'usp', t: 'glock' };

// CS:S hit groups: head, chest, stomach, left/right arm, left/right leg -> damage multiplier
export const HITGROUP_MULT = { 1: 4, 2: 1, 3: 1.25, 4: 1, 5: 1, 6: 0.75, 7: 0.75 };

// Buy menu (prices are the CS:S ones). team: who may buy it. Grenades are counted (max per player).
const cat = (name, ids) => ({ cat: name, items: ids.map((id) => ({ id, price: WEAPONS[id].price, team: WEAPONS[id].team, name: WEAPONS[id].name, icon: WEAPONS[id].icon })) });
export const BUY = [
  cat('Pistols', ['glock', 'usp', 'p228', 'deagle', 'elite', 'fiveseven']),
  cat('Heavy', ['m3', 'xm1014', 'm249']),
  cat('SMGs', ['mac10', 'tmp', 'mp5', 'ump45', 'p90']),
  cat('Rifles', ['galil', 'famas', 'ak47', 'm4a1', 'aug', 'sg552', 'scout', 'sg550', 'g3sg1', 'awp']),
  { cat: 'Gear', items: [{ id: 'kevlar', name: 'Kevlar Vest', icon: 'kevlar', glyph: 't', price: 650 }, { id: 'vesthelm', name: 'Kevlar + Helmet', icon: 'kevlar', glyph: 'u', price: 1000 }, { id: 'defuser', name: 'Defuse Kit', icon: 'defuser', price: 200, team: 'ct' }, ...['hegrenade', 'flashbang', 'smokegrenade'].map((id) => ({ id, price: WEAPONS[id].price, name: WEAPONS[id].name, icon: WEAPONS[id].icon }))] },
];
export const START_MONEY = 800, MAX_MONEY = 16000, BUY_TIME = 90;
export const REWARD = { kill: 300, knife: 1500, win: 3250, loss: 1400, plant: 300, defuse: 300, plantedLoss: 800, rescue: 1000, hostageKill: 1500 };
// C4 (CS:S): 3 s to plant inside a bombsite, 10 s to defuse (5 s with a kit), explodes after the timer; damage 500 with a 1750 unit radius.
export const BOMB = { timer: 40, plantTime: 3, defuseTime: 10, kitTime: 5, damage: 500, radius: 1750, useRange: 72 };
export const GRENADE = { speedMax: 750, gravity: 0.4, bounce: 0.45, friction: 0.8, fuse: 1.5, heRadius: 350, heDamage: 98, smokeTime: 18, smokeRadius: 140, flashRange: 1500 };
