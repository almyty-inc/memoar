import type { Annotation, AnnotationKind, MemoryDocument, MemoryRevision, ProvenanceEntry, Visibility } from "../../libs/canonical/src/generated.js";
import type { ArchivedSession, SessionFilter, SessionPage, TenantContext } from "./context.js";
import type {
  CollectionRecord,
  DistillationSettings,
  JobRecord,
  MachineCommandRecord,
  MachineRecord,
  RawArtifactRecord,
  RedactionReviewRecord,
  ShareGrantRecord,
  ShareTokenLookup,
  TeamMember,
  TeamRecord,
  TenantSettingsRecord,
  TransferRecord,
} from "./records.js";

export interface SessionStore {
  saveSession(context: TenantContext, session: ArchivedSession): Promise<void>;
  resolveSessionIdentity(
    context: TenantContext,
    identity: { sourceTool: string; sourceVersion: string; nativeSessionId: string },
    proposedSessionId: string,
  ): Promise<string>;
  saveSessionEmbedding(context: TenantContext, sessionId: string, vector: readonly number[]): Promise<void>;
  updateSessionVisibility(context: TenantContext, sessionId: string, visibility: Visibility): Promise<boolean>;
  listSessions(context: TenantContext, filter: SessionFilter): Promise<SessionPage>;
  getSession(context: TenantContext, sessionId: string): Promise<ArchivedSession | null>;
  /**
   * Whether a session exists, without reading it.
   *
   * Accepting a conversion only has to know the session is there. Loading it to
   * find out meant hydrating every turn and block of a long session — for a
   * 2000-turn session, on every request, to answer a yes-or-no question.
   */
  sessionExists(context: TenantContext, sessionId: string): Promise<boolean>;
  /**
   * Hydrates many sessions in one round trip set. Search results are hydrated
   * in bulk; doing it one session at a time is an N+1 inside every query.
   */
  getSessions(context: TenantContext, sessionIds: readonly string[]): Promise<ArchivedSession[]>;
  deleteSession(context: TenantContext, sessionId: string): Promise<boolean>;
}

export interface AnnotationStore {
  listAnnotations(context: TenantContext, sessionId?: string): Promise<Annotation[]>;
  createAnnotation(
    context: TenantContext,
    input: { sessionId: string; turnId?: string; blockId?: string; kind: AnnotationKind; value: Record<string, unknown> },
  ): Promise<Annotation>;
  /**
   * Replaces every annotation of one kind on a session.
   *
   * Ingest writes one annotation per secret it finds, and writing them one at a
   * time cost a round trip each: the price of storing a transcript scaled with
   * how leaky it was rather than with how large it was, and a file that
   * mentioned a credential on every line was the worst case for the database
   * rather than merely for the reader.
   */
  replaceAnnotations(
    context: TenantContext,
    sessionId: string,
    kind: AnnotationKind,
    values: Record<string, unknown>[],
  ): Promise<Annotation[]>;
  updateAnnotation(context: TenantContext, annotationId: string, value: Record<string, unknown>): Promise<Annotation | null>;
  deleteAnnotation(context: TenantContext, annotationId: string): Promise<boolean>;
}

/** One reading of one memory file on one machine. */
export interface MemoryCapture {
  scope: MemoryDocument["scope"];
  machineId: string;
  workspacePath?: string;
  path: string;
  title: string;
  /** The supported tools that read this path — a fact about the file, not its owner. */
  readers: string[];
  contentHash: string;
  text: string;
  capturedAt: string;
  visibility: Visibility;
  provenance?: ProvenanceEntry[];
}

/**
 * The instruction files an agent reads before it does anything.
 *
 * They are not transcripts, but they are the standing context every transcript
 * was produced under: an archived session cannot be read for what it was
 * without knowing what the agent had been told. A document is identified by
 * where it lives, and its history is kept, because how a project's instructions
 * changed is the part worth having.
 */
export interface MemoryStore {
  listMemoryDocuments(context: TenantContext, filter?: { machineId?: string; scope?: string }): Promise<MemoryDocument[]>;
  getMemoryDocument(context: TenantContext, documentId: string): Promise<MemoryDocument | null>;
  listMemoryRevisions(context: TenantContext, documentId: string): Promise<MemoryRevision[]>;
  captureMemoryDocument(context: TenantContext, capture: MemoryCapture): Promise<{ document: MemoryDocument; revision: MemoryRevision | null }>;
  deleteMemoryDocument(context: TenantContext, documentId: string): Promise<boolean>;
}

export interface CollectionStore {
  listCollections(context: TenantContext): Promise<CollectionRecord[]>;
  saveCollection(context: TenantContext, collection: CollectionRecord): Promise<void>;
}

