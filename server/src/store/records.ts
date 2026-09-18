export interface CollectionRecord {
  id: string;
  tenantId: string;
  name: string;
  description?: string;
  teamId?: string;
  sessionIds: string[];
  updatedAt: string;
}

export interface TeamRecord {
  id: string;
  orgId: string;
  name: string;
  memberCount: number;
}

export interface TeamMember {
  userId: string;
  tenantId: string;
  email: string;
}

/** A team somebody has been asked to join but has not yet joined. */
export interface TeamInvitation {
  teamId: string;
  teamName: string;
  orgId: string;
}

/**
 * Standing consent to share into one team. No row means no sharing: the default
 * is off, and creating or joining a team shares nothing by itself.
 *
 * `machineId: null` means every machine of the tenant, including ones enrolled
 * later. Consent is forward-looking only — enrolling never widens what is
 * already archived, because "share what I do from here on" is a different
 * consent from "share everything I have ever captured on this laptop".
 */
export interface TeamShareOptinRecord {
  id: string;
  teamId: string;
  tenantId: string;
  userId: string;
  machineId: string | null;
  createdAt: string;
}

export interface RedactionMaskSnapshot {
  kind: string;
  start: number;
  end: number;
  preview: string;
}

export interface RedactionReviewRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  reviewerUserId: string;
  status: "pending" | "completed" | "superseded";
  contentDigest: string;
  masks: RedactionMaskSnapshot[];
  completedAt: string | null;
}

export interface ShareGrantRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  permission: "viewer" | "importer";
  tokenHash: string;
  status: "active" | "revoked" | "expired";
  createdAt: string;
  expiresAt: string | null;
}

export interface ShareTokenLookup {
  grantId: string;
  tenantId: string;
  sessionId: string;
  permission: "viewer" | "importer";
  status: "active" | "revoked" | "expired";
  expiresAt: string | null;
}

export interface TransferRecord {
  id: string;
  tenantId: string;
  sessionId: string;
  senderEmail: string;
  recipientEmail: string;
  status: "pending" | "accepted" | "declined" | "expired";
  createdAt: string;
}

export interface RawArtifactRecord {
  id: string;
  tenantId: string;
  sessionIds: string[];
  sha256: string;
  size: number;
  objectKey: string;
  status: "stored" | "queued" | "parsed" | "unknown_format" | "failed";
  source: string;
  sourcePath: string | null;
  capturedAt: string;
  diagnostic: string | null;
}

export interface JobRecord {
  id: string;
  tenantId: string;
  kind: "parse" | "index" | "embed" | "secret_scan" | "convert" | "distill" | "materialize";
  status: "queued" | "running" | "ready" | "failed";
  payload: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

export type DistillationProviderName = "none" | "anthropic";

/**
 * What an account has before it has chosen anything.
 *
 * One definition, used by both stores and by the tests, so a new field cannot
 * be added to the type and forgotten in one of the three places that build it.
 */
export function defaultDistillationSettings(now = new Date()): DistillationSettings {
  return {
    enabled: false,
    provider: "none",
    model: null,
    sealedApiKey: null,
    monthlyBudgetCents: 0,
    monthlySpentCents: 0,
    budgetWindowStartedAt: now.toISOString(),
  };
}

export interface DistillationSettings {
  enabled: boolean;
  /**
   * Which provider this account distills with, and with whose credential.
   *
   * "none" is the default and means the account has not chosen one, which is
   * different from disabled: an account can be enabled and still have nothing
   * to distill with.
   */
  provider: DistillationProviderName;
  model: string | null;
  /**
   * The tenant's own API key, AES-256-GCM sealed. Never leaves the process in
   * this form or any other: the API reports only whether one is set and its
   * last four characters.
   */
  sealedApiKey: string | null;
  monthlyBudgetCents: number;
  monthlySpentCents: number;
  budgetWindowStartedAt: string;
}

export interface MachineCommandRecord {
  id: string;
  tenantId: string;
  machineId: string;
  kind: string;
  payload: Record<string, unknown>;
  status: "pending" | "delivered" | "completed" | "failed";
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
  ackedAt: string | null;
}

export interface RedactionSettingsRecord {
  secretScan: boolean;
  pathScan: boolean;
  emailScan: boolean;
  customPatterns: string[];
}

export interface RetentionSettingsRecord {
  policy: "indefinite" | "days";
  days?: number;
  exemptCollected: boolean;
}

export interface TenantSettingsRecord {
  redaction: RedactionSettingsRecord;
  retention: RetentionSettingsRecord;
  updatedAt: string | null;
}

export const DEFAULT_TENANT_SETTINGS: TenantSettingsRecord = {
  redaction: { secretScan: true, pathScan: false, emailScan: false, customPatterns: [] },
  retention: { policy: "indefinite", exemptCollected: true },
  updatedAt: null,
};

export interface MachineRecord {
  id: string;
  tenantId: string;
  name: string;
  platform: string;
  agentVersion: string | null;
  sourceSettings: Record<string, unknown>;
  lastSeenAt: string | null;
}
