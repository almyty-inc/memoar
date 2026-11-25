import { describe, expect, it } from 'vitest';
import { encodeSourcePath } from './source-path';

describe('encodeSourcePath', () => {
  it('sends a non-ASCII file name as percent-encoded UTF-8', () => {
    expect(encodeSourcePath('ünï 日本.jsonl')).toBe('%C3%BCn%C3%AF%20%E6%97%A5%E6%9C%AC.jsonl');
  });

  it('escapes the characters encodeURIComponent leaves alone', () => {
    // The server decodes only unreserved characters and escapes, so a bare
    // parenthesis would have kept the whole value from being decoded.
    expect(encodeSourcePath("it's (1)!*.jsonl")).toBe('it%27s%20%281%29%21%2A.jsonl');
  });

  it('round-trips through decodeURIComponent', () => {
    const name = '/Users/ünï 日本/x (copy).jsonl';
    expect(decodeURIComponent(encodeSourcePath(name))).toBe(name);
  });
});
