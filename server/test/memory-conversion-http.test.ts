import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { arr, obj, startTestApi, str, type TestApi } from "./helpers/http-app.js";

let api: TestApi;
const MACHINE = "0191cafe-0000-7000-8000-0000000000e1";

beforeAll(async () => { api = await startTestApi(); }, 30_000);
afterAll(async () => { if (api) await api.close(); });

function capture(path: string, text: string, readers: string[]) {
  return api.request("POST", "/memory", {
    body: {
      scope: "global",
      machineId: MACHINE,
      path,
      readers,
      text,
      capturedAt: "2026-09-18T00:00:00.000Z",
    },
  });
}

/**
 * The conversion over the wire, through the production wiring.
 *
 * The unit tests prove what the port produces; this proves the route exists at
 * the path the contract says, that the validation pipe sees the body — a body
 * typed as an interface is invisible to it, which is how several memory
 * endpoints once reached the store as 500s — and that a target the archive
 * cannot write is refused with a code rather than a stack trace.
 */
describe("POST /memory/conversions", () => {
  it("answers with the files to write and where", async () => {
    await capture("/Users/ada/.claude/CLAUDE.md", "Small files. Real coverage.\n", ["claude-code"]);

    const response = await api.request("POST", "/memory/conversions", {
      body: { source: "claude-code", target: "codex", scope: "global" },
    });
    expect(response.status).toBe(200);
    const files = arr(response.body, "files");
    expect(files).toHaveLength(1);
    expect(str(files[0]!, "path")).toBe("~/.codex/AGENTS.md");
    expect(Buffer.from(str(files[0]!, "base64"), "base64").toString("utf8"))
      .toBe("Small files. Real coverage.\n");
    expect(str(response.body as never, "bundleSha256")).toMatch(/^[a-f0-9]{64}$/u);
  });

  it("refuses a body it cannot make sense of rather than storing or serving nonsense", async () => {
    for (const body of [
      {},
      { source: "claude-code", target: "codex" },
      { source: "claude-code", target: "codex", scope: "everywhere" },
      // Cursor is a source and never a target: a `.mdc` without frontmatter is
      // a file Cursor silently ignores, and inventing frontmatter is not a port.
      { source: "claude-code", target: "cursor", scope: "global" },
      { source: "nothing-of-the-sort", target: "codex", scope: "global" },
      { source: "claude-code", target: "codex", scope: "global", machineId: "not-a-uuid" },
    ]) {
      const response = await api.request("POST", "/memory/conversions", { body });
      expect(response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("says plainly when the target tool has no such file", async () => {
    await capture("/Users/ada/.claude/CLAUDE.md", "Small files.\n", ["claude-code"]);
    const response = await api.request("POST", "/memory/conversions", {
      body: { source: "claude-code", target: "copilot", scope: "global" },
    });
    expect(response.status).toBe(400);
    expect(str(response.body as never, "code")).toBe("unsupported_memory_dialect");
  });

  it("is refused without a token, like everything else that reads the archive", async () => {
    const response = await api.request("POST", "/memory/conversions", {
      body: { source: "claude-code", target: "codex", scope: "global" },
      token: null,
    });
    expect(response.status).toBe(401);
  });

  it("is in the specification the contract check reads", async () => {
    const spec = await api.request("GET", "/openapi.json", { token: null });
    const paths = obj(spec.body, "paths");
    expect(paths["/memory/conversions"], "an undocumented route is one nobody can find").toBeDefined();
  });
});
