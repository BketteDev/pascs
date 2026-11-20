// One naming scheme for folders, menus and configuration. Legacy IDs remain valid aliases.
export const MAPS = [
  ['de_dust2', 'Dust2', 'css'], ['de_inferno', 'Inferno', 'css'], ['cs_office', 'Office', 'css'], ['de_nuke', 'Nuke', 'css'],
  ['cs_agency', 'Agency', 'csgo'], ['cs_italy', 'Italy', 'csgo'], ['de_bank', 'Bank', 'csgo'], ['de_lake', 'Lake', 'csgo'],
  ['de_mirage_csgo_new', 'Mirage', 'csgo'], ['de_overpass', 'Overpass', 'csgo'], ['de_shortdust', 'ShortDust', 'csgo'], ['de_shortnuke', 'ShortNuke', 'csgo'],
].map(([id, name, game]) => ({ id, name, game, directory: `${game === 'css' ? 'Source' : 'GO'}-${name}`, enabled: !['de_dust2', 'de_bank'].includes(id) }));
export const PLAYABLE_MAPS = MAPS.filter((m) => m.enabled);
export function mapDetails(value) {
  if (value === 'de_mirage') value = 'de_mirage_csgo_new';
  const known = MAPS.find((m) => m.id === value || m.directory.toLowerCase() === String(value).toLowerCase());
  if (known) return known;
  if (typeof value !== 'string' || !/^(?:(?:GO|Source)-)?[a-zA-Z0-9_]+$/.test(value)) return null;
  const source = value.startsWith('Source-'), prefixed = /^(GO|Source)-/.test(value);
  const id = prefixed ? value.slice(value.indexOf('-') + 1) : value;
  return { id, name: id, game: source ? 'css' : 'csgo', directory: prefixed ? value : `GO-${value}` };
}
export const mapFolder = (value) => mapDetails(value)?.directory;
export const selectableMaps = (values, game) => PLAYABLE_MAPS.filter((m) => (!game || m.game === game) && values.some((v) => mapFolder(v) === m.directory)).map((m) => m.directory);
