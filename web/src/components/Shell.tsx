import { ChevronsUpDown, Menu as MenuIcon, Search, X } from 'lucide-react';
import { useEffect, useState, type MouseEvent, type ReactNode } from 'react';
import { shortcutLabel } from '../lib/platform';
import { pathForRoute } from '../lib/routes';
import type { CurrentUser, ViewId } from '../lib/types';
import { AgentDot } from './AgentMark';
import { Menu } from './Menu';
import { Endorsement, Wordmark } from './MemoarMark';
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

export interface AgentCount { source: string; label: string; count: number }

/** Whether a key press landed in something the reader is typing into. */
export function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName);
}

/** A plain click on a link, as opposed to one meant for a new tab. */
export function isPlainClick(event: MouseEvent): boolean {
  return event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
}

export function Shell({ view, user, children, onNavigate, onOpenPalette, sessionCount, agents = [], onAgent }: {
  view: ViewId;
  user: CurrentUser | null;
  children: ReactNode;
  onNavigate: (view: ViewId) => void;
  /** Cmd-K, or Ctrl-K off Apple platforms. Without it, Cmd-K goes to search. */
  onOpenPalette?: () => void;
  /** Sessions in the archive, shown beside the Sessions destination. */
  sessionCount?: number;
  /** Sessions per agent, as the machines report them. */
  agents?: AgentCount[];
  /** Shows the session list filtered to one agent. */
  onAgent?: (source: string) => void;
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
  const openPalette = () => { setMenuOpen(false); if (onOpenPalette) onOpenPalette(); else navigate('search'); };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={cn('sidebar', menuOpen && 'sidebar-open')} aria-label="Primary navigation">
        <div className="sidebar-brand">
          <a href="/timeline" className="brand" aria-label="memoar, sessions" onClick={(event) => { if (isPlainClick(event)) { event.preventDefault(); navigate('timeline'); } }}>
            <Wordmark size={22} />
          </a>
          <IconButton className="sidebar-close" label="Close navigation" onClick={() => setMenuOpen(false)}>
            <X size={16} />
          </IconButton>
        </div>

        <button className="sidebar-search" type="button" aria-keyshortcuts="Meta+K Control+K" onClick={openPalette}>
          <span>Search or jump to</span>
          <kbd aria-hidden="true">{shortcutLabel('K')}</kbd>
        </button>

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
                {/* Outside the link's name, so it stays "Sessions". */}
                {item.view === 'timeline' && sessionCount ? <span className="nav-count" aria-hidden="true">{sessionCount.toLocaleString('en')}</span> : null}
              </a>
            );
          })}
        </nav>

        {agents.length > 0 ? (
          <section className="sidebar-agents" aria-labelledby="sidebar-agents-heading">
            <h2 id="sidebar-agents-heading">Agents</h2>
            {agents.map((agent) => (
              <button key={agent.source} type="button" className="agent-row" onClick={() => { setMenuOpen(false); onAgent?.(agent.source); }} aria-label={`Show ${agent.label} sessions`}>
                <AgentDot source={agent.source} />
                <span className="agent-row-label">{agent.label}</span>
                <span className="agent-row-count">{agent.count.toLocaleString('en')}</span>
              </button>
            ))}
          </section>
        ) : null}

        <div className="sidebar-foot">
          <Endorsement />
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
            <MenuIcon size={18} />
          </IconButton>
          <Wordmark size={20} />
          <IconButton className="topbar-search" label="Search or run a command" onClick={openPalette}>
            <Search size={17} />
          </IconButton>
        </header>
        <main id="main-content" tabIndex={-1} className="main-content">{children}</main>
      </div>
    </div>
  );
}
