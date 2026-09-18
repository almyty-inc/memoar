#!/usr/bin/env node
/**
 * Runs each parser against the real native store of a tool installed on this
 * machine.
 *
 * Every fixture in contracts/fixtures was written by whoever wrote the parser
 * it tests, which means the fixture proves the parser agrees with its author
 * and nothing else. That is not a hypothetical weakness: opencode numbers its
 * messages `msg_00f6cbeba001…`, not as uuids, and the fixture used uuids —
 * so a real opencode session was refused by the database after parsing
 * perfectly, and no test in this repository could have caught it.
 *
 * This reads the stores the tools actually wrote. It never copies them, never
 * prints their contents, and reports only counts and whether every identifier
 * it produced can be stored. Run it on a machine where the tools are used:
 *
 *   node scripts/verify-parsers-locally.mjs
 *
 * A tool that is not installed is skipped and said to be skipped, because
 * "verified" and "not checked" must never look the same. So is a store that
 * opens and holds no exchange. Every source the capture agent knows is listed,
 * and the ones still unverified are printed last with what a person who has the
 * tool must do — that list is the work, not a footnote to it.
 *
 * What it cannot see: whether the capture agent points at the file this script
 * hands the parser. That is scripts/check-capture-parser-agreement.mjs, which
 * runs in CI; this needs the tool installed and so it cannot.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ParserRegistry } from "../server/dist/libs/parsers/src/index.js";
import { isUuid } from "../server/dist/libs/parsers/src/common.js";

const home = homedir();

/** The first of these directories that exists, or null. */
function firstStore(candidates) {
  return candidates.map((path) => join(home, path)).find((path) => existsSync(path)) ?? null;
}

/**
 * Where each tool keeps what it wrote.
 *
 * `stores` are the candidate roots, most specific first, because the same tool
 * sits in a different place on Linux, macOS and Windows. `pick` returns the
 * single file to hand the parser, or null when the store exists but holds
 * nothing yet — a tool installed and never used is not evidence either way.
 *
 * `todo` is what a person who has the tool must actually do. Every source the
 * agent captures is listed, including the ones nobody here runs: a source
 * missing from this list looks verified by being absent, and
 * contracts/fixtures/PROVENANCE.md sends people here to verify exactly those.
 */
const SOURCES = [
  {
    source: "opencode",
    version: "v1",
    stores: [".local/share/opencode", "AppData/Roaming/opencode"],
    pick: (dir) => (existsSync(join(dir, "opencode.db")) ? join(dir, "opencode.db") : null),
  },
  {
    source: "crush",
    version: "v1",
    // Per project rather than per user, so this looks for the most recently
    // written one under the workspace root.
    stores: ["workspace"],
    pick: (dir) => newestUnder(dir, (path) => path.endsWith("/.crush/crush.db"), 3),
  },
  {
    source: "claude-code",
    version: "v1",
    stores: [".claude/projects"],
    pick: (dir) => newestUnder(dir, (path) => path.endsWith(".jsonl"), 3),
  },
  {
    source: "codex",
    version: "rollout-v1",
    stores: [".codex/sessions"],
    pick: (dir) => newestUnder(dir, (path) => path.endsWith(".jsonl"), 5),
  },
  {
    source: "antigravity-cli",
    version: "v1",
    // The path the agent's own connector watches, so this checks the same file
    // capture would upload rather than one chosen to be convenient.
    stores: [".gemini/antigravity-cli/brain"],
    pick: (dir) => newestUnder(dir, (path) => path.endsWith("/.system_generated/logs/transcript.jsonl"), 4),
  },
  {
    source: "zed",
    version: "v1",
    stores: ["Library/Application Support/Zed/threads", ".local/share/zed/threads"],
    pick: (dir) => newestUnder(dir, (path) => path.endsWith(".db"), 2),
  },
  // Below this line, nothing has ever been run against real data. These are the
  // sources PROVENANCE.md lists as written from the format, and the whole point
  // of this script is that somebody with the tool can finish the job in an hour.
  {
    source: "cursor",
    version: "v3",
    stores: [
      "Library/Application Support/Cursor/User",
      ".config/Cursor/User",
      "AppData/Roaming/Cursor/User",
    ],
    // The conversation is `composerData:` rows indexing `bubbleId:` rows, both
    // in `cursorDiskKV`. globalStorage holds it; workspaceStorage is a fallback.
    pick: (dir) => (existsSync(join(dir, "globalStorage/state.vscdb"))
      ? join(dir, "globalStorage/state.vscdb")
      : newestUnder(join(dir, "workspaceStorage"), (path) => path.endsWith("state.vscdb"), 2)),
    todo: "Install Cursor, hold one conversation with the agent, quit Cursor so it flushes, and re-run this.",
  },
  {
    source: "copilot",
    version: "v1",
    stores: [".copilot"],
    pick: (dir) => (existsSync(join(dir, "session-store.db")) ? join(dir, "session-store.db") : null),
    // The schema was read off an installed CLI whose `turns` table was empty,
    // so the columns are right and the mapping of a populated session is not.
    todo: "Install GitHub Copilot CLI, hold one conversation that records exchanges (~/.copilot/session-store.db must have rows in `turns`), and re-run this. Separately, the capture patterns also collect VS Code `chatSessions/*.json`, which this parser refuses outright — see UNSETTLED in scripts/check-capture-parser-agreement.mjs.",
  },
  {
    source: "goose",
    version: "v1",
    stores: [".local/share/goose/sessions", "AppData/Roaming/Block/goose/data/sessions"],
    pick: (dir) => newestUnder(dir, (path) => path.endsWith(".db"), 1),
    todo: "brew install block-goose-cli, hold one session, and re-run this. While there, list ~/.local/share/goose/sessions: the capture patterns still collect *.jsonl, which this parser refuses, and nobody here can say whether goose still writes one.",
  },
  {
    source: "roo",
    version: "v1",
    stores: [
      "Library/Application Support/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
      ".config/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
      "AppData/Roaming/Code/User/globalStorage/rooveterinaryinc.roo-cline/tasks",
    ],
    // The parser reads the Anthropic message array, which is this file and not
    // the `ui_messages.json` beside it.
    pick: (dir) => newestUnder(dir, (path) => path.endsWith("api_conversation_history.json"), 2),
    todo: "Install Roo Code in VS Code, run one task, and re-run this. Also list one tasks/<id> directory: the pattern takes every *.json in it, and the parser reads only api_conversation_history.json.",
  },
  {
    source: "kilo",
    version: "v1",
    stores: [
      "Library/Application Support/Code/User/globalStorage/kilocode.kilo-code/tasks",
      ".config/Code/User/globalStorage/kilocode.kilo-code/tasks",
      "AppData/Roaming/Code/User/globalStorage/kilocode.kilo-code/tasks",
    ],
    pick: (dir) => newestUnder(dir, (path) => path.endsWith("api_conversation_history.json"), 2),
    todo: "Install Kilo Code in VS Code, run one task, and re-run this. Same question about the other *.json in tasks/<id> as for Roo.",
  },
];

