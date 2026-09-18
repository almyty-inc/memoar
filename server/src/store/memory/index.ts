import type { Annotation, AnnotationKind, MemoryDocument, MemoryRevision, Visibility } from "../../../libs/canonical/src/generated.js";
import type { ArchivedSession, SessionFilter, SessionPage, TenantContext } from "../context.js";
import type { ArchiveStore, MemoryCapture } from "../interfaces.js";
import type {
  CollectionRecord, DistillationSettings, JobRecord, MachineCommandRecord, MachineRecord,
  RawArtifactRecord, RedactionReviewRecord, ShareGrantRecord, ShareTokenLookup,
  TeamInvitation, TeamMember, TeamRecord, TeamShareOptinRecord, TenantSettingsRecord, TransferRecord,
} from "../records.js";
import { MemoryAnnotationStore, MemoryCollectionStore } from "./curation.js";
import { MemoryMemoryDocumentStore } from "./memory-documents.js";
import { MemoryArtifactStore, MemoryJobStore, MemoryMachineStore, MemorySettingsStore } from "./operations.js";
import { MemorySessionStore } from "./sessions.js";
import { MemorySharingStore, MemoryTeamStore } from "./sharing.js";
import { MemoryTeamOptinStore } from "./team-optins.js";
import { MemoryTables } from "./tables.js";

/**
 * In-memory ArchiveStore used by unit tests and the no-database dev mode.
 * Behavior lives in the per-domain memory stores; this facade only delegates
 * and exposes the shared tables that tests seed directly.
 */
export class DevArchiveStore implements ArchiveStore {
  private readonly tables = new MemoryTables();
  private readonly sessionStore = new MemorySessionStore(this.tables);
  private readonly annotationStore = new MemoryAnnotationStore(this.tables, this.sessionStore);
  private readonly collectionStore = new MemoryCollectionStore(this.tables);
  private readonly sharingStore = new MemorySharingStore(this.tables);
  private readonly teamStore = new MemoryTeamStore(this.tables);
  private readonly teamOptinStore = new MemoryTeamOptinStore(this.tables);
  private readonly artifactStore = new MemoryArtifactStore(this.tables);
  private readonly memoryStore = new MemoryMemoryDocumentStore(this.tables);
  private readonly jobStore = new MemoryJobStore(this.tables);
  private readonly settingsStore = new MemorySettingsStore(this.tables);
  private readonly machineStore = new MemoryMachineStore(this.tables);

  /** Test seam: team membership lookups resolve accounts through this map. */
  get accountsByEmail(): Map<string, TeamMember> { return this.tables.accountsByEmail; }

  getSessionEmbedding(context: TenantContext, sessionId: string): readonly number[] | null { return this.sessionStore.getSessionEmbedding(context, sessionId); }

  saveSession(context: TenantContext, session: ArchivedSession): Promise<void> { return this.sessionStore.saveSession(context, session); }
  resolveSessionIdentity(context: TenantContext, identity: { sourceTool: string; sourceVersion: string; nativeSessionId: string }, proposedSessionId: string): Promise<string> { return this.sessionStore.resolveSessionIdentity(context, identity, proposedSessionId); }
  saveSessionEmbedding(context: TenantContext, sessionId: string, vector: readonly number[]): Promise<void> { return this.sessionStore.saveSessionEmbedding(context, sessionId, vector); }
  updateSessionVisibility(context: TenantContext, sessionId: string, visibility: Visibility): Promise<boolean> { return this.sessionStore.updateSessionVisibility(context, sessionId, visibility); }
  listSessions(context: TenantContext, filter: SessionFilter): Promise<SessionPage> { return this.sessionStore.listSessions(context, filter); }
  getSession(context: TenantContext, sessionId: string): Promise<ArchivedSession | null> { return this.sessionStore.getSession(context, sessionId); }
  sessionExists(context: TenantContext, sessionId: string): Promise<boolean> { return this.sessionStore.sessionExists(context, sessionId); }
  countSessionsByMachineSource(context: TenantContext): Promise<{ machineId: string; tool: string; sessions: number }[]> { return this.sessionStore.countSessionsByMachineSource(context); }
  getSessions(context: TenantContext, sessionIds: readonly string[]): Promise<ArchivedSession[]> { return this.sessionStore.getSessions(context, sessionIds); }
  deleteSession(context: TenantContext, sessionId: string): Promise<boolean> { return this.sessionStore.deleteSession(context, sessionId); }

