/**
 * Light or dark. The default follows the system, and a reader can pin either
 * one on this device. Kept in local storage because it is a preference of the
 * browser, not of the archive.
 *
 * The resolved mode is written to `data-mode` on the root element, so the
 * stylesheet holds one dark palette rather than a copy per way of asking.
 */
export type ThemeChoice = 'system' | 'light' | 'dark';

const KEY = 'memoar.theme';

export function readTheme(): ThemeChoice {
  try {
    const stored = window.localStorage.getItem(KEY);
    return stored === 'light' || stored === 'dark' ? stored : 'system';
  } catch {
    return 'system';
  }
}

function systemDark(): MediaQueryList | null {
  return typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-color-scheme: dark)') : null;
}

let current: ThemeChoice = 'system';

function resolve(): void {
  const dark = current === 'dark' || (current === 'system' && (systemDark()?.matches ?? false));
  document.documentElement.setAttribute('data-mode', dark ? 'dark' : 'light');
}

export function applyTheme(choice: ThemeChoice): void {
  current = choice;
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  resolve();
}

/** Follows the system while the reader has not pinned a theme. */
export function watchSystemTheme(): void {
  systemDark()?.addEventListener('change', resolve);
}

export function saveTheme(choice: ThemeChoice): void {
  applyTheme(choice);
  try {
    if (choice === 'system') window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, choice);
  } catch {
    // A blocked store costs the preference on the next visit, nothing more.
  }
}
