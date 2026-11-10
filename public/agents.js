// Which character models ("agents") each map uses per team. Like CS:GO, every map has its own pair; unlisted maps use everything.
export const AGENT_NAMES = {
  ct_gign: 'GIGN', ct_gsg9: 'GSG-9', ct_sas: 'SAS', ct_urban: 'Seal Team Six',
  t_arctic: 'Arctic Avengers', t_guerilla: 'Guerrilla Warfare', t_leet: 'Elite Crew', t_phoenix: 'Phoenix Connexion',
};
export const MAP_AGENTS = {
  de_dust2: { ct: ['ct_sas', 'ct_gsg9'], t: ['t_leet', 't_guerilla'] },
  de_dust: { ct: ['ct_urban', 'ct_gign'], t: ['t_guerilla', 't_arctic'] },
  de_inferno: { ct: ['ct_gign', 'ct_urban'], t: ['t_phoenix', 't_arctic'] },
  de_lake: { ct: ['ct_gign', 'ct_urban'], t: ['t_phoenix', 't_arctic'] },
  default: { ct: ['ct_gign', 'ct_gsg9', 'ct_sas', 'ct_urban'], t: ['t_arctic', 't_guerilla', 't_leet', 't_phoenix'] },
};
const HOSTAGES = ['hostage_01', 'hostage_02', 'hostage_03', 'hostage_04']; // team 'h' on hostage rescue maps
export const agentsFor = (map, team) => (team === 'h' ? HOSTAGES : (MAP_AGENTS[map] ?? MAP_AGENTS.default)[team]);