export interface SharingStore {
  getReview(context: TenantContext, reviewId: string): Promise<RedactionReviewRecord | null>;
  saveReview(context: TenantContext, review: RedactionReviewRecord): Promise<void>;
  listShareGrants(context: TenantContext): Promise<ShareGrantRecord[]>;
  saveShareGrant(context: TenantContext, grant: ShareGrantRecord): Promise<void>;
  getShareGrantByTokenHash(tokenHash: string): Promise<ShareTokenLookup | null>;
  saveTransfer(context: TenantContext, transfer: TransferRecord): Promise<void>;
  listTransfers(context: TenantContext): Promise<TransferRecord[]>;
  getTransfer(context: TenantContext, transferId: string): Promise<TransferRecord | null>;
  createTransferOffer(context: TenantContext, offer: { id: string; sessionId: string; recipientEmail: string }): Promise<void>;
  acceptTransferOffer(context: TenantContext, transferId: string): Promise<ArchivedSession>;

  /** Refuses a pending transfer without copying the session. */
  declineTransferOffer(context: TenantContext, transferId: string): Promise<void>;
}

export interface TeamStore {
  createTeam(input: { name: string; orgId?: string }, creator: TeamMember): Promise<TeamRecord>;
  listTeamsForUser(userId: string): Promise<TeamRecord[]>;
  isTeamMember(teamId: string, userId: string): Promise<boolean>;
  addTeamMember(teamId: string, member: TeamMember): Promise<void>;
  removeTeamMember(teamId: string, userId: string): Promise<boolean>;
  listTeamSessions(teamId: string): Promise<ArchivedSession[]>;
  listTeamCollections(teamId: string): Promise<CollectionRecord[]>;
}

export interface DirectoryStore {
  findAccountByEmail(email: string): Promise<TeamMember | null>;
  getAccountEmail(userId: string): Promise<string | null>;
}

export interface ArtifactStore {
  saveRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<boolean>;
  updateRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<void>;
  getRawArtifact(context: TenantContext, sha256: string): Promise<RawArtifactRecord | null>;
  listArtifactHashes(context: TenantContext, hashes: readonly string[]): Promise<Set<string>>;
  listRawArtifacts(context: TenantContext): Promise<RawArtifactRecord[]>;
}

export interface JobStore {
  saveJob(context: TenantContext, job: JobRecord): Promise<void>;
  getJob(context: TenantContext, jobId: string): Promise<JobRecord | null>;
}

export interface SettingsStore {
  getTenantSettings(context: TenantContext): Promise<TenantSettingsRecord>;
  saveTenantSettings(context: TenantContext, settings: TenantSettingsRecord): Promise<void>;
  getDistillationSettings(context: TenantContext): Promise<DistillationSettings>;
  saveDistillationSettings(context: TenantContext, settings: DistillationSettings): Promise<void>;
  reserveDistillationBudget(context: TenantContext, costCents: number): Promise<{ reserved: boolean; remainingCents: number }>;
  settleDistillationSpend(context: TenantContext, deltaCents: number): Promise<void>;
}

export interface RetentionStore {
  listTenantIds(): Promise<string[]>;
  applyRetention(context: TenantContext, cutoffIso: string, exemptCollected: boolean): Promise<{ deletedSessions: number; deletedArtifacts: number }>;
}

export interface MachineStore {
  listMachines(context: TenantContext): Promise<MachineRecord[]>;
  getMachine(context: TenantContext, machineId: string): Promise<MachineRecord | null>;
  saveMachine(context: TenantContext, machine: MachineRecord): Promise<void>;
  createMachineCommand(context: TenantContext, input: { machineId: string; kind: string; payload: Record<string, unknown> }): Promise<MachineCommandRecord>;
  listUnackedMachineCommands(context: TenantContext, machineId: string): Promise<MachineCommandRecord[]>;
  markMachineCommandsDelivered(context: TenantContext, commandIds: readonly string[]): Promise<void>;
  ackMachineCommand(context: TenantContext, machineId: string, commandId: string, outcome: { status: "completed" | "failed"; error?: string }): Promise<boolean>;
}

/**
 * The full persistence surface. Services should depend on the narrowest
 * domain interface(s) they actually use; only wiring code (module providers,
 * store implementations) should reference the composed interface.
 */
export interface ArchiveStore extends
  SessionStore,
  AnnotationStore,
  CollectionStore,
  SharingStore,
  TeamStore,
  DirectoryStore,
  ArtifactStore,
  JobStore,
  SettingsStore,
  RetentionStore,
  MachineStore,
  MemoryStore {}
