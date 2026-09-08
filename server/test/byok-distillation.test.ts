import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { credentialHint, credentialsAvailable, openCredential, sealCredential } from "../src/credentials.js";
import { startTestApi, type TestApi } from "./helpers/http-app.js";

const CREDENTIAL_KEY = "6b1f3c7d9a2e4f508192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f8";
const TENANT_KEY = "sk-ant-api03-not-a-real-key-abcd1234";

/**
 * Distillation is the only feature that sends archived content to a third
 * party. It used to be configured with one server-wide ANTHROPIC_API_KEY, which
 * meant a single operator key paid for every tenant and every tenant's sessions
 * went through the operator's provider account. The bill and the consent belong
 * to whoever owns the sessions.
 */
describe("a provider credential at rest", () => {
  it("cannot be read back out of what is stored", () => {
    const sealed = sealCredential(TENANT_KEY, { MEMOAR_CREDENTIAL_KEY: CREDENTIAL_KEY });

    // The database is in every backup and every restore. A dump carrying usable
    // customer credentials would make a lost backup far worse than a lost
    // archive.
    expect(sealed).not.toContain(TENANT_KEY);
    expect(sealed).not.toContain("sk-ant");
    expect(openCredential(sealed, { MEMOAR_CREDENTIAL_KEY: CREDENTIAL_KEY })).toBe(TENANT_KEY);
  });

  it("refuses to open after the key is rotated or the row is edited", () => {
    const sealed = sealCredential(TENANT_KEY, { MEMOAR_CREDENTIAL_KEY: CREDENTIAL_KEY });
    const otherKey = "0".repeat(64);

    expect(openCredential(sealed, { MEMOAR_CREDENTIAL_KEY: otherKey }), "a rotated key must not open it").toBeNull();

    // Authenticated encryption: an edited row fails to open rather than
    // decrypting to something else.
    const raw = Buffer.from(sealed, "base64");
    raw[raw.length - 1] ^= 0xff;
    expect(openCredential(raw.toString("base64"), { MEMOAR_CREDENTIAL_KEY: CREDENTIAL_KEY })).toBeNull();
  });

  it("uses a fresh nonce, so two seals of one value differ", () => {
    const environment = { MEMOAR_CREDENTIAL_KEY: CREDENTIAL_KEY };
    expect(sealCredential(TENANT_KEY, environment)).not.toBe(sealCredential(TENANT_KEY, environment));
  });

  it("refuses a key that is not 32 bytes rather than padding it", () => {
    // Silently accepting a weak key is how a system ends up encrypted in name.
    expect(() => credentialKeyFor("too-short")).toThrow(/32 bytes/u);
    expect(credentialsAvailable({})).toBe(false);
  });

  it("hints at which key is stored without revealing it", () => {
    expect(credentialHint(TENANT_KEY)).toBe(TENANT_KEY.slice(-4));
    expect(credentialHint("short"), "too short to give any of it away").toBeNull();
  });
});

function credentialKeyFor(value: string): unknown {
  return sealCredential("anything", { MEMOAR_CREDENTIAL_KEY: value });
}

describe("choosing a provider and bringing a key", () => {
  let api: TestApi;
  beforeAll(async () => { api = await startTestApi({ MEMOAR_CREDENTIAL_KEY: CREDENTIAL_KEY }); }, 30_000);
  afterAll(async () => { if (api) await api.close(); });

  it("starts with no provider chosen", async () => {
    const settings = (await api.request("GET", "/distillation/settings")).body;
    expect(settings.provider, "an account has chosen nothing until it says so").toBe("none");
    expect(settings.keySet).toBe(false);
    expect(settings.keyHint).toBeNull();
  });

  it("stores a key and never gives it back", async () => {
    const updated = await api.request("PUT", "/distillation/settings", {
      body: { enabled: true, provider: "anthropic", model: "claude-opus-5", apiKey: TENANT_KEY, monthlyBudgetCents: 500 },
    });

    expect(updated.status).toBe(200);
    expect(updated.body.keySet).toBe(true);
    expect(updated.body.keyHint, "enough to recognise the key, not to use it").toBe(TENANT_KEY.slice(-4));
    // The PUT response is the shape a client logs, so this is where a key would
    // most easily escape.
    expect(JSON.stringify(updated.body)).not.toContain(TENANT_KEY);

    const read = await api.request("GET", "/distillation/settings");
    expect(JSON.stringify(read.body)).not.toContain(TENANT_KEY);
    expect(JSON.stringify(read.body), "not even the sealed form").not.toContain("sealed");
    expect(read.body.provider).toBe("anthropic");
    expect(read.body.model).toBe("claude-opus-5");
  });

  it("leaves the stored key alone when the field is absent", async () => {
    // The distinction that matters: every settings update that did not resend
    // the key would otherwise delete it.
    const updated = await api.request("PUT", "/distillation/settings", { body: { monthlyBudgetCents: 900 } });

    expect(updated.body.keySet, "an omitted apiKey must not clear the credential").toBe(true);
    expect(updated.body.keyHint).toBe(TENANT_KEY.slice(-4));
    expect(updated.body.monthlyBudgetCents).toBe(900);
  });

  it("clears the key only when explicitly told to", async () => {
    const cleared = await api.request("PUT", "/distillation/settings", { body: { provider: "none", apiKey: null } });

    expect(cleared.body.keySet).toBe(false);
    expect(cleared.body.keyHint).toBeNull();
    expect(cleared.body.provider).toBe("none");
  });

  it("refuses a provider with no credential to use", async () => {
    // Better than a distillation job that fails much later for no stated reason.
    const refused = await api.request("PUT", "/distillation/settings", { body: { provider: "anthropic" } });

    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("needs an apiKey");
  });

  it("rejects a provider it does not have", async () => {
    const refused = await api.request("PUT", "/distillation/settings", { body: { provider: "some-other-llm", apiKey: TENANT_KEY } });
    expect(refused.status).toBe(400);
  });

  it("does not distill for an account that brought no key", async () => {
    await api.request("PUT", "/distillation/settings", { body: { enabled: true, provider: "none", apiKey: null, monthlyBudgetCents: 500 } });
    const sessions = await api.request("GET", "/sessions");
    const sessionId = (sessions.body.items as { id: string }[])[0]!.id;

    const attempt = await api.request("POST", `/distillation/sessions/${sessionId}`);
    // Whatever the wording, it must not have spent anybody else's credential.
    expect(attempt.status).toBeGreaterThanOrEqual(400);
  });
});

describe("a deployment that cannot encrypt", () => {
  let api: TestApi;
  // No MEMOAR_CREDENTIAL_KEY at all.
  beforeAll(async () => { api = await startTestApi({ MEMOAR_CREDENTIAL_KEY: "" }); }, 30_000);
  afterAll(async () => { if (api) await api.close(); });

  it("refuses to hold a credential rather than storing it weakly", async () => {
    const refused = await api.request("PUT", "/distillation/settings", {
      body: { provider: "anthropic", apiKey: TENANT_KEY },
    });

    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).not.toContain(TENANT_KEY);
  });
});
