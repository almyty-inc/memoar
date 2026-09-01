/**
 * What each source is called, mirroring the server's table.
 *
 * The client used to know five names and title-case the rest, so Kilo Code
 * appeared as "Kilo", OpenCode as "Opencode", and antigravity-cli as
 * "Antigravity Cli" — names produced by a string transform rather than taken
 * from the tools. Sessions carry their label from the server now; this covers
 * the places that only have an id to work with, and a test holds it to the
 * server's table so the two cannot drift.
 */
export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex CLI',
  'antigravity-cli': 'Antigravity CLI',
  cursor: 'Cursor',
  opencode: 'OpenCode',
  copilot: 'GitHub Copilot',
  goose: 'Goose',
  crush: 'Crush',
  roo: 'Roo Code',
  kilo: 'Kilo Code',
  zed: 'Zed',
  'canonical-bundle': 'Canonical bundle',
  'cass-export': 'CASS export',
  'chatgpt-export': 'ChatGPT export',
};

/** The source's own name, or the id when it has none — never a guess. */
export function sourceLabel(source: string): string {
  return SOURCE_LABELS[source] ?? source;
}
