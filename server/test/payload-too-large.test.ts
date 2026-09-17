import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestApi, str, type TestApi } from "./helpers/http-app.js";

/**
 * A batch too big to describe.
 *
 * `statusFor` exists precisely so body-parser's `status: 413` is reported as a
 * 413 rather than a 500 — and then the body was named after the exception's
 * class rather than after that status, so a plain Error fell through to the
 * generic internal-error document. The caller got `HTTP 413` carrying
 * `"code":"internal_error"` and could not tell "your batch is too big", which
 * they can fix, from "we broke", which they cannot.
 */
let api: TestApi;

beforeAll(async () => {
  api = await startTestApi({ MEMOAR_MAX_MANIFEST_BYTES: "1kb" });
}, 30_000);

afterAll(async () => {
  delete process.env.MEMOAR_MAX_MANIFEST_BYTES;
  if (api) await api.close();
});

describe("a manifest larger than the archive will read", () => {
  it("is refused as the caller's problem, in words they can act on", async () => {
    const manifest = {
      machineId: "0191cafe-0000-7000-8000-00000000d002",
      batchId: "0191cafe-0000-7000-8000-00000000d003",
      artifacts: Array.from({ length: 200 }, (_, index) => ({ sha256: String(index).padStart(64, "0") })),
    };

    const response = await api.request("POST", "/ingest/manifests", { body: manifest });

    expect(response.status).toBe(413);
    expect(str(response.body, "code"), "a 413 reported as a fault of ours").toBe("payload_too_large");
    expect(str(response.body, "title")).toMatch(/payload too large/iu);
    // A 4xx is the caller's own mistake, so it says what it was.
    expect(str(response.body, "detail")).toMatch(/too large/iu);
  });
});
