import type { Session } from "../../libs/canonical/src/generated.js";
import { antigravityDatabaseBytes, type AntigravityStep } from "./antigravity-database.js";
import { countMapped, dropThinking, placement, planSession, type PlanPart } from "./native-plan.js";
import { freshReport, type ConversionBundle, type ConversionReport, type NativeWriter, type WriteOptions } from "./types.js";

const TOOL_REASON = "Antigravity tool steps have no published format; the call is carried as text in the response";

/**
 * A part as the text of a step.
 *
 * Antigravity records each tool as its own step type with a payload shaped per
 * tool, and that format is not published. A call and its result are written
 * into the planner response as attributed text, so the model still sees what
 * was run and what came back, and the report says so.
 */
function partText(part: PlanPart, report: ConversionReport): string {
  switch (part.kind) {
    case "text":
      return part.text;
    case "tool_call":
      report.degraded.push({ turnId: part.turnId, blockId: part.blockId, kind: "tool_call", reason: TOOL_REASON });
      return `[Memoar tool_call ${part.name} ${part.callId}] ${part.rawArguments ?? JSON.stringify(part.input)}`;
    case "tool_result":
      report.degraded.push({ turnId: part.turnId, blockId: part.blockId, kind: "tool_result", reason: TOOL_REASON });
      return `[Memoar tool_result ${part.callId}${part.isError ? " error" : ""}] ${part.text}`;
    case "document":
      if (part.text !== undefined) return part.title ? `${part.title}\n${part.text}` : part.text;
    // falls through: a binary document is carried no further than an image
    case "image":
      report.degraded.push({ turnId: part.turnId, blockId: part.blockId, kind: "attachment", reason: "Attachments are not carried into Antigravity steps" });
      return `[Memoar attachment] ${part.kind === "image" ? part.mediaType : part.title ?? "document"}`;
    case "thinking":
      return "";
  }
}

/**
 * Writes the conversation database `agy --conversation <id>` resumes.
 *
 * Thinking is dropped: Antigravity keeps its own reasoning in fields whose
 * format is not published, and another vendor's reasoning is not portable.
 */
export class AntigravityCliWriter implements NativeWriter {
  readonly target = "antigravity-cli" as const;

  write(session: Session, options: WriteOptions = {}): ConversionBundle {
    const report = freshReport();
    const workspace = placement(session, options.workspacePath);
    const messages = dropThinking(planSession(session, report), report, () => false);

    const steps: AntigravityStep[] = [];
    for (const message of messages) {
      const results: PlanPart[] = message.role === "user" ? message.parts.filter((part) => part.kind === "tool_result") : [];
      const rest = message.parts.filter((part) => !results.includes(part));
      const previous = steps.at(-1);
      // A tool result belongs to the response that made the call.
      if (results.length && previous?.kind === "assistant") {
        previous.text = [previous.text, ...results.map((part) => partText(part, report))].join("\n\n");
      } else if (results.length) {
        rest.unshift(...results);
      }
      const text = rest.map((part) => partText(part, report)).filter(Boolean).join("\n\n");
      if (!text) continue;
      const last = steps.at(-1);
      if (last?.kind === message.role) last.text = `${last.text}\n\n${text}`;
      else steps.push({ kind: message.role, text, createdAt: message.createdAt });
    }
    countMapped(messages, report);

    return {
      target: this.target,
      sessionId: session.id,
      files: [{
        path: `~/.gemini/antigravity-cli/conversations/${session.id}.db`,
        mediaType: "application/vnd.sqlite3",
        bytes: antigravityDatabaseBytes({ id: session.id, workspacePath: workspace.path, createdAt: session.createdAt, steps }),
      }],
      resumeCommand: `agy --conversation ${session.id}`,
      report,
    };
  }
}
