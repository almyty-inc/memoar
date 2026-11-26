import { ChevronsUpDown, Menu as MenuIcon, Search, X } from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { shortcutLabel } from '../lib/platform';
import { pathForRoute } from '../lib/routes';
import type { CurrentUser, ViewId } from '../lib/types';
import { Menu } from './Menu';
import { IconButton, cn } from './ui';

/** The destinations, and the screens each one stays lit for. */
const NAV: Array<{ view: ViewId; label: string; also?: ViewId[] }> = [
  { view: 'timeline', label: 'Sessions', also: ['session', 'import'] },
  { view: 'search', label: 'Search' },
  { view: 'memory', label: 'Memory' },
  { view: 'collections', label: 'Collections' },
  { view: 'sharing', label: 'Shared', also: ['teams'] },
  { view: 'machines', label: 'Machines', also: ['onboarding'] },
  { view: 'settings', label: 'Settings' },
];

/** Whether a key press landed in something the reader is typing into. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** A plain click on a link, as opposed to one meant for a new tab. */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function Shell({ view, user, children, onNavigate, onOpenPalette }: {
  view: ViewId;
  user: CurrentUser | null;
  children: ReactNode;
  onNavigate: (view: ViewId) => void;
  /** Cmd-K, or Ctrl-K off Apple platforms. Without it, Cmd-K goes to search. */
  onOpenPalette?: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);

  // Cmd-K and Ctrl-K open the palette everywhere. / goes to transcript search
  // unless it is being typed.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const commandK = (event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k';
      const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !isTyping(event.target);
      if (!commandK && !slash) return;
      if (slash && document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      if (commandK && onOpenPalette) { onOpenPalette(); return; }
      if (view === 'search') document.querySelector<HTMLInputElement>('#search-input')?.focus();
      else onNavigate('search');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onNavigate, onOpenPalette, view]);

  const navigate = (next: ViewId) => {
    onNavigate(next);
    setMenuOpen(false);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={cn('sidebar', menuOpen && 'sidebar-open')} aria-label="Primary navigation">
        <div className="sidebar-brand">
          <a href="/timeline" className="brand" onClick={(event) => { if (isPlainClick(event)) { event.preventDefault(); navigate('timeline'); } }}>memoar</a>
          <IconButton className="sidebar-close" label="Close navigation" onClick={() => setMenuOpen(false)}>
            <X size={16} />
          </IconButton>
        </div>

        <nav className="sidebar-nav" aria-label="Sections">
          {NAV.map((item) => {
            const active = view === item.view || (item.also?.includes(view) ?? false);
            return (
              <a
                key={item.view}
                href={pathForRoute({ view: item.view })}
                className={cn('nav-item', active && 'nav-item-active')}
                aria-current={active ? 'page' : undefined}
                onClick={(event) => {
                  if (!isPlainClick(event)) return;
                  event.preventDefault();
                  navigate(item.view);
                }}
              >
                {item.label}
              </a>
            );
          })}
        </nav>

        <div className="sidebar-account">
          {/* One line: who is signed in, and a menu. An account whose display
              name is its email shows it once. */}
          <Menu
            label="Account"
            up
            triggerClassName="account-button"
            trigger={<><span className="ellipsis">{user?.displayName ?? 'Not signed in'}</span><ChevronsUpDown size={13} aria-hidden="true" /></>}
            header={user && user.email !== user.displayName ? user.email : null}
            items={[
              { label: 'Settings', onSelect: () => navigate('settings') },
              { label: user ? 'Switch account' : 'Sign in', onSelect: () => navigate('signin') },
            ]}
          />
        </div>
      </aside>

      {menuOpen ? <button className="mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}

      <div className="workspace-shell">
        <header className="topbar">
          <IconButton className="menu-button" label="Open navigation" onClick={() => setMenuOpen(true)}>
            <MenuIcon size={16} />
          </IconButton>
          <button className="topbar-search" type="button" aria-keyshortcuts="Meta+K Control+K" onClick={() => (onOpenPalette ? onOpenPalette() : navigate('search'))}>
            <Search size={13} aria-hidden="true" />
            <span>Search or run a command</span>
            <kbd aria-hidden="true">{shortcutLabel('K')}</kbd>
          </button>
        </header>
        <main id="main-content" tabIndex={-1} className="main-content">{children}</main>
      </div>
    </div>
  );
}
