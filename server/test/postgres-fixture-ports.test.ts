import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const testRoot = resolve(dirname(fileURLToPath(import.meta.url)));
const thisFile = fileURLToPath(import.meta.url);

/**
 * No Postgres test fixture chooses its own host port.
 *
 * Every suite used to pin one in 55979-55996, and CI failed with `docker run`
 * exiting 125 after creating the container: the port could not be published.
 * Pinning a port loses twice. Two suites can pick the same number, and the
 * range sits inside Linux's ephemeral port range, so an unrelated outbound
 * connection on the runner can hold it. Both failures showed up in jobs where
 * the failing suite was the only one using its port.
 *
 * The containers are started in one place, which asks Docker for a free
 * loopback port and reads it back. This keeps it that way.
 */
describe("the host ports the Postgres test fixtures publish", () => {
  it("are picked by Docker in one helper, never pinned by a suite", async () => {
    const publishers: string[] = [];
    const pinned: string[] = [];
    for (const entry of await readdir(testRoot, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
      const file = resolve(entry.parentPath, entry.name);
      if (file === thisFile) continue;
      const source = await readFile(file, "utf8");
      const name = relative(testRoot, file);
      if (/"-p",/u.test(source)) publishers.push(name);
      if (/\bport\s*[:=]\s*\d{4,5}\b/iu.test(source) && /docker|postgres/iu.test(source)) pinned.push(name);
    }
    expect(publishers, "only the docker helper publishes a container port").toEqual(["helpers/docker.ts"]);
    expect(pinned, "these suites pin a host port for a container").toEqual([]);
    const helper = await readFile(resolve(testRoot, "helpers/docker.ts"), "utf8");
    expect(helper, "the helper lets Docker pick a loopback port").toContain(`"-p", "127.0.0.1::5432"`);
  });
});
