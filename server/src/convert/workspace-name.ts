import { createHash } from "node:crypto";

/**
 * The longest directory component a Claude Code conversion may produce.
 *
 * `~/.claude/projects/<workspace>/<session>.jsonl` turns a whole absolute path
 * into exactly one component, and a component stops at 255 bytes on APFS, ext4
 * and NTFS alike. Nothing bounded it here, so a session captured from a deep
 * workspace produced a 531-byte component; the bundle serialized, uploaded and
 * downloaded fine, and then died on the user's machine with
 * `File name too long (os error 63)` — a failure that can only happen where
 * there is no CI.
 *
 * `agent/crates/memoar-materializer/src/native.rs` bounded its own copy of this
 * encoder at 180 and this one was never changed with it. 180 leaves room for
 * the session id and extension that follow the directory.
 */
const MAX_WORKSPACE_COMPONENT = 180;

/** 12 hex characters of digest, a separator, and the rest is tail. */
const DIGEST_PREFIX = 12;

/**
 * The directory name a workspace path takes under `~/.claude/projects`.
 *
 * Byte for byte what `native.rs::encode_claude_workspace` produces, and held to
 * it by `contracts/fixtures/claude-workspace-names.json`, which both languages
 * assert against. A disagreement would not fail: it would quietly file the same
 * workspace under two directories depending on which half converted it.
 */
export function encodeClaudeWorkspace(workspace: string): string {
  const encoded = [...workspace]
    .map((character) => (/^[A-Za-z0-9._-]$/u.test(character) ? character : "-"))
    .join("");
  if (encoded.length === 0) return "memoar-imports";
  // Every character above is ASCII, so length is byte length.
  if (encoded.length <= MAX_WORKSPACE_COMPONENT) return encoded;
  // The tail is kept because that is where the project is named; the digest of
  // the whole path goes in front so two long workspaces sharing a tail do not
  // land in one directory.
  const digest = createHash("sha256").update(Buffer.from(workspace, "utf8")).digest("hex");
  const tail = encoded.slice(-(MAX_WORKSPACE_COMPONENT - DIGEST_PREFIX - 1));
  return `${digest.slice(0, DIGEST_PREFIX)}-${tail}`;
}