  listAnnotations(context: TenantContext, sessionId?: string): Promise<Annotation[]> { return this.annotationStore.listAnnotations(context, sessionId); }
  createAnnotation(context: TenantContext, input: { sessionId: string; turnId?: string; blockId?: string; kind: AnnotationKind; value: Record<string, unknown> }): Promise<Annotation> { return this.annotationStore.createAnnotation(context, input); }
  replaceAnnotations(context: TenantContext, sessionId: string, kind: AnnotationKind, values: Record<string, unknown>[], origin?: string): Promise<Annotation[]> { return this.annotationStore.replaceAnnotations(context, sessionId, kind, values, origin); }
  updateAnnotation(context: TenantContext, annotationId: string, value: Record<string, unknown>): Promise<Annotation | null> { return this.annotationStore.updateAnnotation(context, annotationId, value); }
  deleteAnnotation(context: TenantContext, annotationId: string): Promise<boolean> { return this.annotationStore.deleteAnnotation(context, annotationId); }

  listMemoryDocuments(context: TenantContext, filter?: { machineId?: string; scope?: string }): Promise<MemoryDocument[]> { return this.memoryStore.listMemoryDocuments(context, filter); }
  getMemoryDocument(context: TenantContext, documentId: string): Promise<MemoryDocument | null> { return this.memoryStore.getMemoryDocument(context, documentId); }
  listMemoryRevisions(context: TenantContext, documentId: string): Promise<MemoryRevision[]> { return this.memoryStore.listMemoryRevisions(context, documentId); }
  captureMemoryDocument(context: TenantContext, capture: MemoryCapture): Promise<{ document: MemoryDocument; revision: MemoryRevision | null }> { return this.memoryStore.captureMemoryDocument(context, capture); }
  deleteMemoryDocument(context: TenantContext, documentId: string): Promise<boolean> { return this.memoryStore.deleteMemoryDocument(context, documentId); }

  listCollections(context: TenantContext): Promise<CollectionRecord[]> { return this.collectionStore.listCollections(context); }
  saveCollection(context: TenantContext, collection: CollectionRecord): Promise<void> { return this.collectionStore.saveCollection(context, collection); }

  getReview(context: TenantContext, reviewId: string): Promise<RedactionReviewRecord | null> { return this.sharingStore.getReview(context, reviewId); }
  saveReview(context: TenantContext, review: RedactionReviewRecord): Promise<void> { return this.sharingStore.saveReview(context, review); }
  listShareGrants(context: TenantContext): Promise<ShareGrantRecord[]> { return this.sharingStore.listShareGrants(context); }
  saveShareGrant(context: TenantContext, grant: ShareGrantRecord): Promise<void> { return this.sharingStore.saveShareGrant(context, grant); }
  getShareGrantByTokenHash(tokenHash: string): Promise<ShareTokenLookup | null> { return this.sharingStore.getShareGrantByTokenHash(tokenHash); }
  saveTransfer(context: TenantContext, transfer: TransferRecord): Promise<void> { return this.sharingStore.saveTransfer(context, transfer); }
  listTransfers(context: TenantContext): Promise<TransferRecord[]> { return this.sharingStore.listTransfers(context); }
  getTransfer(context: TenantContext, transferId: string): Promise<TransferRecord | null> { return this.sharingStore.getTransfer(context, transferId); }
  createTransferOffer(context: TenantContext, offer: { id: string; sessionId: string; recipientEmail: string }): Promise<void> { return this.sharingStore.createTransferOffer(context, offer); }
  acceptTransferOffer(context: TenantContext, transferId: string): Promise<ArchivedSession> { return this.sharingStore.acceptTransferOffer(context, transferId); }
  declineTransferOffer(context: TenantContext, transferId: string): Promise<void> { return this.sharingStore.declineTransferOffer(context, transferId); }

  createTeam(input: { name: string; orgId?: string }, creator: TeamMember): Promise<TeamRecord> { return this.teamStore.createTeam(input, creator); }
  listTeamsForUser(userId: string): Promise<TeamRecord[]> { return this.teamStore.listTeamsForUser(userId); }
  isTeamMember(teamId: string, userId: string): Promise<boolean> { return this.teamStore.isTeamMember(teamId, userId); }
  inviteTeamMember(teamId: string, member: TeamMember): Promise<void> { return this.teamStore.inviteTeamMember(teamId, member); }
  listTeamInvitations(userId: string): Promise<TeamInvitation[]> { return this.teamStore.listTeamInvitations(userId); }
  acceptTeamInvitation(teamId: string, userId: string): Promise<boolean> { return this.teamStore.acceptTeamInvitation(teamId, userId); }
  removeTeamMember(teamId: string, userId: string): Promise<boolean> { return this.teamStore.removeTeamMember(teamId, userId); }
  findAccountByEmail(email: string): Promise<TeamMember | null> { return this.teamStore.findAccountByEmail(email); }
  getAccountEmail(userId: string): Promise<string | null> { return this.teamStore.getAccountEmail(userId); }
  listTeamSessions(teamId: string): Promise<ArchivedSession[]> { return this.teamStore.listTeamSessions(teamId); }
  listTeamMemberTenants(teamId: string): Promise<string[]> { return this.teamStore.listTeamMemberTenants(teamId); }
  getTeamSession(teamId: string, sessionId: string): Promise<ArchivedSession | null> { return this.teamStore.getTeamSession(teamId, sessionId); }
  listTeamCollections(teamId: string): Promise<CollectionRecord[]> { return this.teamStore.listTeamCollections(teamId); }

