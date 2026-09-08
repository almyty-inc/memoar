import { DataSource } from "typeorm";
import { hashSecret } from "./auth.js";
import { bootstrapAccount, PASSWORD_SCOPES, type BootstrapAccount } from "./bootstrap-account.js";
import { AuthIdentityEntity, ENTITIES, UserEntity } from "./entities.js";
import { Initial1700000000000 } from "./migrations/1700000000000-Initial.js";
import { CredentialBilling1700000001000 } from "./migrations/1700000001000-CredentialBilling.js";
import { SessionIdentity1700000002000 } from "./migrations/1700000002000-SessionIdentity.js";
import { TransferOffers1700000003000 } from "./migrations/1700000003000-TransferOffers.js";
import { ReviewMaskSnapshot1700000004000 } from "./migrations/1700000004000-ReviewMaskSnapshot.js";
import { ArtifactSessions1700000005000 } from "./migrations/1700000005000-ArtifactSessions.js";
import { TenantSettings1700000006000 } from "./migrations/1700000006000-TenantSettings.js";
import { ShareTokens1700000007000 } from "./migrations/1700000007000-ShareTokens.js";
import { TeamScope1700000008000 } from "./migrations/1700000008000-TeamScope.js";
import { MachineCommands1700000009000 } from "./migrations/1700000009000-MachineCommands.js";
import { AppRole1700000010000 } from "./migrations/1700000010000-AppRole.js";
import { MemoryDocuments1700000011000 } from "./migrations/1700000011000-MemoryDocuments.js";
import { TenantProviderCredentials1700000012000 } from "./migrations/1700000012000-TenantProviderCredentials.js";

export const MIGRATIONS = [
  Initial1700000000000, CredentialBilling1700000001000, SessionIdentity1700000002000,
  TransferOffers1700000003000, ReviewMaskSnapshot1700000004000, ArtifactSessions1700000005000,
  TenantSettings1700000006000, ShareTokens1700000007000, TeamScope1700000008000,
  MachineCommands1700000009000, AppRole1700000010000, MemoryDocuments1700000011000,
  TenantProviderCredentials1700000012000,
];

function dataSourceFor(url: string): DataSource {
  return new DataSource({
    type: "postgres",
    url,
    entities: [...ENTITIES],
    migrations: MIGRATIONS,
    synchronize: false,
    migrationsRun: false,
    logging: process.env.TYPEORM_LOGGING === "true",
    ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : false,
  });
}

/**
 * Creates the first account, once.
 *
 * Deliberately not an upsert: the password hash carries a fresh random salt
 * every time it is computed, so an upsert would rewrite the row on every boot —
 * and would put the environment's password back over one the owner had since
 * changed. An account that already exists is left exactly as it is.
 */
export async function createBootstrapAccount(dataSource: DataSource, account: BootstrapAccount): Promise<boolean> {
  const identities = dataSource.getRepository(AuthIdentityEntity);
  const existing = await identities.findOneBy({ kind: "password", lookupKey: account.email });
  if (existing) return false;

  const secretHash = hashSecret(account.password);
  await dataSource.getRepository(UserEntity).save({
    id: account.userId,
    email: account.email,
    displayName: account.displayName,
    passwordHash: secretHash,
  });
  await identities.save({
    id: account.identityId,
    kind: "password",
    lookupKey: account.email,
    tenantId: account.tenantId,
    userId: account.userId,
    secretHash,
    scopes: PASSWORD_SCOPES,
    machineId: null, expiresAt: null, revokedAt: null, lastUsedAt: null,
  });
  return true;
}

export async function dataSourceFactory(): Promise<DataSource | null> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    if (process.env.NODE_ENV === "production") throw new Error("DATABASE_URL is required in production");
    return null;
  }
  // DDL needs an owner/superuser, but the runtime connection must NOT be one:
  // FORCE ROW LEVEL SECURITY is bypassed by superusers, which would silently
  // disable every tenant policy. Migrations therefore run on their own
  // connection when MIGRATION_DATABASE_URL is supplied.
  if (process.env.MEMOAR_RUN_MIGRATIONS !== "false") {
    const migrationUrl = process.env.MIGRATION_DATABASE_URL ?? url;
    const migrator = dataSourceFor(migrationUrl);
    await migrator.initialize();
    try {
      await migrator.runMigrations({ transaction: "all" });
    } finally {
      await migrator.destroy();
    }
  }
  const dataSource = dataSourceFor(url);
  await dataSource.initialize();
  // The first account, when the operator asked for one. An archive nobody can
  // sign in to is useless, and an archive with a published password on it is
  // worse; the credentials come from the environment and nothing is created
  // without them.
  const account = bootstrapAccount();
  if (account) await createBootstrapAccount(dataSource, account);
  return dataSource;
}
