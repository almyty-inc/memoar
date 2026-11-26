import { describe, expect, it } from "vitest";
import type { Turn } from "../libs/canonical/src/generated.js";
import { isPlaceholderTitle, titleFromTurns } from "../src/ingest/session-title.js";

function turn(role: Turn["role"], ...texts: string[]): Turn {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    ordinal: 0,
    parentId: null,
    role,
    createdAt: "2026-11-26T00:00:00Z",
    blocks: texts.map((text) => ({ id: "00000000-0000-4000-8000-000000000001", kind: "text" as const, text })),
  };
}

describe("session titles", () => {
  it("knows the seed's placeholder from a real title", () => {
    expect(isPlaceholderTitle("codex imported session", "codex")).toBe(true);
    expect(isPlaceholderTitle("", "codex")).toBe(true);
    expect(isPlaceholderTitle("Fix the rate limiter", "codex")).toBe(false);
  });

  it("takes the first line of the first thing a person typed", () => {
    const turns = [
      turn("system", "You are a coding agent."),
      turn("user", "<command-name>/clear</command-name>"),
      turn("user", "  Fix the flaky timeline test\n\nIt fails one run in five."),
      turn("user", "Later message"),
    ];
    expect(titleFromTurns(turns)).toBe("Fix the flaky timeline test");
  });

  it("takes the prompt out of an agent's own wrapper, and skips injected instructions", () => {
    expect(titleFromTurns([turn("user", "<USER_REQUEST>\nWrite a short summary of the passage.\n</USER_REQUEST>")]))
      .toBe("Write a short summary of the passage.");
    expect(titleFromTurns([
      turn("user", "# AGENTS.md instructions for /repo\n\n<INSTRUCTIONS>Be brief.</INSTRUCTIONS>"),
      turn("user", "<recommended_plugins>none</recommended_plugins>"),
      turn("user", "Rename the config loader"),
    ])).toBe("Rename the config loader");
  });

  it("takes the prompt from under the Codex IDE context, and skips Codex's own messages", () => {
    expect(titleFromTurns([turn(
      "user",
      "# Context from my IDE setup:\n\n## Active file: main.tf\n\n## Open tabs:\n- main.tf: main.tf\n\n## My request for Codex:\nAdd a queue for the mailer\n",
    )])).toBe("Add a queue for the mailer");
    expect(titleFromTurns([
      turn("user", "# AGENTS.md instructions\n\nBe brief."),
      turn("user", "The following is the Codex agent history added since your last turn."),
      turn("user", "Rename the config loader"),
    ])).toBe("Rename the config loader");
  });

  it("counts a stored title made of injected text as no title", () => {
    expect(isPlaceholderTitle("# AGENTS.md instructions", "codex")).toBe(true);
    expect(isPlaceholderTitle("# Context from my IDE setup:", "codex")).toBe(true);
    expect(isPlaceholderTitle("<command-name>/clear</command-name>", "claude-code")).toBe(true);
    expect(isPlaceholderTitle("# Fix the rate limiter", "codex")).toBe(false);
  });

  it("shortens long prompts at a word", () => {
    const title = titleFromTurns([turn("user", "word ".repeat(40))]);
    expect(title?.length).toBeLessThanOrEqual(80);
    expect(title?.endsWith("…")).toBe(true);
    expect(title).not.toContain("  ");
  });

  it("gives nothing when no person spoke", () => {
    expect(titleFromTurns([turn("assistant", "Hello"), turn("user", "   ", "***")])).toBeUndefined();
  });
});