  listTeamOptins(teamId: string, tenantId: string): Promise<TeamShareOptinRecord[]> { return this.teamOptinStore.listTeamOptins(teamId, tenantId); }
  listTenantOptins(tenantId: string): Promise<TeamShareOptinRecord[]> { return this.teamOptinStore.listTenantOptins(tenantId); }
  createTeamOptin(optin: TeamShareOptinRecord): Promise<boolean> { return this.teamOptinStore.createTeamOptin(optin); }
  deleteTeamOptin(teamId: string, tenantId: string, machineId: string | null): Promise<boolean> { return this.teamOptinStore.deleteTeamOptin(teamId, tenantId, machineId); }
  resolveIngestTeam(tenantId: string, machineId?: string): Promise<string | null> { return this.teamOptinStore.resolveIngestTeam(tenantId, machineId); }
  revokeTeamVisibility(context: TenantContext, teamId: string, machineId: string | null): Promise<number> { return this.teamOptinStore.revokeTeamVisibility(context, teamId, machineId); }

  saveRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<boolean> { return this.artifactStore.saveRawArtifact(context, artifact); }
  updateRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<void> { return this.artifactStore.updateRawArtifact(context, artifact); }
  getRawArtifact(context: TenantContext, sha256: string): Promise<RawArtifactRecord | null> { return this.artifactStore.getRawArtifact(context, sha256); }
  listArtifactHashes(context: TenantContext, hashes: readonly string[]): Promise<Set<string>> { return this.artifactStore.listArtifactHashes(context, hashes); }
  listRawArtifacts(context: TenantContext): Promise<RawArtifactRecord[]> { return this.artifactStore.listRawArtifacts(context); }
  countUnparsedArtifactsBySource(context: TenantContext) { return this.artifactStore.countUnparsedArtifactsBySource(context); }

  saveJob(context: TenantContext, job: JobRecord): Promise<void> { return this.jobStore.saveJob(context, job); }
  getJob(context: TenantContext, jobId: string): Promise<JobRecord | null> { return this.jobStore.getJob(context, jobId); }

  getTenantSettings(context: TenantContext): Promise<TenantSettingsRecord> { return this.settingsStore.getTenantSettings(context); }
  saveTenantSettings(context: TenantContext, settings: TenantSettingsRecord): Promise<void> { return this.settingsStore.saveTenantSettings(context, settings); }
  getDistillationSettings(context: TenantContext): Promise<DistillationSettings> { return this.settingsStore.getDistillationSettings(context); }
  saveDistillationSettings(context: TenantContext, settings: DistillationSettings): Promise<void> { return this.settingsStore.saveDistillationSettings(context, settings); }
  reserveDistillationBudget(context: TenantContext, costCents: number): Promise<{ reserved: boolean; remainingCents: number }> { return this.settingsStore.reserveDistillationBudget(context, costCents); }
  settleDistillationSpend(context: TenantContext, deltaCents: number): Promise<void> { return this.settingsStore.settleDistillationSpend(context, deltaCents); }
  listTenantIds(): Promise<string[]> { return this.settingsStore.listTenantIds(); }
  applyRetention(context: TenantContext, cutoffIso: string, exemptCollected: boolean): Promise<{ deletedSessions: number; deletedArtifacts: number }> { return this.settingsStore.applyRetention(context, cutoffIso, exemptCollected); }

  listMachines(context: TenantContext): Promise<MachineRecord[]> { return this.machineStore.listMachines(context); }
  getMachine(context: TenantContext, machineId: string): Promise<MachineRecord | null> { return this.machineStore.getMachine(context, machineId); }
  saveMachine(context: TenantContext, machine: MachineRecord): Promise<void> { return this.machineStore.saveMachine(context, machine); }
  createMachineCommand(context: TenantContext, input: { machineId: string; kind: string; payload: Record<string, unknown> }): Promise<MachineCommandRecord> { return this.machineStore.createMachineCommand(context, input); }
  listUnackedMachineCommands(context: TenantContext, machineId: string): Promise<MachineCommandRecord[]> { return this.machineStore.listUnackedMachineCommands(context, machineId); }
  markMachineCommandsDelivered(context: TenantContext, commandIds: readonly string[]): Promise<void> { return this.machineStore.markMachineCommandsDelivered(context, commandIds); }
  ackMachineCommand(context: TenantContext, machineId: string, commandId: string, outcome: { status: "completed" | "failed"; error?: string }): Promise<boolean> { return this.machineStore.ackMachineCommand(context, machineId, commandId, outcome); }
}
