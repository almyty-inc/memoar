import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ParserRegistry, type SessionSeed } from "../../libs/parsers/src/index.js";
import { FormatDetector } from "../../src/ingest/format-detection.js";

/** The seed the ingest pipeline hands a parser: it knows no model. */
export const SEED: SessionSeed = {
  id: "0191cafe-0000-7000-8000-000000000001",
  source: { vendor: "fixture", tool: "fixture", version: "v1", machineId: "0191cafe-0000-7000-8000-000000000002" },
  workspace: { path: "/workspace/seeded" },
  createdAt: "2026-08-01T00:00:00.000Z",
  updatedAt: "2026-08-01T00:00:00.000Z",
  title: "seeded",
  models: [],
  tokenTotals: { input: 0, output: 0 },
  provenance: [{ kind: "native", capturedAt: "2026-08-01T00:00:00.000Z" }],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-000000000003" },
};

/** Detects the version from the bare tool name, as an agent upload does, then parses. */
export function ingest(source: string, raw: Uint8Array) {
  const format = new FormatDetector().detect(source, raw);
  return { format, result: new ParserRegistry().parse({ ...format, raw, seed: SEED }) };
}

/** A SQLite database built from DDL and rows, returned as its bytes. */
export function buildDatabase(schema: string, rows: [string, unknown[]][]): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "memoar-store-test-"));
  const path = join(directory, "native.sqlite3");
  try {
    const database = new DatabaseSync(path);
    try {
      database.exec(schema);
      for (const [table, values] of rows) {
        database
          .prepare(`INSERT INTO ${table} VALUES (${values.map(() => "?").join(",")})`)
          .run(...(values as (string | number | null | Uint8Array)[]));
      }
    } finally {
      database.close();
    }
    return readFileSync(path);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function jsonLines(records: readonly unknown[]): Uint8Array {
  return Buffer.from(records.map((record) => JSON.stringify(record)).join("\n") + "\n");
}
