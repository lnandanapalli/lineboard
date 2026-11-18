/**
 * Keyboard shortcut labels in the conventions of the platform: ⌘ / ⇧ on Apple devices,
 * Ctrl+ / Shift+ elsewhere. Shortcuts are written once as e.g. "Mod+Shift+Z".
 */

interface NavigatorUAData {
  platform?: string;
}

/** Mac, iPad (which reports itself as a Mac with touch), iPhone. */
export const isApple = (() => {
  if (typeof navigator === 'undefined') return false;
  const uaPlatform = (navigator as Navigator & { userAgentData?: NavigatorUAData }).userAgentData?.platform ?? '';
  return /mac|iphone|ipad|ipod/i.test(uaPlatform || navigator.platform || '') || /iPad|iPhone|Macintosh/.test(navigator.userAgent);
})();

const APPLE: Record<string, string> = { Mod: '⌘', Ctrl: '⌃', Alt: '⌥', Shift: '⇧' };
const OTHER: Record<string, string> = { Mod: 'Ctrl', Ctrl: 'Ctrl', Alt: 'Alt', Shift: 'Shift' };
const KEYS: Record<string, string> = { Up: '↑', Down: '↓', Left: '←', Right: '→', PageUp: 'Page Up', PageDown: 'Page Down' };

/** "Mod+Shift+Z" -> "⇧⌘Z" on Apple, "Ctrl+Shift+Z" elsewhere. */
export function shortcut(combo: string, apple = isApple): string {
  const parts = combo.split('+');
  const key = parts.pop()!;
  const k = KEYS[key] ?? key;
  if (apple) {
    // Apple orders modifiers ⌃ ⌥ ⇧ ⌘ and writes them without separators.
    const order = ['Ctrl', 'Alt', 'Shift', 'Mod'];
    const mods = parts.sort((a, b) => order.indexOf(a) - order.indexOf(b)).map((m) => APPLE[m] ?? m);
    return mods.join('') + k;
  }
  return [...parts.map((m) => OTHER[m] ?? m), k].join('+');
}

/** "Undo (⌘Z)" style tooltip text. */
export const withShortcut = (label: string, ...combos: string[]) => `${label} (${combos.map((c) => shortcut(c)).join(' or ')})`;
