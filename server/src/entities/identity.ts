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

/**
 * Cross-tenant team membership. Deliberately not under RLS (like
 * auth_identities): carries account metadata only, no session content.
 *
 * `status` is what makes membership two-sided: an existing member invites, and
 * only the invited person turns their own row into a membership.
 */
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

  @Column("text", { default: "active" })
  status!: "invited" | "active";

  @CreateDateColumn({ type: "timestamptz" })
  addedAt!: Date;
}

/**
 * Standing consent: sessions this tenant captures from here on are widened to
 * this team at ingest. A null `machineId` means every machine of the tenant.
 *
 * Not under RLS, for the same reason `team_members` is not — consent metadata,
 * no session content. The moment a content-bearing column appears here that
 * rationale is void.
 */
@Entity("team_share_optins")
@Unique(["teamId", "tenantId", "machineId"])
export class TeamShareOptinEntity extends IdentifiedEntity {
  @Index()
  @Column("uuid")
  teamId!: string;

  @Index()
  @Column("uuid")
  tenantId!: string;

  @Column("uuid")
  userId!: string;

  @Column("uuid", { nullable: true })
  machineId!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
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
  kind!: "password" | "api_key" | "machine_token" | "oauth";

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
