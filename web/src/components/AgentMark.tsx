import { cn } from './ui';

/**
 * Each agent's colour and monogram. Marks are rounded squares with two
 * letters, never vendor logos. Codex is ink in light and a light grey in
 * dark, so its colour comes from a token rather than this table.
 */
const AGENTS: Record<string, { mono: string; tone: string }> = {
  'claude-code': { mono: 'CC', tone: 'claude' },
  codex: { mono: 'CX', tone: 'codex' },
  'antigravity-cli': { mono: 'AG', tone: 'antigravity' },
  cursor: { mono: 'CU', tone: 'cursor' },
  opencode: { mono: 'OC', tone: 'opencode' },
  copilot: { mono: 'CP', tone: 'copilot' },
  goose: { mono: 'GO', tone: 'goose' },
  crush: { mono: 'CR', tone: 'crush' },
  roo: { mono: 'RO', tone: 'roo' },
  kilo: { mono: 'KI', tone: 'kilo' },
  zed: { mono: 'ZE', tone: 'zed' },
};

export function agentTone(source: string): string {
  return AGENTS[source]?.tone ?? 'other';
}

function monogram(source: string, label: string): string {
  const known = AGENTS[source]?.mono;
  if (known) return known;
  const words = label.split(/\s+/u).filter(Boolean);
  return (words.length > 1 ? `${words[0]![0]}${words[1]![0]}` : label.slice(0, 2)).toUpperCase();
}

/** The agent's mark. Decorative: the agent's name is always said beside it. */
export function AgentMark({ source, label, size = 32 }: { source: string; label: string; size?: 22 | 32 }) {
  return (
    <span className={cn('agent-mark', `agent-${agentTone(source)}`, size === 22 && 'agent-mark-sm')} aria-hidden="true">
      {monogram(source, label)}
    </span>
  );
}

/** The agent's colour as a small dot, for filters and lists. */
export function AgentDot({ source }: { source: string }) {
  return <i className={cn('agent-dot', `agent-${agentTone(source)}`)} aria-hidden="true" />;
}
