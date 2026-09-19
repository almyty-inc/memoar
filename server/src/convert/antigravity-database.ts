import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CONTRACT_VERSION } from "../../libs/canonical/src/generated.js";

/**
 * The brain database Antigravity actually opens.
 *
 * This half used to invent its own schema — `conversations` and `messages` —
 * and the materializer validates the observed one
 * (`agent/crates/memoar-materializer/src/antigravity.rs`), which begins with
 * `trajectory_meta`. So every `antigravity-cli` conversion this server built
 * was refused on the user's machine with
 * `Antigravity database lacks trajectory_meta: no such table: trajectory_meta`,
 * and neither side's tests could see it: the server asserted its own tables and
 * the materializer built its own database to test against.
 *
 * The turns are not in here. They are in `transcript.jsonl`, which is the file
 * of the three that carries the conversation; this database carries the
 * trajectory identity Antigravity indexes by, and a `memoar_conversion` row
 * that records where the bytes came from.
 */
export interface AntigravitySeed {
  id: string;
  workspacePath: string;
  title: string;
  createdAt: string;
  updatedAt: string;
}

const SCHEMA = `
  PRAGMA user_version = 1;
  PRAGMA journal_mode = DELETE;
  CREATE TABLE trajectory_meta (
    trajectory_id TEXT PRIMARY KEY,
    cascade_id TEXT,
    trajectory_type INTEGER,
    source INTEGER
  );
  CREATE TABLE steps (
    idx INTEGER PRIMARY KEY,
    step_type INTEGER DEFAULT 0,
    status INTEGER DEFAULT 0,
    has_subtrajectory NUMERIC DEFAULT 0,
    metadata BLOB,
    error_details BLOB,
    permissions BLOB,
    task_details BLOB,
    render_info BLOB,
    step_payload BLOB,
    step_format INTEGER DEFAULT 0
  );
  CREATE INDEX idx_steps_status ON steps(status);
  CREATE INDEX idx_steps_step_type ON steps(step_type);
  CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER);
  CREATE TABLE executor_metadata (idx INTEGER PRIMARY KEY, data BLOB);
  CREATE TABLE parent_references (idx INTEGER PRIMARY KEY, data BLOB);
  CREATE TABLE trajectory_metadata_blob (
    id TEXT PRIMARY KEY DEFAULT 'main', data BLOB
  );
  CREATE TABLE battle_mode_infos (idx INTEGER PRIMARY KEY, data BLOB);
  CREATE TABLE memoar_conversion (
    id TEXT PRIMARY KEY,
    workspace_path TEXT,
    title TEXT,
    contract_version TEXT NOT NULL,
    source_seed BLOB NOT NULL
  );
`;

export function antigravityDatabaseBytes(seed: AntigravitySeed): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "memoar-antigravity-"));
  const path = join(directory, `${seed.id}.db`);
  const database = new DatabaseSync(path);
  let closed = false;
  try {
    database.exec(SCHEMA);
    database.prepare("INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, 0, 0)")
      .run(seed.id, seed.id);
    database.prepare("INSERT INTO memoar_conversion (id, workspace_path, title, contract_version, source_seed) VALUES (?, ?, ?, ?, ?)")
      .run(seed.id, seed.workspacePath, seed.title, CONTRACT_VERSION, Buffer.from(JSON.stringify(seed), "utf8"));
    const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
    if (integrity.integrity_check !== "ok") throw new Error("antigravity_sqlite_integrity_failed");
    database.exec("VACUUM");
    database.close();
    closed = true;
    return readFileSync(path);
  } finally {
    if (!closed) { try { database.close(); } catch { /* already failing */ } }
    rmSync(directory, { recursive: true, force: true });
  }
}
