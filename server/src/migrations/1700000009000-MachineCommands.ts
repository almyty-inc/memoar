import type { MigrationInterface, QueryRunner } from "typeorm";

export class MachineCommands1700000009000 implements MigrationInterface {
  name = "MachineCommands1700000009000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE machine_commands (
        "id" uuid PRIMARY KEY,
        "tenantId" uuid NOT NULL,
        "machineId" uuid NOT NULL,
        "kind" text NOT NULL,
        "payload" jsonb NOT NULL,
        "status" text NOT NULL DEFAULT 'pending',
        "error" text,
        "createdAt" timestamptz NOT NULL DEFAULT now(),
        "deliveredAt" timestamptz,
        "ackedAt" timestamptz
      )
    `);
    await queryRunner.query(`CREATE INDEX machine_commands_machine_idx ON machine_commands ("tenantId", "machineId", "status")`);
    await queryRunner.query(`ALTER TABLE machine_commands ENABLE ROW LEVEL SECURITY`);
    await queryRunner.query(`ALTER TABLE machine_commands FORCE ROW LEVEL SECURITY`);
    await queryRunner.query(`
      CREATE POLICY machine_commands_tenant_policy ON machine_commands
      USING ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid)
      WITH CHECK ("tenantId" = nullif(current_setting('memoar.tenant_id', true), '')::uuid)
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE machine_commands`);
  }
}
