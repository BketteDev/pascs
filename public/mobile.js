export const isTouchDevice = () => typeof window !== 'undefined' && (
  window.matchMedia?.('(pointer: coarse)').matches || ((navigator.maxTouchPoints ?? 0) > 0 && !window.matchMedia?.('(pointer: fine)').matches)
);
// Saved choices take precedence; these defaults only apply to a new player.
export const deviceDefaults = (defaults, mobile = isTouchDevice()) => mobile
  ? { ...defaults, renderScale: 0.75, texLow: true, touchScale: 1.05, touchSens: 0.8, legibleHud: true }
  : { ...defaults };
