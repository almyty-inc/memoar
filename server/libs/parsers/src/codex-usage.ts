import type { TokenTotals, Turn, WorkspaceDescriptor } from "../../canonical/src/generated.js";
import { isRecord, stringValue } from "./common.js";
import { addTokens, isZeroTokens, NO_TOKENS, openAiUsage } from "./tokens.js";

/**
 * The usage Codex reports, one model request at a time.
 *
 * After each request Codex writes an `event_msg` whose payload is
 * `{type: "token_count", info: {last_token_usage, total_token_usage, …}}`.
 * `last_token_usage` is that request alone, so it belongs to the assistant turn
 * the request produced, and a turn that took several requests to finish (one
 * per tool call) sums them.
 *
 * Codex sometimes writes the same event twice: 59 of 4,345 on the machine this
 * was checked on repeated the previous running total exactly. Counting those
 * would bill one request twice, so an event whose `total_token_usage` has not
 * moved is skipped. `info` is null on the event Codex writes before any request.
 */
export class CodexUsage {
  private lastTotal: string | null = null;
  /** Usage that arrived before the assistant turn it belongs to was opened. */
  private pending: TokenTotals = NO_TOKENS;

  read(payload: Record<string, unknown>, current: Turn | undefined): void {
    if (payload.type !== "token_count" || !isRecord(payload.info)) return;
    const total = isRecord(payload.info.total_token_usage) ? JSON.stringify(payload.info.total_token_usage) : null;
    if (total !== null && total === this.lastTotal) return;
    this.lastTotal = total;
    const last = openAiUsage(payload.info.last_token_usage);
    if (!last || isZeroTokens(last)) return;
    if (current?.role === "assistant") current.tokens = addTokens(current.tokens ?? NO_TOKENS, last);
    else this.pending = addTokens(this.pending, last);
  }

  /** What a newly opened assistant turn starts with, which clears it. */
  takePending(): TokenTotals {
    const taken = this.pending;
    this.pending = NO_TOKENS;
    return taken;
  }

  /** Usage no later turn claimed goes to the last assistant turn, not nowhere. */
  flush(turns: readonly Turn[]): void {
    if (isZeroTokens(this.pending)) return;
    const last = turns.findLast((turn) => turn.role === "assistant");
    if (last) last.tokens = addTokens(last.tokens ?? NO_TOKENS, this.takePending());
  }
}

/**
 * The working directory and repository a rollout records.
 *
 * `session_meta.payload.cwd` is where Codex was started, and every
 * `turn_context` repeats a cwd. `git` is `{commit_hash, branch,
 * repository_url}` when Codex ran inside a repository and absent otherwise.
 * The parser read none of it, so every Codex session in the archive gave the
 * rollout file itself as its workspace.
 */
export function codexWorkspace(meta: Record<string, unknown>, contextCwd: string | null, seeded: WorkspaceDescriptor): WorkspaceDescriptor {
  const path = stringValue(meta, "cwd") || contextCwd;
  const git = isRecord(meta.git) ? meta.git : {};
  const remote = stringValue(git, "repository_url");
  const branch = stringValue(git, "branch");
  return {
    ...seeded,
    ...(path ? { path } : {}),
    ...(remote ? { gitRemote: remote } : {}),
    ...(branch ? { branch } : {}),
  };
}
