/**
 * The version each parser stamps on what it parses, in one place.
 *
 * A session records the parser that produced it in its native provenance entry
 * as `<source>:<format>:<semver>`. Bumping the semver here is how a deploy
 * tells `reprocess --stale-parser` which archived sessions an older parser
 * wrote and should be parsed again.
 *
 * claude-code 0.5.0, codex and antigravity-cli 0.4.0 (#26 had taken 0.3.0 for
 * line-by-line reading), and 0.3.0 for the rest: the parse keeps tool output,
 * thinking text, redacted and encrypted reasoning, images and documents, and
 * the system, compaction and summary records it used to drop.
 */
export const PARSER_VERSIONS: Readonly<Record<string, string>> = {
  "claude-code": "claude-code:v1:0.5.0",
  codex: "codex:rollout-v1:0.4.0",
  "antigravity-cli": "antigravity-cli:v1:0.4.0",
  cursor: "cursor:v3:0.3.0",
  goose: "goose:v1:0.3.0",
  crush: "crush:v1:0.3.0",
  zed: "zed:v1:0.3.0",
  opencode: "opencode:v1:0.3.0",
  copilot: "copilot:v1:0.3.0",
  kilo: "kilo:v1:0.3.0",
  roo: "roo:v1:0.3.0",
  "chatgpt-export": "chatgpt-export:2026-08:0.3.0",
  "cass-export": "cass-export:2026-08:0.3.0",
};

export function parserVersion(source: string): string {
  const version = PARSER_VERSIONS[source];
  if (!version) throw new Error(`no parser version is declared for ${source}`);
  return version;
}

function semver(value: string): number[] | null {
  const match = /:(\d+)\.(\d+)\.(\d+)$/u.exec(value);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/**
 * Whether a recorded parser version is older than the one deployed.
 *
 * A session still marked `pending`, or stamped by a version this build does not
 * know how to compare, counts as stale: parsing it again is the safe answer. A
 * source with no declared version (an uploaded canonical bundle) never is.
 */
export function isStaleParserVersion(recorded: string | null | undefined, source: string): boolean {
  const current = PARSER_VERSIONS[source];
  if (!current) return false;
  if (!recorded) return true;
  if (recorded === current) return false;
  const [have, want] = [semver(recorded), semver(current)];
  if (!have || !want || !recorded.startsWith(current.slice(0, current.lastIndexOf(":") + 1))) return true;
  for (let index = 0; index < 3; index += 1) {
    if (have[index]! !== want[index]!) return have[index]! < want[index]!;
  }
  return false;
}
