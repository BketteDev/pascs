// Inline so the buy menu and HUD also work with existing read-only asset mounts.
export const FIRE_ICON = '<path fill="#e6a451" d="M18 1c2 9-8 8-5 16-3-1-4-4-3-7C1 17 6 30 16 31c12-1 14-15 7-21 0 5-3 6-4 7 3-7 3-11-1-16z"/><path fill="#ffe4a5" d="M17 17c1 5-5 5-3 10-6-3-4-7-2-10-1 4 2 5 2 5z"/>';
export const fireIcon = (size) => `<svg role="img" aria-label="Incendiary" viewBox="0 0 32 32" width="${size}" height="${size}">${FIRE_ICON}</svg>`;
