import { describe, expect, it } from 'vitest';
import { projectName, workspaceLabel } from './workspace';

describe('a session workspace', () => {
  it('shows the placeholder for no workspace as "No workspace"', () => {
    for (const placeholder of ['/memoar/no-workspace', '/memoar/imports', '']) {
      expect(projectName(placeholder)).toBe('No workspace');
      expect(workspaceLabel(placeholder)).toBe('No workspace');
    }
  });

  it('names a real project by its last path part and keeps the full path as its label', () => {
    expect(projectName('/workspace/memoar/')).toBe('memoar');
    expect(workspaceLabel('/workspace/memoar')).toBe('/workspace/memoar');
  });
});
