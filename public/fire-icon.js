export function fireIcon(id, size, x = 0, y = 0) {
  const label = id === 'molotov' ? 'Molotov' : 'Incendiary Grenade';
  return `<svg x="${x}" y="${y}" role="img" aria-label="${label}" viewBox="0 0 32 32" width="${size}" height="${size}"><image href="/equipment-icons/${id}.svg" width="32" height="32"/></svg>`;
}
