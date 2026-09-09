#!/usr/bin/env node
/**
 * Asks whether the words the tool wrote are still there afterwards.
 *
 * Everything else in this repository grades itself. The parsers, their tests,
 * their fixtures and the verification script were all written by the same hand,
 * so "the parser works" has meant "the parser agrees with its author" — and a
 * parser that silently dropped half a conversation would pass every check,
 * because the checks ask about identifiers and counts, which is what its author
 * thought to ask about.
 *
 * This asks something the author does not get to define. It pulls the long text
 * strings out of the tool's own store, without going through any memoar code,
 * then asks what fraction of them can be found in the archived session. A
 * parser that reads a transcript and keeps only half of it scores 50% no matter
 * what its author believed.
 *
 * It is not proof of correctness: text can survive while being attributed to
 * the wrong speaker, ordered wrongly, or split badly. It is a floor, and the
 * floor was missing.
 *
 *   node scripts/parser-coverage.mjs
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { join } from "node:path";
import { ParserRegistry } from "../server/dist/libs/parsers/src/index.js";

const home = homedir();

/** Long enough that finding it by accident is not plausible. */
const MIN_LENGTH = 60;
/** Enough to judge a parser; more only makes the run slower. */
const MAX_SAMPLES = 400;

function newestUnder(root, matches, depth) {
  let best = null;
  const walk = (dir, level) => {
    if (level > depth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path, level + 1);
      else if (matches(path)) {
        try {
          const at = statSync(path).mtimeMs;
          if (!best || at > best.at) best = { path, at };
        } catch { /* vanished */ }
      }
    }
  };
  walk(root, 0);
  return best?.path ?? null;
}

/**
 * Every long string in a JSON document, wherever it is nested.
 *
 * Deliberately structure-blind: it does not know which field a transcript keeps
 * its text in, which is exactly the knowledge that would make this agree with
 * the parser by construction.
 */
/**
 * Strings that are not content, however long they are.
 *
 * Two kinds, and excluding them is structural rather than parser-specific — no
 * knowledge of which field any tool keeps its text in:
 *
 *   - A serialized object or array. These stores keep JSON in text columns, so
 *     the container comes back as a long string; its leaves are extracted
 *     separately and are the actual content. Counting the container asks the
 *     archive to contain a verbatim copy of the tool's storage format, which is
 *     not what archiving means.
 *   - A base64 blob. Claude Code stores a signature for each thinking block —
 *     a few hundred characters of opaque bytes that are a cryptographic
 *     artefact, not something anybody wrote.
 */
function isNotContent(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object") return true;
    } catch { /* looked like JSON and was not, so it is text */ }
  }
  // No whitespace at all, and only base64's alphabet, over a long run.
  return /^[A-Za-z0-9+/=]{120,}$/u.test(trimmed);
}

function stringsFromJson(value, into) {
  if (typeof value === "string") {
    // JSON kept inside a string is how every one of these stores keeps a tool
    // call's arguments. Skipping the container without descending into it lost
    // the commands, which is the opposite of what this is measuring.
    const trimmed = value.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      try {
        const parsed = JSON.parse(trimmed);
        if (parsed && typeof parsed === "object") {
          stringsFromJson(parsed, into);
          return;
        }
      } catch { /* looked like JSON and was not */ }
    }
    if (value.length >= MIN_LENGTH && !isNotContent(value)) into.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) stringsFromJson(entry, into);
    return;
  }
  if (value && typeof value === "object") {
    for (const entry of Object.values(value)) stringsFromJson(entry, into);
  }
}

function stringsFromJsonl(path) {
  const found = new Set();
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      stringsFromJson(JSON.parse(line), found);
    } catch { /* a partial last line is normal in a live transcript */ }
  }
  return found;
}

/** Every long text value in every table, again without knowing the schema. */
function stringsFromSqlite(path) {
  const found = new Set();
  const database = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type='table'").all();
    for (const { name } of tables) {
      let rows;
      try {
        rows = database.prepare(`SELECT * FROM "${name}" LIMIT 2000`).all();
      } catch { continue; }
      for (const row of rows) {
        for (const value of Object.values(row)) {
          if (typeof value !== "string") continue;
          if (value.length >= MIN_LENGTH && !isNotContent(value)) found.add(value);
          // Columns that hold JSON are common in these stores, and the text
          // inside them is the conversation.
          if (value.startsWith("{") || value.startsWith("[")) {
            try { stringsFromJson(JSON.parse(value), found); } catch { /* not JSON */ }
          }
        }
      }
    }
  } finally {
    database.close();
  }
  return found;
}

