import { useState } from 'react';
import { readTheme, saveTheme, type ThemeChoice } from '../../lib/theme';
import type { CurrentUser } from '../../lib/types';

const THEMES: Array<[ThemeChoice, string]> = [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']];

/** Who this archive belongs to, and how it looks on this device. */
export function AccountTab({ user }: { user: CurrentUser | null }) {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme);

  return (
    <>
      <section className="settings-section">
        <h2>Account</h2>
        <dl className="plain-dl">
          <dt>Name</dt><dd>{user?.displayName ?? 'Not signed in'}</dd>
          {user && user.email !== user.displayName ? <><dt>Email</dt><dd>{user.email}</dd></> : null}
        </dl>
      </section>
      <section className="settings-section">
        <h2 id="theme-heading">Appearance</h2>
        <div className="segmented" role="radiogroup" aria-labelledby="theme-heading">
          {THEMES.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={theme === value}
              onClick={() => { setTheme(value); saveTheme(value); }}
            >
              {label}
            </button>
          ))}
        </div>
        <p className="field-hint">System follows your operating system. The choice is kept in this browser.</p>
      </section>
    </>
  );
}
