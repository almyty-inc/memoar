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

export interface DistillationSettings {
  enabled: boolean;
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
