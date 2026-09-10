import { describe, expect, it } from 'vitest';
import { pathForLegacyHash, pathForRoute, routeForPath } from './routes';

/**
 * Addresses.
 *
 * Every screen used to live behind a fragment — `#/timeline`, `#/signin` — and
 * a session had no address at all: the open session was held in memory, so a
 * reload landed on the timeline and there was nothing to send anybody.
 */
describe('the address of a screen', () => {
  it('gives sign-in and sign-up their own addresses', () => {
    expect(pathForRoute({ view: 'signin' })).toBe('/login');
    expect(pathForRoute({ view: 'signin', creating: true })).toBe('/signup');
    expect(routeForPath('/login')).toEqual({ view: 'signin' });
    expect(routeForPath('/signup')).toEqual({ view: 'signin', creating: true });
  });

  it('gives a session an address that identifies it', () => {
    expect(pathForRoute({ view: 'session', sessionId: 'abc-123' })).toBe('/sessions/abc-123');
    expect(routeForPath('/sessions/abc-123')).toEqual({ view: 'session', sessionId: 'abc-123' });
  });

  it('round-trips every screen', () => {
    const views = ['workspace', 'timeline', 'search', 'collections', 'import', 'sharing', 'machines', 'memory', 'settings', 'onboarding', 'signin'] as const;
    for (const view of views) {
      expect(routeForPath(pathForRoute({ view }))).toEqual({ view });
    }
  });

  it('reaches Agent memory, which the old hash list left out', () => {
    // `memory` was a view but not a restorable one: it was missing from the
    // list the hash was checked against, so a reload on it fell to the timeline.
    expect(routeForPath('/memory')).toEqual({ view: 'memory' });
  });

  it('lands on the timeline at the root, and nowhere for an address that has no screen', () => {
    expect(routeForPath('/')).toEqual({ view: 'timeline' });
    expect(routeForPath('/nothing-here')).toBeNull();
  });

  it('ignores a trailing slash', () => {
    expect(routeForPath('/settings/')).toEqual({ view: 'settings' });
  });
});

describe('a link from before there were paths', () => {
  it('rewrites the fragment to the address that replaced it', () => {
    expect(pathForLegacyHash('#/timeline')).toBe('/timeline');
    expect(pathForLegacyHash('#/signin')).toBe('/login');
    expect(pathForLegacyHash('#/machines')).toBe('/machines');
  });

  it('sends an old session fragment to the timeline, since it named no session', () => {
    expect(pathForLegacyHash('#/session')).toBe('/timeline');
  });

  it('leaves a page with no fragment alone', () => {
    expect(pathForLegacyHash('')).toBeNull();
    expect(pathForLegacyHash('#/unknown')).toBeNull();
  });
});
