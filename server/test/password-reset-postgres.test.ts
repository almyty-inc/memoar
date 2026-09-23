import { randomBytes } from "node:crypto";
import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { AuthService } from "../src/auth/auth.service.js";
import { BrowserSessionService } from "../src/auth/browser-sessions.js";
import { CredentialsService } from "../src/auth/credentials.service.js";
import { hashSecret, TokenService } from "../src/auth/tokens.js";
import { PASSWORD_SCOPES } from "../src/bootstrap-account.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { AuthIdentityEntity, MachineEntity, UserEntity } from "../src/entities.js";
import { uuidV7 } from "../src/ids.js";
import { resetPassword, runResetPassword } from "../src/reset-password.js";
import { dockerAvailable, startPostgres, stopPostgres } from "./helpers/postgres.js";

/**
 * Changing and resetting a password against a real database, which is where
 * the transaction, the row lock and the session cutoff columns live.
 */
const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const suite = usePostgres ? describe : describe.skip;
const FIXTURE = { container: "memoar-password-reset-test", port: 55993 };
const DATABASE_URL = `postgres://memoar:contract@127.0.0.1:${FIXTURE.port}/memoar`;

let dataSource: DataSource | null = null;
let auth: AuthService;
let tokens: TokenService;
let store: DevArchiveStore;

beforeAll(async () => {
  if (!usePostgres) return;
  process.env.MEMOAR_SIGNUP = "open";
  dataSource = await startPostgres(FIXTURE);
  tokens = new TokenService();
  store = new DevArchiveStore();
  auth = new AuthService(tokens, dataSource, store, new BrowserSessionService(dataSource), new CredentialsService(tokens, dataSource, store));
}, 300_000);

afterAll(async () => {
  delete process.env.MEMOAR_SIGNUP;
  await stopPostgres(dataSource, FIXTURE);
});

const freshPassword = (): string => `pw-${randomBytes(12).toString("hex")}`;
const freshEmail = (): string => `reset-${randomBytes(6).toString("hex")}@memoar.test`;

async function contextOf(token: string): Promise<TenantContext | null> {
  return auth.authenticateBearer(token);
}

async function registered(): Promise<{ email: string; password: string; token: string; context: TenantContext }> {
  const email = freshEmail();
  const password = freshPassword();
  const { accessToken } = await auth.register(email, password);
  const context = await contextOf(accessToken);
  if (!context) throw new Error("a fresh registration was not signed in");
  return { email, password, token: accessToken, context };
}

/** An account that only ever signed in with a provider: a user and an oauth identity, no password. */
async function providerOnlyAccount(): Promise<{ email: string; token: string }> {
  const email = freshEmail();
  const userId = uuidV7();
  const tenantId = uuidV7();
  await dataSource!.getRepository(UserEntity).insert({ id: userId, email, displayName: email, passwordHash: null });
  await dataSource!.getRepository(AuthIdentityEntity).insert({
    id: uuidV7(), kind: "oauth", lookupKey: email, tenantId, userId, secretHash: hashSecret(freshPassword()),
    scopes: PASSWORD_SCOPES, machineId: null, expiresAt: null, revokedAt: null, lastUsedAt: null,
  });
  const { token } = tokens.issue({ sub: userId, tenantId, scopes: PASSWORD_SCOPES, type: "browser" }, 3600);
  return { email, token };
}

