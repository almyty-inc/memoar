import type { HttpException } from "@nestjs/common";
import { beforeEach, describe, expect, it } from "vitest";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { MemoryConversionService } from "../src/memory/memory-conversion.service.js";
import { MemoryService } from "../src/memory/memory.service.js";
import type { CaptureMemoryDto, ConvertMemoryDto } from "../src/memory/memory.dto.js";
import { TEST_CONTEXT } from "./fixtures/archive.js";

const MACHINE = "0191cafe-0000-7000-8000-0000000000c1";

let store: DevArchiveStore;
let memory: MemoryService;
let conversions: MemoryConversionService;

beforeEach(() => {
  store = new DevArchiveStore();
  memory = new MemoryService(store);
  conversions = new MemoryConversionService(store);
});

function capture(overrides: Partial<CaptureMemoryDto>) {
  return memory.capture(TEST_CONTEXT, {
    scope: "global",
    machineId: MACHINE,
    path: "/Users/x/.claude/CLAUDE.md",
    readers: ["claude-code"],
    text: "Global rules.",
    capturedAt: "2026-09-18T00:00:00.000Z",
    ...overrides,
  });
}

function convert(overrides: Partial<ConvertMemoryDto> = {}) {
  return conversions.convert(TEST_CONTEXT, {
    source: "claude-code",
    target: "codex",
    scope: "global",
    ...overrides,
  });
}

/** Nest renders an object body as a bare string in `message`; the code is what a client reads. */
async function refusal(call: Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    await call;
  } catch (error) {
    const response = (error as HttpException).getResponse?.();
    if (response && typeof response === "object") return response as Record<string, unknown>;
    return { code: String(response) };
  }
  throw new Error("expected the call to be refused, and it was not");
}

function text(base64: string): string {
  return Buffer.from(base64, "base64").toString("utf8");
}

/**
 * The same intent in a different dialect.
 *
 * `CLAUDE.md`, `AGENTS.md` and `GEMINI.md` say the same things to different
 * tools, and until now the only way to have both was to keep two copies by
 * hand. What this is not: a rewrite. The text is the user's own, it is
 * expensive to recreate, and memoar's job is to move it rather than to have an
 * opinion about it — so the bytes come out the other side unchanged and the
 * only thing that changes is where they live.
 */
