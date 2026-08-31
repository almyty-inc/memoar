import { TaskHistoryParser } from "./task-history.js";
import { AntigravityCliV1Parser } from "./antigravity-cli.js";
import { CanonicalBundleParser } from "./canonical-bundle.js";
import { CassExportParser } from "./cass-export.js";
import { ChatgptExportParser } from "./chatgpt-export.js";
import { ClaudeCodeV1Parser } from "./claude-code.js";
import { CodexRolloutV1Parser } from "./codex.js";
import { CopilotV1Parser } from "./copilot.js";
import { CrushV1Parser } from "./crush.js";
import { CursorV3Parser } from "./cursor.js";
import { GooseV1Parser } from "./goose.js";
import { OpencodeV1Parser } from "./opencode.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";
import { ZedV1Parser } from "./zed.js";

export * from "./types.js";
export { isSqliteBytes } from "./sqlite.js";

export class ParserRegistry {
  constructor(private readonly parsers: readonly VersionedParser[] = [
    new ClaudeCodeV1Parser(),
    new CodexRolloutV1Parser(),
    new AntigravityCliV1Parser(),
    new CursorV3Parser(),
    new GooseV1Parser(),
    new CrushV1Parser(),
    new ZedV1Parser(),
    new CanonicalBundleParser(),
    new CassExportParser(),
    new ChatgptExportParser(),
    new OpencodeV1Parser(),
    new CopilotV1Parser(),
    // Kilo and Roo share the task format they both inherited.
    ...["kilo", "roo"].map((source) => new TaskHistoryParser(source)),
  ]) {}

  parse(request: ParseRequest): ParseResult {
    const parser = this.parsers.find((candidate) => candidate.source === request.source && candidate.versions.includes(request.version));
    if (!parser) {
      return {
        kind: "unknown",
        diagnostic: `No parser for ${request.source}@${request.version}. Raw bytes were preserved.`,
        raw: request.raw,
      };
    }
    try {
      return parser.parse(request);
    } catch (error) {
      return {
        kind: "unknown",
        diagnostic: `Parser ${request.source}@${request.version} threw: ${error instanceof Error ? error.message : String(error)}. Raw bytes were preserved.`,
        raw: request.raw,
      };
    }
  }

  capabilities(): Record<string, readonly string[]> {
    return Object.fromEntries(this.parsers.map((parser) => [parser.source, parser.versions]));
  }
}
