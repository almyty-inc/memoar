import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Makes joining a team something the joiner agrees to.
 *
 * `addMember` required only that the *caller* was a member, so anyone in any
 * team could add anyone else by email, with no invitation and no acceptance —
 * and membership is what team-scoped sessions and collections are read through.
 * Being added was therefore a change to what somebody else could see of your
 * work, made without you.
 *
 * Rows that already exist become 'active': they were added under the old rules
 * and removing them would break archives that are working today. From here on a
 * row starts 'invited' and only the invited person can move it.
 */
export class TeamInvitations1700000014000 implements MigrationInterface {
  name = "TeamInvitations1700000014000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE team_members
      ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'active'
    `);
    await queryRunner.query("ALTER TABLE team_members DROP CONSTRAINT IF EXISTS team_members_status_check");
    await queryRunner.query(`
      ALTER TABLE team_members ADD CONSTRAINT team_members_status_check
      CHECK (status IN ('invited', 'active'))
    `);
    await queryRunner.query(`CREATE INDEX IF NOT EXISTS team_members_user_status_idx ON team_members ("userId", status)`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP INDEX IF EXISTS team_members_user_status_idx");
    await queryRunner.query("ALTER TABLE team_members DROP CONSTRAINT IF EXISTS team_members_status_check");
    await queryRunner.query("ALTER TABLE team_members DROP COLUMN IF EXISTS status");
  }
}
