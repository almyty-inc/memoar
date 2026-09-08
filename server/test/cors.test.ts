import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LOCAL_ORIGINS } from "../src/main.js";
import { startTestApi, type TestApi } from "./helpers/http-app.js";

/**
 * Who may call this API from a browser.
 *
 * `origin: true` reflects whatever Origin arrives, and with credentials enabled
 * that lets any site on the internet make authenticated requests on a signed-in
 * user's behalf. It used to do exactly that whenever NODE_ENV was not the
 * string "production" — the same fail-open shape as the authentication guard,
 * so a deployment that never set that one variable published an API any website
 * could call.
 */
describe("which origins a browser may call from", () => {
  describe("with nothing configured", () => {
    let api: TestApi;
    // Deliberately the misconfigured deployment: no WEB_ORIGIN, no NODE_ENV.
    beforeAll(async () => { api = await startTestApi({ WEB_ORIGIN: "", NODE_ENV: "" }); }, 30_000);
    afterAll(async () => { if (api) await api.close(); });

    it("does not reflect a stranger's origin", async () => {
      const response = await fetch(`${api.baseUrl}/health`, { headers: { origin: "https://not-your-archive.example" } });

      expect(response.headers.get("access-control-allow-origin"), "reflected an arbitrary site").not.toBe("https://not-your-archive.example");
      expect(response.headers.get("access-control-allow-origin")).not.toBe("*");
    });

    it("still lets the local web app through", async () => {
      // Failing closed must not mean failing everyone: a developer running the
      // web app should not have to configure anything.
      const response = await fetch(`${api.baseUrl}/health`, { headers: { origin: LOCAL_ORIGINS[0]! } });
      expect(response.headers.get("access-control-allow-origin")).toBe(LOCAL_ORIGINS[0]);
    });
  });

  describe("with WEB_ORIGIN set", () => {
    let api: TestApi;
    beforeAll(async () => { api = await startTestApi({ WEB_ORIGIN: "https://archive.example,https://other.example" }); }, 30_000);
    afterAll(async () => { if (api) await api.close(); });

    it("allows exactly what was named", async () => {
      const allowed = await fetch(`${api.baseUrl}/health`, { headers: { origin: "https://archive.example" } });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("https://archive.example");

      const refused = await fetch(`${api.baseUrl}/health`, { headers: { origin: "https://archive.example.evil.test" } });
      expect(refused.headers.get("access-control-allow-origin"), "a prefix is not a match").not.toBe("https://archive.example.evil.test");
    });
  });
});
