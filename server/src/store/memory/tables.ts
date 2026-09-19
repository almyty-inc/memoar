import type { Annotation, MemoryDocument, MemoryRevision } from "../../../libs/canonical/src/generated.js";
import type { ArchivedSession } from "../context.js";
import type {
  CollectionRecord,
  DistillationSettings,
  JobRecord,
  MachineCommandRecord,
  MachineRecord,
  RawArtifactRecord,
  RedactionReviewRecord,
  ShareGrantRecord,
  TeamMember,
  TeamShareOptinRecord,
  TenantSettingsRecord,
  TransferRecord,
} from "../records.js";

export interface TransferOffer {
  id: string;
  senderTenantId: string;
  senderUserId: string;
  sessionId: string;
  recipientEmail: string;
  status: "pending" | "accepted" | "declined" | "expired";
}

export function key(tenantId: string, id: string): string {
  return `${tenantId}:${id}`;
}

export function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Shared in-memory tables for the development/test store. The per-domain
 * memory stores read and write these maps; keeping them in one place lets the
 * domains stay small without giving up cross-domain reads (a transfer needs
 * sessions, retention needs collections).
 */
export class MemoryTables {
  readonly machines = new Map<string, MachineRecord>();
  readonly machineCommands = new Map<string, MachineCommandRecord>();
  readonly sessions = new Map<string, ArchivedSession>();
  readonly sessionIdentities = new Map<string, string>();
  readonly sessionEmbeddings = new Map<string, number[]>();
  readonly annotations = new Map<string, Annotation & { tenantId: string }>();
  readonly collections = new Map<string, CollectionRecord>();
  readonly reviews = new Map<string, RedactionReviewRecord>();
  readonly grants = new Map<string, ShareGrantRecord>();
  readonly transfers = new Map<string, TransferRecord>();
  readonly transferOffers = new Map<string, TransferOffer>();
  readonly artifacts = new Map<string, RawArtifactRecord>();
  readonly jobs = new Map<string, JobRecord>();
  readonly distillation = new Map<string, DistillationSettings>();
  readonly tenantSettings = new Map<string, TenantSettingsRecord>();
  readonly teams = new Map<string, { id: string; orgId: string; name: string }>();
  readonly teamMembers = new Map<string, (TeamMember & { status: "invited" | "active" })[]>();
  readonly teamShareOptins = new Map<string, TeamShareOptinRecord>();
  readonly memoryDocuments = new Map<string, MemoryDocument & { tenantId: string }>();
  readonly memoryRevisions = new Map<string, MemoryRevision & { tenantId: string }>();
  readonly accountsByEmail = new Map<string, TeamMember>();
}
