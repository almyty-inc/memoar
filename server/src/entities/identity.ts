import { Column, CreateDateColumn, Entity, Index, Unique } from "typeorm";

import { IdentifiedEntity, TenantEntity } from "./base.js";

@Entity("users")
export class UserEntity extends IdentifiedEntity {
  @Index({ unique: true })
  @Column("citext")
  email!: string;

  @Column("text")
  displayName!: string;

  @Column("text", { nullable: true })
  passwordHash!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}

@Entity("organizations")
export class OrganizationEntity extends IdentifiedEntity {
  @Column("text")
  name!: string;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}

@Entity("teams")
export class TeamEntity extends IdentifiedEntity {
  @Index()
  @Column("uuid")
  orgId!: string;

  @Column("text")
  name!: string;
}

/** Cross-tenant team membership. Deliberately not under RLS (like auth_identities): carries account metadata only, no session content. */
@Entity("team_members")
@Unique(["teamId", "userId"])
export class TeamMemberEntity extends IdentifiedEntity {
  @Index()
  @Column("uuid")
  teamId!: string;

  @Column("uuid")
  userId!: string;

  @Column("uuid")
  tenantId!: string;

  @Column("citext")
  email!: string;

  @CreateDateColumn({ type: "timestamptz" })
  addedAt!: Date;
}

@Entity("auth_sessions")
export class AuthSessionEntity extends IdentifiedEntity {
  @Index()
  @Column("uuid")
  userId!: string;

  @Index({ unique: true })
  @Column("text")
  tokenHash!: string;

  @Column("timestamptz")
  expiresAt!: Date;

  @Column("timestamptz", { nullable: true })
  revokedAt!: Date | null;
}

@Entity("api_keys")
export class ApiKeyEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  userId!: string;

  @Column("text")
  name!: string;

  @Index({ unique: true })
  @Column("text")
  prefix!: string;

  @Column("text")
  secretHash!: string;

  @Column("text", { array: true })
  scopes!: string[];

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @Column("timestamptz", { nullable: true })
  lastUsedAt!: Date | null;

  @Column("timestamptz", { nullable: true })
  revokedAt!: Date | null;
}

@Entity("auth_identities")
@Unique(["kind", "lookupKey"])
export class AuthIdentityEntity extends IdentifiedEntity {
  @Column("text")
  kind!: "password" | "api_key" | "machine_token";

  @Column("citext")
  lookupKey!: string;

  @Index()
  @Column("uuid")
  tenantId!: string;

  @Column("uuid")
  userId!: string;

  @Column("text")
  secretHash!: string;

  @Column("text", { array: true, default: [] })
  scopes!: string[];

  @Column("uuid", { nullable: true })
  machineId!: string | null;

  @Column("timestamptz", { nullable: true })
  expiresAt!: Date | null;

  @Column("timestamptz", { nullable: true })
  revokedAt!: Date | null;

  @Column("timestamptz", { nullable: true })
  lastUsedAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}

@Entity("billing_accounts")
export class BillingAccountEntity extends TenantEntity {
  @Column("text", { default: "stub" })
  provider!: "stub";

  @Column("text", { default: "inactive" })
  status!: "inactive";

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}

@Entity("billing_subscriptions")
export class BillingSubscriptionEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  billingAccountId!: string;

  @Column("text", { default: "none" })
  plan!: "none";

  @Column("text", { default: "inactive" })
  status!: "inactive";

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}
