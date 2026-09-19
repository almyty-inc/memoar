import { readFile, readdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testRoot = resolve(dirname(fileURLToPath(import.meta.url)));

/**
 * Two suites on one port.
 *
 * Every Postgres-backed suite starts its own throwaway container so the files
 * can run in parallel, and each one picks a host port by writing a number into
 * its own file. Nothing compared those numbers. Reusing one is invisible alone
 * and fails in CI as `docker run` refusing to bind — in whichever of the two
 * suites happened to start second, which is not the one that took the port.
 *
 * It has happened. The numbers live in eight files, so the check is mechanical.
 */
describe("the ports the Postgres test fixtures bind", () => {
  it("are not shared between suites", async () => {
    const claims = new Map<number, string[]>();
    for (const entry of await readdir(testRoot, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const file = resolve(entry.parentPath, entry.name);
      for (const match of (await readFile(file, "utf8")).matchAll(/\bport\s*[:=]\s*(55\d{3})\b/giu)) {
        const port = Number(match[1]);
        claims.set(port, [...(claims.get(port) ?? []), entry.name]);
      }
    }
    expect(claims.size, "no fixture ports were found; has the shape changed?").toBeGreaterThan(5);
    const shared = [...claims].filter(([, files]) => new Set(files).size > 1);
    expect(shared, "these host ports are claimed by more than one suite").toEqual([]);
  });
});
