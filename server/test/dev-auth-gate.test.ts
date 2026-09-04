import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { developmentAuthEnabled } from "../src/dev-mode.js";
import { startTestApi, type TestApi } from "./helpers/http-app.js";

/**
 * The guard used to open its development doors whenever `NODE_ENV` was not
 * exactly "production" — so an operator who ran the built server without
 * setting that one variable published an API where
 *
 *     X-Memoar-Tenant: <anyone's tenant>
 *     X-Memoar-User:   <anyone>
 *
 * returned full scopes over that tenant's archive. Forgetting to set a variable
 * is not consent. These tests hold the door shut in the default configuration.
 */
describe("the development authentication switch", () => {
  it("is off unless it has been asked for by name", () => {
    expect(developmentAuthEnabled({})).toBe(false);
    expect(developmentAuthEnabled({ NODE_ENV: "development" })).toBe(false);
    // Not merely "not production" — the old condition, and the whole defect.
    expect(developmentAuthEnabled({ NODE_ENV: undefined })).toBe(false);
    expect(developmentAuthEnabled({ MEMOAR_DEV_AUTH: "1" })).toBe(false);
    expect(developmentAuthEnabled({ MEMOAR_DEV_AUTH: "true" })).toBe(true);
  });

  describe("against a server that never enabled it", () => {
    let api: TestApi;
    // Deliberately not production: this is the misconfigured deployment, the
    // one where NODE_ENV was never set, and it must still be shut.
    beforeAll(async () => { api = await startTestApi({ MEMOAR_DEV_AUTH: "false", NODE_ENV: "" }); });
    afterAll(async () => { await api.close(); });

    it("refuses a tenant named by a header", async () => {
      const response = await api.request("GET", "/sessions", {
        token: null,
        headers: {
          "x-memoar-tenant": "0191cafe-0000-7000-8000-000000000002",
          "x-memoar-user": "0191cafe-0000-7000-8000-000000000002",
        },
      });

      expect(response.status, "headers must not be able to name their own tenant").toBe(401);
    });

    it("refuses the fixed development bearer token", async () => {
      const response = await api.request("GET", "/sessions", { token: "memoar-development-token" });
      expect(response.status).toBe(401);
    });

    it("still lets a real account in", async () => {
      // The gate closes the back door, not the front one.
      expect((await api.request("GET", "/sessions")).status).toBe(200);
    });
  });
});
