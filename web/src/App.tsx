import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shell } from './components/Shell';
import { Button } from './components/ui';
import { memoarApi } from './lib/api';
import type { CurrentUser, DashboardState, SessionDetailData, SessionSummary, ViewId } from './lib/types';
import { pathForLegacyHash, pathForRoute, routeForPath, type Route } from './lib/routes';
import { CollectionsView } from './views/Collections';
import { MemoryView } from './views/Memory';
import { ImportView } from './views/Import';
import { MachinesView } from './views/Machines';
import { SignInView } from './views/Onboarding';
import { OnboardingView } from './views/OnboardingSteps';
import { SearchView } from './views/Search';
import { SessionDetailView } from './views/SessionDetail';
import { SettingsView } from './views/Settings';
import { SharingView } from './views/Sharing';
import { TimelineView } from './views/Timeline';
import { WorkspaceView } from './views/Workspace';

const emptyConnectedDashboard: DashboardState = {
  timeline: [],
  archivedSessions: 0,
  collections: [],
  grants: [],
  transfers: [],
  machines: [],
  apiKeys: [],
};

/**
 * The route in the address bar.
 *
 * A `#/…` link left over from before paths is rewritten once, here, so nothing
 * anyone bookmarked stops working.
 */
function routeFromLocation(): Route {
  const legacy = pathForLegacyHash(window.location.hash);
  if (legacy) {
    window.history.replaceState(null, '', legacy);
    return routeForPath(legacy) ?? { view: 'timeline' };
  }
  return routeForPath(window.location.pathname) ?? { view: 'timeline' };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => {
    const current = routeFromLocation();
    if (!memoarApi.configured || memoarApi.authenticated) return current;
    return current.creating ? { view: 'signin', creating: true } : { view: 'signin' };
  });
  const view = route.view;
  /*
    Where they were going before being asked to sign in. Following a link to a
    session while signed out otherwise dropped you on the timeline afterwards,
    with the thing you were sent still one search away.
  */
  const [intended] = useState<Route | null>(() => {
    if (!memoarApi.configured || memoarApi.authenticated) return null;
    const current = routeFromLocation();
    return current.view === 'signin' ? null : current;
  });
  const [dashboard, setDashboard] = useState<DashboardState>(emptyConnectedDashboard);
  const [loading, setLoading] = useState(() => !memoarApi.configured || memoarApi.authenticated);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [detail, setDetail] = useState<SessionDetailData | null>(null);
  const [user, setUser] = useState<CurrentUser | null>(null);
  // Stamped when the archive loads so views can do time maths without reading
  // the clock while rendering.
  const [loadedAt, setLoadedAt] = useState(0);

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
    }).catch((error: unknown) => {
      if (!active) return;
      setConnectionError(error instanceof Error ? error.message : 'Archive connection failed');
      setLoading(false);
    });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const onUnauthorized = () => {
      setRoute({ view: 'signin' });
      window.history.replaceState(null, '', pathForRoute({ view: 'signin' }));
    };
    window.addEventListener('memoar:unauthorized', onUnauthorized);
    return () => {
      window.removeEventListener('memoar:unauthorized', onUnauthorized);
    };
  }, []);

  const go = useCallback((next: Route) => {
    setRoute(next);
    const path = pathForRoute(next);
    if (window.location.pathname !== path) window.history.pushState(null, '', path);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const navigate = useCallback((next: ViewId) => { go({ view: next }); }, [go]);

  // Back and forward move between screens, which is what those buttons are for.
  useEffect(() => {
    const onPopState = () => { setRoute(routeForPath(window.location.pathname) ?? { view: 'timeline' }); };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const openSession = useCallback((session: SessionSummary) => {
    go({ view: 'session', sessionId: session.id });
  }, [go]);

  /*
    The address says which session is open, and that is the only thing that
    fetches one — whether you clicked a row, followed a link somebody sent, or
    reloaded the page. There is no summary to start from in the last two cases.
  */
  const routeSessionId = route.view === 'session' ? route.sessionId : undefined;
  useEffect(() => {
    if (!routeSessionId || !memoarApi.authenticated) return undefined;
    let active = true;
    void memoarApi.getSession({ id: routeSessionId })
      .then((loaded) => { if (active) setDetail(loaded); })
      .catch((error: unknown) => {
        if (active) setConnectionError(error instanceof Error ? error.message : 'Session could not be loaded');
      });
    return () => { active = false; };
  }, [routeSessionId]);

  // Whatever is loaded is only shown when it is the session the address names,
  // so moving between sessions never renders the previous one under the new
  // heading.
  const openDetail = detail && detail.session.id === routeSessionId ? detail : null;

  const allSessions = useMemo(() => dashboard.timeline.flatMap((group) => group.sessions), [dashboard.timeline]);

  const createCollection = async (name: string, description: string) => {
    const collection = await memoarApi.createCollection(name, description);
    setDashboard((current) => ({ ...current, collections: [collection, ...current.collections] }));
  };


  const loadMoreTimeline = async () => {
    if (!dashboard.nextTimelineCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const page = await memoarApi.loadTimelinePage(dashboard.nextTimelineCursor);
      setDashboard((current) => {
        const byDate = new Map(current.timeline.map((group) => [group.date, [...group.sessions]]));
        for (const group of page.groups) {
          const known = new Set((byDate.get(group.date) ?? []).map((session) => session.id));
          byDate.set(group.date, [...(byDate.get(group.date) ?? []), ...group.sessions.filter((session) => !known.has(session.id))]);
        }
        return { ...current, timeline: [...byDate].map(([date, sessions]) => ({ date, sessions })), nextTimelineCursor: page.nextCursor };
      });
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
      <section className="page connection-error" role="alert">
        <AlertCircle size={24} />
        <div><h1>Archive connection failed</h1><p>{connectionError}</p></div>
        <Button onClick={() => void loadDashboard()}><RefreshCw size={14} /> Retry</Button>
      </section>
    );
  } else if (view === 'workspace') {
    content = (
      <WorkspaceView
        sessions={allSessions}
        archived={dashboard.archivedSessions}
        machines={dashboard.machines}
        collections={dashboard.collections}
        grants={dashboard.grants}
        transfers={dashboard.transfers}
        onOpen={openSession}
      />
    );
  } else if (view === 'search') {
    content = <SearchView onOpen={openSession} workspaces={[...new Set(allSessions.map((session) => session.workspace))]} />;
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
        onRequestTransfer={async (input) => {
          const review = await memoarApi.completeRedactionReview(input.sessionId);
          await memoarApi.requestTransfer({ ...input, redactionReviewId: review.id });
          await loadDashboard();
        }}
      />
    );
  } else if (view === 'machines') {
    content = <MachinesView machines={dashboard.machines} onConnect={() => navigate('onboarding')} />;
  } else if (view === 'settings') {
    content = <SettingsView apiKeys={dashboard.apiKeys} user={user} onKeyRevoked={() => void loadDashboard()} mcpEndpoint={memoarApi.mcpEndpoint} onCreateKey={async (name, scopes) => {
      const created = await memoarApi.createApiKey(name, scopes);
      setDashboard((current) => ({ ...current, apiKeys: [created.apiKey, ...current.apiKeys] }));
      return created.secret;
    }} />;
  } else if (view === 'onboarding') {
    content = <OnboardingView machines={dashboard.machines} onComplete={() => navigate('timeline')} onRefresh={loadDashboard} />;
  } else if (view === 'session') {
    content = openDetail ? (
      <SessionDetailView
        detail={openDetail}
        collections={dashboard.collections}
        machines={dashboard.machines}
        onArchiveChanged={() => void loadDashboard()}
        onBack={() => navigate('timeline')}
        onBuildPack={(query, budget, freshness) => memoarApi.buildPack(query, budget, freshness)}
        onConvert={(target) => memoarApi.requestConversion(openDetail.session.id, target)}
        onConversionStatus={(jobId) => memoarApi.getConversion(jobId)}
        onDeleted={() => {
          setDetail(null);
          void loadDashboard();
          navigate('timeline');
        }}
      />
    ) : <div className="session-loading"><LoaderCircle size={24} /><p>Loading canonical session…</p></div>;
  } else {
    content = <TimelineView groups={dashboard.timeline} machines={dashboard.machines} archived={dashboard.archivedSessions} asOf={loadedAt} onOpen={openSession} onSearch={() => navigate('search')} onConnect={() => navigate('onboarding')} hasMore={Boolean(dashboard.nextTimelineCursor)} loadingMore={loadingMore} onLoadMore={loadMoreTimeline} />;
  }

  return (
    <Shell view={view} user={user} machines={dashboard.machines} reachable={connectionError === null && !loading} onNavigate={navigate}>
      {loading ? <div className="connection-toast" role="status" aria-label="Connection status"><LoaderCircle size={13} /> Checking archive connection</div> : null}
      {content}
    </Shell>
  );
}
