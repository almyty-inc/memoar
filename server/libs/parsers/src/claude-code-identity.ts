import { stringValue } from "./common.js";

/** Who a Claude Code transcript says it is, and whose subagent it was if it was one. */
export interface ClaudeCodeIdentity {
  /** The archive identity. Absent when the transcript names none it can be trusted with. */
  nativeSessionId: string | null;
  /** Set for a subagent transcript: the conversation that spawned it. */
  parent: { nativeSessionId: string; agentId: string } | null;
}

/**
 * The identity of a Claude Code transcript, read from its first message record.
 *
 * A subagent writes its own file, `<session>/subagents/agent-<agentId>.jsonl`,
 * and every line of it carries the *parent's* `sessionId`. Checked on a real
 * machine: 613 of 613 subagent files named their parent directory's id there,
 * with `isSidechain: true` and an `agentId` on the first record. Read as the
 * transcript's own id, that put a parent and every subagent it ran into one
 * archive session, and because a capture replaces the session it saves, the
 * file parsed last erased the others. On dev one session was written by 94
 * files and held the turns of exactly one of them.
 *
 * So a sidechain is its own conversation, named after its parent and its agent
 * id, which is unique within the parent. A sidechain without an agent id names
 * nothing of its own, and returns no id at all: the pipeline then identifies it
 * by where the file sits, which is one file, never the parent.
 */
export function claudeCodeIdentity(first: Record<string, unknown>): ClaudeCodeIdentity {
  const sessionId = stringValue(first, "sessionId");
  if (first.isSidechain !== true) return { nativeSessionId: sessionId, parent: null };
  const agentId = stringValue(first, "agentId");
  if (!sessionId || !agentId) return { nativeSessionId: null, parent: null };
  return {
    nativeSessionId: `${sessionId}:agent:${agentId}`,
    parent: { nativeSessionId: sessionId, agentId },
  };
}
