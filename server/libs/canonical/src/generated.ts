// Generated from contracts/source/canonical.model.json. Do not edit.
export const CONTRACT_VERSION = "0.3.0" as const;

export interface SourceDescriptor {
  vendor: string;
  tool: string;
  version: string;
  machineId: Uuid;
  nativeSessionId?: string;
}

export interface WorkspaceDescriptor {
  path: string;
  gitRemote?: string;
  branch?: string;
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export interface ProvenanceEntry {
  kind: "native" | "import" | "conversion" | "distillation";
  sourceId?: string;
  capturedAt: string;
  parserVersion?: string;
  details?: Record<string, unknown>;
}

export interface Visibility {
  scope: "private" | "team" | "org" | "link";
  ownerId: Uuid;
  teamId?: Uuid;
  orgId?: Uuid;
}

export type ContentBlockKind = "text" | "thinking" | "tool_call" | "tool_result" | "diff" | "artifact" | "attachment" | "system" | "error";

export interface ContentBlock {
  id: Uuid;
  kind: ContentBlockKind;
  text?: string;
  name?: string;
  callId?: string;
  language?: string;
  mimeType?: string;
  artifactRef?: string;
  data?: Record<string, unknown>;
  ext?: Record<string, unknown>;
}

export interface Turn {
  id: Uuid;
  ordinal: number;
  parentId: Uuid | null;
  role: "system" | "user" | "assistant" | "tool";
  createdAt: string;
  model?: string;
  tokens?: TokenTotals;
  blocks: Array<ContentBlock>;
  ext?: Record<string, unknown>;
}

export type AnnotationKind = "tag" | "collection" | "pin" | "note" | "summary" | "redaction_mask";

export interface Annotation {
  id: Uuid;
  sessionId: Uuid;
  turnId?: Uuid;
  blockId?: Uuid;
  kind: AnnotationKind;
  value: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface RawArtifact {
  id: Uuid;
  sessionIds?: Array<Uuid>;
  sha256: string;
  size: number;
  objectKey: string;
  status: "stored" | "queued" | "parsed" | "unknown_format" | "failed";
  sourcePath?: string;
  capturedAt: string;
  diagnostic?: string;
}

export interface Session {
  id: Uuid;
  source: SourceDescriptor;
  workspace: WorkspaceDescriptor;
  createdAt: string;
  updatedAt: string;
  title: string;
  summary?: string;
  models: Array<string>;
  tokenTotals: TokenTotals;
  provenance: Array<ProvenanceEntry>;
  visibility: Visibility;
  turns: Array<Turn>;
  ext?: Record<string, unknown>;
}

export type Uuid = string;

export type MemoryScope = "global" | "project";

export type RedactionStatus = "clear" | "findings" | "reviewed";

export interface MemoryDocument {
  id: Uuid;
  scope: MemoryScope;
  machineId: Uuid;
  workspacePath?: string;
  path: string;
  title: string;
  readers: Array<string>;
  contentHash: string;
  capturedAt: string;
  visibility: Visibility;
  redactionStatus: RedactionStatus;
  redactionFindings: Array<string>;
  provenance?: Array<ProvenanceEntry>;
}

export interface MemoryRevision {
  id: Uuid;
  documentId: Uuid;
  contentHash: string;
  text: string;
  size: number;
  capturedAt: string;
}

