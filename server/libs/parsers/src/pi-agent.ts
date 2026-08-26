import { conversationToSession } from "./conversation-list.js";
import { isRecord, parseJsonLines, stringValue } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

/**
 * pi-agent writes an append-only event log rather than a conversation document,
 * so the session is reconstructed by replaying it: `session_start` carries the
 * identity and `message` events carry the turns, each with its payload of parts.
 *
 * Events other than those two are ignored rather than treated as an error — an
 * append-only log is expected to grow new event types, and a reader that fails
 * on the first one it does not recognise would lose whole transcripts to a
 * routine upgrade.
 */
export class PiAgentV1Parser implements VersionedParser {
  readonly source = "pi-agent";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    const lines = parseJsonLines(request.raw);
    if (!lines) {
      return { kind: "unknown", diagnostic: "pi-agent v1 requires JSON lines", raw: request.raw };
    }
    try {
      let nativeSessionId: string | null = null;
      let title: string | null = null;
      const messages: unknown[] = [];

      for (const line of lines) {
        const event = stringValue(line, "event");
        if (event === "session_start") {
          nativeSessionId = stringValue(line, "sessionId");
          title = stringValue(line, "title");
          continue;
        }
        if (event !== "message") continue;
        const payload = isRecord(line.payload) ? line.payload : {};
        // The parts live one level down; everything else the turn needs is on
        // the event itself.
        messages.push({ ...line, parts: payload.parts });
      }

      if (messages.length === 0) {
        return { kind: "unknown", diagnostic: "pi-agent v1 log contained no message events", raw: request.raw };
      }

      const session = conversationToSession(
        { id: nativeSessionId, title, messages },
        0,
        request.seed,
        "pi-agent-1",
      );
      return { kind: "parsed", parser: "pi-agent:v1:0.2.0", sessions: [session] };
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `pi-agent v1 decode failed: ${error instanceof Error ? error.message : String(error)}`,
        raw: request.raw,
      };
    }
  }
}
