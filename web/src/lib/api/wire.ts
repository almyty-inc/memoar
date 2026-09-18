import type {
  Machine,
  MachineSource,
  ProvenanceEntry,
  SearchResponse,
  SessionSummary,
  SessionTurn,
  ShareGrant,
  Transfer,
} from '../types';

export interface WireSessionSummary {
  id: string;
  title: string;
  summary?: string;
  source: string;
  sourceLabel: string;
  machineId?: string;
  workspace: string;
  branch?: string;
  model?: string;
  updatedAt: string;
  turnCount: number;
  tokenCount: number;
  durationMinutes?: number;
  redactionStatus: SessionSummary['redactionStatus'];
  score?: number;
  highlight?: string;
}

export interface WireTimelineResponse {
  groups: Array<{ date: string; sessions: WireSessionSummary[] }>;
  total: number;
  nextCursor: string | null;
}

export interface WireSearchResponse {
  items: WireSessionSummary[];
  nextCursor: string | null;
  aggregations: Record<string, unknown>;
  meta: SearchResponse['meta'];
}

export interface WireBlock {
  id: string;
  kind: string;
  text?: string;
  name?: string;
  callId?: string;
  mimeType?: string;
  artifactRef?: string;
  data?: Record<string, unknown>;
}

export interface WireTurn {
  id: string;
  ordinal: number;
  parentId: string | null;
  role: SessionTurn['role'];
  createdAt: string;
  model?: string;
  tokens?: { input: number; output: number; cacheRead?: number };
  blocks: WireBlock[];
}

export interface WireSessionChunk {
  session: WireSessionSummary;
  turns: WireTurn[];
  provenance?: ProvenanceEntry[];
  nextCursor: string | null;
}

export interface WireCollection {
  id: string;
  name: string;
  description?: string;
  sessionCount: number;
  updatedAt: string;
}

export interface WireShareGrant {
  id: string;
  sessionId: string;
  permission: ShareGrant['permission'];
  status: ShareGrant['status'];
  token?: string;
  createdAt: string;
  expiresAt?: string | null;
}

export interface WireTransfer {
  id: string;
  sessionId: string;
  senderEmail: string;
  recipientEmail: string;
  status: Transfer['status'];
  createdAt: string;
}

export interface WireMachineSource {
  id?: string;
  source?: string;
  label?: string;
  enabled?: boolean;
  state?: MachineSource['state'];
  sessionCount?: number;
  lastSyncAt?: string | null;
  settings?: { enabled?: boolean };
}

export interface WireMachine {
  id: string;
  name: string;
  platform: string;
  status?: Machine['status'];
  lastSeenAt?: string | null;
  agentVersion?: string;
  sources?: WireMachineSource[];
}

export interface ListResponse<T> {
  items: T[];
}
