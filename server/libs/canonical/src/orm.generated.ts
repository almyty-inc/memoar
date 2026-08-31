// Generated from contracts/source/canonical.model.json. Do not edit.
import { EntitySchema } from "typeorm";
import type { ContentBlockKind, MemoryScope, ProvenanceEntry, SourceDescriptor, TokenTotals, Visibility, WorkspaceDescriptor } from "./generated.js";

export interface SessionRow {
  id: string;
  tenantId: string;
  source: SourceDescriptor;
  workspace: WorkspaceDescriptor;
  capturedCreatedAt: Date;
  capturedUpdatedAt: Date;
  title: string;
  summary: string | null;
  models: Array<string>;
  tokenTotals: TokenTotals;
  provenance: Array<ProvenanceEntry>;
  visibility: Visibility;
  ext: Record<string, unknown> | null;
  redactionStatus: "clear" | "findings" | "reviewed";
  searchDocument: string;
  searchVector: string | null;
  embedding: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export const SessionEntity = new EntitySchema<SessionRow>({
  name: "sessions",
  tableName: "sessions",
  columns: {
    id: { type: "uuid", primary: true },
    tenantId: { type: "uuid" },
    source: { type: "jsonb" },
    workspace: { type: "jsonb" },
    capturedCreatedAt: { type: "timestamptz" },
    capturedUpdatedAt: { type: "timestamptz" },
    title: { type: "text" },
    summary: { type: "text", nullable: true },
    models: { type: "text", array: true },
    tokenTotals: { type: "jsonb" },
    provenance: { type: "jsonb" },
    visibility: { type: "jsonb" },
    ext: { type: "jsonb", nullable: true },
    redactionStatus: { type: "text", default: "clear" },
    searchDocument: { type: "text", default: "" },
    searchVector: { type: "tsvector", nullable: true, select: false, insert: false, update: false },
    embedding: { type: "vector", nullable: true, select: false },
    createdAt: { type: "timestamptz", createDate: true },
    updatedAt: { type: "timestamptz", updateDate: true },
  },
  indices: [{ columns: ["tenantId"] }, { columns: ["tenantId","capturedUpdatedAt"] }],
});

export interface TurnRow {
  id: string;
  tenantId: string;
  sessionId: string;
  ordinal: number;
  parentId: string | null;
  role: "system" | "user" | "assistant" | "tool";
  capturedAt: Date;
  model: string | null;
  tokens: TokenTotals | null;
  ext: Record<string, unknown> | null;
}

export const TurnEntity = new EntitySchema<TurnRow>({
  name: "turns",
  tableName: "turns",
  columns: {
    id: { type: "uuid", primary: true },
    tenantId: { type: "uuid" },
    sessionId: { type: "uuid" },
    ordinal: { type: "integer" },
    parentId: { type: "uuid", nullable: true },
    role: { type: "text" },
    capturedAt: { type: "timestamptz" },
    model: { type: "text", nullable: true },
    tokens: { type: "jsonb", nullable: true },
    ext: { type: "jsonb", nullable: true },
  },
  indices: [{ columns: ["tenantId"] }, { columns: ["sessionId"] }],
  uniques: [{ columns: ["tenantId","sessionId","ordinal"] }],
});

export interface ContentBlockRow {
  id: string;
  tenantId: string;
  sessionId: string;
  turnId: string;
  ordinal: number;
  kind: ContentBlockKind;
  text: string | null;
  name: string | null;
  callId: string | null;
  language: string | null;
  mimeType: string | null;
  artifactRef: string | null;
  data: Record<string, unknown> | null;
  ext: Record<string, unknown> | null;
}

export const ContentBlockEntity = new EntitySchema<ContentBlockRow>({
  name: "content_blocks",
  tableName: "content_blocks",
  columns: {
    id: { type: "uuid", primary: true },
    tenantId: { type: "uuid" },
    sessionId: { type: "uuid" },
    turnId: { type: "uuid" },
    ordinal: { type: "integer" },
    kind: { type: "text" },
    text: { type: "text", nullable: true },
    name: { type: "text", nullable: true },
    callId: { type: "text", nullable: true },
    language: { type: "text", nullable: true },
    mimeType: { type: "text", nullable: true },
    artifactRef: { type: "text", nullable: true },
    data: { type: "jsonb", nullable: true },
    ext: { type: "jsonb", nullable: true },
  },
  indices: [{ columns: ["tenantId"] }, { columns: ["sessionId"] }, { columns: ["turnId"] }],
  uniques: [{ columns: ["tenantId","turnId","ordinal"] }],
});

export interface MemoryDocumentRow {
  id: string;
  tenantId: string;
  scope: MemoryScope;
  machineId: string;
  workspacePath: string | null;
  path: string;
  title: string;
  readers: Array<string>;
  contentHash: string;
  capturedAt: Date;
  visibility: Visibility;
  provenance: Array<ProvenanceEntry> | null;
  createdAt: Date;
  updatedAt: Date;
}

export const MemoryDocumentEntity = new EntitySchema<MemoryDocumentRow>({
  name: "memory_documents",
  tableName: "memory_documents",
  columns: {
    id: { type: "uuid", primary: true },
    tenantId: { type: "uuid" },
    scope: { type: "text" },
    machineId: { type: "uuid" },
    workspacePath: { type: "text", nullable: true },
    path: { type: "text" },
    title: { type: "text" },
    readers: { type: "text", array: true },
    contentHash: { type: "text" },
    capturedAt: { type: "timestamptz" },
    visibility: { type: "jsonb" },
    provenance: { type: "jsonb", nullable: true },
    createdAt: { type: "timestamptz", createDate: true },
    updatedAt: { type: "timestamptz", updateDate: true },
  },
  indices: [{ columns: ["tenantId"] }, { columns: ["tenantId","machineId"] }],
  uniques: [{ columns: ["tenantId","machineId","path"] }],
});

export interface MemoryRevisionRow {
  id: string;
  tenantId: string;
  documentId: string;
  contentHash: string;
  text: string;
  size: number;
  capturedAt: Date;
}

export const MemoryRevisionEntity = new EntitySchema<MemoryRevisionRow>({
  name: "memory_revisions",
  tableName: "memory_revisions",
  columns: {
    id: { type: "uuid", primary: true },
    tenantId: { type: "uuid" },
    documentId: { type: "uuid" },
    contentHash: { type: "text" },
    text: { type: "text" },
    size: { type: "integer" },
    capturedAt: { type: "timestamptz" },
  },
  indices: [{ columns: ["tenantId"] }, { columns: ["documentId"] }],
  uniques: [{ columns: ["tenantId","documentId","contentHash"] }],
});

