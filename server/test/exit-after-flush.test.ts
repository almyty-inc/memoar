import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The artifact cleanup's dry run on dev came back cut off at 65,536 bytes,
 * because the script called `process.exit` while most of its report still sat
 * in the pipe. This prints far more than a pipe buffer through a pipe, exits
 * through the helper, and requires every byte on the other end.
 */
const SCRIPT = `
import { exitAfterFlush } from ${JSON.stringify(resolve(process.cwd(), "src/exit-after-flush.ts"))};
process.stdout.write("x".repeat(${4 * 1024 * 1024}));
process.stdout.write("END");
await exitAfterFlush(3);
`;

function run(): Promise<{ bytes: number; tail: string; code: number | null }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", SCRIPT], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let bytes = 0;
    let tail = "";
    child.stdout.on("data", (chunk: Buffer) => {
      bytes += chunk.length;
      tail = (tail + chunk.toString("utf8")).slice(-3);
    });
    child.on("error", fail);
    child.on("close", (code) => done({ bytes, tail, code }));
  });
}

describe("exitAfterFlush", () => {
  it("lets a piped report of several megabytes arrive whole before exiting", async () => {
    const result = await run();
    expect(result.bytes).toBe(4 * 1024 * 1024 + 3);
    expect(result.tail).toBe("END");
    expect(result.code).toBe(3);
  }, 30_000);
});
