import { describe, expect, it } from "vitest";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";

/*
  The VS Code half of `copilot`.

  Capture has always collected `Code/User/workspaceStorage/*\/chatSessions/*`,
  and the parser read a CLI SQLite schema, so every one of those files went up
  and came back `unknown_format`. This is the branch that reads them.

  The envelope below is assembled here rather than copied from a session: the
  shape — `requests[]`, `message.text`, the `response` part kinds, the `kind:0`
  snapshot and `kind:1` write of the `.jsonl` layout — was read off the 23 files
  and the five populated `interactive.sessions` mementos on the machine this was
  written on, and the text in it is invented. Which is the weaker half of the
  evidence and is said so in contracts/fixtures/PROVENANCE.md: what these cases
  pin is that the mapping does not drift, and what checked the mapping against
  real requests was running this parser over those mementos.
*/

const seed: SessionSeed = {
  id: "0191cafe-0000-7000-8000-000000000001",
  source: { vendor: "github", tool: "copilot", version: "v1", machineId: "0191cafe-0000-7000-8000-00000000f012" },
  workspace: { path: "/workspace/demo" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  title: "seeded title",
  models: [],
  tokenTotals: { input: 0, output: 0, total: 0 },
  provenance: [],
  visibility: "private",
};

/** A `MarkdownString`, which is how VS Code serialises prose in a response. */
const prose = (value: string) => ({ value, isTrusted: false, supportThemeIcons: false, supportHtml: false });

const envelope = (requests: unknown[], extra: Record<string, unknown> = {}) => ({
  version: 3,
  requesterUsername: "someone",
  responderUsername: "GitHub Copilot",
  initialLocation: "panel",
  requests,
  sessionId: "4cf06af0-25a8-4314-8516-de66bee78a6b",
  creationDate: 1_743_594_617_151,
  isImported: false,
  lastMessageDate: 1_743_594_799_183,
  ...extra,
});

const populated = envelope(
  [
    {
      message: { text: "rename the helper", parts: [{ text: "rename the helper" }] },
      variableData: { variables: [] },
      response: [
        prose("Renaming it now."),
        { kind: "progressMessage", content: { value: "Searching for relevant definitions...", uris: {} } },
        { kind: "toolInvocationSerialized", invocationMessage: "Reading project structure", pastTenseMessage: "Read project structure", isConfirmed: true, isComplete: true },
        { kind: "codeblockUri", uri: { $mid: 1, fsPath: "/workspace/demo/helper.ts", path: "/workspace/demo/helper.ts", scheme: "file" } },
        {
          kind: "textEditGroup",
          uri: { $mid: 1, fsPath: "/workspace/demo/helper.ts", path: "/workspace/demo/helper.ts", scheme: "file" },
          edits: [[], [{ text: "export function renamed(): void {}\n" }]],
          done: true,
        },
      ],
      result: { timings: {}, metadata: {} },
      followups: [],
      isCanceled: false,
      agent: { id: "github.copilot.default" },
      contentReferences: [],
      timestamp: 1_743_594_799_183,
    },
    {
      message: { text: "thanks", parts: [{ text: "thanks" }] },
      response: [prose("Any time.")],
      isCanceled: false,
      agent: { id: "github.copilot.default" },
      contentReferences: [],
    },
  ],
  { customTitle: "Renaming a helper" },
);

const bytes = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8");
const parse = (raw: Buffer) => new ParserRegistry().parse({ source: "copilot", version: "v1", raw, seed });

describe("copilot VS Code chatSessions", () => {
  it("reads the whole-JSON layout into a turn per half of each request", () => {
    const result = parse(bytes(populated));
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions).toHaveLength(1);
    const session = result.sessions[0];

    // A request holds both halves of an exchange, and they have different
    // authors, so one request is two turns and the reply answers the question.
    expect(session.turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(session.turns.map((turn) => turn.ordinal)).toEqual([0, 1, 2, 3]);
    expect(session.turns.map((turn) => turn.parentId)).toEqual([
      null,
      session.turns[0].id,
      session.turns[1].id,
      session.turns[2].id,
    ]);
    expect(session.turns[0].blocks[0].text).toBe("rename the helper");
    expect(session.source.nativeSessionId).toBe("4cf06af0-25a8-4314-8516-de66bee78a6b");
    expect(session.title).toBe("Renaming a helper");

    // A request carries its own stamp when VS Code recorded one, and the
    // panel's creation when it did not — never the seed, which is the capture.
    expect(session.turns[0].createdAt).toBe(new Date(1_743_594_799_183).toISOString());
    expect(session.turns[2].createdAt).toBe(new Date(1_743_594_617_151).toISOString());
  });

  it("keeps every response part that is content and drops the ones that are not", () => {
    const result = parse(bytes(populated));
    if (result.kind !== "parsed") throw new Error("expected a parse");
    const reply = result.sessions[0].turns[1];

    // progressMessage is the status line the panel draws while it works, and
    // codeblockUri only names the file for the code block already in the
    // markdown. Keeping either would put UI chrome in the archive as prose.
    expect(reply.blocks.map((block) => block.kind)).toEqual(["text", "tool_call", "diff"]);
    expect(reply.blocks[0].text).toBe("Renaming it now.");
    expect(reply.blocks[1].text).toBe("Read project structure");
    expect(reply.blocks[2].text).toBe("export function renamed(): void {}\n");
    expect(reply.blocks[2].name).toBe("/workspace/demo/helper.ts");
    const text = reply.blocks.map((block) => block.text).join("\n");
    expect(text).not.toContain("Searching for relevant definitions");
  });

  it("reads the .jsonl layout VS Code writes now, snapshot plus writes", () => {
    // 18 of the 23 files on the machine this was written on are this layout.
    const log = [
      JSON.stringify({ kind: 0, v: populated }),
      JSON.stringify({ kind: 1, k: ["inputState"], v: { attachments: [], inputText: "" } }),
      JSON.stringify({ kind: 1, k: ["customTitle"], v: "Renamed after the fact" }),
    ].join("\n");
    const result = parse(Buffer.from(`${log}\n`, "utf8"));
    expect(result.kind, result.kind === "unknown" ? result.diagnostic : "").toBe("parsed");
    if (result.kind !== "parsed") return;
    expect(result.sessions[0].turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user", "assistant"]);
    // A write lands on the snapshot rather than being ignored.
    expect(result.sessions[0].title).toBe("Renamed after the fact");
  });

  it("refuses an unused panel rather than archiving a session with no turns", () => {
    // Every chatSessions file on this machine is this: a panel opened and never
    // used. An empty session in the archive reads as a conversation that was
    // lost; a kept artifact saying why does not.
    for (const raw of [bytes(envelope([])), Buffer.from(`${JSON.stringify({ kind: 0, v: envelope([]) })}\n`, "utf8")]) {
      const result = parse(raw);
      expect(result.kind).toBe("unknown");
      if (result.kind !== "unknown") continue;
      expect(result.diagnostic).toContain("holds no requests");
      expect(Buffer.from(result.raw).equals(raw), "the bytes are kept so a later parser can read them").toBe(true);
    }
  });

  it("still refuses bytes that are neither the session store nor a chat panel", () => {
    const result = parse(Buffer.from("{\"settings\":{\"telemetry\":false}}", "utf8"));
    expect(result.kind).toBe("unknown");
    if (result.kind !== "unknown") return;
    expect(result.diagnostic).toContain("VS Code chatSessions envelope");
  });

  it("gives every turn and block of a chat panel a distinct id", () => {
    const result = parse(bytes(populated));
    if (result.kind !== "parsed") throw new Error("expected a parse");
    const ids = result.sessions[0].turns.flatMap((turn) => [turn.id, ...turn.blocks.map((block) => block.id)]);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
