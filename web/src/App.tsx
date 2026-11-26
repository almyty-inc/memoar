import { useCallback, useEffect, useMemo, useState } from 'react';
import { emptyConnectedDashboard, initialLocation, mergeTimelinePage, placeToReturnTo, routeFromLocation } from './app/bootstrap';
import { buildCommands } from './app/commands';
import { useSessionCache } from './app/session-cache';
import { useExpiryWarning } from './app/session-expiry';
import { CommandPalette } from './components/CommandPalette';
import { SessionExpiryBanner } from './components/SessionExpiryBanner';
import { Shell } from './components/Shell';
import { memoarApi } from './lib/api';
import type { CurrentUser, DashboardState, SessionSummary, ViewId } from './lib/types';
import { pathForRoute, routeForPath, type Route } from './lib/routes';
import { CollectionsView } from './views/Collections';
import { ConnectionError } from './views/ConnectionError';
import { MemoryView, SessionPane, preloadViews } from './app/lazy-views';
import { ImportView } from './views/Import';
import { MachinesView } from './views/Machines';
import { NotFoundPage } from './views/NotFoundPage';
import { SignInView } from './views/Onboarding';
import { OnboardingView } from './views/OnboardingSteps';
import { SearchView } from './views/Search';
import { ListSkeleton } from './views/timeline/ListSkeleton';
import { SessionsSplit, TranscriptSkeleton, wideLayout } from './views/SessionsSplit';
import { SettingsView } from './views/Settings';
import { SharingView } from './views/Sharing';
import { TeamsView } from './views/Teams';
import { TimelineView } from './views/Timeline';

