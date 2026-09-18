export type ViewId =
  | 'workspace'
  | 'timeline'
  | 'search'
  | 'collections'
  | 'import'
  | 'sharing'
  | 'machines'
  | 'memory'
  | 'teams'
  | 'settings'
  | 'onboarding'
  | 'signin'
  | 'session'
  /** An address with no screen behind it. It has no path of its own: it is
      whatever the reader typed, and the address bar keeps saying so. */
  | 'not-found';


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
  /* Optional because a session may genuinely have no branch, no model and no
     measurable duration. A stand-in for any of them reads as a fact. */
  branch?: string;
  machineId?: string;
  model?: string;
  createdAt: string;
  updatedAt: string;
  turnCount: number;
  tokenCount: number;
  durationMinutes?: number;
  redactionStatus: RedactionStatus;
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

/**
 * A team the signed-in account is an active member of.
 *
 * `memberCount` is the server's count of active members. There is no roster
 * endpoint, so the names behind it are not shown: a count the archive measured
 * is a fact, a list the app assembled would not be.
 */
export interface Team {
  id: string;
  orgId: string;
  name: string;
  memberCount: number;
}

/**
 * A team this account has been asked to join and has not joined.
 *
 * Deliberately a different type from Team, because being invited is not being
 * a member: the invitation decides nothing about who can see this account's
 * work until it is accepted.
 */
export interface TeamInvitation {
  teamId: string;
  teamName: string;
  orgId: string;
}

/**
 * Artifacts collected from one tool that the archive could not turn into a
 * session. A source reporting these and no sessions is reading the wrong files.
 */
export interface UnparsedSource {
  source: string;
  artifacts: number;
  diagnostic: string | null;
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
  /** Sessions in the archive, as counted by the server. */
  archivedSessions: number;
  collections: Collection[];
  grants: ShareGrant[];
  transfers: Transfer[];
  machines: Machine[];
  apiKeys: ApiKey[];
}

export interface DashboardState extends DashboardData {
  nextTimelineCursor?: string | null;
}

/** An instruction file an agent reads: CLAUDE.md, AGENTS.md, .goosehints. */
export interface MemoryDocument {
  id: string;
  scope: 'global' | 'project';
  machineId: string;
  workspacePath?: string;
  path: string;
  title: string;
  /** The supported tools that read this path. */
  readers: string[];
  contentHash: string;
  capturedAt: string;
  /**
   * What the secret scanner made of this file, and whether anyone has looked.
   * The same three words a session's status uses, because it is the same
   * question. While this is 'findings' the text does not leave the archive.
   */
  redactionStatus: RedactionStatus;
  /** The kind of each match — api_key, email, path — never the matched text. */
  redactionFindings: string[];
}

export interface MemoryRevision {
  id: string;
  documentId: string;
  contentHash: string;
  text: string;
  size: number;
  capturedAt: string;
}
