import type { DataSource } from "typeorm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TenantContext } from "../src/archive-store.js";
import { CredentialsService } from "../src/auth/credentials.service.js";
import { TokenService } from "../src/auth/tokens.js";
import { DevArchiveStore } from "../src/dev-archive-store.js";
import { TEST_CONTEXT } from "./fixtures/archive.js";
import { dockerAvailable, seedAccount, startPostgres, stopPostgres } from "./helpers/postgres.js";

/**
 * A key revoking itself, against both credential stores.
 *
 * The HTTP suite runs without a database, where the id a request carries and
 * the id the key was issued under are one record. With a database they are two
 * rows joined on the key's prefix, and only this suite proves that join.
 */
const usePostgres = process.env.MEMOAR_TEST_POSTGRES !== "0" && dockerAvailable();
const FIXTURE = { container: "memoar-api-key-self-revocation-test", port: 55996 };

/** The signed-in person who mints the keys. */
const person: TenantContext = { ...TEST_CONTEXT, scopes: ["archive:read", "archive:write", "keys:write"], authType: "browser" };

let dataSource: DataSource | null = null;

beforeAll(async () => {
  if (!usePostgres) return;
  dataSource = await startPostgres(FIXTURE);
  await seedAccount(dataSource, { userId: person.userId, tenantId: person.tenantId, email: "keys@example.test" });
}, 300_000);

afterAll(async () => { await stopPostgres(dataSource, FIXTURE); });

const implementations = [
  { name: "memory", skip: false, database: () => null },
  { name: "postgres", skip: !usePostgres, database: () => dataSource },
];

for (const implementation of implementations) {
  const suite = implementation.skip ? describe.skip : describe;

  suite(`an API key revoking itself: ${implementation.name}`, () => {
    it("revokes the calling key without keys:write, and no other", async () => {
      const credentials = new CredentialsService(new TokenService(), implementation.database(), new DevArchiveStore());
      const mine = await credentials.createApiKey(person, "cli on this laptop", ["archive:read"]);
      const sibling = await credentials.createApiKey(person, "cli on another laptop", ["archive:read"]);
      const caller = await credentials.authenticateApiKey(mine.secret);
      expect(caller?.scopes).toEqual(["archive:read"]);
      const myId = String(mine.apiKey.id);
      const siblingId = String(sibling.apiKey.id);

      expect(await credentials.revokeApiKey(caller!, siblingId), "a narrow key revoked a sibling").toBe(false);
      expect(await credentials.revokeApiKey(caller!, "0191cafe-0000-7000-8000-00000000dead")).toBe(false);
      expect(await credentials.authenticateApiKey(sibling.secret), "the sibling must still work").not.toBeNull();

      expect(await credentials.revokeApiKey(caller!, myId)).toBe(true);
      expect(await credentials.authenticateApiKey(mine.secret), "the revoked key still authenticates").toBeNull();

      const listed = (await credentials.listApiKeys(person)).items;
      const revokedAt = listed.find((item) => item.id === myId)?.revokedAt;
      expect(typeof revokedAt, "the list does not say the key is revoked").toBe("string");
      expect(listed.find((item) => item.id === siblingId)?.revokedAt).toBeNull();

      // Revoking again keeps the first revocation time.
      expect(await credentials.revokeApiKey(person, myId)).toBe(true);
      expect((await credentials.listApiKeys(person)).items.find((item) => item.id === myId)?.revokedAt).toBe(revokedAt);
    });

    it("still lets keys:write revoke any key on the account", async () => {
      const credentials = new CredentialsService(new TokenService(), implementation.database(), new DevArchiveStore());
      const other = await credentials.createApiKey(person, "anything", ["archive:read"]);
      expect(await credentials.revokeApiKey(person, String(other.apiKey.id))).toBe(true);
      expect(await credentials.authenticateApiKey(other.secret)).toBeNull();
    });
  });
}
