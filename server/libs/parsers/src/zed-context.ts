import type { TokenTotals, Turn, WorkspaceDescriptor } from "../../canonical/src/generated.js";
import { isRecord, stringValue } from "./common.js";
import { anthropicUsage, isZeroTokens } from "./tokens.js";

/**
 * Zed's `request_token_usage`: a map from the id of a user message to the
 * usage of the request that message sent, as Zed's `TokenUsage`
 * (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`,
 * `cache_read_input_tokens`, each left out when zero). The agent messages
 * carry no id, so the usage goes to the first agent message after the user
 * message that sent the request.
 */
export class ZedUsage {
  private pending: TokenTotals | null = null;

  constructor(private readonly byUserMessage: unknown) {}

  /** The usage for the message just read, in thread order. */
  next(role: Turn["role"], nativeId: string | null): TokenTotals | null {
    if (role === "user") {
      const usage = nativeId && isRecord(this.byUserMessage) ? anthropicUsage(this.byUserMessage[nativeId]) : null;
      this.pending = usage && !isZeroTokens(usage) ? usage : null;
      return null;
    }
    if (role !== "assistant") return null;
    const taken = this.pending;
    this.pending = null;
    return taken;
  }
}

/**
 * The folder a thread was started in.
 *
 * Newer Zed keeps it in the `folder_paths` column, one path per line. Every
 * thread also carries `initial_project_snapshot.worktree_snapshots`, each
 * `{worktree_path, git_state: {remote_url, current_branch, …}}`. The parser
 * read neither, so every Zed thread gave the database file as its workspace.
 */
export function zedWorkspace(folderPaths: string | null | undefined, snapshot: unknown, seeded: WorkspaceDescriptor): WorkspaceDescriptor {
  const worktrees = isRecord(snapshot) && Array.isArray(snapshot.worktree_snapshots) ? snapshot.worktree_snapshots.filter(isRecord) : [];
  const first = worktrees[0];
  const listed = (folderPaths ?? "").split("\n").map((line) => line.trim()).find((line) => line.length > 0);
  const path = listed ?? (first ? stringValue(first, "worktree_path") : null);
  const git = first && isRecord(first.git_state) ? first.git_state : {};
  const remote = stringValue(git, "remote_url");
  const branch = stringValue(git, "current_branch");
  return {
    ...seeded,
    ...(path ? { path } : {}),
    ...(remote ? { gitRemote: remote } : {}),
    ...(branch ? { branch } : {}),
  };
}