export function App() {
  const [start] = useState(() => initialLocation(!memoarApi.configured || memoarApi.authenticated));
  const [route, setRoute] = useState<Route>(start.route);
  const view = route.view;
  const [intended, setIntended] = useState<Route | null>(start.intended);
  const [dashboard, setDashboard] = useState<DashboardState>(emptyConnectedDashboard);
  const [loading, setLoading] = useState(() => !memoarApi.configured || memoarApi.authenticated);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const sessionCache = useSessionCache();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // What the palette asked transcript search to look for, handed over once.
  const [searchSeed, setSearchSeed] = useState('');
  const [user, setUser] = useState<CurrentUser | null>(null);
  // Stamped when the archive loads so views can do time maths without reading
  // the clock while rendering.
  const [loadedAt, setLoadedAt] = useState(0);
  // Null except in the last few minutes of the signed-in session.
  const expiringIn = useExpiryWarning(memoarApi.expiresAt);

  const loadDashboard = useCallback(async () => {
    setLoading(true);
    setConnectionError(null);
    try {
      setDashboard(await memoarApi.loadDashboard());
      setLoadedAt(Date.now());
    } catch (error) {
      setConnectionError(error instanceof Error ? error.message : 'Archive connection failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (memoarApi.configured && !memoarApi.authenticated) return;
    let active = true;
    if (memoarApi.configured) {
      void memoarApi.currentUser().then((current) => { if (active) setUser(current); }).catch(() => {
        // Identity is not worth failing the whole archive over; the shell falls
        // back to showing no name rather than a name it cannot stand behind.
        if (active) setUser(null);
      });
    }
    void memoarApi.loadDashboard().then((nextDashboard) => {
      if (!active) return;
      setDashboard(nextDashboard);
      setLoadedAt(Date.now());
      setLoading(false);
      preloadViews();
    }).catch((error: unknown) => {
      if (!active) return;
      setConnectionError(error instanceof Error ? error.message : 'Archive connection failed');
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  /*
    Being asked to sign in again does not forget where you were.

    A token lives an hour and is not refreshed, so this fires in the middle of
    whatever somebody was doing. It used to replace the screen with the sign-in
    form and remember nothing, which is how opening a form on one screen and
    coming back signed in on the timeline lost both.
  */
  const askToSignIn = useCallback(() => {
    // Read before the address is rewritten below: a state updater runs during
    // the render that follows, by which time the address says /login.
    const from = placeToReturnTo(routeFromLocation());
    setIntended((current) => current ?? from);
    setRoute({ view: 'signin' });
    window.history.replaceState(null, '', pathForRoute({ view: 'signin' }));
  }, []);

  useEffect(() => {
    window.addEventListener('memoar:unauthorized', askToSignIn);
    return () => {
      window.removeEventListener('memoar:unauthorized', askToSignIn);
    };
  }, [askToSignIn]);

  const go = useCallback((next: Route) => {
    setRoute(next);
    const path = pathForRoute(next);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    if (next.view !== 'session') window.scrollTo({ top: 0 });
  }, []);

  const navigate = useCallback((next: ViewId) => { go({ view: next }); }, [go]);

  // Back and forward move between screens, which is what those buttons are for.
  useEffect(() => {
    const onPopState = () => { setRoute(routeForPath(window.location.pathname)); };

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const openSession = useCallback((session: SessionSummary) => {
    go({ view: 'session', sessionId: session.id });
  }, [go]);

  // Moving through the list with j and k: the address follows the selection
  // without adding a history entry per keystroke.
  const selectSession = useCallback((session: SessionSummary) => {
    const next: Route = { view: 'session', sessionId: session.id };
    setRoute(next);
    window.history.replaceState(null, '', pathForRoute(next));
  }, []);

  /*
    The address says which session is open, and that is the only thing that
    fetches one, whether a row was chosen, a link was followed, or the page was
    reloaded. A transcript seen before, or prefetched, shows at once.
  */
  const allSessions = useMemo(() => dashboard.timeline.flatMap((group) => group.sessions), [dashboard.timeline]);
  // With room for both panes, the list opens with its newest session showing
  // rather than beside an empty pane. The address stays /timeline until the
  // reader picks one.
  const routeSessionId = route.view === 'session'
    ? route.sessionId
    : view === 'timeline' && wideLayout() ? allSessions[0]?.id : undefined;
  const { load: loadSession } = sessionCache;
  useEffect(() => {
    if (!routeSessionId || !memoarApi.authenticated) return undefined;
    let active = true;
    loadSession(routeSessionId).catch((error: unknown) => {
      if (active) setConnectionError(error instanceof Error ? error.message : 'Session could not be loaded');
    });
    return () => { active = false; };
  }, [routeSessionId, loadSession]);

  // Only the session the address names is shown, so moving between sessions
  // never renders the previous one under the new heading.
  const openDetail = sessionCache.peek(routeSessionId) ?? null;

  // Escape from a transcript: back to the list. Side by side the list is
  // already there, so focus goes to the selected row instead.
  const leaveSession = () => {
    if (!wideLayout()) { navigate('timeline'); return; }
    document.querySelector<HTMLElement>('.session-row.row-selected')?.focus();
  };

  const createCollection = async (name: string, description: string) => {
    const collection = await memoarApi.createCollection(name, description);
    setDashboard((current) => ({ ...current, collections: [collection, ...current.collections] }));
  };

  const loadMoreTimeline = async () => {
    if (!dashboard.nextTimelineCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await memoarApi.loadTimelinePage(dashboard.nextTimelineCursor);
      setDashboard((current) => ({
        ...current,
        timeline: mergeTimelinePage(current.timeline, page.groups),
        nextTimelineCursor: page.nextCursor,
      }));
    } catch (error) {
      // Callers invoke this as `void onLoadMore()`, so a failure not caught
      // here would end the spinner and say nothing.
      setConnectionError(error instanceof Error ? error.message : 'More sessions could not be loaded');
    } finally {
      setLoadingMore(false);
    }
  };
  const signIn = async (email: string, password: string) => {
    if (memoarApi.configured) setUser(await memoarApi.login(email, password));
    await loadDashboard();
    go(intended ?? { view: 'timeline' });
  };

  const createAccount = async (email: string, password: string) => {
    if (memoarApi.configured) setUser(await memoarApi.register(email, password));
    await loadDashboard();
    // A new archive has nothing to return to, so it starts where it starts.
    navigate('timeline');
  };

  if (view === 'signin') {
    return (
      <SignInView
        onSignIn={signIn}
        onCreateAccount={createAccount}
        onOAuth={(provider) => memoarApi.beginOAuth(provider)}
        creating={route.creating ?? false}
        onModeChange={(creating) => { go(creating ? { view: 'signin', creating: true } : { view: 'signin' }); }}
      />
    );
  }

  let content;
  if (connectionError) {
    content = (
      <ConnectionError connectionError={connectionError} loadDashboard={loadDashboard} />
    );
  } else if (view === 'search') {
    content = <SearchView key={searchSeed} initialQuery={searchSeed} onOpen={openSession} workspaces={[...new Set(allSessions.map((session) => session.workspace))]} />;
  } else if (view === 'collections') {
    content = <CollectionsView collections={dashboard.collections} onOpen={openSession} onCreate={createCollection} />;
  } else if (view === 'memory') {
    content = <MemoryView />;
  } else if (view === 'import') {
    content = <ImportView machines={dashboard.machines} onOpen={openSession} onImport={async (file, source, machineId, onProgress) => {
      const imported = await memoarApi.importArtifact(file, source, machineId, onProgress);
      await loadDashboard();
      return imported;
    }} />;
  } else if (view === 'sharing') {
    content = (
      <SharingView
        grants={dashboard.grants}
        transfers={dashboard.transfers}
        sessions={allSessions}
        asOf={loadedAt}
        onAcceptTransfer={async (id) => { await memoarApi.acceptTransfer(id); await loadDashboard(); }}
        onDeclineTransfer={async (id) => { await memoarApi.declineTransfer(id); await loadDashboard(); }}
        onRevokeGrant={async (id) => { await memoarApi.revokeShareLink(id); await loadDashboard(); }}
        onTeams={() => navigate('teams')}
        onRequestTransfer={async (input) => {
          const review = await memoarApi.completeRedactionReview(input.sessionId);
          await memoarApi.requestTransfer({ ...input, redactionReviewId: review.id });
          await loadDashboard();
        }}
      />
    );
  } else if (view === 'teams') {
    content = <TeamsView user={user} />;
  } else if (view === 'machines') {
    content = <MachinesView machines={dashboard.machines} onConnect={() => navigate('onboarding')} />;
  } else if (view === 'settings') {
    content = <SettingsView apiKeys={dashboard.apiKeys} user={user} onKeyRevoked={() => void loadDashboard()} mcpEndpoint={memoarApi.mcpEndpoint} onCreateKey={async (name, scopes) => {
      const created = await memoarApi.createApiKey(name, scopes);
      setDashboard((current) => ({ ...current, apiKeys: [created.apiKey, ...current.apiKeys] }));
      return created.secret;
    }} />;
  } else if (view === 'not-found') {
    // The address is left as typed, so it can be corrected or reported.
    content = <NotFoundPage navigate={navigate} />;
  } else if (view === 'onboarding') {
    content = <OnboardingView machines={dashboard.machines} onComplete={() => navigate('timeline')} onRefresh={loadDashboard} />;
  } else {
    // Sessions, with or without one open: the list and the transcript side by side.
    content = (
      <SessionsSplit
        selected={routeSessionId !== undefined}
        list={loading && allSessions.length === 0 ? <ListSkeleton /> : (
          <TimelineView groups={dashboard.timeline} machines={dashboard.machines} archived={dashboard.archivedSessions} asOf={loadedAt} selectedId={routeSessionId} onOpen={openSession} onSelect={selectSession} onPrefetch={sessionCache.prefetch} onConnect={() => navigate('onboarding')} onImport={() => navigate('import')} hasMore={Boolean(dashboard.nextTimelineCursor)} loadingMore={loadingMore} onLoadMore={loadMoreTimeline} />
        )}
        detail={openDetail ? (
          <SessionPane detail={openDetail} collections={dashboard.collections} machines={dashboard.machines} onBack={leaveSession} onChanged={() => void loadDashboard()}
            onDeleted={() => { sessionCache.drop(openDetail.session.id); void loadDashboard(); navigate('timeline'); }} />
        ) : <TranscriptSkeleton />}
      />
    );
  }

  const commands = buildCommands({
    sessions: allSessions,
    openSessionId: openDetail ? routeSessionId : undefined,
    navigate,
    openSession,
    searchFor: (query) => { setSearchSeed(query); navigate('search'); },
  });

  return (
    <Shell view={view} user={user} onNavigate={navigate} onOpenPalette={() => setPaletteOpen(true)}>
      {expiringIn === null ? null : <SessionExpiryBanner msLeft={expiringIn} onSignIn={askToSignIn} />}
      {content}
      <CommandPalette open={paletteOpen} commands={commands} onClose={() => setPaletteOpen(false)} />
    </Shell>
  );
}