const SOURCES = [
  { source: "opencode", version: "v1", store: join(home, ".local/share/opencode"),
    pick: (dir) => (existsSync(join(dir, "opencode.db")) ? join(dir, "opencode.db") : null), read: stringsFromSqlite },
  { source: "crush", version: "v1", store: join(home, "workspace"),
    pick: (dir) => newestUnder(dir, (p) => p.endsWith("/.crush/crush.db"), 3), read: stringsFromSqlite },
  { source: "claude-code", version: "v1", store: join(home, ".claude/projects"),
    pick: (dir) => newestUnder(dir, (p) => p.endsWith(".jsonl"), 3), read: stringsFromJsonl },
  { source: "codex", version: "rollout-v1", store: join(home, ".codex/sessions"),
    pick: (dir) => newestUnder(dir, (p) => p.endsWith(".jsonl"), 5), read: stringsFromJsonl },
  { source: "antigravity-cli", version: "v1", store: join(home, ".gemini/antigravity-cli/brain"),
    pick: (dir) => newestUnder(dir, (p) => p.endsWith("/.system_generated/logs/transcript.jsonl"), 4), read: stringsFromJsonl },
  { source: "zed", version: "v1", store: join(home, "Library/Application Support/Zed"),
    pick: (dir) => newestUnder(dir, (p) => p.endsWith(".db") && p.includes("threads"), 3), read: stringsFromSqlite },
];

const seed = {
  id: "0191cafe-0000-7000-8000-0000000000f0",
  source: { vendor: "local", tool: "local", version: "v1", machineId: "0191cafe-0000-7000-8000-0000000000f1", nativeSessionId: "local" },
  workspace: { path: "/workspace" },
  createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
  title: "coverage", models: ["unknown"], tokenTotals: { input: 0, output: 0 }, provenance: [],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-0000000000f2" }, turns: [],
};

const registry = new ParserRegistry();
let worst = 100;

for (const entry of SOURCES) {
  if (!existsSync(entry.store)) { console.log(`${entry.source.padEnd(16)} skipped   not installed`); continue; }
  const file = entry.pick(entry.store);
  if (!file) { console.log(`${entry.source.padEnd(16)} skipped   nothing written yet`); continue; }

  const original = entry.read(file);
  if (original.size === 0) { console.log(`${entry.source.padEnd(16)} skipped   no text long enough to check`); continue; }

  const parsed = registry.parse({ source: entry.source, version: entry.version, raw: readFileSync(file), seed });
  if (parsed.kind !== "parsed") { console.log(`${entry.source.padEnd(16)} FAILED    ${parsed.diagnostic ?? "not parsed"}`); worst = 0; continue; }

  // Everything the archive would hold for this session, as one haystack. Both
  // text and the data of a tool call, because a call's arguments are content
  // the tool wrote too.
  // Leaf strings, not JSON.stringify. Serialising escapes quotes and newlines,
  // so a command like `echo "hi"` would never be found inside it however
  // faithfully it had been archived — the first version of this reported that
  // as missing content, which it was not.
  const archivedParts = [];
  const collect = (value) => {
    if (typeof value === "string") { archivedParts.push(value); return; }
    if (Array.isArray(value)) { for (const entry of value) collect(entry); return; }
    if (value && typeof value === "object") { for (const entry of Object.values(value)) collect(entry); }
  };
  for (const session of parsed.sessions) {
    for (const turn of session.turns) {
      for (const block of turn.blocks) {
        if (block.text) archivedParts.push(block.text);
        if (block.data) collect(block.data);
        if (block.ext) collect(block.ext);
      }
    }
  }
  const archived = archivedParts.join("\n");

  const samples = [...original].slice(0, MAX_SAMPLES);
  const missing = samples.filter((text) => !archived.includes(text));
  const coverage = Math.round(((samples.length - missing.length) / samples.length) * 100);
  worst = Math.min(worst, coverage);

  console.log(
    `${entry.source.padEnd(16)} ${String(coverage).padStart(3)}%      `
    + `${samples.length - missing.length}/${samples.length} of the tool's own long strings are in the archive`,
  );
  // One example, truncated hard: enough to start looking, not enough to spill
  // somebody's source code into a terminal.
  if (missing.length > 0) console.log(`${" ".repeat(17)}first missing: ${JSON.stringify(missing[0].slice(0, 70))}…`);
}

console.log(`\nlowest coverage: ${worst}%`);
