import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { bytesField, intField, messageField, timestampField } from "./protobuf.js";

/**
 * The conversation database Antigravity opens on `agy --conversation <id>`.
 *
 * `~/.gemini/antigravity-cli/conversations/<id>.db`, one per conversation. The
 * schema is Antigravity's own, copied from the databases it writes. The
 * conversation lives in `steps`, one protobuf message per step. Only the two
 * step types a replay needs are written: a user input (14) and a planner
 * response (15). Antigravity reads a database with `user_version` 0 as
 * uninitialised and skips it.
 *
 * The previous writer put an empty `steps` table under `brain/<id>/`, a
 * directory Antigravity does not look in for conversations.
 */
export interface AntigravityStep {
  kind: "user" | "assistant";
  text: string;
  createdAt: string;
}

export interface AntigravitySeed {
  id: string;
  workspacePath: string;
  createdAt: string;
  steps: AntigravityStep[];
}

const USER_INPUT = 14;
const PLANNER_RESPONSE = 15;
const DONE = 3;
/** The values Antigravity's own CLI conversations carry in `trajectory_meta`. */
const CASCADE_TRAJECTORY = 4;
const CLI_SOURCE = 17;

const SCHEMA = `
  PRAGMA user_version = 1;
  PRAGMA journal_mode = DELETE;
  CREATE TABLE \`trajectory_meta\` (\`trajectory_id\` text,\`cascade_id\` text,\`trajectory_type\` integer,\`source\` integer,PRIMARY KEY (\`trajectory_id\`));
  CREATE TABLE \`steps\` (\`idx\` integer,\`step_type\` integer NOT NULL DEFAULT 0,\`status\` integer NOT NULL DEFAULT 0,\`has_subtrajectory\` numeric NOT NULL DEFAULT false,\`metadata\` blob,\`error_details\` blob,\`permissions\` blob,\`task_details\` blob,\`render_info\` blob,\`step_payload\` blob,\`step_format\` integer NOT NULL DEFAULT 0,PRIMARY KEY (\`idx\`));
  CREATE INDEX \`idx_steps_status\` ON \`steps\`(\`status\`);
  CREATE INDEX \`idx_steps_step_type\` ON \`steps\`(\`step_type\`);
  CREATE TABLE \`gen_metadata\` (\`idx\` integer,\`data\` blob,\`size\` integer NOT NULL DEFAULT 0,PRIMARY KEY (\`idx\`));
  CREATE TABLE \`executor_metadata\` (\`idx\` integer,\`data\` blob,PRIMARY KEY (\`idx\`));
  CREATE TABLE \`parent_references\` (\`idx\` integer,\`data\` blob,PRIMARY KEY (\`idx\`));
  CREATE TABLE \`trajectory_metadata_blob\` (\`id\` text DEFAULT "main",\`data\` blob,PRIMARY KEY (\`id\`));
  CREATE TABLE \`battle_mode_infos\` (\`idx\` integer,\`data\` blob,PRIMARY KEY (\`idx\`));
`;

/**
 * The workspace as Antigravity spells it, `file:///private/tmp/project`.
 *
 * Not `pathToFileURL`, which resolves a Windows path against the server's own
 * working directory when the server runs on Linux.
 */
export function workspaceUri(path: string): string {
  const forward = path.replaceAll("\\", "/");
  const rooted = forward.startsWith("/") ? forward : `/${forward}`;
  return `file://${encodeURI(rooted)}`;
}

function stepRow(seed: AntigravitySeed, step: AntigravityStep): { type: number; metadata: Buffer; payload: Buffer } {
  const type = step.kind === "user" ? USER_INPUT : PLANNER_RESPONSE;
  const metadata = Buffer.concat([
    timestampField(1, step.createdAt),
    intField(3, step.kind === "user" ? 4 : 2),
    messageField(20, bytesField(1, seed.id), bytesField(4, seed.id)),
  ]);
  const body = step.kind === "user"
    ? messageField(19, bytesField(2, step.text), messageField(3, bytesField(1, step.text)))
    : messageField(20, bytesField(1, step.text), bytesField(8, step.text));
  return { type, metadata, payload: Buffer.concat([intField(1, type), intField(4, DONE), messageField(5, metadata), body]) };
}

export function antigravityDatabaseBytes(seed: AntigravitySeed): Uint8Array {
  const directory = mkdtempSync(join(tmpdir(), "memoar-antigravity-"));
  const path = join(directory, `${seed.id}.db`);
  const database = new DatabaseSync(path);
  let closed = false;
  try {
    database.exec(SCHEMA);
    database.prepare("INSERT INTO trajectory_meta (trajectory_id, cascade_id, trajectory_type, source) VALUES (?, ?, ?, ?)")
      .run(seed.id, seed.id, CASCADE_TRAJECTORY, CLI_SOURCE);
    const uri = workspaceUri(seed.workspacePath);
    database.prepare("INSERT INTO trajectory_metadata_blob (id, data) VALUES ('main', ?)").run(Buffer.concat([
      messageField(1, bytesField(1, uri), bytesField(3, "")),
      timestampField(2, seed.createdAt),
      bytesField(6, seed.id),
      bytesField(7, uri),
    ]));
    const insert = database.prepare(
      "INSERT INTO steps (idx, step_type, status, has_subtrajectory, metadata, step_payload, step_format) VALUES (?, ?, ?, 0, ?, ?, 0)",
    );
    seed.steps.forEach((step, index) => {
      const row = stepRow(seed, step);
      insert.run(index, row.type, DONE, row.metadata, row.payload);
    });
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