describe("porting memory files between dialects", () => {
  it("writes one file to the target tool's path, byte for byte", async () => {
    await capture({ text: "Small files. Real coverage.\n" });

    const bundle = await convert();
    expect(bundle.files).toHaveLength(1);
    expect(bundle.files[0]!.path, "Codex reads AGENTS.md under its own directory").toBe("~/.codex/AGENTS.md");
    expect(text(bundle.files[0]!.base64), "one file to one file is a copy, not an edit")
      .toBe("Small files. Real coverage.\n");
    expect(bundle.report.concatenated).toBe(false);
  });

  it("goes to each tool's own path and filename", async () => {
    await capture({ text: "Rules." });
    for (const [target, path] of [
      ["antigravity-cli", "~/.gemini/GEMINI.md"],
      ["codex", "~/.codex/AGENTS.md"],
      ["crush", "~/.config/crush/CRUSH.md"],
      ["opencode", "~/.config/opencode/AGENTS.md"],
    ] as const) {
      const bundle = await convert({ target });
      expect(bundle.files.map((file) => file.path), target).toEqual([path]);
      expect(text(bundle.files[0]!.base64), target).toBe("Rules.");
    }
  });

  /*
    Claude Code is the case that forces this: it reads a CLAUDE.md *and* a
    directory of one-fact files under ~/.claude/projects/*\/memory/. Codex reads
    one path. Four files have to become one, and a reader of the result who
    cannot tell which of their files said what has been handed a wall of text.
  */
  it("concatenates several files into one, saying where each part came from", async () => {
    await capture({ path: "/Users/x/.claude/CLAUDE.md", text: "Global rules." });
    await capture({ path: "/Users/x/.claude/projects/p/memory/note.md", text: "One fact." });

    const bundle = await convert();
    expect(bundle.files).toHaveLength(1);
    expect(text(bundle.files[0]!.base64)).toBe([
      "<!-- memoar: from /Users/x/.claude/CLAUDE.md -->",
      "",
      "Global rules.",
      "",
      "<!-- memoar: from /Users/x/.claude/projects/p/memory/note.md -->",
      "",
      "One fact.",
      "",
    ].join("\n"));
    expect(bundle.report, "the report says both what went in and that it was joined")
      .toEqual({ documents: 2, concatenated: true });
    expect(bundle.files[0]!.sources).toEqual([
      "/Users/x/.claude/CLAUDE.md",
      "/Users/x/.claude/projects/p/memory/note.md",
    ]);
  });

  it("is the same bytes every time, whatever order the archive answers in", async () => {
    await capture({ path: "/Users/x/.claude/projects/p/memory/z.md", text: "Last." });
    await capture({ path: "/Users/x/.claude/CLAUDE.md", text: "First." });

    const first = await convert();
    const again = await convert();
    expect(again.bundleSha256, "a conversion nobody can diff is not reversible").toBe(first.bundleSha256);
    expect(text(first.files[0]!.base64).indexOf("First."))
      .toBeLessThan(text(first.files[0]!.base64).indexOf("Last."));
  });

  /*
    Roo reads a directory, so it has somewhere to put each file. Concatenating
    into it would throw away the one thing the target dialect offers that the
    source did not.
  */
  it("keeps one file per source where the target reads a rules directory", async () => {
    await capture({ path: "/Users/x/.claude/CLAUDE.md", text: "Global rules." });
    await capture({ path: "/Users/x/.claude/projects/p/memory/note.md", text: "One fact." });

    const bundle = await convert({ target: "roo" });
    expect(bundle.files.map((file) => file.path)).toEqual([
      "~/.roo/rules/users-x-claude-claude-md.md",
      "~/.roo/rules/users-x-claude-projects-p-memory-note-md.md",
    ]);
    expect(bundle.files.map((file) => text(file.base64)), "each one copied, none of them joined")
      .toEqual(["Global rules.", "One fact."]);
    expect(bundle.report.concatenated).toBe(false);
  });

  it("writes project files to the workspace, not to the home directory", async () => {
    await capture({
      scope: "project",
      workspacePath: "/workspace/memoar",
      path: "/workspace/memoar/CLAUDE.md",
      text: "Project rules.",
    });

    const bundle = await convert({ scope: "project", workspacePath: "/workspace/memoar", target: "goose" });
    expect(bundle.files.map((file) => file.path), "`./` is the workspace, `~/` is the home directory")
      .toEqual(["./.goosehints"]);
    expect(bundle.workspacePath).toBe("/workspace/memoar");
  });

  it("refuses a target that has no such file rather than inventing one", async () => {
    await capture({ text: "Global rules." });
    // Copilot documents a project instructions file and no user-wide one.
    const problem = await refusal(convert({ target: "copilot" }));
    expect(problem.code).toBe("unsupported_memory_dialect");
  });

  it("refuses the requests that cannot mean anything", async () => {
    await capture({ text: "Global rules." });
    expect((await refusal(convert({ source: "codex", target: "codex" }))).code).toBe("memory_conversion_noop");
    expect((await refusal(convert({ scope: "project" }))).code).toBe("memory_workspace_required");
    expect((await refusal(convert({ source: "goose" }))).code).toBe("no_memory_to_convert");
  });
});

/**
 * Conversion is egress, so the review gate applies to it.
 *
 * Reading your own memory file in your own web app is the only way a review can
 * happen at all. This is the other thing: it takes the text and writes it onto
 * a disk, at a path a tool loads unprompted, possibly on a machine the file was
 * never captured from. If a CLAUDE.md is where somebody wrote a staging key,
 * converting it makes a second copy of that key somewhere nobody is looking —
 * which is precisely what `requireReviewed` was landed for.
 */
describe("converting a memory file the scanner flagged", () => {
  /*
    Assembled at run time, never spelled out.

    A fixture that looks exactly like a live key is the point of the fixture and
    also the reason GitHub's push protection refuses the commit. It is right to:
    a scanner cannot tell a convincing fixture from the real thing. So this file
    contains no such string.
  */
  const body = "0123456789abcdefghij".repeat(2).slice(0, 24);
  const withCredential = `The staging key is ${["sk", "live", body].join("_")} and it works.`;

  it("is refused until a person has looked at it", async () => {
    await capture({ text: withCredential });

    const problem = await refusal(convert());
    expect(problem.code, "the same refusal the MCP read path gives, not a second rule")
      .toBe("redaction_review_required");
    expect(problem.redactionFindings).toContain("api_key");
  });

  it("converts once it has been reviewed", async () => {
    const { document } = await capture({ text: withCredential });
    expect(document.redactionStatus).toBe("findings");
    await memory.review(TEST_CONTEXT, document.id, document.contentHash);

    const bundle = await convert();
    expect(text(bundle.files[0]!.base64), "a reviewed file goes out as it stands").toBe(withCredential);
  });

  it("refuses the whole conversion, not just the flagged part of it", async () => {
    // Otherwise a conversion quietly drops a file, and the target ends up
    // saying less than the source did with nothing to say so.
    await capture({ path: "/Users/x/.claude/CLAUDE.md", text: "Harmless." });
    await capture({ path: "/Users/x/.claude/projects/p/memory/keys.md", text: withCredential });

    expect((await refusal(convert())).code).toBe("redaction_review_required");
  });
});
