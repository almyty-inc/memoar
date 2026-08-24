import { Column, Index, PrimaryColumn } from "typeorm";

export abstract class IdentifiedEntity {
  @PrimaryColumn("uuid")
  id!: string;
}

export abstract class TenantEntity extends IdentifiedEntity {
  @Index()
  @Column("uuid")
  tenantId!: string;
}
