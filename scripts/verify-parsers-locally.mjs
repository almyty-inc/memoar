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
 * "verified" and "not checked" must never look the same.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ParserRegistry } from "../server/dist/libs/parsers/src/index.js";
import { isUuid } from "../server/dist/libs/parsers/src/common.js";

const home = homedir();

/**
 * Where each tool keeps what it wrote.
 *
 * `pick` returns the single file to hand the parser, or null when the store
 * exists but holds nothing yet — a tool installed and never used is not
 * evidence either way.
 */
const SOURCES = [
  {
    source: "opencode",
    version: "v1",
    store: join(home, ".local/share/opencode"),
    pick: (dir) => (existsSync(join(dir, "opencode.db")) ? join(dir, "opencode.db") : null),
  },
  {
    source: "crush",
    version: "v1",
    // Per project rather than per user, so this looks for the most recently
    // written one under the workspace root.
    store: join(home, "workspace"),
    pick: (dir) => newestUnder(dir, (path) => path.endsWith("/.crush/crush.db"), 3),
  },
  {
    source: "claude-code",
    version: "v1",
    store: join(home, ".claude/projects"),
    pick: (dir) => newestUnder(dir, (path) => path.endsWith(".jsonl"), 3),
  },
  {
    source: "codex",
    version: "rollout-v1",
    store: join(home, ".codex/sessions"),
    pick: (dir) => newestUnder(dir, (path) => path.endsWith(".jsonl"), 5),
  },
  {
    source: "antigravity-cli",
    version: "v1",
    // The path the agent's own connector watches, so this checks the same file
    // capture would upload rather than one chosen to be convenient.
    store: join(home, ".gemini/antigravity-cli/brain"),
    pick: (dir) => newestUnder(dir, (path) => path.endsWith("/.system_generated/logs/transcript.jsonl"), 4),
  },
  {
    source: "zed",
    version: "v1",
    store: join(home, "Library/Application Support/Zed"),
    pick: (dir) => newestUnder(dir, (path) => path.endsWith(".db") && path.includes("threads"), 3),
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
  if (!existsSync(entry.store)) {
    rows.push({ source: entry.source, result: "skipped", detail: "not installed on this machine" });
    continue;
  }
  const file = entry.pick(entry.store);
  if (!file) {
    rows.push({ source: entry.source, result: "skipped", detail: "installed, but has written nothing yet" });
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
  rows.push({
    source: entry.source,
    result: unstorable.length === 0 ? "ok" : "FAILED",
    detail: `${parsed.sessions.length} sessions, ${turns} turns, ${blocks} blocks`
      + (unstorable.length ? `, ${unstorable.length} ids a uuid column would refuse` : ""),
  });
}

for (const row of rows) {
  console.log(`${row.source.padEnd(14)} ${row.result.padEnd(8)} ${row.detail}`);
}

const checked = rows.filter((row) => row.result !== "skipped").length;
console.log(`\n${checked} of ${rows.length} parsers checked against real data on this machine.`);
process.exit(failed ? 1 : 0);
