import type { ViewId } from './types';

/**
 * Where each screen lives.
 *
 * These were fragments — `#/timeline`, `#/signin` — which never reach the
 * server, cannot be rendered ahead of time, and gave a session no address at
 * all: the opened session was held in memory, so a reload dropped you back to
 * the timeline and there was nothing to send anyone.
 */
const VIEW_PATHS: Readonly<Record<Exclude<ViewId, 'session' | 'not-found'>, string>> = {

  workspace: '/overview',
  timeline: '/timeline',
  search: '/search',
  collections: '/collections',
  import: '/import',
  sharing: '/sharing',
  teams: '/teams',
  machines: '/machines',
  memory: '/memory',
  settings: '/settings',
  onboarding: '/connect',
  signin: '/login',
};

export interface Route {
  view: ViewId;
  /** Present on /sessions/:id, which is what makes a session linkable. */
  sessionId?: string;
  /** /signup is the sign-in screen already switched to creating an account. */
  creating?: boolean;
}

export const SIGN_UP_PATH = '/signup';

/**
 * The address of a view, for pushing onto history.
 *
 * `not-found` is never navigated to — it is only ever arrived at — so it has no
 * address to push; the address the reader typed stays where it is.
 */
export function pathForRoute(route: Route): string {
  if (route.view === 'session') return route.sessionId ? `/sessions/${route.sessionId}` : VIEW_PATHS.timeline;
  if (route.view === 'not-found') return window.location.pathname;
  if (route.view === 'signin' && route.creating) return SIGN_UP_PATH;
  return VIEW_PATHS[route.view];
}

/**
 * The view at an address.
 *
 * An address with no screen behind it resolves to `not-found`, not to nothing:
 * every caller here used to fall back to the timeline, so a typo'd or
 * since-removed link rendered the archive under an address that did not name
 * it, with no sign anything had gone wrong.
 */
export function routeForPath(pathname: string): Route {
  const path = pathname.replace(/\/+$/u, '') || '/';
  if (path === '/') return { view: 'timeline' };
  if (path === SIGN_UP_PATH) return { view: 'signin', creating: true };

  const session = /^\/sessions\/([^/]+)$/u.exec(path);
  if (session) return { view: 'session', sessionId: decodeURIComponent(session[1]!) };

  const entry = Object.entries(VIEW_PATHS).find(([, value]) => value === path);
  return entry ? { view: entry[0] as ViewId } : { view: 'not-found' };
}


/**
 * The address that replaces an old `#/…` link.
 *
 * Bookmarks and anything already shared keep working; the fragment is rewritten
 * once, on arrival, and never written again.
 */
export function pathForLegacyHash(hash: string): string | null {
  const candidate = hash.replace(/^#\/?/u, '').split('/')[0];
  if (!candidate) return null;
  if (candidate === 'session') return VIEW_PATHS.timeline;
  return Object.hasOwn(VIEW_PATHS, candidate) ? VIEW_PATHS[candidate as keyof typeof VIEW_PATHS] : null;

}
