import type { MigrationInterface, QueryRunner } from "typeorm";

const tenantTables = [
  "api_keys",
  "machines",
  "machine_tokens",
  "sessions",
  "turns",
  "content_blocks",
  "annotations",
  "collections",
  "collection_sessions",
  "raw_artifacts",
  "redaction_reviews",
  "share_grants",
  "transfers",
  "jobs",
  "account_settings",
] as const;

export class Initial1700000000000 implements MigrationInterface {
  name = "Initial1700000000000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE EXTENSION IF NOT EXISTS citext;
      CREATE EXTENSION IF NOT EXISTS pgcrypto;
      CREATE EXTENSION IF NOT EXISTS pg_trgm;
      CREATE EXTENSION IF NOT EXISTS vector;

      CREATE TABLE users (
        id uuid PRIMARY KEY,
        email citext NOT NULL UNIQUE,
        "displayName" text NOT NULL,
        "passwordHash" text,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE organizations (
        id uuid PRIMARY KEY,
        name text NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE teams (
        id uuid PRIMARY KEY,
        "orgId" uuid NOT NULL REFERENCES organizations(id),
        name text NOT NULL
      );
      CREATE TABLE auth_sessions (
        id uuid PRIMARY KEY,
        "userId" uuid NOT NULL REFERENCES users(id),
        "tokenHash" text NOT NULL UNIQUE,
        "expiresAt" timestamptz NOT NULL,
        "revokedAt" timestamptz
      );
      CREATE TABLE api_keys (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "userId" uuid NOT NULL REFERENCES users(id),
        name text NOT NULL,
        prefix text NOT NULL UNIQUE,
        "secretHash" text NOT NULL,
        scopes text[] NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "lastUsedAt" timestamptz,
        "revokedAt" timestamptz
      );
      CREATE TABLE machines (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        name text NOT NULL,
        platform text NOT NULL,
        "agentVersion" text,
        "sourceSettings" jsonb NOT NULL DEFAULT '{}'::jsonb,
        "lastSeenAt" timestamptz
      );
      CREATE TABLE machine_tokens (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "machineId" uuid NOT NULL REFERENCES machines(id),
        "tokenHash" text NOT NULL UNIQUE,
        "expiresAt" timestamptz NOT NULL,
        "revokedAt" timestamptz
      );
      CREATE TABLE sessions (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        source jsonb NOT NULL,
        workspace jsonb NOT NULL,
        "capturedCreatedAt" timestamptz NOT NULL,
        "capturedUpdatedAt" timestamptz NOT NULL,
        title text NOT NULL,
        summary text,
        models text[] NOT NULL DEFAULT '{}',
        "tokenTotals" jsonb NOT NULL,
        provenance jsonb NOT NULL,
        visibility jsonb NOT NULL,
        "redactionStatus" text NOT NULL DEFAULT 'clear',
        "searchDocument" text NOT NULL DEFAULT '',
        "searchVector" tsvector GENERATED ALWAYS AS (to_tsvector('english', coalesce(title, '') || ' ' || coalesce(summary, '') || ' ' || coalesce("searchDocument", ''))) STORED,
        embedding vector(768),
        ext jsonb,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX sessions_tenant_updated_idx ON sessions ("tenantId", "capturedUpdatedAt" DESC, id);
      CREATE INDEX sessions_fts_idx ON sessions USING gin ("searchVector");
      CREATE INDEX sessions_title_trgm_idx ON sessions USING gin (title gin_trgm_ops);
      CREATE INDEX sessions_embedding_idx ON sessions USING hnsw (embedding vector_cosine_ops);

      CREATE TABLE turns (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "sessionId" uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        ordinal integer NOT NULL,
        "parentId" uuid,
        role text NOT NULL,
        "capturedAt" timestamptz NOT NULL,
        model text,
        tokens jsonb,
        ext jsonb,
        UNIQUE ("tenantId", "sessionId", ordinal)
      );
      CREATE TABLE content_blocks (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "sessionId" uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        "turnId" uuid NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
        ordinal integer NOT NULL,
        kind text NOT NULL,
        text text,
        name text,
        "callId" text,
        language text,
        "mimeType" text,
        "artifactRef" text,
        data jsonb,
        ext jsonb,
        UNIQUE ("tenantId", "turnId", ordinal)
      );
      CREATE INDEX content_blocks_text_trgm_idx ON content_blocks USING gin (text gin_trgm_ops);

      CREATE TABLE annotations (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "sessionId" uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        "turnId" uuid,
        "blockId" uuid,
        kind text NOT NULL,
        value jsonb NOT NULL,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE collections (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        name text NOT NULL,
        description text,
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE collection_sessions (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "collectionId" uuid NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
        "sessionId" uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        UNIQUE ("tenantId", "collectionId", "sessionId")
      );
      CREATE TABLE raw_artifacts (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "sessionId" uuid REFERENCES sessions(id),
        sha256 char(64) NOT NULL,
        size bigint NOT NULL,
        "objectKey" text NOT NULL,
        status text NOT NULL,
        source text NOT NULL,
        "sourcePath" text,
        "capturedAt" timestamptz NOT NULL,
        diagnostic text,
        UNIQUE ("tenantId", sha256)
      );
      CREATE TABLE redaction_reviews (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "sessionId" uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        "reviewerUserId" uuid NOT NULL REFERENCES users(id),
        status text NOT NULL,
        "contentDigest" text NOT NULL,
        "completedAt" timestamptz
      );
      CREATE TABLE share_grants (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "sessionId" uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        permission text NOT NULL,
        "tokenHash" text NOT NULL,
        status text NOT NULL,
        "expiresAt" timestamptz,
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE transfers (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "sessionId" uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        "senderEmail" citext NOT NULL,
        "recipientEmail" citext NOT NULL,
        status text NOT NULL,
        "createdAt" timestamptz NOT NULL
      );
      CREATE TABLE jobs (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        kind text NOT NULL,
        status text NOT NULL,
        payload jsonb NOT NULL,
        result jsonb,
        error text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "updatedAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE account_settings (
        id uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL UNIQUE,
        "distillationEnabled" boolean NOT NULL DEFAULT false,
        "monthlyDistillationBudgetCents" integer NOT NULL DEFAULT 0,
        "monthlyDistillationSpentCents" integer NOT NULL DEFAULT 0,
        "budgetWindowStartedAt" timestamptz
      );
    `);

    for (const table of tenantTables) {
      await queryRunner.query(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`);
      await queryRunner.query(`ALTER TABLE ${table} FORCE ROW LEVEL SECURITY`);
      await queryRunner.query(`
        CREATE POLICY ${table}_tenant_policy ON ${table}
        USING ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid)
        WITH CHECK ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid)
      `);
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TABLE IF EXISTS account_settings, jobs, transfers, share_grants,
        redaction_reviews, raw_artifacts, collection_sessions, collections,
        annotations, content_blocks, turns, sessions, machine_tokens, machines,
        api_keys, auth_sessions, teams, organizations, users CASCADE
    `);
  }
}
