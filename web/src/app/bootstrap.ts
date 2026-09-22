import { pathForLegacyHash, routeForPath, type Route } from '../lib/routes';
import type { DashboardState, TimelineGroup } from '../lib/types';

export const emptyConnectedDashboard: DashboardState = {
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
export function routeFromLocation(): Route {
  const legacy = pathForLegacyHash(window.location.hash);
  if (legacy) {
    window.history.replaceState(null, '', legacy);
    return routeForPath(legacy);
  }
  return routeForPath(window.location.pathname);
}

/** An address with no screen, or the sign-in screen itself, is nowhere to return to. */
export function placeToReturnTo(route: Route): Route | null {
  return route.view === 'signin' || route.view === 'not-found' ? null : route;
}

/**
 * Where the app opens, and where it owes the reader a return trip to.
 *
 * `intended` is where they were going before being asked to sign in. Following
 * a link to a session while signed out otherwise dropped them on the timeline
 * afterwards, with the thing they were sent still one search away.
 */
export function initialLocation(signedIn: boolean): { route: Route; intended: Route | null } {
  const current = routeFromLocation();
  if (signedIn) return { route: current, intended: null };
  return {
    route: current.creating ? { view: 'signin', creating: true } : { view: 'signin' },
    intended: placeToReturnTo(current),
  };
}

/**
 * Folds a newly fetched page of history into the groups already on screen.
 *
 * Sessions are keyed by id within their date, so a page that overlaps the one
 * before it — which a cursor over a moving archive will do — adds no duplicate
 * rows.
 */
export function mergeTimelinePage(current: TimelineGroup[], page: TimelineGroup[]): TimelineGroup[] {
  const byDate = new Map(current.map((group) => [group.date, [...group.sessions]]));
  for (const group of page) {
    const known = new Set((byDate.get(group.date) ?? []).map((session) => session.id));
    byDate.set(group.date, [...(byDate.get(group.date) ?? []), ...group.sessions.filter((session) => !known.has(session.id))]);
  }
  return [...byDate].map(([date, sessions]) => ({ date, sessions }));
}
