import type { Turn } from "../../canonical/src/generated.js";
import { incrementUuid, isRecord, mostlyJsonLines, stringValue, withModelAndTokens } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";
import { parserVersion } from "./versions.js";

/** The CLI's own markers, which record no content. */
const BOOKKEEPING_STEPS = new Set(["CHECKPOINT", "CONVERSATION_HISTORY"]);

export class AntigravityCliV1Parser implements VersionedParser {
  readonly source = "antigravity-cli";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    return this.parseJsonl(request);
  }

  /**
   * Reads the transcript log the CLI writes beside a session.
   *
   * It is a log of steps, not of messages: each line records something that
   * happened — the user's request, the planner's response with its reasoning
   * and tool calls, the output of a command or a file read, and the
   * checkpoints and history markers the CLI keeps for itself. Steps are not
   * written in order, so they are sorted by step_index before being read.
   */
  private parseJsonl(request: ParseRequest): ParseResult {
    const records = mostlyJsonLines(request.raw);
    if (!records?.length) {
      return { kind: "unknown", diagnostic: "antigravity-cli v1 requires a transcript log of JSON lines", raw: request.raw };
    }

    const steps = [...records]
      .filter((record) => stringValue(record, "type") !== null)
      .sort((left, right) => Number(left.step_index ?? 0) - Number(right.step_index ?? 0));

    const turns: Turn[] = [];
    let blockOrdinal = 0;
    const mint = () => incrementUuid(request.seed.id, 0x10000000 + (blockOrdinal += 1));

    const openAssistant = (createdAt: string): Turn => {
      const last = turns.at(-1);
      if (last && last.role === "assistant") return last;
      const turn = withModelAndTokens({
        id: incrementUuid(request.seed.id, turns.length + 1),
        ordinal: turns.length,
        parentId: turns.at(-1)?.id ?? null,
        role: "assistant" as const,
        createdAt,
        blocks: [],
      }, request.seed.models[0], request.seed.tokenTotals.input, request.seed.tokenTotals.output);
      turns.push(turn);
      return turn;
    };

    const systemTurn = (createdAt: string, block: Turn["blocks"][number]): Turn => ({
      id: incrementUuid(request.seed.id, turns.length + 1),
      ordinal: turns.length,
      parentId: turns.at(-1)?.id ?? null,
      role: "system",
      createdAt,
      blocks: [block],
    });
    /** Calls still waiting for their output, oldest first. */
    const pending: string[] = [];

    for (const step of steps) {
      const type = stringValue(step, "type");
      const createdAt = stringValue(step, "created_at") ?? request.seed.createdAt;
      const content = stringValue(step, "content");

      if (type === "USER_INPUT") {
        if (content === null || content.length === 0) continue;
        turns.push({
          id: incrementUuid(request.seed.id, turns.length + 1),
          ordinal: turns.length,
          parentId: turns.at(-1)?.id ?? null,
          role: "user",
          createdAt,
          blocks: [{ id: mint(), kind: "text", text: content }],
        });
        continue;
      }

      if (type === "PLANNER_RESPONSE") {
        const turn = openAssistant(createdAt);
        const thinking = stringValue(step, "thinking");
        if (thinking) turn.blocks.push({ id: mint(), kind: "thinking", text: thinking });
        const calls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        for (const call of calls) {
          if (!isRecord(call)) continue;
          // The block's id is minted before the call's, as it always was, so
          // ids archived by earlier parsers stay where they were.
          const id = mint();
          const callId = stringValue(call, "id") ?? mint();
          pending.push(callId);
          turn.blocks.push({
            id,
            kind: "tool_call",
            name: stringValue(call, "name") ?? "tool",
            callId,
            data: isRecord(call.args) ? call.args : {},
          });
        }
        if (content) turn.blocks.push({ id: mint(), kind: "text", text: content });
        continue;
      }

      const error = stringValue(step, "error");
      if (type === "SYSTEM_MESSAGE") {
        if (content) turns.push(systemTurn(createdAt, { id: mint(), kind: "system", name: type, text: content }));
        continue;
      }
      if (type === "ERROR_MESSAGE") {
        if (error ?? content) openAssistant(createdAt).blocks.push({ id: mint(), kind: "error", name: type, text: (error ?? content)! });
        continue;
      }
      if (BOOKKEEPING_STEPS.has(type ?? "")) continue;
      if ((content === null || content.length === 0) && !error) continue;

      // Step types that report what a tool did. Their output belongs to the
      // assistant turn that asked for it.
      //
      // The CLI on the machine this was checked on writes every tool's output
      // as `GENERIC` with `source: "MODEL"`: 343 such steps across 655
      // transcripts, and not one of the four named types below. Dropping them
      // kept the model's tool calls and lost everything the tools answered.
      // A tool's error sits in `error`, beside or instead of its output. The
      // log carries no call id, so a result answers the oldest call still
      // waiting for one.
      const isToolOutput = type === "GENERIC" && stringValue(step, "source") === "MODEL";
      if (isToolOutput || type === "VIEW_FILE" || type === "RUN_COMMAND" || type === "EDIT_FILE" || type === "SEARCH") {
        const callId = pending.shift();
        openAssistant(createdAt).blocks.push({
          id: mint(),
          kind: "tool_result",
          ...(type !== "GENERIC" && type ? { name: type } : {}),
          ...(callId ? { callId } : {}),
          text: content || error!,
          ...(error ? { data: { isError: true, ...(content ? { error } : {}) } } : {}),
        });
        continue;
      }
      // A step type added since this was written, or a GENERIC step the model
      // did not produce: kept as a system note in its place, not dropped.
      turns.push(systemTurn(createdAt, {
        id: mint(),
        kind: error && !content ? "error" : "system",
        name: type ?? "step",
        text: content || error!,
        ...(content && error ? { data: { error } } : {}),
      }));
    }

    const withOrdinals = turns
      .filter((turn) => turn.blocks.length > 0)
      .map((turn, ordinal) => ({ ...turn, ordinal }));
    if (withOrdinals.length === 0) {
      return { kind: "unknown", diagnostic: "antigravity-cli v1 transcript contained no readable steps", raw: request.raw };
    }
    return { kind: "parsed", parser: parserVersion(this.source), sessions: [{ ...request.seed, turns: withOrdinals }] };
  }
}
