import type { MemoryScope } from "../../libs/canonical/src/generated.js";

/**
 * Which tool's dialect a captured instruction file is written in.
 *
 * Every id here is a `readers` entry the capture agent stamps onto a memory
 * document, which is the only thing that ties a file to a tool. The list is
 * held to `memoar-connectors/src/memory_files.rs` by a test, because a tool
 * spelled one way in Rust and another way here is the shape of bug that has
 * already cost this repository a broken `memoar login` and a batch of inert API
 * keys.
 */
export const MEMORY_SOURCE_TOOLS = [
  "antigravity-cli",
  "claude-code",
  "codex",
  "copilot",
  "crush",
  "cursor",
  "goose",
  "kilo",
  "opencode",
  "roo",
  "zed",
] as const;

export type MemorySourceTool = (typeof MEMORY_SOURCE_TOOLS)[number];

/**
 * The dialects a conversion may be written *into*.
 *
 * `cursor` reads instructions only from `.cursor/rules/**\/*.mdc`, and Cursor
 * ignores a file there that carries no frontmatter — the connector table says
 * so in as many words. Writing one would mean inventing frontmatter, which the
 * decision behind this feature rules out; writing one without frontmatter would
 * put the user's words somewhere Cursor silently never reads, which is worse
 * than refusing. So Cursor is a source and not a target, and that is the one
 * asymmetry in this table.
 */
export const MEMORY_DIALECTS = [
  "antigravity-cli",
  "claude-code",
  "codex",
  "copilot",
  "crush",
  "goose",
  "kilo",
  "opencode",
  "roo",
  "zed",
] as const;

export type MemoryDialect = (typeof MEMORY_DIALECTS)[number];

export function isMemoryDialect(value: string): value is MemoryDialect {
  return (MEMORY_DIALECTS as readonly string[]).includes(value);
}

export interface MemoryDestination {
  /**
   * `file` — the dialect reads exactly one path, so every selected document
   * lands in it and several of them concatenate.
   *
   * `directory` — the dialect reads a rules directory, so each document keeps
   * its own file and nothing is concatenated.
   */
  kind: "file" | "directory";
  /** Relative to the root the scope names: the home directory, or the workspace. */
  path: string;
}

/**
 * Where each dialect reads, per scope. Taken from the connector table and held
 * to it by a test: memoar only ever writes where its own capture already looks,
 * so a converted file is picked up on the next reading rather than becoming a
 * copy nobody tracks.
 *
 * A scope missing from a dialect means that tool has no such file. Copilot,
 * Goose and Zed document no user-wide path; Roo and Kilo read the same rules
 * directory in both scopes.
 */
export const MEMORY_DIALECT_PATHS: Record<MemoryDialect, Partial<Record<MemoryScope, MemoryDestination>>> = {
  "antigravity-cli": {
    global: { kind: "file", path: ".gemini/GEMINI.md" },
    project: { kind: "file", path: "GEMINI.md" },
  },
  "claude-code": {
    global: { kind: "file", path: ".claude/CLAUDE.md" },
    project: { kind: "file", path: "CLAUDE.md" },
  },
  codex: {
    global: { kind: "file", path: ".codex/AGENTS.md" },
    project: { kind: "file", path: "AGENTS.md" },
  },
  copilot: {
    project: { kind: "file", path: ".github/copilot-instructions.md" },
  },
  crush: {
    global: { kind: "file", path: ".config/crush/CRUSH.md" },
    project: { kind: "file", path: "AGENTS.md" },
  },
  goose: {
    project: { kind: "file", path: ".goosehints" },
  },
  kilo: {
    global: { kind: "directory", path: ".kilocode/rules" },
    project: { kind: "directory", path: ".kilocode/rules" },
  },
  opencode: {
    global: { kind: "file", path: ".config/opencode/AGENTS.md" },
    project: { kind: "file", path: "AGENTS.md" },
  },
  roo: {
    global: { kind: "directory", path: ".roo/rules" },
    project: { kind: "directory", path: ".roo/rules" },
  },
  zed: {
    project: { kind: "file", path: ".rules" },
  },
};

export function memoryDestination(dialect: MemoryDialect, scope: MemoryScope): MemoryDestination | undefined {
  return MEMORY_DIALECT_PATHS[dialect][scope];
}

/**
 * The prefix a wire path carries so the root it is relative to is never
 * guessed. `~/` is the home directory, `./` is the workspace the conversion
 * named — the same two roots the scopes mean.
 */
export function rootPrefix(scope: MemoryScope): "~/" | "./" {
  return scope === "global" ? "~/" : "./";
}

/**
 * The maximum length of a generated rules filename.
 *
 * ext4 and APFS both stop at 255 bytes for one component, and a global memory
 * file's path can be much longer than that once the directories are flattened
 * into it. The tail is kept rather than the head because the tail is the part
 * that names the file.
 */
const MAX_RULES_NAME = 120;

/**
 * The filename one source document takes inside a rules directory.
 *
 * Derived from the source path alone, so the same file converts to the same
 * name every time and a second conversion is a no-op rather than a second copy
 * under a new name. Restricted to `[a-z0-9-]` and one `.md`, which is also the
 * shape the materializer will accept for a path inside a rules directory.
 */
export function rulesFileName(sourcePath: string): string {
  const slug = sourcePath
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, "-")
    .replaceAll(/^-+|-+$/gu, "");
  const trimmed = slug.slice(-MAX_RULES_NAME).replaceAll(/^-+/gu, "");
  return `${trimmed || "memory"}.md`;
}
