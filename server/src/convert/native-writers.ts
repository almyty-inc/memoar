import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type Session } from "../../libs/canonical/src/generated.js";
import { bytes, freshReport, nativeBlocks, type ConversionBundle, type NativeWriter } from "./types.js";

export class ClaudeCodeWriter implements NativeWriter {
  readonly target = "claude-code" as const;

  write(session: Session): ConversionBundle {
    const report = freshReport();
    const lines = session.turns.map((turn) => JSON.stringify({
      uuid: turn.id,
      parentUuid: turn.parentId,
      type: turn.role,
      message: {
        role: turn.role,
        ...(turn.model ? { model: turn.model } : {}),
        content: nativeBlocks(turn, report),
      },
      timestamp: turn.createdAt,
      memoar: { sourceSessionId: session.id },
    }));
    const encodedWorkspace = session.workspace.path.replaceAll(/[^A-Za-z0-9._-]/gu, "-") || "memoar-imports";
    return {
      target: this.target,
      sessionId: session.id,
      files: [{
        path: `~/.claude/projects/${encodedWorkspace}/${session.id}.jsonl`,
        mediaType: "application/x-ndjson",
        bytes: bytes(`${lines.join("\n")}\n`),
      }],
      resumeCommand: `claude -r ${session.id} --print smoke`,
      report,
    };
  }
}

export class CodexWriter implements NativeWriter {
  readonly target = "codex" as const;

  write(session: Session): ConversionBundle {
    const report = freshReport();
    const lines = [JSON.stringify({
      timestamp: session.createdAt,
      type: "session_meta",
      payload: { id: session.id, cwd: session.workspace.path, source: "memoar" },
    })];
    for (const turn of session.turns) lines.push(JSON.stringify({
      timestamp: turn.createdAt,
      type: "response_item",
      payload: {
        role: turn.role,
        content: nativeBlocks(turn, report).map((block) => ({ ...block, kind: block.kind === "text" ? "text" : block.kind })),
        memoarParentId: turn.parentId,
      },
    }));
    const date = session.createdAt.slice(0, 10).replaceAll("-", "/");
    const stamp = session.createdAt.replaceAll(/[:.]/gu, "-");
    return {
      target: this.target,
      sessionId: session.id,
      files: [{
        path: `~/.codex/sessions/${date}/rollout-${stamp}-${session.id}.jsonl`,
        mediaType: "application/x-ndjson",
        bytes: bytes(`${lines.join("\n")}\n`),
      }],
      resumeCommand: `codex resume ${session.id} --no-alt-screen`,
      report,
    };
  }
}

export class AntigravityCliWriter implements NativeWriter {
  readonly target = "antigravity-cli" as const;

  write(session: Session): ConversionBundle {
    const report = freshReport();
    const messages = session.turns.map((turn) => ({
      type: "message",
      id: turn.id,
      parentId: turn.parentId,
      role: turn.role,
      parts: nativeBlocks(turn, report),
      createdAt: turn.createdAt,
    }));
    const transcript = messages.map((message) => JSON.stringify(message)).join("\n");
    const base = `~/.gemini/antigravity-cli/brain/${session.id}`;
    const walkthrough = [
      `# Memoar conversion ${session.id}`,
      "",
      `Source: ${session.source.tool}`,
      `Workspace: ${session.workspace.path}`,
      `Mapped blocks: ${report.mapped}`,
      `Degraded blocks: ${report.degraded.length}`,
    ].join("\n");
    const temporaryDirectory = mkdtempSync(join(tmpdir(), "memoar-antigravity-"));
    const databasePath = join(temporaryDirectory, `${session.id}.db`);
    const database = new DatabaseSync(databasePath);
    let closed = false;
    let databaseBytes: Uint8Array;
    try {
      database.exec(`
        PRAGMA journal_mode = DELETE;
        PRAGMA foreign_keys = ON;
        CREATE TABLE conversations (
          id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_path TEXT NOT NULL,
          source_tool TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, schema_version INTEGER NOT NULL
        );
        CREATE TABLE messages (
          id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
          parent_id TEXT, ordinal INTEGER NOT NULL, role TEXT NOT NULL, parts_json TEXT NOT NULL, created_at TEXT NOT NULL
        );
      `);
      database.prepare("INSERT INTO conversations VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        session.id, session.title, session.workspace.path, session.source.tool, session.createdAt, session.updatedAt, 1,
      );
      const insertMessage = database.prepare("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?)");
      messages.forEach((message, ordinal) => insertMessage.run(
        message.id, session.id, message.parentId, ordinal, message.role, JSON.stringify(message.parts), message.createdAt,
      ));
      const integrity = database.prepare("PRAGMA integrity_check").get() as { integrity_check?: string };
      if (integrity.integrity_check !== "ok") throw new Error("antigravity_sqlite_integrity_failed");
      database.exec("VACUUM");
      database.close();
      closed = true;
      databaseBytes = readFileSync(databasePath);
    } finally {
      if (!closed) { try { database.close(); } catch {} }
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
    return {
      target: this.target,
      sessionId: session.id,
      files: [
        { path: `${base}/.system_generated/logs/transcript.jsonl`, mediaType: "application/x-ndjson", bytes: bytes(`${transcript}\n`) },
        { path: `${base}/conversations/${session.id}.db`, mediaType: "application/vnd.sqlite3", bytes: databaseBytes },
        { path: `${base}/walkthrough.md`, mediaType: "text/markdown", bytes: bytes(walkthrough) },
      ],
      resumeCommand: `agy --conversation ${session.id} --print smoke`,
      report,
    };
  }
}
