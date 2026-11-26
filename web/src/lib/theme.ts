/**
 * Light or dark. The default follows the system, and a reader can pin either
 * one on this device. Kept in local storage because it is a preference of the
 * browser, not of the archive.
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

export function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
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
