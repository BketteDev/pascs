// Key bindings (Options > Keyboard): action -> KeyboardEvent.code, saved in localStorage. `binds` is one live object every module reads,
// so a rebind applies at once. Weapon slots stay on 1-5; 6 selects smoke, 7 incendiary; Esc is reserved for the menu.
export const ACTIONS = [
  ['forward', 'Move forward', 'KeyW'], ['back', 'Move back', 'KeyS'], ['left', 'Move left (strafe)', 'KeyA'], ['right', 'Move right (strafe)', 'KeyD'],
  ['jump', 'Jump', 'Space'], ['duck', 'Duck', 'ControlLeft'], ['walk', 'Walk', 'ShiftLeft'],
  ['use', 'Use / defuse', 'KeyE'], ['reload', 'Reload', 'KeyR'], ['lastweapon', 'Last weapon used', 'KeyQ'], ['drop', 'Drop weapon', 'KeyG'],
  ['buy', 'Buy menu', 'KeyB'], ['team', 'Select team', 'KeyM'], ['scores', 'Show scores', 'Tab'],
];
export const DEFAULT_BINDS = Object.fromEntries(ACTIONS.map(([a, , k]) => [a, k]));
export const binds = (() => { try { return { ...DEFAULT_BINDS, ...JSON.parse(localStorage.getItem('binds') ?? '{}') }; } catch { return { ...DEFAULT_BINDS }; } })();
export const is = (action, code) => !!code && binds[action] === code;
export function setBinds(next) {
  Object.assign(binds, next);
  try { localStorage.setItem('binds', JSON.stringify(binds)); } catch { /* storage blocked: this session only */ }
}
/** 'KeyW' -> 'W', 'Digit1' -> '1', 'ControlLeft' -> 'Ctrl'... for the Keyboard tab. */
export const keyName = (code) => !code ? '(none)' : code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/(Left|Right)$/, (m) => (m === 'Right' ? ' (R)' : ''))
  .replace('Control', 'Ctrl').replace('Arrow', 'Arrow ').replace('Backquote', '`');
