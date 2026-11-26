import { Suspense, lazy, type ComponentProps } from 'react';
import { TranscriptSkeleton } from '../views/SessionsSplit';

/*
  The transcript renderers carry markdown, diffing and syntax highlighting,
  which is most of the app's weight and none of what the sign-in screen or
  the session list needs. They load in their own chunk, and are fetched as
  soon as the archive has answered, so the first transcript does not wait.
*/
const loadSessionPane = () => import('../views/SessionPane');
const loadMemory = () => import('../views/Memory');

const SessionPaneChunk = lazy(() => loadSessionPane().then((module) => ({ default: module.SessionPane })));
const MemoryChunk = lazy(() => loadMemory().then((module) => ({ default: module.MemoryView })));

type SessionPaneProps = ComponentProps<typeof import('../views/SessionPane').SessionPane>;

export function SessionPane(props: SessionPaneProps) {
  return <Suspense fallback={<TranscriptSkeleton />}><SessionPaneChunk {...props} /></Suspense>;
}

export function MemoryView() {
  return <Suspense fallback={<p className="loading-line" role="status">Loading memory</p>}><MemoryChunk /></Suspense>;
}

/** Fetch both chunks ahead of need. A failure here is retried on first use. */
export function preloadViews(): void {
  void loadSessionPane().catch(() => undefined);
  void loadMemory().catch(() => undefined);
}
