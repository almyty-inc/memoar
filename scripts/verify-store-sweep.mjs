#!/usr/bin/env node
/**
 * Every file of a store, not the newest one, through the path an agent upload
 * takes: the bare tool name into format detection, then the parser.
 *
 * `verify-parsers-locally.mjs` reads one file per source, which cannot notice
 * that most of a store is in a layout capture never named. Codex was exactly
 * that: 3,405 of 3,879 rollouts on one machine were `.jsonl.zst`, and the one
 * file the other script picked was always a plain one.
 *
 * Read-only. It never copies a store and prints only counts:
 *
 *   npm run build --workspace @memoar/server
 *   node scripts/verify-store-sweep.mjs
 *
 * Compressed rollouts are decompressed here with Node's own zstd, which is a
 * different decoder from the agent's, and the total and digest of the
 * plaintext are printed so the agent's decoder can be compared against it
 * (`cargo test -p memoar-daemon -- --ignored zstd_sweep`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import { ParserRegistry } from "../server/dist/libs/parsers/src/index.js";
import { FormatDetector } from "../server/dist/src/ingest/format-detection.js";

const home = process.env.MEMOAR_SWEEP_HOME ?? homedir();
/** The ceiling the archive accepts, `MEMOAR_MAX_ARTIFACT_BYTES`'s default. */
const MAX_ARTIFACT_BYTES = 256 * 1024 * 1024;

function walk(root, depth, keep, found = []) {
  if (depth < 0) return found;
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) walk(path, depth - 1, keep, found);
    else if (entry.isFile() && keep(path)) found.push(path);
  }
  return found.sort();
}

const vscode = ["Library/Application Support/Code/User", ".config/Code/User", "AppData/Roaming/Code/User"]
  .map((path) => join(home, path)).find(existsSync);

const SWEEPS = [
  {
    source: "codex",
    files: () => walk(join(home, ".codex/sessions"), 4, (path) => /\/rollout-[^/]*\.jsonl(\.zst)?$/u.test(path)),
  },
  {
    source: "antigravity-cli",
    files: () => walk(join(home, ".gemini/antigravity-cli/brain"), 4, (path) => path.endsWith("/.system_generated/logs/transcript.jsonl")),
  },
  {
    source: "copilot",
    files: () => [
      ...walk(join(home, ".copilot/session-state"), 2, (path) => path.endsWith("/events.jsonl")),
      ...[join(home, ".copilot/session-store.db")].filter(existsSync),
      ...(vscode ? walk(join(vscode, "workspaceStorage"), 2, (path) => /\/chatSessions\/[^/]+\.jsonl?$/u.test(path)) : []),
      ...(vscode ? walk(join(vscode, "globalStorage/emptyWindowChatSessions"), 0, (path) => /\.jsonl?$/u.test(path)) : []),
    ],
  },
  {
    source: "opencode",
    files: () => walk(join(home, ".local/share/opencode"), 0, (path) => /\/opencode(-[^/]+)?\.db$/u.test(path)),
  },
  {
    source: "kilo",
    files: () => walk(join(home, ".local/share/kilo"), 0, (path) => /\/kilo(-[^/]+)?\.db$/u.test(path)),
  },
];

const seed = {
  id: "0191cafe-0000-7000-8000-0000000000f0",
  source: { vendor: "local", tool: "local", version: "v1", machineId: "0191cafe-0000-7000-8000-0000000000f1", nativeSessionId: "local" },
  workspace: { path: "/workspace" },
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  title: "local verification",
  models: [],
  tokenTotals: { input: 0, output: 0 },
  provenance: [],
  visibility: { scope: "private", ownerId: "0191cafe-0000-7000-8000-0000000000f2" },
};

const detector = new FormatDetector();
const registry = new ParserRegistry();
let failed = false;

for (const sweep of SWEEPS) {
  const files = sweep.files();
  const tally = { files: files.length, compressed: 0, parsed: 0, empty: 0, unknown: 0, tooLarge: 0, sessions: 0, turns: 0, withModel: 0, assistant: 0 };
  const diagnostics = new Map();
  const digest = createHash("sha256");
  let plaintext = 0;
  for (const file of files) {
    let raw = readFileSync(file);
    if (file.endsWith(".zst")) {
      tally.compressed += 1;
      raw = zstdDecompressSync(raw);
      digest.update(createHash("sha256").update(raw).digest());
      plaintext += raw.byteLength;
    }
    // The agent refuses these before upload, so they are not the parser's.
    if (raw.byteLength > MAX_ARTIFACT_BYTES) {
      tally.tooLarge += 1;
      continue;
    }
    const format = detector.detect(sweep.source, raw);
    const result = registry.parse({ ...format, raw, seed });
    if (result.kind === "parsed") {
      tally.parsed += 1;
      for (const session of result.sessions) {
        tally.sessions += 1;
        tally.turns += session.turns.length;
        for (const turn of session.turns) {
          if (turn.role !== "assistant") continue;
          tally.assistant += 1;
          if (turn.model) tally.withModel += 1;
        }
      }
    } else if (result.kind === "empty") {
      tally.empty += 1;
    } else {
      tally.unknown += 1;
      // The diagnostic names a shape, never content: parsers sanitise samples.
      const key = `${format.version}: ${result.diagnostic.slice(0, 90)}`;
      diagnostics.set(key, (diagnostics.get(key) ?? 0) + 1);
    }
  }
  if (tally.unknown > 0) failed = true;
  console.log(`${sweep.source.padEnd(16)} ${JSON.stringify(tally)}`);
  for (const [key, count] of diagnostics) console.log(`  ${count} x ${key}`);
  if (tally.compressed > 0) {
    console.log(`  zstd plaintext: ${plaintext} bytes, digest ${digest.digest("hex").slice(0, 16)}`);
  }
}

process.exit(failed ? 1 : 0);
