import {
  Archive,
  BookMarked,
  ChevronsUpDown,
  CircleHelp,
  LibraryBig as Collection,
  Command,
  Cpu,
  KeyRound,
  LayoutGrid,
  Menu,
  Plus,
  Search,
  Settings,
  Share2,
  Upload,
  X,
} from 'lucide-react';
import { MemoarMark } from './MemoarMark';
import { useEffect, useState, type ReactNode } from 'react';
import { accountInitials } from '../lib/account';
import type { CurrentUser, Machine, ViewId } from '../lib/types';
import { Badge, Button, IconButton, cn } from './ui';

const navGroups: Array<{
  label: string;
  items: Array<{ view: ViewId; label: string; icon: typeof Archive }>;
}> = [
  {
    label: 'Archive',
    items: [
      { view: 'workspace', label: 'Overview', icon: LayoutGrid },
      { view: 'timeline', label: 'Timeline', icon: Archive },
      { view: 'search', label: 'Search', icon: Search },
      { view: 'import', label: 'Import', icon: Upload },
      { view: 'collections', label: 'Collections', icon: Collection },
      { view: 'memory', label: 'Agent memory', icon: BookMarked },
    ],
  },
  {
    label: 'Manage',
    items: [
      // No badge here: the count was hardcoded to '1', so the nav claimed one
      // pending item forever regardless of what was actually pending. It also
      // silently became part of the button's accessible name ("Sharing 1"),
      // which is how it broke navigation for anyone matching on the name. A
      // real count needs real data, and needs to reach the name deliberately.
      { view: 'sharing', label: 'Sharing', icon: Share2 },
      { view: 'machines', label: 'Machines & sources', icon: Cpu },
      { view: 'settings', label: 'Settings', icon: Settings },
    ],
  },
];

const titles: Partial<Record<ViewId, string>> = {
  workspace: 'Overview',
  timeline: 'Timeline',
  search: 'Search',
  import: 'Import',
  collections: 'Collections',
  memory: 'Agent memory',
  sharing: 'Sharing',
  machines: 'Machines & sources',
  settings: 'Settings',
  onboarding: 'Connect a machine',
  signin: 'Account',
  session: 'Session',
};

export function Shell({ view, user, machines, children, onNavigate }: {
  view: ViewId;
  user: CurrentUser | null;
  machines: Machine[];
  children: ReactNode;
  onNavigate: (view: ViewId) => void;
}) {
  // Setup progress is the share of connected machines that have actually
  // archived something.
  const capturing = machines.filter((machine) => machine.sources.some((source) => source.sessionCount > 0)).length;
  const setupProgress = machines.length === 0 ? 0 : Math.round((capturing / machines.length) * 100);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        onNavigate('search');
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [onNavigate]);

  const navigate = (next: ViewId) => {
    onNavigate(next);
    setMenuOpen(false);
  };

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">Skip to content</a>
      <aside className={cn('sidebar', menuOpen && 'sidebar-open')} aria-label="Primary navigation">
        <div className="brand-row">
          <button className="brand" type="button" onClick={() => navigate('timeline')} aria-label="Memoar home">
            <span className="brand-mark" aria-hidden="true"><MemoarMark size={17} /></span>
            <span>memoar</span>
          </button>
          <IconButton className="sidebar-close" label="Close navigation" onClick={() => setMenuOpen(false)}>
            <X size={18} />
          </IconButton>
        </div>

        <Button className="new-session-button" variant="primary" onClick={() => navigate('onboarding')}>
          <Plus size={16} /> Connect a machine
        </Button>

        <nav className="sidebar-nav">
          {navGroups.map((group) => (
            <section key={group.label}>
              <p className="nav-label">{group.label}</p>
              {group.items.map((item) => {
                const Icon = item.icon;
                const active = view === item.view || (view === 'session' && item.view === 'timeline');
                return (
                  <button
                    key={item.view}
                    type="button"
                    className={cn('nav-item', active && 'nav-item-active')}
                    aria-current={active ? 'page' : undefined}
                    onClick={() => navigate(item.view)}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </section>
          ))}
        </nav>

        <div className="sidebar-foot">
          <button className="help-card" type="button" onClick={() => navigate('onboarding')}>
            <span><CircleHelp size={16} /> Setup guide</span>
            <small>
              {machines.length === 0
                ? 'No machine connected yet'
                : `${capturing} of ${machines.length} ${machines.length === 1 ? 'machine is' : 'machines are'} archiving`}
            </small>
            <span className="mini-progress"><span style={{ width: `${setupProgress}%` }} /></span>
          </button>
          <button className="user-switcher" type="button" onClick={() => navigate('signin')}>
            <span className="avatar">{user ? accountInitials(user.displayName) : '·'}</span>
            {/* An account whose display name is its email printed the address
                twice, one above the other. */}
            <span>
              <strong>{user?.displayName ?? 'Account'}</strong>
              {user && user.email !== user.displayName ? <small>{user.email}</small> : null}
              {user ? null : <small>Not signed in</small>}
            </span>
            <ChevronsUpDown size={14} />
          </button>
        </div>
      </aside>

      {menuOpen ? <button className="mobile-scrim" type="button" aria-label="Close navigation" onClick={() => setMenuOpen(false)} /> : null}

      <div className="workspace-shell">
        <header className="topbar">
          <div className="topbar-title">
            <IconButton className="menu-button" label="Open navigation" onClick={() => setMenuOpen(true)}>
              <Menu size={19} />
            </IconButton>
            <span className="crumb">Archive</span>
            <span className="crumb-separator">/</span>
            <strong>{titles[view] ?? 'Memoar'}</strong>
          </div>
          <div className="topbar-actions">
            <button className="command-search" type="button" onClick={() => navigate('search')}>
              <Search size={15} />
              <span>Search your archive</span>
              <kbd><Command size={11} /> K</kbd>
            </button>
            <Badge className="live-badge">Connected</Badge>
            <IconButton label="API keys" onClick={() => navigate('settings')}><KeyRound size={17} /></IconButton>
          </div>
        </header>
        <main id="main-content" tabIndex={-1} className="main-content">{children}</main>
      </div>

      <nav className="bottom-nav" aria-label="Mobile navigation">
        {navGroups.flatMap((group) => group.items).slice(0, 5).map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.view}
              type="button"
              className={cn(view === item.view && 'active')}
              onClick={() => navigate(item.view)}
              aria-label={item.label}
            >
              <Icon size={19} /><span>{item.label.split(' ')[0]}</span>
            </button>
          );
        })}
      </nav>
    </div>
  );
}
