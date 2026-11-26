import type { Command } from '../components/command-search';
import { formatRelative } from '../components/ui';
import { saveTheme, type ThemeChoice } from '../lib/theme';
import { workspaceLabel } from '../lib/workspace';
import type { Machine, SessionSummary, ViewId } from '../lib/types';
import { requestSessionAction } from '../views/session-detail/session-actions';

const PLACES: Array<[ViewId, string, string?]> = [
  ['timeline', 'Sessions', 'home list'],
  ['search', 'Search', 'find transcripts'],
  ['memory', 'Memory', 'claude.md agents.md instructions'],
  ['collections', 'Collections'],
  ['sharing', 'Shared', 'links transfers'],
  ['teams', 'Teams'],
  ['machines', 'Machines', 'sources capture'],
  ['onboarding', 'Connect a machine', 'setup install login'],
  ['import', 'Import', 'upload archive'],
  ['settings', 'Settings', 'api keys mcp redaction retention'],
];

/** Sessions per agent across every machine, most first, for the sidebar. */
export function agentCounts(machines: Machine[]): Array<{ source: string; label: string; count: number }> {
  const counts = new Map<string, { source: string; label: string; count: number }>();
  for (const source of machines.flatMap((machine) => machine.sources)) {
    const entry = counts.get(source.id) ?? { source: source.id, label: source.label, count: 0 };
    entry.count += source.sessionCount;
    counts.set(source.id, entry);
  }
  return [...counts.values()].filter((entry) => entry.count > 0).sort((left, right) => right.count - left.count);
}

/** Recent sessions listed before anything is typed. The rest need a query. */
const RECENT = 6;

/**
 * Everything the palette can do, given where the reader is.
 *
 * Actions on a session are offered only while one is open, and reach it as an
 * event, so the palette does not need to hold the session's state.
 */
export function buildCommands({ sessions, openSessionId, navigate, openSession, searchFor }: {
  sessions: SessionSummary[];
  openSessionId: string | undefined;
  navigate: (view: ViewId) => void;
  openSession: (session: SessionSummary) => void;
  searchFor: (query: string) => void;
}): Command[] {
  const commands: Command[] = [];

  if (openSessionId) {
    const actions: Array<[string, string, () => void, string?]> = [
      ['convert-codex', 'Convert to Codex', () => requestSessionAction('convert', 'codex'), 'c'],
      ['convert-claude', 'Convert to Claude Code', () => requestSessionAction('convert', 'claude-code')],
      ['convert-agy', 'Convert to Antigravity', () => requestSessionAction('convert', 'antigravity-cli')],
      ['export', 'Export session', () => requestSessionAction('export'), 'e'],
      ['share', 'Share session', () => requestSessionAction('share'), 's'],
      ['copy-id', 'Copy session id', () => requestSessionAction('copy-id'), 'y'],
      ['thinking', 'Show or hide thinking', () => requestSessionAction('thinking'), 't'],
      ['pin', 'Pin or unpin session', () => requestSessionAction('pin')],
      ['pack', 'Build a context pack', () => requestSessionAction('pack')],
    ];
    for (const [id, label, run, hint] of actions) {
      commands.push({ id: `action-${id}`, group: 'This session', label: () => label, run, ...(hint ? { hint } : {}), matchLabel: true });
    }
  }

  sessions.forEach((session, index) => {
    commands.push({
      id: `session-${session.id}`,
      group: 'Sessions',
      label: () => session.title,
      keywords: `${session.sourceLabel} ${workspaceLabel(session.workspace)}`,
      detail: `${workspaceLabel(session.workspace)} · ${formatRelative(session.updatedAt)}`,
      matchLabel: true,
      needsQuery: index >= RECENT,
      run: () => openSession(session),
    });
  });

  for (const [view, label, keywords] of PLACES) {
    commands.push({ id: `go-${view}`, group: 'Go to', label: () => label, matchLabel: true, run: () => navigate(view), ...(keywords ? { keywords } : {}) });
  }

  const themes: Array<[ThemeChoice, string]> = [['system', 'Use the system theme'], ['light', 'Use the light theme'], ['dark', 'Use the dark theme']];
  for (const [choice, label] of themes) {
    commands.push({ id: `theme-${choice}`, group: 'Theme', label: () => label, keywords: 'appearance dark mode light mode', matchLabel: true, needsQuery: true, run: () => saveTheme(choice) });
  }

  commands.push({
    id: 'search-transcripts',
    group: 'Search',
    label: (query) => `Search transcripts for “${query}”`,
    always: true,
    hint: 'Enter',
    run: (query) => searchFor(query),
  });

  return commands;
}
