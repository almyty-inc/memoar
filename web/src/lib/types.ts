export type ViewId =
  | 'workspace'
  | 'timeline'
  | 'search'
  | 'collections'
  | 'import'
  | 'sharing'
  | 'machines'
  | 'settings'
  | 'onboarding'
  | 'signin'
  | 'session';

/** A user-authored mark on a session: a pin, a tag, a note, a collection link. */
export interface Annotation {
  id: string;
  sessionId: string;
  turnId?: string;
  blockId?: string;
  kind: 'tag' | 'collection' | 'pin' | 'note' | 'summary' | 'redaction_mask';
  value: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** The signed-in account, as reported by the server. Never assembled locally. */
export interface CurrentUser {
  id: string;
  email: string;
  displayName: string;
}

export type RedactionStatus = 'clear' | 'findings' | 'reviewed';
export type SourceId = string;

export interface SessionSummary {
  id: string;
  title: string;
  summary: string;
  source: SourceId;
  sourceLabel: string;
  workspace: string;
  branch: string;
  machine: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  tokenCount: number;
  durationMinutes: number;
  redactionStatus: RedactionStatus;
  tags: string[];
  pinned?: boolean;
  score?: number;
  highlight?: string;
}

export interface TimelineGroup {
  date: string;
  sessions: SessionSummary[];
}

export type ContentBlock =
  | { id: string; kind: 'text' | 'thinking' | 'system' | 'error'; text: string }
  | { id: string; kind: 'tool_call'; name: string; callId: string; data: Record<string, unknown> }
  | { id: string; kind: 'tool_result'; callId: string; text: string; status: 'success' | 'error' }
  | { id: string; kind: 'diff'; path: string; oldText: string; newText: string }
  | { id: string; kind: 'artifact'; name: string; mediaType: string };

export interface SessionTurn {
  id: string;
  ordinal: number;
  parentId: string | null;
  role: 'user' | 'assistant' | 'system' | 'tool';
  createdAt: string;
  model?: string;
  tokens?: { input: number; output: number };
  blocks: ContentBlock[];
}

/** Mirrors ProvenanceEntry in the canonical model. */
export interface ProvenanceEntry {
  kind: 'native' | 'import' | 'conversion' | 'distillation';
  sourceId?: string;
  capturedAt: string;
  parserVersion?: string;
}

export interface SessionDetailData {
  session: SessionSummary;
  turns: SessionTurn[];
  provenance: ProvenanceEntry[];
  tokenTotals: { input: number; output: number; cacheRead: number };
}

export interface SearchAggregation {
  label: string;
  value: string;
  count: number;
}

export interface SearchResponse {
  items: SessionSummary[];
  nextCursor: string | null;
  aggregations: {
    agents: SearchAggregation[];
    workspaces: SearchAggregation[];
    dates: SearchAggregation[];
  };
  meta: {
    requestedMode: 'hybrid' | 'lexical' | 'semantic';
    realizedMode: 'hybrid' | 'lexical' | 'semantic';
    tookMs: number;
    semanticFailure: string | null;
  };
}

export interface Collection {
  id: string;
  name: string;
  description: string;
  sessionCount: number;
  updatedAt: string;
  color: string;
  members: string[];
}

export interface ShareGrant {
  id: string;
  sessionId: string;
  sessionTitle: string;
  permission: 'viewer' | 'importer';
  status: 'active' | 'revoked' | 'expired';
  token?: string;
  createdAt: string;
  expiresAt: string | null;
  views: number;
}

export interface Transfer {
  id: string;
  sessionId: string;
  sessionTitle: string;
  senderEmail: string;
  recipientEmail: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired';
  direction: 'incoming' | 'outgoing';
  createdAt: string;
}

export interface MachineSource {
  id: SourceId;
  label: string;
  enabled: boolean;
  state: 'synced' | 'syncing' | 'attention' | 'disabled';
  sessionCount: number;
  lastSyncAt: string | null;
}

export interface Machine {
  id: string;
  name: string;
  platform: string;
  status: 'online' | 'offline' | 'never_connected';
  lastSeenAt: string | null;
  agentVersion: string;
  sources: MachineSource[];
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
}

export interface ApiKeyCreateResult {
  apiKey: ApiKey;
  secret: string;
}

export interface PackEvidence {
  sessionId: string;
  turnStart: number;
  turnEnd: number;
  ageDays: number;
  excerpt: string;
}

export interface PackResponse {
  query: string;
  markdown: string;
  evidence: PackEvidence[];
  tokenEstimate: number;
  staleCount: number;
  redactionStatus: 'clear' | 'findings' | 'mixed';
}

export interface ConversionJob {
  id: string;
  sessionId: string;
  target: 'claude-code' | 'codex' | 'antigravity-cli';
  status: 'queued' | 'running' | 'ready' | 'failed';
  createdAt: string;
  resumeCommand?: string;
  report: Record<string, unknown>;
}

export interface DashboardData {
  timeline: TimelineGroup[];
  collections: Collection[];
  grants: ShareGrant[];
  transfers: Transfer[];
  machines: Machine[];
  apiKeys: ApiKey[];
}

export interface DashboardState extends DashboardData {
  mode: 'connected' | 'demo';
  nextTimelineCursor?: string | null;
}
