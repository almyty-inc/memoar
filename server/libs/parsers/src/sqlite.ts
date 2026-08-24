import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

const SQLITE_MAGIC = Buffer.concat([Buffer.from("SQLite format 3", "latin1"), Buffer.from([0])]);

export function isSqliteBytes(raw: Uint8Array): boolean {
  return raw.byteLength >= 16 && Buffer.from(raw.subarray(0, 16)).equals(SQLITE_MAGIC);
}

export function withSqlite<T>(raw: Uint8Array, read: (database: DatabaseSync) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "memoar-parse-"));
  const path = join(directory, "artifact.sqlite3");
  try {
    writeFileSync(path, raw);
    const database = new DatabaseSync(path, { readOnly: true });
    try {
      const row = database.prepare("PRAGMA integrity_check").get() as Record<string, unknown> | undefined;
      const integrity = row ? Object.values(row)[0] : undefined;
      if (integrity !== "ok") throw new Error(`sqlite integrity check failed: ${String(integrity)}`);
      return read(database);
    } finally {
      database.close();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
