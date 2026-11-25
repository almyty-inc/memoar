/**
 * Whether a stored artifact's source path names something capture should never
 * have taken.
 *
 * The deny tables are a copy of agent/crates/memoar-connectors/src/deny.rs, the
 * list the capture agent now applies after every pattern. The server image does
 * not carry the agent's source, so they are repeated here, and
 * test/artifact-cleanup.test.ts reads deny.rs and fails if the two differ.
 */

export const DENIED_DIRECTORIES = [".git", ".hg", ".svn", ".ssh", ".gnupg", ".aws"];

export const DENIED_NAMES = [
  ".DS_Store", ".audit-key", ".claude.json", ".credentials.json", "credentials.json", ".netrc", ".npmrc",
  ".pypirc", ".git-credentials", ".env", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
];

export const DENIED_PATTERNS = [
  "*.key", "*.pem", "*.p12", "*.pfx", "*.keychain", "*.keychain-db", ".env.*", ".claude.json.*",
  "id_rsa*", "id_dsa*", "id_ecdsa*", "id_ed25519*",
];

/** `*` within one name, as the agent's `matches_segment` does it. */
export function matchesName(pattern: string, name: string): boolean {
  const parts = pattern.split("*");
  if (parts.length === 1) return pattern === name;
  const [first, ...rest] = parts;
  const last = rest.pop() ?? "";
  if (!name.startsWith(first!)) return false;
  const tail = name.slice(first!.length);
  if (tail.length < last.length || !tail.endsWith(last)) return false;
  let remaining = tail.slice(0, tail.length - last.length);
  for (const middle of rest) {
    const index = remaining.indexOf(middle);
    if (index === -1) return false;
    remaining = remaining.slice(index + middle.length);
  }
  return true;
}

/** A capture path's components, whichever separator the capturing machine used. */
function componentsOf(sourcePath: string): string[] {
  return sourcePath.split(/[\\/]+/u).filter((part) => part.length > 0);
}

/** Why the path is on the deny list, or null. */
export function deniedReason(sourcePath: string): string | null {
  const parts = componentsOf(sourcePath);
  const file = parts.at(-1);
  if (!file) return null;
  const directory = parts.slice(0, -1).find((part) => DENIED_DIRECTORIES.includes(part));
  if (directory) return `inside ${directory}`;
  if (DENIED_DIRECTORIES.includes(file) || DENIED_NAMES.includes(file)) return `a ${file} file`;
  const pattern = DENIED_PATTERNS.find((candidate) => matchesName(candidate, file));
  return pattern ? `a key or credential file (${pattern})` : null;
}

/**
 * The file names each source's parser reads, for the sources whose stray
 * uploads are on record. A source not listed here is judged by the deny list
 * alone, because nothing says which of its files were wrong.
 */
const TRANSCRIPT_NAMES: Readonly<Record<string, (parts: readonly string[]) => boolean>> = {
  // Session and subagent JSONL. The prompt history, the desktop audit stream
  // and tool results saved beside a session are not transcripts.
  "claude-code": (parts) => {
    const file = parts.at(-1)!;
    return file.endsWith(".jsonl") && file !== "history.jsonl" && file !== "audit.jsonl" && !parts.includes("tool-results");
  },
  codex: (parts) => matchesName("rollout-*.jsonl", parts.at(-1)!),
  "antigravity-cli": (parts) => parts.at(-1) === "transcript.jsonl",
};

/** Why an unparsed artifact cannot be a transcript of its source, or null. */
export function notATranscriptReason(source: string, sourcePath: string): string | null {
  const parts = componentsOf(sourcePath);
  const test = TRANSCRIPT_NAMES[source];
  if (!test || parts.length === 0) return null;
  return test(parts) ? null : `not a ${source} transcript (${parts.at(-1)})`;
}
