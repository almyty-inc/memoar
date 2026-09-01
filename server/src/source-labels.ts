/**
 * What each source is called.
 *
 * The web client carried five of these and title-cased the rest, so Kilo Code
 * appeared as "Kilo", OpenCode as "Opencode", and antigravity-cli as
 * "Antigravity Cli" — names invented by a string transform rather than taken
 * from the tools. These are the tools' own names, the same ones the capture
 * agent's connector table uses, plus the import-only formats which are named
 * for what the file is.
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
