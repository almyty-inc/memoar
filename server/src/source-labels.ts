/**
 * What each source is called.
 *
 * The tools. own names, the same ones the capture agent.s connector table uses,
 * plus the import-only formats, which are named for what the file is. Never
 * title-cased from an id: that produces "Kilo" and "Antigravity Cli".
 */
const LABELS: Readonly<Record<string, string>> = {
  "claude-code": "Claude Code",
  codex: "Codex CLI",
  "antigravity-cli": "Antigravity CLI",
  cursor: "Cursor",
  opencode: "OpenCode",
  copilot: "GitHub Copilot",
  goose: "Goose",
  crush: "Crush",
  roo: "Roo Code",
  kilo: "Kilo Code",
  zed: "Zed",
  "canonical-bundle": "Canonical bundle",
  "cass-export": "CASS export",
  "chatgpt-export": "ChatGPT export",
};

/** The source's own name, or the id when it has none — never a guess. */
export function sourceLabel(source: string): string {
  return LABELS[source] ?? source;
}

export function knownSourceLabels(): readonly string[] {
  return Object.keys(LABELS);
}
