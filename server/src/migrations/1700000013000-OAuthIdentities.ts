import type { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Lets an account exist because a provider vouched for its address.
 *
 * Signing in with GitHub or Google wrote no identity row at all: the tenant was
 * invented from the user id on every callback, so the same person arriving by
 * password and by provider held two tenants and saw an empty archive the second
 * way in — and `findAccountByEmail`, which only ever looked at password
 * identities, could never find them to add to a team.
 *
 * A separate kind rather than reusing 'password', so nothing can mistake an
 * account with no password for one that has a weak or empty one.
 */
export class OAuthIdentities1700000013000 implements MigrationInterface {
  name = "OAuthIdentities1700000013000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("ALTER TABLE auth_identities DROP CONSTRAINT IF EXISTS auth_identities_kind_check");
    await queryRunner.query(`
      ALTER TABLE auth_identities ADD CONSTRAINT auth_identities_kind_check
      CHECK (kind IN ('password', 'api_key', 'machine_token', 'oauth'))
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    // The rows have to go before the narrower rule can hold again; the accounts
    // they belong to keep their sessions and their archives.
    await queryRunner.query("DELETE FROM auth_identities WHERE kind = 'oauth'");
    await queryRunner.query("ALTER TABLE auth_identities DROP CONSTRAINT IF EXISTS auth_identities_kind_check");
    await queryRunner.query(`
      ALTER TABLE auth_identities ADD CONSTRAINT auth_identities_kind_check
      CHECK (kind IN ('password', 'api_key', 'machine_token'))
    `);
  }
}
