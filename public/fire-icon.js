const silhouettes = {
  molotov: '<path fill="#f0e8d3" d="M13 7h6v5l5 5v11a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2V17l5-5z"/><path fill="#a86d39" d="M8 20h16v5H8z"/><path fill="#e9a04f" d="M16 9c-4-4 2-5 0-9 5 3 6 6 3 9z"/>',
  incgrenade: '<path fill="#f0e8d3" d="M9 9h14l2 3v15l-2 3H9l-2-3V12zM12 5h8v3h-8z"/><path fill="#a34e43" d="M7 14h18v10H7z"/><path fill="#f0e8d3" d="M18 5h4l5 3v2l-6-3h-3z"/>',
};
const originals = new Set();
if (typeof Image !== 'undefined') {
  for (const id of Object.keys(silhouettes)) {
    const image = new Image();
    image.onload = () => originals.add(id);
    image.src = `ui/icons/${id}.svg`;
  }
}

export function fireIcon(id, size, x = 0, y = 0) {
  const label = id === 'molotov' ? 'Molotov' : 'Incendiary Grenade';
  const art = originals.has(id) ? `<image href="ui/icons/${id}.svg" width="32" height="32"/>` : silhouettes[id];
  return `<svg x="${x}" y="${y}" role="img" aria-label="${label}" viewBox="0 0 32 32" width="${size}" height="${size}">${art}</svg>`;
}
