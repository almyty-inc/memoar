import { OpencodeV1Parser } from "./opencode.js";
import { isSqliteBytes } from "./sqlite.js";
import { TaskHistoryParser } from "./task-history.js";
import type { ParseRequest, ParseResult, VersionedParser } from "./types.js";

/**
 * Kilo Code, in both of the forms it has stored a conversation in.
 *
 * The VS Code extension it started as is a Cline fork and writes
 * `tasks/<id>/api_conversation_history.json`, which Roo Code writes too. Kilo
 * was then rebuilt on opencode, and its CLI and the extension built on that
 * CLI keep sessions in `kilo.db`, opencode's SQLite schema
 * (`Kilo-Org/kilocode`, `packages/core/src/session/sql.ts`). The bytes say
 * which one an artifact is, so both are one source with one version.
 */
export class KiloParser implements VersionedParser {
  readonly source = "kilo";
  readonly versions = ["v1"] as const;
  private readonly database = new OpencodeV1Parser("kilo");
  private readonly tasks = new TaskHistoryParser("kilo");

  parse(request: ParseRequest): ParseResult {
    return isSqliteBytes(request.raw) ? this.database.parse(request) : this.tasks.parse(request);
  }
}
