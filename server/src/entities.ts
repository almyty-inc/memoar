// Entity definitions, grouped by domain. The canonical content tables
// (sessions, turns, content_blocks) are generated from the canonical model.
export * from "./entities/base.js";
export * from "./entities/identity.js";
export * from "./entities/machines.js";
export * from "./entities/curation.js";
export * from "./entities/sharing.js";
export * from "./entities/operations.js";
export { ContentBlockEntity, SessionEntity, TurnEntity } from "../libs/canonical/src/orm.generated.js";
export type { ContentBlockRow, SessionRow, TurnRow } from "../libs/canonical/src/orm.generated.js";

import { ContentBlockEntity, SessionEntity, TurnEntity } from "../libs/canonical/src/orm.generated.js";
import { AnnotationEntity, CollectionEntity, CollectionSessionEntity } from "./entities/curation.js";
import { ApiKeyEntity, AuthIdentityEntity, AuthSessionEntity, BillingAccountEntity, BillingSubscriptionEntity, OrganizationEntity, TeamEntity, TeamMemberEntity, UserEntity } from "./entities/identity.js";
import { MachineCommandEntity, MachineEntity, MachineTokenEntity } from "./entities/machines.js";
import { AccountSettingsEntity, ArtifactSessionEntity, JobEntity, RawArtifactEntity, SessionIdentityEntity } from "./entities/operations.js";
import { RedactionReviewEntity, ShareGrantEntity, ShareTokenEntity, TransferEntity, TransferOfferEntity } from "./entities/sharing.js";

export const ENTITIES = [
  UserEntity,
  OrganizationEntity,
  TeamEntity,
  AuthSessionEntity,
  AuthIdentityEntity,
  ApiKeyEntity,
  MachineEntity,
  MachineTokenEntity,
  SessionEntity,
  TurnEntity,
  ContentBlockEntity,
  AnnotationEntity,
  CollectionEntity,
  CollectionSessionEntity,
  RawArtifactEntity,
  RedactionReviewEntity,
  ShareGrantEntity,
  TransferEntity,
  JobEntity,
  AccountSettingsEntity,
  BillingAccountEntity,
  BillingSubscriptionEntity,
  SessionIdentityEntity,
  TransferOfferEntity,
  ShareTokenEntity,
  TeamMemberEntity,
  MachineCommandEntity,
  ArtifactSessionEntity,
] as const;
