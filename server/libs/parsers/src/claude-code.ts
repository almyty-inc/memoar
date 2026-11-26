import type { Turn } from "../../canonical/src/generated.js";
import { claudeCodeIdentity } from "./claude-code-identity.js";
import { claudeCodeWorkspace, ClaudeCodeUsage } from "./claude-code-usage.js";
import { parseBlock } from "./blocks.js";
import { recordTurn } from "./claude-code-records.js";
import { incrementUuid, isRecord, mapParent, MIN_JSON_SHARE, readJsonLines, stringValue, turnId, withModelAndTokens, type JsonLinesReport } from "./common.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";
import { parserVersion } from "./versions.js";

/** What the artifact turned out to be, in the words of what was actually read. */
function describeRefusal(read: JsonLinesReport): string {
  if (read.total === 0) return "claude-code v1 found no lines at all: the artifact is empty";
  const howMuch = `read ${read.total - read.invalid} of ${read.total} lines as JSON`;
  const where = read.firstInvalid
    ? `; first failure at line ${read.firstInvalid.line} (${read.firstInvalid.reason}), which begins: ${read.firstInvalid.sample}`
    : "";
  if (read.binary) return `claude-code v1 expects text JSON lines but the bytes are binary (they contain NUL); ${howMuch}${where}`;
  return `claude-code v1 ${howMuch}${where}`;
}

/** The line shapes present, so "no messages" says what the file held instead. */
function describeTypes(records: readonly Record<string, unknown>[]): string {
  const seen = new Map<string, number>();
  for (const record of records) {
    const type = stringValue(record, "type") ?? "(no type field)";
    seen.set(type, (seen.get(type) ?? 0) + 1);
  }
  const ranked = [...seen].sort((left, right) => right[1] - left[1]).slice(0, 6);
  return ranked.map(([type, count]) => `${type}×${count}`).join(", ");
}

export class ClaudeCodeV1Parser implements VersionedParser {
  readonly source = "claude-code";
  readonly versions = ["v1"] as const;

