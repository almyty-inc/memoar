import { Column, CreateDateColumn, Entity, Index, Unique, UpdateDateColumn } from "typeorm";

import { TenantEntity } from "./base.js";

@Entity("jobs")
export class JobEntity extends TenantEntity {
  @Column("text")
  kind!: "parse" | "index" | "embed" | "secret_scan" | "convert" | "distill" | "materialize";

  @Column("text")
  status!: "queued" | "running" | "ready" | "failed";

  @Column("jsonb")
  payload!: Record<string, unknown>;

  @Column("jsonb", { nullable: true })
  result!: Record<string, unknown> | null;

  @Column("text", { nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("account_settings")
export class AccountSettingsEntity extends TenantEntity {
  @Column("boolean", { default: false })
  distillationEnabled!: boolean;

  /** Which provider this account distills with: "none" until it chooses one. */
  @Column("text", { nullable: true })
  distillationProvider!: string | null;

  @Column("text", { nullable: true })
  distillationModel!: string | null;

  /**
   * The account's own provider key, AES-256-GCM sealed.
   *
   * Ciphertext in the column and nowhere else in plaintext: this table is in
   * every backup and every restore, and a dump that carried usable customer
   * credentials would make losing a backup far worse than losing an archive.
   */
  @Column("text", { nullable: true })
  distillationApiKey!: string | null;

  @Column("integer", { default: 0 })
  monthlyDistillationBudgetCents!: number;

  @Column("integer", { default: 0 })
  monthlyDistillationSpentCents!: number;

  @Column("timestamptz", { nullable: true })
  budgetWindowStartedAt!: Date | null;

  @Column("jsonb", { nullable: true })
  redaction!: Record<string, unknown> | null;

  @Column("jsonb", { nullable: true })
  retention!: Record<string, unknown> | null;

  @Column("timestamptz", { nullable: true })
  settingsUpdatedAt!: Date | null;
}

@Entity("session_identities")
@Unique(["tenantId", "sourceTool", "nativeSessionId"])
export class SessionIdentityEntity extends TenantEntity {
  @Column("text")
  sourceTool!: string;

  @Column("text")
  sourceVersion!: string;

  @Column("text")
  nativeSessionId!: string;

  @Index()
  @Column("uuid")
  sessionId!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("raw_artifacts")
@Unique(["tenantId", "sha256"])
export class RawArtifactEntity extends TenantEntity {
  @Column("char", { length: 64 })
  sha256!: string;

  @Column("bigint")
  size!: string;

  @Column("text")
  objectKey!: string;

  @Column("text")
  status!: "stored" | "queued" | "parsed" | "unknown_format" | "failed";

  @Column("text")
  source!: string;

  @Column("text", { nullable: true })
  sourcePath!: string | null;

  @Column("timestamptz")
  capturedAt!: Date;

  @Column("text", { nullable: true })
  diagnostic!: string | null;
}

/** Authoritative artifact-to-session join: one raw artifact can yield zero-to-many canonical sessions. */
@Entity("artifact_sessions")
@Unique(["artifactId", "sessionId"])
export class ArtifactSessionEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  artifactId!: string;

  @Index()
  @Column("uuid")
  sessionId!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
