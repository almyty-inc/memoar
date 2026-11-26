/**
 * The tool versions the native writers were verified against.
 *
 * Held to `contracts/convert-matrix/versions.json` by a test. Claude Code and
 * Codex both record the writing tool's version in the session, so a converted
 * session states the version whose format it follows.
 */
export const TARGET_VERSIONS = {
  "claude-code": "2.1.331",
  codex: "0.172.0",
  "antigravity-cli": "1.5.15",
} as const;
