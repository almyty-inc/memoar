import type { Session } from "../../libs/canonical/src/generated.js";
import { countMapped, dropThinking, placement, planSession, type PlanMessage, type PlanPart } from "./native-plan.js";
import { TARGET_VERSIONS } from "./target-versions.js";
import { bytes, freshReport, type ConversionBundle, type ConversionReport, type NativeWriter, type WriteOptions } from "./types.js";

type Item = Record<string, unknown>;

function imageUrl(part: Extract<PlanPart, { kind: "image" }>): string {
  return part.base64 ? `data:${part.mediaType};base64,${part.base64}` : part.url ?? "";
}

/**
 * One plan message as Responses API items, which is what a rollout replays.
 *
 * Text and images of a message stay together in one `message` item. A call
 * and its output are items of their own, in order, so a text that followed a
 * call in the source still follows it here.
 */
function items(message: PlanMessage, report: ConversionReport): Item[] {
  const out: Item[] = [];
  let content: Item[] = [];
  const flush = () => {
    if (content.length) out.push({ type: "message", role: message.role, content });
    content = [];
  };
  const textType = message.role === "assistant" ? "output_text" : "input_text";
  for (const part of message.parts) {
    switch (part.kind) {
      case "text":
        content.push({ type: textType, text: part.text });
        break;
      case "image":
        if (message.role === "user") content.push({ type: "input_image", image_url: imageUrl(part) });
        else {
          report.degraded.push({ turnId: part.turnId, blockId: part.blockId, kind: "attachment", reason: "Codex carries images in user messages only" });
          content.push({ type: textType, text: `[Memoar attachment] ${part.mediaType} ${part.url ?? "inline image"}` });
        }
        break;
      case "document":
        if (part.text !== undefined) {
          content.push({ type: textType, text: part.title ? `${part.title}\n${part.text}` : part.text });
          break;
        }
        report.degraded.push({ turnId: part.turnId, blockId: part.blockId, kind: "attachment", reason: "Codex has no document input" });
        content.push({ type: textType, text: `[Memoar attachment] ${part.title ?? "document"}` });
        break;
      case "thinking":
        flush();
        out.push({
          type: "reasoning",
          summary: part.text ? [{ type: "summary_text", text: part.text }] : [],
          encrypted_content: part.data.encrypted,
        });
        break;
      case "tool_call":
        flush();
        out.push({ type: "function_call", name: part.name, arguments: part.rawArguments ?? JSON.stringify(part.input), call_id: part.callId });
        break;
      case "tool_result":
        flush();
        out.push({ type: "function_call_output", call_id: part.callId, output: part.text || JSON.stringify(part.nativeContent ?? "") });
        break;
    }
  }
  flush();
  return out;
}

/**
 * Only Codex's own encrypted reasoning goes back to Codex. Anything else is
 * plain text the Responses API would not accept as a reasoning item.
 */
function isCodexReasoning(session: Session) {
  return (part: { data: Record<string, unknown> }) => session.source.tool === "codex" && typeof part.data.encrypted === "string";
}

/**
 * Writes the rollout `codex resume <id>` and `codex exec resume <id>` replay.
 *
 * A `session_meta` line names the session and its working directory, then each
 * message is a `response_item` holding a Responses API item. The previous
 * writer put canonical blocks under `response_item` with no item type, which
 * Codex skipped as unknown, so the resumed thread was empty.
 */
export class CodexWriter implements NativeWriter {
  readonly target = "codex" as const;

  write(session: Session, options: WriteOptions = {}): ConversionBundle {
    const report = freshReport();
    const workspace = placement(session, options.workspacePath);
    const messages = dropThinking(planSession(session, report), report, isCodexReasoning(session));
    const payloads = messages.map((message) => ({ message, items: items(message, report) }));
    countMapped(messages, report);

    const lines = [JSON.stringify({
      timestamp: session.createdAt,
      type: "session_meta",
      payload: {
        id: session.id,
        timestamp: session.createdAt,
        cwd: workspace.path,
        originator: "memoar",
        cli_version: TARGET_VERSIONS.codex,
        source: "cli",
        model_provider: "openai",
        ...(workspace.branch ? { git: { branch: workspace.branch } } : {}),
      },
    })];
    for (const { message, items: converted } of payloads) {
      for (const payload of converted) {
        lines.push(JSON.stringify({ timestamp: message.createdAt, type: "response_item", payload }));
      }
    }
    const date = session.createdAt.slice(0, 10).replaceAll("-", "/");
    const stamp = session.createdAt.slice(0, 19).replaceAll(":", "-");
    return {
      target: this.target,
      sessionId: session.id,
      files: [{
        path: `~/.codex/sessions/${date}/rollout-${stamp}-${session.id}.jsonl`,
        mediaType: "application/x-ndjson",
        bytes: bytes(`${lines.join("\n")}\n`),
      }],
      resumeCommand: `codex resume ${session.id}`,
      report,
    };
  }
}
