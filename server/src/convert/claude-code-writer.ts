import type { Session } from "../../libs/canonical/src/generated.js";
import { countMapped, derivedUuid, dropThinking, placement, planSession, type PlanMessage, type PlanPart } from "./native-plan.js";
import { TARGET_VERSIONS } from "./target-versions.js";
import { bytes, freshReport, type ConversionBundle, type NativeWriter, type WriteOptions } from "./types.js";
import { encodeClaudeWorkspace } from "./workspace-name.js";

/** Claude accepts tool ids of this alphabet only. */
function toolId(callId: string): string {
  return callId.replaceAll(/[^A-Za-z0-9_-]/gu, "_");
}

function claudeBlock(part: PlanPart): Record<string, unknown> {
  switch (part.kind) {
    case "text":
      return { type: "text", text: part.text };
    case "image":
      return part.base64
        ? { type: "image", source: { type: "base64", media_type: part.mediaType, data: part.base64 } }
        : { type: "image", source: { type: "url", url: part.url } };
    case "document":
      return { type: "document", source: part.source, ...(part.title ? { title: part.title } : {}) };
    case "thinking":
      return part.data.redacted === true
        ? { type: "redacted_thinking", data: part.data.data }
        : { type: "thinking", thinking: part.text, signature: part.data.signature };
    case "tool_call":
      return { type: "tool_use", id: toolId(part.callId), name: part.name, input: part.input };
    case "tool_result":
      return {
        type: "tool_result",
        tool_use_id: toolId(part.callId),
        content: part.nativeContent ?? part.text,
        ...(part.isError ? { is_error: true } : {}),
      };
  }
}

/**
 * Only Claude's own signed reasoning goes back to Claude.
 *
 * The API rejects a thinking block whose signature it did not issue, so
 * thinking from Codex (encrypted for OpenAI) or Antigravity (unsigned) is
 * dropped and reported, not replayed.
 */
function isClaudeReasoning(session: Session) {
  return (part: { data: Record<string, unknown> }) =>
    session.source.tool === "claude-code" && (typeof part.data.signature === "string" || part.data.redacted === true);
}

/**
 * Writes the transcript Claude Code reads on `claude -r <id>`.
 *
 * One line per message, in Claude Code's own record shape: native content
 * blocks, the session id and working directory on every line, and a linear
 * `parentUuid` chain that `--resume` walks back from the last line. Canonical
 * blocks (`{"kind":"text"}`) were written here before, and Claude Code treated
 * the file as having no conversation at all.
 */
export class ClaudeCodeWriter implements NativeWriter {
  readonly target = "claude-code" as const;

  write(session: Session, options: WriteOptions = {}): ConversionBundle {
    const report = freshReport();
    const workspace = placement(session, options.workspacePath);
    const messages = dropThinking(planSession(session, report), report, isClaudeReasoning(session));
    countMapped(messages, report);

    const used = new Set<string>();
    let parentUuid: string | null = null;
    const lines = messages.map((message: PlanMessage, index) => {
      const own = message.turnIds.find((id) => !used.has(id));
      const uuid = own ?? derivedUuid(`${session.id}:claude-code:${index}`);
      used.add(uuid);
      const content = message.parts.map(claudeBlock);
      const common = {
        parentUuid,
        isSidechain: false,
        userType: "external",
        cwd: workspace.path,
        sessionId: session.id,
        version: TARGET_VERSIONS["claude-code"],
        gitBranch: workspace.branch ?? "",
      };
      parentUuid = uuid;
      if (message.role === "user") {
        return JSON.stringify({ ...common, type: "user", message: { role: "user", content }, uuid, timestamp: message.createdAt });
      }
      const endsInCall = message.parts.at(-1)?.kind === "tool_call";
      return JSON.stringify({
        ...common,
        type: "assistant",
        message: {
          id: `msg_memoar_${uuid.replaceAll("-", "")}`,
          type: "message",
          role: "assistant",
          model: message.model ?? session.models[0] ?? "unknown",
          content,
          stop_reason: endsInCall ? "tool_use" : "end_turn",
          stop_sequence: null,
          usage: { input_tokens: 0, output_tokens: 0 },
        },
        uuid,
        timestamp: message.createdAt,
      });
    });
    return {
      target: this.target,
      sessionId: session.id,
      files: [{
        path: `~/.claude/projects/${encodeClaudeWorkspace(workspace.path)}/${session.id}.jsonl`,
        mediaType: "application/x-ndjson",
        bytes: bytes(lines.length ? `${lines.join("\n")}\n` : ""),
      }],
      resumeCommand: `claude -r ${session.id}`,
      report,
    };
  }
}
