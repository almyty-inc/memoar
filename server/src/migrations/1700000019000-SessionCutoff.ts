import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * The moment before which an account's browser sessions stop counting.
 *
 * A browser token is revoked one at a time, by the jti it carries, and nothing
 * records the tokens as they are minted. So "end every session for this
 * account" had nothing to enumerate. A password change and an operator reset
 * both need exactly that: somebody who had the old password may be signed in
 * somewhere, and changing it must throw them out.
 *
 * `sessionsNotBefore` ends every browser token minted before it.
 * `sessionsKeptJti` is the one token the change was made from, which a change
 * keeps alive so the person making it is not signed out by their own action.
 * A reset sets the first and clears the second.
 */
export class SessionCutoff1700000019000 implements MigrationInterface {
  name = "SessionCutoff1700000019000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users ADD COLUMN "sessionsNotBefore" timestamptz`);
    await queryRunner.query(`ALTER TABLE users ADD COLUMN "sessionsKeptJti" text`);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE users DROP COLUMN "sessionsKeptJti"`);
    await queryRunner.query(`ALTER TABLE users DROP COLUMN "sessionsNotBefore"`);
  }
}
