import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { Session } from "../libs/canonical/src/generated.js";
import { ParserRegistry, type SessionSeed } from "../libs/parsers/src/index.js";
import { haystackOf, nativeStrings, type NativeString } from "./helpers/native-strings.js";

/**
 * Nothing a transcript says may vanish on the way into the archive unless this
 * file says so.
 *
 * On dev, 38,429 of 45,703 tool results and 19,166 of 20,209 thinking blocks
 * were stored without a word of their content, and every test passed, because
 * each test asked about the fields its author expected to be read. This asks
 * about every string in the native input instead, without knowing which field
 * any tool keeps its text in: each one of 16 characters or more must be found
 * somewhere in the parsed session, in its text, its data or its ext.
 *
 * Identifiers, timestamps and thinking signatures are left out by key name in
 * `native-strings.ts`. Everything else that a parser leaves out on purpose is
 * declared below, by where it sits in the native record, with the reason. A
 * string dropped anywhere else fails this test, so a parser cannot start losing
 * content again without someone writing down why.
 */
interface Drop {
  path: RegExp;
  reason: string;
}

const DECLARED_DROPS: Readonly<Record<string, readonly Drop[]>> = {
  "claude-code": [
    { path: /^\[[^\]]*\]\.toolUseResult\b/u, reason: "Claude Code's own structured copy of a tool result. What the model saw is in message.content, which is kept, and an edit's change is in the tool call's input." },
    { path: /^\[type=(permission-mode|file-history-snapshot|queue-operation|last-prompt|mode|cost-state|agent-name)\b/u, reason: "Harness bookkeeping: modes, file backups, queue state, costs." },
    { path: /^\[type=attachment,attachment=(hook_success|hook_cancelled|total_tokens_reminder|deferred_tools_record|skill_listing|prompt_snapshot|environment)\b/u, reason: "Harness bookkeeping attachments: hook stdout, reminders, tool and skill listings, the system prompt snapshot. Listed in BOOKKEEPING_ATTACHMENTS." },
    { path: /^\[[^\]]*\]\.(cwd|entrypoint|userType)$/u, reason: "Where and how the CLI ran, kept on the session's workspace rather than per line." },
  ],
  codex: [
    { path: /^\[type=(event_msg|turn_context|token_usage_record|world_state)\b/u, reason: "UI events that repeat response items, per-turn settings and token accounting." },
    { path: /^\[type=session_meta\]/u, reason: "The rollout header. Its id, cwd and instructions identify the session; the harness's base instructions are configuration." },
    { path: /^\[type=response_item,payload=additional_tools\]/u, reason: "The tool catalogue the harness offered. Listed in CODEX_BOOKKEEPING_ITEMS." },
    { path: /^\[type=compacted\]\.payload\.replacement_history\b/u, reason: "Restates items the rollout already holds, so it is not read twice. The compaction summary in payload.message is kept." },
  ],
  "antigravity-cli": [
    { path: /^\[type=(CHECKPOINT|CONVERSATION_HISTORY)\]/u, reason: "The CLI's own markers." },
  ],
  "chatgpt-export": [],
  copilot: [],
  opencode: [
    { path: /^\[session\]\.(project_id|directory)$/u, reason: "Identifiers. The directory becomes the session's workspace path." },
  ],
  goose: [],
  crush: [],
  cursor: [
    { path: /^\[cursorDiskKV\]\.key$/u, reason: "Row keys, which only name the composer and bubble ids." },
    { path: /^\[cursorDiskKV\]\.value\.conversation\b/u, reason: "The session-2 and session-3 fixtures predate the parser and hold an invented `conversation` array Cursor never writes. Real conversations are bubble rows, which are read." },
  ],
  zed: [],
  roo: [],
  kilo: [],
  "cass-export": [],
  "canonical-bundle": [],
};

interface ManifestEntry {
  source: string;
  version: string;
  fixture: string;
  input: string;
  expected: string;
}

const repository = resolve(process.cwd(), "..");
const manifest = JSON.parse(readFileSync(resolve(repository, "contracts/fixtures/manifest.json"), "utf8")) as { fixtures: ManifestEntry[] };

/**
 * The fixture's seed with every field a parser may fill replaced by a
 * placeholder, so a title or a path found in the output came from the native
 * input and not from the seed the test handed in.
 */
function seedFrom(expected: string): SessionSeed {
  const session = JSON.parse(readFileSync(resolve(repository, expected), "utf8")) as Session;
  const seed = Object.fromEntries(Object.entries(session).filter(([key]) => key !== "turns" && key !== "summary" && key !== "ext")) as SessionSeed;
  return { ...seed, title: "seed", workspace: { path: "/seed" }, source: { ...seed.source, nativeSessionId: "seed" } };
}

/** What a parse of this fixture left out that nothing declares. */
function undeclaredLosses(entry: ManifestEntry, tamper: (sessions: Session[]) => void = () => undefined): NativeString[] {
  const raw = readFileSync(resolve(repository, entry.input));
  const seed = seedFrom(entry.expected);
  const result = new ParserRegistry().parse({ source: entry.source, version: entry.version, raw, seed });
  if (result.kind !== "parsed") throw new Error(`${entry.source}/${entry.version}/${entry.fixture} did not parse: ${result.diagnostic}`);
  tamper(result.sessions);
  const haystack = haystackOf(result.sessions);
  const drops = DECLARED_DROPS[entry.source] ?? [];
  return nativeStrings(raw)
    .filter(({ path }) => !drops.some((drop) => drop.path.test(path)))
    .filter(({ value }) => !haystack.includes(value));
}

describe("parser fidelity: every native string reaches the canonical session", () => {
  it.each(manifest.fixtures.map((entry) => [`${entry.source}/${entry.version}/${entry.fixture}`, entry] as const))(
    "%s keeps every string it does not declare a reason to drop",
    (_name, entry) => {
      const lost = undeclaredLosses(entry).map(({ path, value }) => `${path}: ${value.slice(0, 80)}`);
      expect(lost, "declare a drop in DECLARED_DROPS with its reason, or keep the content").toEqual([]);
    },
  );

  it("has a rich fixture for every parser that reads a tool's own store", () => {
    // Each of these holds tool output, thinking, images and the other shapes
    // the dev archive lost. A parser with only a plain fixture would be checked
    // against text and nothing else.
    const rich = new Set(manifest.fixtures.filter((entry) => entry.fixture === "rich-1").map((entry) => entry.source));
    const sources = new ParserRegistry().connectors().concat("chatgpt-export");
    expect(sources.filter((source) => !rich.has(source))).toEqual([]);
  });

  it("declares a drop list for every source, so silence cannot mean none was thought about", () => {
    const sources = Object.keys(new ParserRegistry().capabilities());
    expect(sources.filter((source) => DECLARED_DROPS[source] === undefined)).toEqual([]);
  });

  it("fails when a parser goes back to keeping only a tool result's call id and a thinking block's signature", () => {
    // The guard is only worth having if it fires on the defect it exists for.
    // This replays the old parse: tool results and thinking with no content.
    const entry = manifest.fixtures.find((candidate) => candidate.source === "claude-code" && candidate.fixture === "rich-1")!;
    const lost = undeclaredLosses(entry, (sessions) => {
      for (const block of sessions.flatMap((session) => session.turns.flatMap((turn) => turn.blocks))) {
        if (block.kind !== "tool_result" && block.kind !== "thinking") continue;
        delete block.text;
        delete block.data;
      }
    }).map(({ value }) => value);
    expect(lost).toContain("export function parseBlock() { return copyTextOnly(); }");
    expect(lost).toContain("The importer probably copies only the text field of each block.");
    expect(lost).toContain("The screenshot tool timed out after capturing one frame.");
  });
});
