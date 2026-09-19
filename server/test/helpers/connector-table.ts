import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";

const CONNECTOR_SRC = resolve(process.cwd(), "../agent/crates/memoar-connectors/src");

/**
 * The capture agent's connector table, found rather than addressed.
 *
 * These tests read a Rust file from TypeScript, so nothing the compiler or
 * `cargo test` does can notice when it moves — and it moved: the table lived in
 * `lib.rs` until that crate was split, and three tests started reporting that
 * the agent captures nothing at all. The message they printed, "has the table
 * moved?", was written by someone who saw this coming.
 *
 * So the directory is searched for the table instead of one filename being
 * trusted. Moving it between files in this crate is now free; deleting it still
 * fails loudly, which is the part worth failing on.
 */
export async function connectorTable(): Promise<string> {
  const entries = await readdir(CONNECTOR_SRC, { withFileTypes: true });
  const sources = await Promise.all(
    entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".rs"))
      .map(async (entry) => readFile(resolve(CONNECTOR_SRC, entry.name), "utf8")),
  );
  const table = sources.filter((text) => text.includes("SourceSpec {"));
  if (table.length === 0) {
    throw new Error(`no SourceSpec table under ${CONNECTOR_SRC}; has the connector table been deleted?`);
  }
  return table.join("\n");
}
