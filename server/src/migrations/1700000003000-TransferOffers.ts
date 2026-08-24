import type { MigrationInterface, QueryRunner } from "typeorm";

export class TransferOffers1700000003000 implements MigrationInterface {
  name = "TransferOffers1700000003000";

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE IF NOT EXISTS transfer_offers (
        id uuid PRIMARY KEY,
        "senderTenantId" uuid NOT NULL,
        "senderUserId" uuid NOT NULL,
        "sessionId" uuid NOT NULL,
        "recipientEmail" citext NOT NULL,
        status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined', 'expired')),
        "createdAt" timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX IF NOT EXISTS transfer_offers_recipient_idx ON transfer_offers ("recipientEmail");
    `);
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query("DROP TABLE IF EXISTS transfer_offers CASCADE");
  }
}
