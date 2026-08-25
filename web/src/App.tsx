import { AlertCircle, LoaderCircle, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Shell } from './components/Shell';
import { Button } from './components/ui';
import { memoarApi } from './lib/api';
import { demoDashboard } from './lib/demo';
import type { CurrentUser, DashboardState, SessionDetailData, SessionSummary, ViewId } from './lib/types';
import { CollectionsView } from './views/Collections';
import { ImportView } from './views/Import';
import { MachinesView } from './views/Machines';
import { OnboardingView, SignInView } from './views/Onboarding';
import { SearchView } from './views/Search';
import { SessionDetailView } from './views/SessionDetail';
import { SettingsView } from './views/Settings';
import { SharingView } from './views/Sharing';
import { TimelineView } from './views/Timeline';

const supportedViews: ViewId[] = ['timeline', 'search', 'collections', 'import', 'sharing', 'machines', 'settings', 'onboarding', 'signin', 'session'];

const emptyConnectedDashboard: DashboardState = {
  timeline: [],
  collections: [],
  grants: [],
  transfers: [],
  machines: [],
  apiKeys: [],
  mode: 'connected',
};

function viewFromHash(): ViewId {
  const candidate = window.location.hash.replace(/^#\/?/, '').split('/')[0];
  return supportedViews.includes(candidate as ViewId) ? candidate as ViewId : 'timeline';
}

export function App() {
  const [view, setView] = useState<ViewId>(() => memoarApi.configured && !memoarApi.authenticated ? 'signin' : viewFromHash());
  const [dashboard, setDashboard] = useState<DashboardState>(memoarApi.configured ? emptyConnectedDashboard : { ...demoDashboard, mode: 'demo' });
  const [loading, setLoading] = useState(() => !memoarApi.configured || memoarApi.authenticated);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<SessionSummary | null>(null);
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
    const onHashChange = () => setView(memoarApi.configured && !memoarApi.authenticated ? 'signin' : viewFromHash());
    const onUnauthorized = () => {
      setView('signin');
      window.history.replaceState(null, '', '#/signin');
    };
    window.addEventListener('hashchange', onHashChange);
    window.addEventListener('memoar:unauthorized', onUnauthorized);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
      window.removeEventListener('memoar:unauthorized', onUnauthorized);
    };
  }, []);

  const navigate = useCallback((next: ViewId) => {
    setView(next);
    const nextHash = `#/${next}`;
    if (window.location.hash !== nextHash) window.history.pushState(null, '', nextHash);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  const openSession = useCallback((session: SessionSummary) => {
    setSelected(session);
    setDetail(null);
    navigate('session');
    void memoarApi.getSession(session).then(setDetail).catch((error: unknown) => {
      setConnectionError(error instanceof Error ? error.message : 'Session could not be loaded');
    });
  }, [navigate]);

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
    navigate('timeline');
  };

  if (view === 'signin') return <SignInView onSignIn={signIn} onOAuth={(provider) => memoarApi.beginOAuth(provider)} />;

  let content;
  if (connectionError) {
    content = (
      <section className="page connection-error" role="alert">
        <AlertCircle size={24} />
        <div><h1>Archive connection failed</h1><p>{connectionError}</p></div>
        <Button onClick={() => void loadDashboard()}><RefreshCw size={14} /> Retry</Button>
      </section>
    );
  } else if (view === 'search') {
    content = <SearchView onOpen={openSession} />;
  } else if (view === 'collections') {
    content = <CollectionsView collections={dashboard.collections} sessions={allSessions} onOpen={openSession} onCreate={createCollection} />;
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
        shareOrigin={window.location.origin}
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
    content = <OnboardingView onComplete={() => navigate('timeline')} />;
  } else if (view === 'session' && selected) {
    content = detail ? (
      <SessionDetailView
        detail={detail}
        collections={dashboard.collections}
        machines={dashboard.machines}
        onCollectionsChanged={() => void loadDashboard()}
        onBack={() => navigate('timeline')}
        onBuildPack={(query, budget, freshness) => memoarApi.buildPack(query, budget, freshness)}
        onConvert={(target) => memoarApi.requestConversion(detail.session.id, target)}
        onDeleted={() => {
          setSelected(null);
          setDetail(null);
          void loadDashboard();
          navigate('timeline');
        }}
      />
    ) : <div className="session-loading"><LoaderCircle size={24} /><p>Loading canonical session…</p></div>;
  } else {
    content = <TimelineView groups={dashboard.timeline} onOpen={openSession} onSearch={() => navigate('search')} hasMore={Boolean(dashboard.nextTimelineCursor)} loadingMore={loadingMore} onLoadMore={loadMoreTimeline} />;
  }

  return (
    <Shell view={view} mode={dashboard.mode} user={user} machines={dashboard.machines} onNavigate={navigate}>
      {loading ? <div className="connection-toast" role="status"><LoaderCircle size={13} /> Checking archive connection</div> : null}
      {content}
    </Shell>
  );
}
