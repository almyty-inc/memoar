import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthService } from "../src/auth/auth.service.js";
import { TokenService } from "../src/auth/tokens.js";
import { BrowserSessionService } from "../src/auth/browser-sessions.js";
import { CredentialsService } from "../src/auth/credentials.service.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { AuthIdentityEntity, UserEntity } from "../src/entities.js";
import { dockerAvailable, startPostgres, stopPostgres } from "./helpers/postgres.js";

/**
 * Registration against a real database.
 *
 * The in-memory path is what a developer runs locally; this is what runs in
 * production, and it is the half with the transaction and the unique
 * constraint in it. Testing only the other one would leave every interesting
 * line uncovered.
 */
const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;
const FIXTURE = { container: "memoar-registration-test", port: 55987 };

let dataSource: DataSource | null = null;
let auth: AuthService;

beforeAll(async () => {
  if (!usePostgres) return;
  process.env.MEMOAR_SIGNUP = "open";
  dataSource = await startPostgres(FIXTURE);
  const tokens = new TokenService();
  const store = new DevArchiveStore();
  auth = new AuthService(tokens, dataSource, store, new BrowserSessionService(dataSource), new CredentialsService(tokens, dataSource, store));
}, 300_000);

afterAll(async () => {
  delete process.env.MEMOAR_SIGNUP;
  await stopPostgres(dataSource, FIXTURE);
});

suite("registering against Postgres", () => {
  it("writes the user and its identity, and signs the account in", async () => {
    const session = await auth.register("first@memoar.test", "a-password-of-real-length", "First Person");

    expect(session.accessToken.length).toBeGreaterThan(20);
    expect(session.user).toMatchObject({ email: "first@memoar.test", displayName: "First Person" });

    const user = await dataSource!.getRepository(UserEntity).findOneBy({ email: "first@memoar.test" });
    const identity = await dataSource!.getRepository(AuthIdentityEntity).findOneBy({ kind: "password", lookupKey: "first@memoar.test" });
    expect(user, "a token whose subject resolves to nothing is not an account").not.toBeNull();
    expect(identity, "a user with no identity cannot sign in").not.toBeNull();
    expect(identity!.userId).toBe(user!.id);
    // Its own tenant: signing up must never join somebody else's archive.
    expect(identity!.tenantId).not.toBe(user!.id);
    // The password is stored as a verifier, never as itself.
    expect(identity!.secretHash).not.toContain("a-password-of-real-length");
    expect(identity!.secretHash.startsWith("scrypt$")).toBe(true);
  });

  it("can sign in afterwards with the same credentials", async () => {
    await auth.register("returning@memoar.test", "a-password-of-real-length");
    const signedIn = await auth.login("returning@memoar.test", "a-password-of-real-length");

    expect(signedIn.user.email).toBe("returning@memoar.test");
    await expect(auth.login("returning@memoar.test", "the-wrong-password-entirely")).rejects.toThrow(/Invalid credentials/u);
  });

  it("lets the database refuse a duplicate rather than checking first", async () => {
    // Looking before inserting is a race: two registrations for one address
    // arriving together would both find nothing and both insert.
    await auth.register("taken@memoar.test", "a-password-of-real-length");
    await expect(auth.register("taken@memoar.test", "another-password-entirely"))
      .rejects.toMatchObject({ response: { code: "account_exists" } });

    // And the failed attempt left nothing behind.
    const identities = await dataSource!.getRepository(AuthIdentityEntity).findBy({ lookupKey: "taken@memoar.test" });
    expect(identities).toHaveLength(1);
  });

  it("normalises the address, so one account cannot be created twice by case", async () => {
    await auth.register("MiXeD@Memoar.Test", "a-password-of-real-length");
    await expect(auth.register("mixed@memoar.test", "a-password-of-real-length"))
      .rejects.toMatchObject({ response: { code: "account_exists" } });
    // And it signs in by the normalised form whichever way it was typed.
    expect((await auth.login("MIXED@MEMOAR.TEST", "a-password-of-real-length")).user.email).toBe("mixed@memoar.test");
  });

  it("refuses when the archive is not taking accounts", async () => {
    process.env.MEMOAR_SIGNUP = "closed";
    try {
      await expect(auth.register("uninvited@memoar.test", "a-password-of-real-length"))
        .rejects.toMatchObject({ response: { code: "registration_closed" } });
      const rows = await dataSource!.getRepository(UserEntity).findBy({ email: "uninvited@memoar.test" });
      expect(rows, "a refusal must not half-create the account").toHaveLength(0);
    } finally {
      process.env.MEMOAR_SIGNUP = "open";
    }
  });

  it("reports the methods this deployment offers", () => {
    expect(auth.authMethods()).toMatchObject({ password: true, signup: "open", oauth: [] });
  });
});
