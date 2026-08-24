import type { MigrationInterface, QueryRunner } from "typeorm";

export class TeamScope1700000008000 implements MigrationInterface {
  name = "TeamScope1700000008000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE team_members (
        "id" uuid PRIMARY KEY,
        "teamId" uuid NOT NULL REFERENCES teams(id),
        "userId" uuid NOT NULL,
        "tenantId" uuid NOT NULL,
        "email" citext NOT NULL,
        "addedAt" timestamptz NOT NULL DEFAULT now(),
        UNIQUE ("teamId", "userId")
      )
    `);
    await queryRunner.query(`CREATE INDEX team_members_team_idx ON team_members ("teamId")`);
    await queryRunner.query(`ALTER TABLE collections ADD COLUMN "teamId" uuid`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE collections DROP COLUMN "teamId"`);
    await queryRunner.query(`DROP TABLE team_members`);
  }
}
