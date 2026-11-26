/**
 * Workspace paths the server gives a session whose source records none.
 *
 * The contract requires a path, so the server fills it with a value that is
 * not a directory on any machine. `/memoar/imports` is what uploads were given
 * before, and sessions archived then still carry it.
 */
const NO_WORKSPACE_PATHS = new Set(['/memoar/no-workspace', '/memoar/imports']);

export const NO_WORKSPACE_LABEL = 'No workspace';

export function isNoWorkspace(workspace: string): boolean {
  return workspace === '' || NO_WORKSPACE_PATHS.has(workspace);
}

/** The full path, or "No workspace" in place of the placeholder. */
export function workspaceLabel(workspace: string): string {
  return isNoWorkspace(workspace) ? NO_WORKSPACE_LABEL : workspace;
}

/** The last part of a project path, which is how people name a project. */
export function projectName(workspace: string): string {
  if (isNoWorkspace(workspace)) return NO_WORKSPACE_LABEL;
  return workspace.replace(/\/+$/u, '').split('/').at(-1) || workspace;
}