suite("changing a password against Postgres", () => {
  it("ends the other sessions, keeps the caller's, and swaps the password", async () => {
    const account = await registered();
    const other = (await auth.login(account.email, account.password)).accessToken;
    const next = freshPassword();

    await auth.changePassword(account.context, account.token, account.password, next);

    expect(await contextOf(other), "another session outlived the change").toBeNull();
    expect(await contextOf(account.token), "the change signed its own caller out").not.toBeNull();
    await expect(auth.login(account.email, account.password)).rejects.toThrow(/Invalid credentials/u);
    expect(await contextOf((await auth.login(account.email, next)).accessToken)).not.toBeNull();
  });

  it("refuses a wrong current password and writes nothing", async () => {
    const account = await registered();
    const before = await dataSource!.getRepository(AuthIdentityEntity).findOneByOrFail({ kind: "password", lookupKey: account.email });

    await expect(auth.changePassword(account.context, account.token, freshPassword(), freshPassword()))
      .rejects.toMatchObject({ response: { code: "wrong_password" } });

    const after = await dataSource!.getRepository(AuthIdentityEntity).findOneByOrFail({ kind: "password", lookupKey: account.email });
    expect(after.secretHash).toBe(before.secretHash);
    const user = await dataSource!.getRepository(UserEntity).findOneByOrFail({ email: account.email });
    expect(user.sessionsNotBefore, "a refused change cut the sessions").toBeNull();
  });

  it("says a provider-only account has no password, and will not change one", async () => {
    const account = await providerOnlyAccount();
    const context = await contextOf(account.token);
    expect(context).not.toBeNull();

    expect((await auth.currentUser(context!)).hasPassword).toBe(false);
    await expect(auth.changePassword(context!, account.token, freshPassword(), freshPassword()))
      .rejects.toMatchObject({ response: { code: "no_password" } });
  });
});

suite("the operator reset", () => {
  it("refuses an address with no password identity and creates nothing", async () => {
    const unknown = freshEmail();
    await expect(resetPassword(dataSource!, unknown)).rejects.toThrow(/Nothing was changed/u);

    const provider = await providerOnlyAccount();
    await expect(resetPassword(dataSource!, provider.email)).rejects.toThrow(/Nothing was changed/u);
    const created = await dataSource!.getRepository(AuthIdentityEntity).findBy({ kind: "password", lookupKey: provider.email });
    expect(created, "the reset minted a password for a provider-only account").toHaveLength(0);
  });

  it("sets a new password and ends every session, key and machine token", async () => {
    const account = await registered();
    const second = (await auth.login(account.email, account.password)).accessToken;
    const { secret } = await auth.createApiKey(account.context, "laptop", ["archive:read"]);
    const machineId = uuidV7();
    const machineRecord = {
      id: machineId, tenantId: account.context.tenantId, name: "laptop", platform: "macos",
      agentVersion: null, sourceSettings: {}, lastSeenAt: null,
    };
    // The store here is in memory, but machine_tokens has a foreign key to the
    // machines table, so the machine has to exist in both.
    await store.saveMachine(account.context, machineRecord);
    await dataSource!.getRepository(MachineEntity).insert({ ...machineRecord, installationId: null });
    const machine = await auth.issueMachineToken(account.context, machineId);
    expect(await auth.authenticateApiKey(secret)).not.toBeNull();
    expect(await contextOf(machine.token)).not.toBeNull();

    const outcome = await resetPassword(dataSource!, account.email.toUpperCase());

    expect(outcome.revoked).toEqual({ apiKeys: 1, machineTokens: 1 });
    expect(await contextOf(account.token), "a browser session outlived the reset").toBeNull();
    expect(await contextOf(second), "a browser session outlived the reset").toBeNull();
    expect(await auth.authenticateApiKey(secret), "an API key outlived the reset").toBeNull();
    expect(await contextOf(machine.token), "a machine token outlived the reset").toBeNull();
    await expect(auth.login(account.email, account.password)).rejects.toThrow(/Invalid credentials/u);
    expect(await contextOf((await auth.login(account.email, outcome.password)).accessToken)).not.toBeNull();
  });

  it("runs as a CLI: prints the password once, and exits non-zero on a refusal", async () => {
    const account = await registered();
    const out: string[] = [];
    const err: string[] = [];
    const io = { out: (line: string) => out.push(line), err: (line: string) => err.push(line) };

    expect(await runResetPassword(["node", "reset-password.js"], { DATABASE_URL }, io)).toBe(2);
    expect(await runResetPassword(["node", "reset-password.js", "--email", freshEmail()], { DATABASE_URL }, io)).toBe(1);
    expect(err.join("\n")).toMatch(/Nothing was changed/u);

    expect(await runResetPassword(["node", "reset-password.js", "--email", account.email], { DATABASE_URL }, io)).toBe(0);
    const printed = /shown once and stored only as a hash: (\S+)$/mu.exec(out.join("\n"))?.[1];
    expect(printed).toBeDefined();
    expect((await auth.login(account.email, printed!)).user.email).toBe(account.email);
  });
});
