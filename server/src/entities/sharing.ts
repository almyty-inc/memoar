import { Column, CreateDateColumn, Entity, Index } from "typeorm";

import { IdentifiedEntity, TenantEntity } from "./base.js";

@Entity("redaction_reviews")
export class RedactionReviewEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  sessionId!: string;

  @Column("uuid")
  reviewerUserId!: string;

  @Column("text")
  status!: "pending" | "completed" | "superseded";

  @Column("text")
  contentDigest!: string;

  @Column("jsonb", { default: () => "'[]'" })
  masks!: { kind: string; start: number; end: number; preview: string }[];

  @Column("timestamptz", { nullable: true })
  completedAt!: Date | null;
}

@Entity("share_grants")
export class ShareGrantEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  sessionId!: string;

  @Column("text")
  permission!: "viewer" | "importer";

  @Column("text")
  tokenHash!: string;

  @Column("text")
  status!: "active" | "revoked" | "expired";

  @Column("timestamptz", { nullable: true })
  expiresAt!: Date | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}

@Entity("transfers")
export class TransferEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  sessionId!: string;

  @Column("citext")
  senderEmail!: string;

  @Column("citext")
  recipientEmail!: string;

  @Column("text")
  status!: "pending" | "accepted" | "declined" | "expired";

  @Column("timestamptz")
  createdAt!: Date;
}

/** Cross-tenant transfer lookup. Deliberately not under RLS (like auth_identities): carries no session content. */
@Entity("transfer_offers")
export class TransferOfferEntity extends IdentifiedEntity {
  @Column("uuid")
  senderTenantId!: string;

  @Column("uuid")
  senderUserId!: string;

  @Column("uuid")
  sessionId!: string;

  @Index()
  @Column("citext")
  recipientEmail!: string;

  @Column("text", { default: "pending" })
  status!: "pending" | "accepted" | "declined" | "expired";

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;
}

/** Cross-tenant share-link lookup. Deliberately not under RLS (like transfer_offers): carries only the token hash and grant metadata, no session content. */
@Entity("share_tokens")
export class ShareTokenEntity extends IdentifiedEntity {
  @Index({ unique: true })
  @Column("text")
  tokenHash!: string;

  @Column("uuid")
  tenantId!: string;

  @Column("uuid")
  sessionId!: string;

  @Column("text")
  permission!: "viewer" | "importer";

  @Column("text", { default: "active" })
  status!: "active" | "revoked" | "expired";

  @Column("timestamptz", { nullable: true })
  expiresAt!: Date | null;
}
