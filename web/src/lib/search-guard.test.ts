import { describe, expect, it, vi } from 'vitest';
import { memoarApi } from './api';

/**
 * Asking for nothing must not return results for something.
 *
 * The client sent `q=session` when the phrase was empty, so an empty search
 * silently became a search for the literal word "session" — results for a query
 * nobody typed, presented as the answer to the one they did. The page has its
 * own guard, but a client that substitutes a phrase should not need the caller
 * to protect against it.
 */
describe('searching for nothing', () => {
  it('refuses rather than substituting a phrase', async () => {
    const asked = vi.spyOn(memoarApi as unknown as { request: () => Promise<unknown> }, 'request');
    for (const empty of ['', '   ', '\t\n']) {
      await expect(memoarApi.search(empty)).rejects.toThrow(/phrase/u);
    }
    expect(asked, 'the archive should never have been asked').not.toHaveBeenCalled();
  });
});
