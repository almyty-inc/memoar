import { pathForLegacyHash, routeForPath, type Route } from '../lib/routes';
import type { DashboardState } from '../lib/types';

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