  parse(request: ParseRequest): ParseResult {
    // Line by line, because one corrupt line is not a corrupt transcript. A
    // redaction pass that ate the backslash off an escaped quote left 16 broken
    // lines in a 26,462-line session; reading all-or-nothing threw away the
    // other 26,445 and reported only "requires JSON lines".
    const read = readJsonLines(request.raw);
    if (read.records.length === 0 || read.total - read.invalid < read.total * MIN_JSON_SHARE) {
      return { kind: "unknown", diagnostic: describeRefusal(read), raw: request.raw };
    }
    // A real transcript interleaves conversation with bookkeeping Claude Code
    // keeps for itself: attachments, file-history snapshots and deltas, mode
    // and permission changes, generated titles, queued operations. Requiring
    // uuid and message on every line refused the whole file over lines that
    // were never meant to be messages.
    const records = read.records.filter((record) => stringValue(record, "uuid") !== null && isRecord(record.message));
    if (records.length === 0) {
      return {
        kind: "unknown",
        raw: request.raw,
        diagnostic: `claude-code v1 read ${read.records.length} of ${read.total} lines as JSON objects but none carried both "uuid" and "message"; saw ${describeTypes(read.records)}`,
      };
    }
    // Blocks are numbered once for the whole session. Deriving them from
    // neighbouring record uuids produced 802 duplicate ids in a 4,369-turn
    // transcript, because adjacent uuids are close enough that the ranges met.
    let blockOrdinal = 0;
    const mintBlock = () => incrementUuid(request.seed.id, 0x8000000 + (blockOrdinal += 1));

    /*
      A uuid a transcript uses twice must still become two turns.

      The turn id is derived from the record's uuid, so two records carrying one
      uuid produced two turns with one id — and their blocks then collided on
      the unique key over (tenant, turn, ordinal), failing the whole save.
      Seventeen artifacts in the dev archive, 200 MB, died exactly there:
      `duplicate key value violates unique constraint
      "content_blocks_tenantId_turnId_ordinal_key"`, losing every turn in the
      session over a repeat somewhere inside it.

      Repeats are not corruption. A record can be rewritten as a conversation
      goes on, and subagent transcripts — which are collected now, and were not
      before — reuse ids from the session that spawned them. So the later
      occurrence is given a distinct id rather than dropped: losing a turn is
      the worse answer, and the whole point of reading these files is to keep
      what is in them.

      The first occurrence keeps the derived id, so a `parentUuid` naming it
      still resolves to it, which is the right reading — a parent link means the
      original.
    */
    const usedTurnIds = new Set<string>();
    const uniqueId = (nativeId: string): string => {
      // Claude Code writes real uuids, so this normally returns exactly what
      // the transcript said. It is here for the transcript that does not.
      const derived = turnId(nativeId, request.seed.id);
      let id = derived;
      for (let attempt = 1; usedTurnIds.has(id); attempt += 1) id = incrementUuid(derived, attempt);
      usedTurnIds.add(id);
      return id;
    };
    // Blocks of the lines that are not messages are numbered in a range of
    // their own, so the ids of message blocks are the ones earlier parsers gave
    // them, and a redaction mask anchored on one still finds it after a re-parse.
    let recordOrdinal = 0;
    const mintRecordBlock = () => incrementUuid(request.seed.id, 0x9000000 + (recordOrdinal += 1));
    const turns: Turn[] = [];
    const usage = new ClaudeCodeUsage(records);
    for (const [index, record] of read.records.entries()) {
      const isMessage = stringValue(record, "uuid") !== null && isRecord(record.message);
      if (isMessage) {
        turns.push(this.messageTurn(record, uniqueId(stringValue(record, "uuid")!), turns.length, mintBlock, request, usage));
        continue;
      }
      const extra = recordTurn(record, mintRecordBlock);
      if (!extra) continue;
      const leaf = stringValue(record, "leafUuid");
      const nativeId = stringValue(record, "uuid") ?? `summary:${leaf ?? index}`;
      turns.push({
        id: uniqueId(nativeId),
        ordinal: turns.length,
        parentId: mapParent(stringValue(record, "parentUuid") ?? leaf, request.seed.id),
        role: extra.role,
        createdAt: stringValue(record, "timestamp") ?? request.seed.createdAt,
        blocks: extra.blocks,
        ext: extra.ext,
      });
    }
    // A transcript names its own conversation, its working directory and its
    // branch. Without the session id the archive identified a capture by the
    // hash of the file, so the same conversation captured again after it grew
    // looked like a different session — and then failed to save, because its
    // turns already belonged to the first one. An ongoing session stopped being
    // archived after its first capture.
    //
    // A subagent transcript names its parent's session id instead of its own.
    // See `claudeCodeIdentity`. Read from the first message line, as before
    // non-message lines became turns.
    const first = records[0]!;
    const { nativeSessionId, parent } = claudeCodeIdentity(first);
    const { cwd, branch } = claudeCodeWorkspace(first, read.records);
    // The title Claude Code shows for the conversation, a person's rename
    // winning over the generated one. The last line of each kind is current.
    const titles = read.records.flatMap((record) => {
      const value = stringValue(record, "customTitle") ?? stringValue(record, "aiTitle");
      return value && (record.type === "custom-title" || record.type === "ai-title") ? [{ custom: record.type === "custom-title", value }] : [];
    });
    const title = (titles.findLast((entry) => entry.custom) ?? titles.at(-1))?.value;
    return {
      kind: "parsed",
      parser: parserVersion(this.source),
      sessions: [{
        ...request.seed,
        ...(nativeSessionId ? { source: { ...request.seed.source, nativeSessionId } } : {}),
        ...(title ? { title } : {}),
        ...(parent ? { ext: { ...request.seed.ext, claudeCode: { parentNativeSessionId: parent.nativeSessionId, agentId: parent.agentId } } } : {}),
        ...(cwd || branch ? {
          workspace: {
            ...request.seed.workspace,
            ...(cwd ? { path: cwd } : {}),
            ...(branch ? { branch } : {}),
          },
        } : {}),
        turns,
      }],
    };
  }

  private messageTurn(record: Record<string, unknown>, id: string, ordinal: number, mintBlock: () => string, request: ParseRequest, usage: ClaudeCodeUsage): Turn {
    const message = record.message as Record<string, unknown>;
    const roleValue = stringValue(message, "role") ?? stringValue(record, "type") ?? "user";
    const role = roleValue === "assistant" || roleValue === "tool" || roleValue === "system" ? roleValue : "user";
    const content = message.content;
    const rawBlocks = Array.isArray(content) ? content : [content];
    const blocks = rawBlocks.map((block) => parseBlock(block, mintBlock())).filter((block) => block !== null);
    return withModelAndTokens({
      id,
      ordinal,
      // Through the same derivation as the id, or a remapped turn would be
      // pointed at by a parent link that still names the original.
      parentId: mapParent(stringValue(record, "parentUuid"), request.seed.id),
      role,
      createdAt: stringValue(record, "timestamp") ?? request.seed.createdAt,
      blocks,
    }, typeof message.model === "string" ? message.model : request.seed.models[0], usage.claim(message));
  }
}
