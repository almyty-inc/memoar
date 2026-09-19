import type { ConversionBundle } from "./types.js";

/**
 * The prefix each native target's materializer pins, from
 * `agent/crates/memoar-materializer/src/paths.rs`.
 */
const TARGET_PREFIXES: Record<string, string> = {
  "claude-code": ".claude/projects/",
  codex: ".codex/sessions/",
  "antigravity-cli": ".gemini/antigravity-cli/brain/",
};

/** APFS, ext4 and NTFS all stop a single path component here. */
const MAX_COMPONENT_BYTES = 255;

/**
 * Refuses a bundle the machine would refuse, at the moment it is built.
 *
 * Everything the materializer checks about a path it checks after the download,
 * on somebody's laptop, where no test runs — so a path this half gets wrong is
 * a conversion that succeeds in CI, reports `ready`, hands out a pre-signed URL
 * and then fails on every machine that fetches it. Two such paths shipped: an
 * unbounded workspace component that died with `File name too long`, and there
 * is nothing structural stopping a third.
 *
 * Checked here rather than after the upload, because a bundle already in object
 * storage with a `ready` job pointing at it is a promise this service cannot
 * keep.
 */
export function assertMaterializablePaths(bundle: ConversionBundle): void {
  const prefix = TARGET_PREFIXES[bundle.target];
  // An injection prelude is pasted by hand, never materialized, so it has no
  // path rules to meet.
  if (!prefix) return;
  for (const file of bundle.files) {
    const relative = file.path.startsWith("~/") ? file.path.slice(2) : null;
    if (relative === null || !relative.startsWith(prefix)) {
      throw new Error(`conversion_path_outside_target:${file.path}`);
    }
    if (!relative.includes(bundle.sessionId)) {
      throw new Error(`conversion_path_missing_session_id:${file.path}`);
    }
    for (const component of relative.split("/")) {
      if (component === "" || component === "." || component === "..") {
        throw new Error(`conversion_path_not_normal:${file.path}`);
      }
      const size = Buffer.byteLength(component, "utf8");
      if (size > MAX_COMPONENT_BYTES) {
        throw new Error(`conversion_path_component_too_long:${size}:${file.path}`);
      }
    }
  }
}
