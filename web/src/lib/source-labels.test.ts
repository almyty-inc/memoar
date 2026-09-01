import { describe, expect, it } from 'vitest';
import { SOURCE_LABELS, sourceLabel } from './source-labels';

/*
  Kept free of node APIs on purpose: the web package is type-checked as part of
  its production build, without node types, so a test that reads a file here
  fails the build rather than the test — which is exactly what happened, and the
  container went on serving the previous bundle.

  The check that this table matches the server's lives in the server suite,
  which does have a filesystem.
*/
describe('source names', () => {
  it('gives every supported tool its own name rather than a title-cased id', () => {
    expect(sourceLabel('kilo')).toBe('Kilo Code');
    expect(sourceLabel('opencode')).toBe('OpenCode');
    expect(sourceLabel('antigravity-cli')).toBe('Antigravity CLI');
    expect(sourceLabel('copilot')).toBe('GitHub Copilot');
    expect(sourceLabel('codex')).toBe('Codex CLI');
  });

  it('returns an unknown id unchanged instead of dressing it up', () => {
    expect(sourceLabel('some-new-agent')).toBe('some-new-agent');
  });

  it('covers every source the archive can hold', () => {
    for (const source of ['claude-code', 'codex', 'antigravity-cli', 'cursor', 'opencode', 'copilot', 'goose', 'crush', 'roo', 'kilo', 'zed']) {
      expect(SOURCE_LABELS[source], `${source} has no name`).toBeDefined();
    }
  });
});
