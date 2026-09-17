import type { MemoryDocument } from "../../libs/canonical/src/generated.js";

/**
 * Which captured instruction files a caller is asking about.
 *
 * `machineId` and `scope` are columns and are pushed to the store; `workspacePath`
 * and `pathPattern` are matched here, over the tenant-scoped listing, so that a
 * caller-supplied pattern never becomes part of a query.
 */
export interface MemoryDocumentFilter {
  machineId?: string;
  scope?: string;
  workspacePath?: string;
  pathPattern?: string;
}

/**
 * Compiles a glob of the kind people write for filenames — `*` and `?`, nothing
 * else — into an anchored expression.
 *
 * Every other character is escaped, so a pattern is a pattern over names and
 * cannot smuggle in alternation, backreferences or a nested quantifier: the
 * result has no construct that can backtrack exponentially, whatever is typed.
 * The DTO bounds the length before this is ever called.
 */
export function compilePathPattern(pattern: string): RegExp {
  const source = [...pattern]
    .map((character) => {
      if (character === "*") return ".*";
      if (character === "?") return ".";
      return character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    })
    .join("");
  return new RegExp(`^${source}$`, "iu");
}

function basenameOf(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

/**
 * Whether one document answers the parts of a filter the store did not apply.
 *
 * A pattern is tried against the whole path and against the file's name, because
 * `CLAUDE.md` is what a person means and `/workspace/*` is what they mean too.
 */
export function matchesMemoryFilter(document: MemoryDocument, filter: MemoryDocumentFilter): boolean {
  if (filter.workspacePath && document.workspacePath !== filter.workspacePath) return false;
  if (!filter.pathPattern) return true;
  const expression = compilePathPattern(filter.pathPattern);
  return expression.test(document.path) || expression.test(basenameOf(document.path));
}