/** The most recently modified matching file, without walking the whole disk. */
function newestUnder(root, matches, depth) {
  let best = null;
  const walk = (dir, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, level + 1);
      else if (matches(path)) {
        try {
          const at = statSync(path).mtimeMs;
          if (!best || at > best.at) best = { path, at };
        } catch { /* vanished between listing and stat */ }
      }
    }
  };
  walk(root, 0);
  return best?.path ?? null;
}

const seed = {
  id: "0191cafe-0000-7000-8000-0000000000f0",
  source: { vendor: "local", tool: "local", version: "v1", machineId: "0191cafe-0000-7000-8000-0000000000f1", nativeSessionId: "local" },
  workspace: { path: "/workspace" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  title: "local verification",
  models: ["unknown"],
  tokenTotals: { input: 0, output: 0 },
  provenance: [],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-0000000000f2" },
  turns: [],
};

const registry = new ParserRegistry();
const rows = [];
let failed = false;

for (const entry of SOURCES) {
  const store = firstStore(entry.stores);
  if (!store) {
    rows.push({ source: entry.source, result: "skipped", detail: "not installed on this machine", todo: entry.todo });
    continue;
  }
  const file = entry.pick(store);
  if (!file) {
    rows.push({ source: entry.source, result: "skipped", detail: "installed, but has written nothing yet", todo: entry.todo });
    continue;
  }

  const parsed = registry.parse({ source: entry.source, version: entry.version, raw: readFileSync(file), seed });
  if (parsed.kind !== "parsed") {
    failed = true;
    rows.push({ source: entry.source, result: "FAILED", detail: parsed.diagnostic ?? "not parsed" });
    continue;
  }

  let turns = 0;
  let blocks = 0;
  const unstorable = [];
  for (const session of parsed.sessions) {
    if (!isUuid(session.id)) unstorable.push("session");
    for (const turn of session.turns) {
      turns += 1;
      if (!isUuid(turn.id)) unstorable.push("turn");
      if (turn.parentId && !isUuid(turn.parentId)) unstorable.push("parent");
      for (const block of turn.blocks) {
        blocks += 1;
        if (!isUuid(block.id)) unstorable.push("block");
      }
    }
  }

  // An id a uuid column refuses means the whole session is accepted, parsed,
  // and then never archived — the failure this script exists to catch.
  if (unstorable.length > 0) failed = true;
  // A store that opened and yielded no turn has verified the session half of
  // the schema and nothing else. Copilot is exactly this: the columns were read
  // off an installed CLI whose `turns` table was empty, so a green line here
  // would say the mapping works when nothing has ever been mapped.
  const result = unstorable.length > 0 ? "FAILED" : turns === 0 ? "empty" : "ok";
  rows.push({
    source: entry.source,
    result,
    detail: `${parsed.sessions.length} sessions, ${turns} turns, ${blocks} blocks`
      + (unstorable.length ? `, ${unstorable.length} ids a uuid column would refuse` : "")
      + (result === "empty" ? " — the store opened and held no exchange, so only the session row is verified" : ""),
    ...(result === "empty" ? { todo: entry.todo } : {}),
  });
}

for (const row of rows) {
  console.log(`${row.source.padEnd(16)} ${row.result.padEnd(8)} ${row.detail}`);
}

const checked = rows.filter((row) => row.result === "ok" || row.result === "FAILED").length;
console.log(`\n${checked} of ${rows.length} parsers checked against real data on this machine.`);

// The skipped ones are the whole reason this file exists, so they get the last
// word rather than a silent absence. Each line is one person-hour of work that
// would move a parser out of "written from the format" in PROVENANCE.md.
const waiting = rows.filter((row) => row.result !== "ok" && row.result !== "FAILED" && row.todo);
if (waiting.length > 0) {
  console.log("\nStill unverified. On a machine with the tool:\n");
  for (const row of waiting) console.log(`  ${row.source}: ${row.todo}`);
  console.log("\nThen update the tables in contracts/fixtures/PROVENANCE.md with what you saw.");
}

process.exit(failed ? 1 : 0);
