import { chatEnvelopes, chatEnvelopesFromLog, isCopilotEventLog, isSqliteBytes, messageArray } from "../../libs/parsers/src/index.js";

/**
 * Which parser version an upload belongs to, when the client named only the tool.
 *
 * The capture agent sends `x-memoar-source: <tool>` with no version, so every
 * artifact it uploads goes through here. Each branch reads the bytes the way
 * the parser it chooses will read them: by parsing the first lines and looking
 * at their fields, not by searching for a substring.
 *
 * A substring is how this went wrong. Antigravity was recognised by `"parts"`
 * in the first 2 KiB, a field the CLI has never written: a real transcript line
 * is `{step_index, source, type, status, created_at, content}`. All 655
 * Antigravity transcripts on the dev archive were refused as
 * `antigravity-cli@unknown`, and the fixture tests passed throughout because
 * they named the version themselves. `format-detection.test.ts` now runs every
 * fixture through here with only the header the agent sends.
 */

/** Native stores whose schema was confirmed against the tool itself. */
const SQLITE_SOURCE_VERSIONS: Readonly<Record<string, string>> = {
  cursor: "v3",
  goose: "v1",
  crush: "v1",
  zed: "v1",
  opencode: "v1",
  copilot: "v1",
  // `kilo.db`, opencode's schema, since Kilo Code was rebuilt on opencode.
  kilo: "v1",
};

const SOURCE_ALIASES: Readonly<Record<string, { source: string; version: string }>> = {
  canonical: { source: "canonical-bundle", version: "v1" },
  "canonical-bundle": { source: "canonical-bundle", version: "v1" },
  cass: { source: "cass-export", version: "2026-08" },
  "cass-export": { source: "cass-export", version: "2026-08" },
  "chatgpt-export": { source: "chatgpt-export", version: "2026-08" },
};

/**
 * How far into an artifact the sniff reads, and how many lines it will judge.
 *
 * A Claude Code transcript opens with whatever bookkeeping the session wrote
 * first, and `attachment` records run to kilobytes each, so the first message
 * is not reliably inside 2 KiB. One 71 MB transcript cleared it by 1,735 bytes.
 */
const SNIFF_BYTES = 64 * 1024;
const SNIFF_LINES = 64;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The JSON objects among the first lines of the artifact.
 *
 * A line cut off by the sniff window, or broken in the file, is skipped rather
 * than ending the read: one bad line is not a reason to call a transcript
 * something else.
 */
function leadingRecords(bytes: Uint8Array): JsonRecord[] {
  const prefix = Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString("utf8");
  const records: JsonRecord[] = [];
  for (const line of prefix.split(/\r?\n/u).slice(0, SNIFF_LINES)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(trimmed);
      if (isRecord(value)) records.push(value);
    } catch {
      // Not a whole line of JSON.
    }
  }
  return records;
}

/** The artifact read as one JSON document, or undefined when it is not one. */
function wholeJson(bytes: Uint8Array): unknown {
  const first = Buffer.from(bytes.subarray(0, 64)).toString("utf8").trimStart()[0];
  if (first !== "{" && first !== "[") return undefined;
  try {
    return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Deliberately generous: the other outcome refuses the artifact with "no
 * parser for claude-code@unknown" and says nothing about what was in it, while
 * the parser's own refusal names the line it failed on.
 */
function isClaudeCode(records: readonly JsonRecord[], bytes: Uint8Array): boolean {
  if (Buffer.from(bytes.subarray(0, SNIFF_BYTES)).toString("utf8").includes('"parentUuid"')) return true;
  // Claude Desktop's local agent mode writes `uuid` and `message` with no
  // `parentUuid`, so the substring above can never match one.
  return records.some((record) => typeof record.uuid === "string" && isRecord(record.message));
}

function isCodexRollout(records: readonly JsonRecord[]): boolean {
  return records.some((record) => record.type === "session_meta" && isRecord(record.payload));
}

/** A step of the transcript log: `{step_index, source, type, status, created_at, content}`. */
function isAntigravityTranscript(records: readonly JsonRecord[]): boolean {
  return records.some((record) => typeof record.step_index === "number" && typeof record.type === "string");
}

function isCursorEnvelope(document: unknown): boolean {
  return isRecord(document) && document.source === "cursor" && isRecord(document.session);
}

/**
 * The first line read whole, however long it is.
 *
 * A VS Code chat log opens with a `kind:0` snapshot of the entire panel, and
 * after VS Code compacts the log that one line is the whole conversation, far
 * past the sniff window. Cut off there, it parsed as nothing and the panel was
 * refused as `copilot@unknown`.
 */
function firstLine(bytes: Uint8Array): JsonRecord[] {
  const end = Buffer.from(bytes).indexOf(0x0a);
  const line = Buffer.from(bytes.subarray(0, end === -1 ? bytes.length : end)).toString("utf8").trim();
  if (!line.startsWith("{")) return [];
  try {
    const value: unknown = JSON.parse(line);
    return isRecord(value) ? [value] : [];
  } catch {
    return [];
  }
}

/** A VS Code panel in any layout, or the CLI's `events.jsonl`. */
function isCopilotChat(document: unknown, bytes: Uint8Array): boolean {
  const records = leadingRecords(bytes);
  return chatEnvelopes(document) !== null
    || chatEnvelopesFromLog(records) !== null
    || isCopilotEventLog(records)
    || chatEnvelopesFromLog(firstLine(bytes)) !== null;
}

/** Roo and Kilo: an `api_conversation_history.json` array of `{role, content}`. */
function isTaskHistory(document: unknown): boolean {
  const messages = messageArray(document);
  return messages !== null && messages.some((message) => isRecord(message) && typeof message.role === "string");
}

type Sniffer = (bytes: Uint8Array) => string | null;

const lines = (test: (records: readonly JsonRecord[], bytes: Uint8Array) => boolean, version: string): Sniffer =>
  (bytes) => (test(leadingRecords(bytes), bytes) ? version : null);

/** Every source with a text format, and the version its bytes prove. */
const TEXT_SNIFFERS: Readonly<Record<string, Sniffer>> = {
  "claude-code": lines(isClaudeCode, "v1"),
  codex: lines(isCodexRollout, "rollout-v1"),
  "antigravity-cli": lines(isAntigravityTranscript, "v1"),
  cursor: (bytes) => (isCursorEnvelope(wholeJson(bytes)) ? "v3" : null),
  copilot: (bytes) => (isCopilotChat(wholeJson(bytes), bytes) ? "v1" : null),
  kilo: (bytes) => (isTaskHistory(wholeJson(bytes)) ? "v1" : null),
  roo: (bytes) => (isTaskHistory(wholeJson(bytes)) ? "v1" : null),
};

export class FormatDetector {
  detect(sourceHeader: string, bytes: Uint8Array): { source: string; version: string } {
    const [source, statedVersion] = sourceHeader.split("@", 2);
    if (statedVersion) return { source: source!, version: statedVersion };
    if (!source) return { source: "unknown", version: "unknown" };
    const alias = SOURCE_ALIASES[source];
    if (alias) return alias;
    const sqliteVersion = SQLITE_SOURCE_VERSIONS[source];
    if (sqliteVersion && isSqliteBytes(bytes)) return { source, version: sqliteVersion };
    const version = TEXT_SNIFFERS[source]?.(bytes) ?? null;
    return { source, version: version ?? "unknown" };
  }
}
