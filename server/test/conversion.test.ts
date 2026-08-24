import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversionEngine, InjectionFallbackWriter, serializedBundleObject } from "../src/convert.js";
import { DEMO_SESSION } from "../src/demo-data.js";

describe("conversion writers", () => {
  const engine = new ConversionEngine();

  it("writes Claude Code and Codex native JSONL layouts", () => {
    const claude = engine.convert(DEMO_SESSION, "claude-code", "fail");
    expect(claude.files[0]!.path).toMatch(/\.claude\/projects\/.+\.jsonl$/u);
    const claudeRecords = Buffer.from(claude.files[0]!.bytes).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(claudeRecords[1]).toMatchObject({ uuid: DEMO_SESSION.turns[1]!.id, parentUuid: DEMO_SESSION.turns[0]!.id });
    expect(claude.resumeCommand).toContain(`claude -r ${DEMO_SESSION.id}`);

    const codex = engine.convert(DEMO_SESSION, "codex", "fail");
    expect(codex.files[0]!.path).toContain("/.codex/sessions/2026/08/17/rollout-");
    const codexRecords = Buffer.from(codex.files[0]!.bytes).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(codexRecords[0]).toMatchObject({ type: "session_meta", payload: { id: DEMO_SESSION.id, cwd: DEMO_SESSION.workspace.path } });
    expect(codexRecords.filter((record) => record.type === "response_item")).toHaveLength(DEMO_SESSION.turns.length);
  });

  it("writes the Antigravity matrix paths and always supports injection fallback", () => {
    const antigravity = engine.convert(DEMO_SESSION, "antigravity-cli", "fail");
    expect(antigravity.files.map((file) => file.path)).toEqual([
      `~/.gemini/antigravity-cli/brain/${DEMO_SESSION.id}/.system_generated/logs/transcript.jsonl`,
      `~/.gemini/antigravity-cli/brain/${DEMO_SESSION.id}/conversations/${DEMO_SESSION.id}.db`,
      `~/.gemini/antigravity-cli/brain/${DEMO_SESSION.id}/walkthrough.md`,
    ]);
    const databaseFile = antigravity.files.find((file) => file.path.endsWith(".db"));
    expect(databaseFile).toBeDefined();
    expect(Buffer.from(databaseFile!.bytes).subarray(0, 16).toString("utf8")).toBe("SQLite format 3\0");
    const directory = mkdtempSync(join(tmpdir(), "memoar-conversion-test-"));
    const databasePath = join(directory, "conversation.db");
    writeFileSync(databasePath, databaseFile!.bytes);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      expect(database.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
      const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[];
      expect(tables.map((row) => row.name)).toEqual(["conversations", "messages"]);
      expect(database.prepare("SELECT id, workspace_path FROM conversations").get()).toMatchObject({
        id: DEMO_SESSION.id,
        workspace_path: DEMO_SESSION.workspace.path,
      });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }

    const fallback = engine.convert(DEMO_SESSION, "unsupported-agent", "injection");
    expect(fallback.report.fallback).toBe(true);
    expect(Buffer.from(fallback.files[0]!.bytes).toString("utf8")).toContain("# Memoar context prelude");
    expect(() => engine.convert(DEMO_SESSION, "unsupported-agent", "fail")).toThrow("unsupported_conversion_target");
  });

  it("adds deterministic bundle and per-file integrity metadata", () => {
    const serialized = serializedBundleObject(engine.convert(DEMO_SESSION, "codex", "fail")) as {
      contractVersion: string; bundleVersion: string; target: string; sessionId: string;
      files: { path: string; mediaType: string; base64: string; sha256: string; size: number }[];
      resumeCommand: string; report: unknown; bundleSha256: string;
    };
    for (const file of serialized.files) {
      const decoded = Buffer.from(file.base64, "base64");
      expect(file.size).toBe(decoded.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(decoded).digest("hex"));
    }
    const manifest = {
      contractVersion: serialized.contractVersion, bundleVersion: serialized.bundleVersion, target: serialized.target, sessionId: serialized.sessionId,
      files: serialized.files.map((file) => ({ path: file.path, mediaType: file.mediaType, sha256: file.sha256, size: file.size })),
      resumeCommand: serialized.resumeCommand, report: serialized.report,
    };
    expect(serialized.bundleSha256).toBe(createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex"));
  });

  it("keeps injection fallback within its token budget with cited excerpts and a truncation report", () => {
    const generous = new InjectionFallbackWriter().write(DEMO_SESSION, "unknown-agent");
    const generousMarkdown = Buffer.from(generous.files[0]!.bytes).toString("utf8");
    expect(generousMarkdown).toContain(`[${DEMO_SESSION.id} turn 0]`);
    expect(generousMarkdown).toContain("No turns were omitted.");
    expect(generous.report.dropped).toHaveLength(0);

    const tight = new InjectionFallbackWriter(40).write(DEMO_SESSION, "unknown-agent");
    const tightMarkdown = Buffer.from(tight.files[0]!.bytes).toString("utf8");
    expect(tight.report.dropped.length).toBeGreaterThan(0);
    expect(tight.report.dropped[0]!.reason).toBe("injection_token_budget_exceeded");
    expect(tightMarkdown).toContain("Omitted turns (budget exceeded):");
    expect(tightMarkdown.length).toBeLessThan(Buffer.from(generous.files[0]!.bytes).byteLength + 1);
  });
});