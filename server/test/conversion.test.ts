import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ConversionEngine, InjectionFallbackWriter, serializedBundleObject } from "../src/convert.js";
import { TEST_SESSION } from "./fixtures/archive.js";

describe("conversion writers", () => {
  const engine = new ConversionEngine();

  it("writes Claude Code and Codex native JSONL layouts", () => {
    const claude = engine.convert(TEST_SESSION, "claude-code", "fail");
    expect(claude.files[0]!.path).toMatch(/\.claude\/projects\/.+\.jsonl$/u);
    const claudeRecords = Buffer.from(claude.files[0]!.bytes).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(claudeRecords[1]).toMatchObject({ uuid: TEST_SESSION.turns[1]!.id, parentUuid: TEST_SESSION.turns[0]!.id });
    expect(claude.resumeCommand).toContain(`claude -r ${TEST_SESSION.id}`);

    const codex = engine.convert(TEST_SESSION, "codex", "fail");
    expect(codex.files[0]!.path).toContain("/.codex/sessions/2026/08/17/rollout-");
    const codexRecords = Buffer.from(codex.files[0]!.bytes).toString("utf8").trim().split("\n").map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(codexRecords[0]).toMatchObject({ type: "session_meta", payload: { id: TEST_SESSION.id, cwd: TEST_SESSION.workspace.path } });
    expect(codexRecords.filter((record) => record.type === "response_item")).toHaveLength(TEST_SESSION.turns.length);
  });

  it("writes the Antigravity matrix paths and always supports injection fallback", () => {
    const antigravity = engine.convert(TEST_SESSION, "antigravity-cli", "fail");
    expect(antigravity.files.map((file) => file.path)).toEqual([
      `~/.gemini/antigravity-cli/brain/${TEST_SESSION.id}/.system_generated/logs/transcript.jsonl`,
      `~/.gemini/antigravity-cli/brain/${TEST_SESSION.id}/conversations/${TEST_SESSION.id}.db`,
      `~/.gemini/antigravity-cli/brain/${TEST_SESSION.id}/walkthrough.md`,
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
      // The schema Antigravity itself opens, which is also the one the
      // materializer validates: it reads `trajectory_meta` and refuses a brain
      // database without it. This used to be `conversations` and `messages`,
      // invented here, and every conversion died on the user's machine.
      expect(tables.map((row) => row.name)).toEqual([
        "battle_mode_infos", "executor_metadata", "gen_metadata", "memoar_conversion",
        "parent_references", "steps", "trajectory_meta", "trajectory_metadata_blob",
      ]);
      expect(database.prepare("SELECT trajectory_id FROM trajectory_meta").get()).toMatchObject({ trajectory_id: TEST_SESSION.id });
      expect(database.prepare("SELECT id, workspace_path FROM memoar_conversion").get()).toMatchObject({
        id: TEST_SESSION.id,
        workspace_path: TEST_SESSION.workspace.path,
      });
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }

    const fallback = engine.convert(TEST_SESSION, "unsupported-agent", "injection");
    expect(fallback.report.fallback).toBe(true);
    expect(Buffer.from(fallback.files[0]!.bytes).toString("utf8")).toContain("# Memoar context prelude");
    expect(() => engine.convert(TEST_SESSION, "unsupported-agent", "fail")).toThrow("unsupported_conversion_target");
  });

  it("adds deterministic bundle and per-file integrity metadata", () => {
    const serialized = serializedBundleObject(engine.convert(TEST_SESSION, "codex", "fail")) as {
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
    const generous = new InjectionFallbackWriter().write(TEST_SESSION, "unknown-agent");
    const generousMarkdown = Buffer.from(generous.files[0]!.bytes).toString("utf8");
    expect(generousMarkdown).toContain(`[${TEST_SESSION.id} turn 0]`);
    expect(generousMarkdown).toContain("No turns were omitted.");
    expect(generous.report.dropped).toHaveLength(0);

    const tight = new InjectionFallbackWriter(40).write(TEST_SESSION, "unknown-agent");
    const tightMarkdown = Buffer.from(tight.files[0]!.bytes).toString("utf8");
    expect(tight.report.dropped.length).toBeGreaterThan(0);
    expect(tight.report.dropped[0]!.reason).toBe("injection_token_budget_exceeded");
    expect(tightMarkdown).toContain("Omitted turns");
    expect(tightMarkdown.length).toBeLessThan(Buffer.from(generous.files[0]!.bytes).byteLength + 1);
  });

  it("does not wrap a prelude it already wrote", () => {
    // A prelude is pasted into another tool, captured from it, and converted
    // again. Marking plain text `[Memoar text]` meant the second pass marked
    // the marker, and the third marked that, with nothing counting the layers.
    const session = {
      ...TEST_SESSION,
      turns: [{
        id: "0191cafe-0000-7000-8000-00000000e001", ordinal: 0, parentId: null, role: "user" as const,
        createdAt: TEST_SESSION.createdAt,
        blocks: [
          { id: "0191cafe-0000-7000-8000-00000000e002", kind: "text" as const, text: "Decide how the archive stores unknown formats." },
          // `artifact` is a real ContentBlockKind and is the one that carries an
          // artifactRef. A made-up kind would make this test prove nothing: the
          // prelude's fallback is keyed on the kind, so a kind the canonical
          // model does not have cannot reach the branch being tested.
          { id: "0191cafe-0000-7000-8000-00000000e003", kind: "artifact" as const, artifactRef: "sha256:c0ffee" },
        ],
      }],
    };
    const writer = new InjectionFallbackWriter();
    const first = Buffer.from(writer.write(session, "unknown-agent").files[0]!.bytes).toString("utf8");
    expect(first).toContain("Decide how the archive stores unknown formats.");
    expect(first).not.toContain("[Memoar text]");
    // The shape it genuinely cannot show still says so, and says what it had.
    expect(first).toContain("[Memoar artifact] sha256:c0ffee");

    // The prelude comes back as an ordinary text turn on the next capture.
    const rearchived = { ...session, turns: [{ ...session.turns[0]!, blocks: [{ id: "0191cafe-0000-7000-8000-00000000e004", kind: "text" as const, text: first }] }] };
    const second = Buffer.from(writer.write(rearchived, "unknown-agent").files[0]!.bytes).toString("utf8");
    const count = (text: string) => [...text.matchAll(/\[Memoar artifact\]/gu)].length;
    expect(count(second), "a second pass must not add a layer of its own").toBe(count(first));
  });

  /** A long conversation: 4000 turns of 400 characters, the odd short one. */
  function longSession(turns: number, charactersFor: (index: number) => number = (index) => (index % 7 === 0 ? 20 : 400)) {
    return {
      ...TEST_SESSION,
      turns: Array.from({ length: turns }, (_, index) => ({
        id: `0191cafe-0000-7000-8000-${(0x2000 + index).toString(16).padStart(12, "0")}`,
        ordinal: index,
        parentId: null,
        role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
        createdAt: TEST_SESSION.createdAt,
        blocks: [{ id: `0191cafe-0000-7000-8000-${(0x9000 + index).toString(16).padStart(12, "0")}`, kind: "text" as const, text: `${index} ${"x".repeat(charactersFor(index))}` }],
      })),
    };
  }

  /** The ordinals the prelude actually carries, in the order it carries them. */
  function includedOrdinals(bundle: { files: { bytes: Uint8Array }[] }): number[] {
    const markdown = Buffer.from(bundle.files[0]!.bytes).toString("utf8");
    return [...markdown.matchAll(/turn (\d+)\]/gu)].map((match) => Number(match[1]));
  }

  it("gives a long session its recent end, not its opening", () => {
    // Filling the budget from the start meant a four-thousand-turn session came
    // out as turns 0 to 37: somebody resuming their work in another tool was
    // handed the beginning of the conversation and nothing of what they had
    // been doing. Resuming needs the task and the recent state, in that order.
    const ordinals = includedOrdinals(new InjectionFallbackWriter().write(longSession(4000), "unknown-agent"));

    expect(ordinals[0], "the first turn states the task").toBe(0);
    expect(ordinals.at(-1), "and the excerpt runs to where the work stopped").toBe(3999);
    expect(ordinals.length).toBeGreaterThan(10);
  });

  it("excerpts a run of turns rather than whichever ones happen to be short", () => {
    // The budget loop used to keep scanning after the budget ran out, admitting
    // any later turn small enough to squeeze in. That prefers the "ok"s and the
    // "yes"es over the substantive turns and leaves the transcript full of
    // holes. Turn 20 here is one big tool result, larger than the whole budget:
    // reaching it must end the excerpt, not send it hunting further back.
    const uneven = longSession(40, (index) => (index === 20 ? 20_000 : 200));
    const ordinals = includedOrdinals(new InjectionFallbackWriter().write(uneven, "unknown-agent"));
    const tail = ordinals.slice(1);

    expect(tail.every((ordinal, index) => index === 0 || ordinal === tail[index - 1]! + 1), `not contiguous: ${tail.join(",")}`).toBe(true);
    expect(tail, "the excerpt stops at the turn that does not fit").not.toContain(19);
    expect(tail.at(-1)).toBe(39);
  });

  it("does not let the list of omissions outgrow the excerpt", () => {
    // One dropped entry per omitted turn made the bundle grow with the session
    // while its payload stayed capped: 4000 turns produced 452kB of which 91%
    // was a list of what had been left out, and the prelude itself carried a
    // wall of 3960 ordinals for a model to read.
    const bundle = new InjectionFallbackWriter().write(longSession(4000), "unknown-agent");
    const prelude = Buffer.from(bundle.files[0]!.bytes);

    expect(bundle.report.dropped, "omissions are reported as ranges").toEqual([
      { reference: "turns:1-3960", reason: "injection_token_budget_exceeded" },
    ]);
    expect(serializedBundleObject(bundle).files, "the payload is the bundle").toBeDefined();
    expect(JSON.stringify(bundle.report).length, "the report stays a fraction of the excerpt").toBeLessThan(prelude.byteLength / 4);
  });

  it("carries something recent even when the last turn alone exceeds the budget", () => {
    // Otherwise a session whose final turn is a large tool result degrades to a
    // prelude that says only what the work was going to be.
    const bundle = new InjectionFallbackWriter().write(longSession(3, (index) => (index === 2 ? 90_000 : 100)), "unknown-agent");
    const markdown = Buffer.from(bundle.files[0]!.bytes).toString("utf8");

    expect(markdown, "the tail is truncated, and says so").toContain("[Memoar truncated");
    expect(bundle.report.degraded[0]!.reason).toContain("truncated to fit");
  });
});