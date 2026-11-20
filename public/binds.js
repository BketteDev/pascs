// Key bindings (Options > Keyboard): action -> KeyboardEvent.code, saved in localStorage. `binds` is one live object every module reads,
// so a rebind applies at once. Weapon slots stay on 1-5; 6 selects smoke, 7 incendiary; Esc is reserved for the menu.
export const ACTIONS = [
  ['forward', 'Move forward', 'KeyW'], ['back', 'Move back', 'KeyS'], ['left', 'Move left (strafe)', 'KeyA'], ['right', 'Move right (strafe)', 'KeyD'],
  ['jump', 'Jump', 'Space'], ['duck', 'Duck', 'ControlLeft'], ['walk', 'Walk', 'ShiftLeft'],
  ['use', 'Use / defuse', 'KeyE'], ['reload', 'Reload', 'KeyR'], ['lastweapon', 'Last weapon used', 'KeyQ'], ['drop', 'Drop weapon', 'KeyG'],
  ['inspect', 'Inspect weapon', 'KeyF'],
  ['buy', 'Buy menu', 'KeyB'], ['team', 'Select team', 'KeyM'], ['chat', 'Chat message (All)', 'KeyY'], ['teamchat', 'Team chat message', 'KeyU'], ['scores', 'Show scores', 'Tab'], ['quit', 'Quick quit (close tab)', 'F10'],
];
export const DEFAULT_BINDS = Object.fromEntries(ACTIONS.map(([a, , k]) => [a, k]));
// KeyboardEvent.code uses physical positions: KeyW is the Z key on AZERTY.
export const KEYBOARD_PRESETS = { qwerty: { ...DEFAULT_BINDS }, azerty: { ...DEFAULT_BINDS, forward: 'KeyW', left: 'KeyA', lastweapon: 'KeyQ', team: 'Semicolon' } };
export const keyboardLayout = () => { try { return localStorage.getItem('keyboardLayout') ?? (/^fr/i.test(navigator.language) ? 'azerty' : 'qwerty'); } catch { return 'qwerty'; } };
export const binds = (() => { try { return { ...KEYBOARD_PRESETS[keyboardLayout()], ...JSON.parse(localStorage.getItem('binds') ?? '{}') }; } catch { return { ...DEFAULT_BINDS }; } })();
export const is = (action, code) => !!code && binds[action] === code;
export function setBinds(next) {
  Object.assign(binds, next);
  try { localStorage.setItem('binds', JSON.stringify(binds)); } catch { /* storage blocked: this session only */ }
}
/** 'KeyW' -> 'W', 'Digit1' -> '1', 'ControlLeft' -> 'Ctrl'... for the Keyboard tab. */
let keyLabels = {};
export function setKeyboardLayout(layout) {
  keyLabels = layout === 'azerty' ? { KeyW: 'Z', KeyA: 'Q', KeyQ: 'A', KeyZ: 'W', KeyM: ',', Semicolon: 'M' } : {};
}
setKeyboardLayout(keyboardLayout());
export const keyName = (code) => keyLabels[code] ?? (!code ? '(none)' : code.replace(/^Key/, '').replace(/^Digit/, '').replace(/^Numpad/, 'Num ').replace(/(Left|Right)$/, (m) => (m === 'Right' ? ' (R)' : ''))
  .replace('Control', 'Ctrl').replace('Arrow', 'Arrow ').replace('Backquote', '`'));
