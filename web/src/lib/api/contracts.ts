export type ImportSource = 'canonical' | 'cass' | 'claude-code' | 'codex' | 'antigravity-cli' | 'cursor' | 'chatgpt-export';

export type ImportStage = 'hashing' | 'uploading' | 'queued' | 'processing' | 'ready';

/** What `GET /mcp/status` answers. */
export interface McpStatus {
  available: boolean;
  contractVersion: string;
  tools: string[];
}

/** What `GET /capabilities` answers. */
export interface ArchiveCapabilities {
  contractVersion: string;
  connectors: string[];
  connectorCount: number;
  uploadFormats: string[];
}

export interface TenantSettings {
  redaction: { secretScan: boolean; pathScan: boolean; emailScan: boolean; customPatterns: string[] };
  retention: { policy: 'indefinite' | 'days'; days?: number; exemptCollected: boolean };
  updatedAt: string | null;
}


/**
 * Distillation reads sessions with a language model to leave durable notes
 * behind. It is the only feature that sends archived content anywhere else, so
 * the account chooses the provider and brings the key.
 *
 * The key itself never appears here. `keySet` says whether one is stored and
 * `keyHint` is its last four characters, which is enough to recognise which key
 * it is and not enough to use it.
 */
export interface DistillationSettings {
  enabled: boolean;
  provider: 'none' | 'anthropic';
  model: string | null;
  keySet: boolean;
  keyHint: string | null;
  monthlyBudgetCents: number;
  monthlySpentCents: number;
  remainingCents: number;
  budgetWindowStartedAt: string;
}

/** What the deployment accepts. `oauth` lists only configured providers. */
export interface AuthMethods {
  password: boolean;
  signup: 'open' | 'closed';
  oauth: Array<'github' | 'google'>;
}

export interface RawArtifactStatus {
  sha256: string;
  status: 'stored' | 'queued' | 'parsed' | 'unknown_format' | 'failed';
  sessionIds: string[];
  source: string;
  sourcePath: string | null;
  capturedAt: string;
  diagnostic: string | null;
}

export interface ImportProgress {
  stage: ImportStage;
  detail: string;
}
