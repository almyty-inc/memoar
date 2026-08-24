import { Column, CreateDateColumn, Entity, Index, Unique, UpdateDateColumn } from "typeorm";

import type { AnnotationKind } from "../../libs/canonical/src/generated.js";

import { TenantEntity } from "./base.js";

@Entity("annotations")
export class AnnotationEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  sessionId!: string;

  @Column("uuid", { nullable: true })
  turnId!: string | null;

  @Column("uuid", { nullable: true })
  blockId!: string | null;

  @Column("text")
  kind!: AnnotationKind;

  @Column("jsonb")
  value!: Record<string, unknown>;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("collections")
export class CollectionEntity extends TenantEntity {
  @Column("text")
  name!: string;

  @Column("text", { nullable: true })
  description!: string | null;

  @Column("uuid", { nullable: true })
  teamId!: string | null;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;
}

@Entity("collection_sessions")
@Unique(["tenantId", "collectionId", "sessionId"])
export class CollectionSessionEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  collectionId!: string;

  @Index()
  @Column("uuid")
  sessionId!: string;
}
