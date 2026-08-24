import { Column, CreateDateColumn, Entity, Index } from "typeorm";

import { TenantEntity } from "./base.js";

@Entity("machines")
export class MachineEntity extends TenantEntity {
  @Column("text")
  name!: string;

  @Column("text")
  platform!: string;

  @Column("text", { nullable: true })
  agentVersion!: string | null;

  @Column("jsonb", { default: {} })
  sourceSettings!: Record<string, unknown>;

  @Column("timestamptz", { nullable: true })
  lastSeenAt!: Date | null;
}

@Entity("machine_tokens")
export class MachineTokenEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  machineId!: string;

  @Index({ unique: true })
  @Column("text")
  tokenHash!: string;

  @Column("timestamptz")
  expiresAt!: Date;

  @Column("timestamptz", { nullable: true })
  revokedAt!: Date | null;
}

@Entity("machine_commands")
export class MachineCommandEntity extends TenantEntity {
  @Index()
  @Column("uuid")
  machineId!: string;

  @Column("text")
  kind!: string;

  @Column("jsonb")
  payload!: Record<string, unknown>;

  @Column("text", { default: "pending" })
  status!: "pending" | "delivered" | "completed" | "failed";

  @Column("text", { nullable: true })
  error!: string | null;

  @CreateDateColumn({ type: "timestamptz" })
  createdAt!: Date;

  @Column("timestamptz", { nullable: true })
  deliveredAt!: Date | null;

  @Column("timestamptz", { nullable: true })
  ackedAt!: Date | null;
}
