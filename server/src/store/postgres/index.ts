import type { DataSource } from "typeorm";
import type { Annotation, AnnotationKind, MemoryDocument, MemoryRevision, Visibility } from "../../../libs/canonical/src/generated.js";
import type { ArchivedSession, SessionFilter, SessionPage, TenantContext } from "../context.js";
import type { AnnotationStore, ArchiveStore, MemoryCapture } from "../interfaces.js";
import type {
  CollectionRecord, DistillationSettings, JobRecord, MachineCommandRecord, MachineRecord,
  RawArtifactRecord, RedactionReviewRecord, ShareGrantRecord, ShareTokenLookup,
  TeamInvitation, TeamMember, TeamMemberSummary, TeamRecord, TeamShareOptinRecord, TenantSettingsRecord, TransferRecord,
} from "../records.js";
import { PostgresAnnotationStore } from "./annotations.js";
import { PostgresArtifactStore } from "./artifacts.js";
import { PostgresCollectionStore } from "./collections.js";
import { PostgresJobStore } from "./jobs.js";
import { PostgresMemoryStore } from "./memory.js";
import { PostgresMachineStore } from "./machines.js";
import { TenantRunner } from "./runner.js";
import { PostgresSessionStore } from "./sessions.js";
import { PostgresSettingsStore } from "./settings.js";
import { PostgresSharingStore } from "./sharing.js";
import { PostgresTeamOptinStore } from "./team-optins.js";
import { PostgresTeamStore } from "./teams.js";

export { TenantRunner, TenantScope } from "./runner.js";

/**
 * Facade composing the per-domain Postgres stores behind the full
 * ArchiveStore surface. Every method is a one-line delegate; the behavior
 * lives in the domain store files next to this one.
 */
export class PostgresArchiveStore implements ArchiveStore {
  private readonly sessions: PostgresSessionStore;
  private readonly annotations: PostgresAnnotationStore;
  private readonly collections: PostgresCollectionStore;
  private readonly sharing: PostgresSharingStore;
  private readonly teams: PostgresTeamStore;
  private readonly teamOptins: PostgresTeamOptinStore;
  private readonly artifacts: PostgresArtifactStore;
  private readonly jobs: PostgresJobStore;
  private readonly settings: PostgresSettingsStore;
  private readonly machines: PostgresMachineStore;
  private readonly memoryDocuments: PostgresMemoryStore;

  constructor(dataSource: DataSource) {
    const runner = new TenantRunner(dataSource);
    this.sessions = new PostgresSessionStore(runner);
    this.annotations = new PostgresAnnotationStore(runner, this.sessions);
    this.collections = new PostgresCollectionStore(runner);
    this.teams = new PostgresTeamStore(runner, this.sessions, this.collections);
    this.teamOptins = new PostgresTeamOptinStore(runner);
    this.artifacts = new PostgresArtifactStore(runner);
    this.jobs = new PostgresJobStore(runner);
    this.settings = new PostgresSettingsStore(runner);
    // After settings and annotations: accepting a transfer has to project the
    // copy through the sender's own redaction settings and masks.
    this.sharing = new PostgresSharingStore(runner, this.sessions, this.settings, this.annotations);
    this.machines = new PostgresMachineStore(runner);
    this.memoryDocuments = new PostgresMemoryStore(runner);
  }

  saveSession(context: TenantContext, session: ArchivedSession): Promise<void> { return this.sessions.saveSession(context, session); }
  resolveSessionIdentity(context: TenantContext, identity: { sourceTool: string; sourceVersion: string; nativeSessionId: string }, proposedSessionId: string): Promise<string> { return this.sessions.resolveSessionIdentity(context, identity, proposedSessionId); }
  saveSessionEmbedding(context: TenantContext, sessionId: string, vector: readonly number[]): Promise<void> { return this.sessions.saveSessionEmbedding(context, sessionId, vector); }
  updateSessionVisibility(context: TenantContext, sessionId: string, visibility: Visibility): Promise<boolean> { return this.sessions.updateSessionVisibility(context, sessionId, visibility); }
  listSessions(context: TenantContext, filter: SessionFilter): Promise<SessionPage> { return this.sessions.listSessions(context, filter); }
  getSession(context: TenantContext, sessionId: string): Promise<ArchivedSession | null> { return this.sessions.getSession(context, sessionId); }
  sessionExists(context: TenantContext, sessionId: string): Promise<boolean> { return this.sessions.sessionExists(context, sessionId); }
  countSessionsByMachineSource(context: TenantContext): Promise<{ machineId: string; tool: string; sessions: number }[]> { return this.sessions.countSessionsByMachineSource(context); }
  getSessions(context: TenantContext, sessionIds: readonly string[]): Promise<ArchivedSession[]> { return this.sessions.getSessions(context, sessionIds); }
  deleteSession(context: TenantContext, sessionId: string): Promise<boolean> { return this.sessions.deleteSession(context, sessionId); }

  listAnnotations(context: TenantContext, sessionId?: string): Promise<Annotation[]> { return this.annotations.listAnnotations(context, sessionId); }
  createAnnotation(context: TenantContext, input: Parameters<AnnotationStore["createAnnotation"]>[1]): Promise<Annotation> { return this.annotations.createAnnotation(context, input); }
  replaceAnnotations(context: TenantContext, sessionId: string, kind: AnnotationKind, values: Record<string, unknown>[], origin?: string): Promise<Annotation[]> { return this.annotations.replaceAnnotations(context, sessionId, kind, values, origin); }
  updateAnnotation(context: TenantContext, annotationId: string, value: Record<string, unknown>): Promise<Annotation | null> { return this.annotations.updateAnnotation(context, annotationId, value); }
  deleteAnnotation(context: TenantContext, annotationId: string): Promise<boolean> { return this.annotations.deleteAnnotation(context, annotationId); }

  listMemoryDocuments(context: TenantContext, filter?: { machineId?: string; scope?: string }): Promise<MemoryDocument[]> { return this.memoryDocuments.listMemoryDocuments(context, filter); }
  getMemoryDocument(context: TenantContext, documentId: string): Promise<MemoryDocument | null> { return this.memoryDocuments.getMemoryDocument(context, documentId); }
  listMemoryRevisions(context: TenantContext, documentId: string): Promise<MemoryRevision[]> { return this.memoryDocuments.listMemoryRevisions(context, documentId); }
  captureMemoryDocument(context: TenantContext, capture: MemoryCapture): Promise<{ document: MemoryDocument; revision: MemoryRevision | null }> { return this.memoryDocuments.captureMemoryDocument(context, capture); }
  reviewMemoryDocument(context: TenantContext, documentId: string, contentHash: string): Promise<MemoryDocument | null> { return this.memoryDocuments.reviewMemoryDocument(context, documentId, contentHash); }
  deleteMemoryDocument(context: TenantContext, documentId: string): Promise<boolean> { return this.memoryDocuments.deleteMemoryDocument(context, documentId); }

  listCollections(context: TenantContext): Promise<CollectionRecord[]> { return this.collections.listCollections(context); }
  saveCollection(context: TenantContext, collection: CollectionRecord): Promise<void> { return this.collections.saveCollection(context, collection); }

  getReview(context: TenantContext, reviewId: string): Promise<RedactionReviewRecord | null> { return this.sharing.getReview(context, reviewId); }
  saveReview(context: TenantContext, review: RedactionReviewRecord): Promise<void> { return this.sharing.saveReview(context, review); }
  listShareGrants(context: TenantContext): Promise<ShareGrantRecord[]> { return this.sharing.listShareGrants(context); }
  saveShareGrant(context: TenantContext, grant: ShareGrantRecord): Promise<void> { return this.sharing.saveShareGrant(context, grant); }
  getShareGrantByTokenHash(tokenHash: string): Promise<ShareTokenLookup | null> { return this.sharing.getShareGrantByTokenHash(tokenHash); }
  saveTransfer(context: TenantContext, transfer: TransferRecord): Promise<void> { return this.sharing.saveTransfer(context, transfer); }
  listTransfers(context: TenantContext): Promise<TransferRecord[]> { return this.sharing.listTransfers(context); }
  getTransfer(context: TenantContext, transferId: string): Promise<TransferRecord | null> { return this.sharing.getTransfer(context, transferId); }
  createTransferOffer(context: TenantContext, offer: { id: string; sessionId: string; recipientEmail: string }): Promise<void> { return this.sharing.createTransferOffer(context, offer); }
  acceptTransferOffer(context: TenantContext, transferId: string): Promise<ArchivedSession> { return this.sharing.acceptTransferOffer(context, transferId); }
  declineTransferOffer(context: TenantContext, transferId: string): Promise<void> { return this.sharing.declineTransferOffer(context, transferId); }

  createTeam(input: { name: string; orgId?: string }, creator: TeamMember): Promise<TeamRecord> { return this.teams.createTeam(input, creator); }
  listTeamsForUser(userId: string): Promise<TeamRecord[]> { return this.teams.listTeamsForUser(userId); }
  isTeamMember(teamId: string, userId: string): Promise<boolean> { return this.teams.isTeamMember(teamId, userId); }
  inviteTeamMember(teamId: string, member: TeamMember): Promise<void> { return this.teams.inviteTeamMember(teamId, member); }
  listTeamInvitations(userId: string): Promise<TeamInvitation[]> { return this.teams.listTeamInvitations(userId); }
  listTeamMembers(teamId: string): Promise<TeamMemberSummary[]> { return this.teams.listTeamMembers(teamId); }
  acceptTeamInvitation(teamId: string, userId: string): Promise<boolean> { return this.teams.acceptTeamInvitation(teamId, userId); }
  removeTeamMember(teamId: string, userId: string): Promise<boolean> { return this.teams.removeTeamMember(teamId, userId); }
  findAccountByEmail(email: string): Promise<TeamMember | null> { return this.teams.findAccountByEmail(email); }
  getAccountEmail(userId: string): Promise<string | null> { return this.teams.getAccountEmail(userId); }
  listTeamSessions(teamId: string): Promise<ArchivedSession[]> { return this.teams.listTeamSessions(teamId); }
  listTeamMemberTenants(teamId: string): Promise<string[]> { return this.teams.listTeamMemberTenants(teamId); }
  getTeamSession(teamId: string, sessionId: string): Promise<ArchivedSession | null> { return this.teams.getTeamSession(teamId, sessionId); }
  listTeamCollections(teamId: string): Promise<CollectionRecord[]> { return this.teams.listTeamCollections(teamId); }

  listTeamOptins(teamId: string, tenantId: string): Promise<TeamShareOptinRecord[]> { return this.teamOptins.listTeamOptins(teamId, tenantId); }
  listTenantOptins(tenantId: string): Promise<TeamShareOptinRecord[]> { return this.teamOptins.listTenantOptins(tenantId); }
  createTeamOptin(optin: TeamShareOptinRecord): Promise<boolean> { return this.teamOptins.createTeamOptin(optin); }
  deleteTeamOptin(teamId: string, tenantId: string, machineId: string | null): Promise<boolean> { return this.teamOptins.deleteTeamOptin(teamId, tenantId, machineId); }
  resolveIngestTeam(tenantId: string, machineId?: string): Promise<string | null> { return this.teamOptins.resolveIngestTeam(tenantId, machineId); }
  revokeTeamVisibility(context: TenantContext, teamId: string, machineId: string | null): Promise<number> { return this.teamOptins.revokeTeamVisibility(context, teamId, machineId); }

  saveRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<boolean> { return this.artifacts.saveRawArtifact(context, artifact); }
  updateRawArtifact(context: TenantContext, artifact: RawArtifactRecord): Promise<void> { return this.artifacts.updateRawArtifact(context, artifact); }
  getRawArtifact(context: TenantContext, sha256: string): Promise<RawArtifactRecord | null> { return this.artifacts.getRawArtifact(context, sha256); }
  listArtifactHashes(context: TenantContext, hashes: readonly string[]): Promise<Set<string>> { return this.artifacts.listArtifactHashes(context, hashes); }
  countUnparsedArtifactsBySource(context: TenantContext) { return this.artifacts.countUnparsedArtifactsBySource(context); }
  listRawArtifacts(context: TenantContext): Promise<RawArtifactRecord[]> { return this.artifacts.listRawArtifacts(context); }

  saveJob(context: TenantContext, job: JobRecord): Promise<void> { return this.jobs.saveJob(context, job); }
  getJob(context: TenantContext, jobId: string): Promise<JobRecord | null> { return this.jobs.getJob(context, jobId); }

  getTenantSettings(context: TenantContext): Promise<TenantSettingsRecord> { return this.settings.getTenantSettings(context); }
  saveTenantSettings(context: TenantContext, settings: TenantSettingsRecord): Promise<void> { return this.settings.saveTenantSettings(context, settings); }
  getDistillationSettings(context: TenantContext): Promise<DistillationSettings> { return this.settings.getDistillationSettings(context); }
  saveDistillationSettings(context: TenantContext, settings: DistillationSettings): Promise<void> { return this.settings.saveDistillationSettings(context, settings); }
  reserveDistillationBudget(context: TenantContext, costCents: number): Promise<{ reserved: boolean; remainingCents: number }> { return this.settings.reserveDistillationBudget(context, costCents); }
  settleDistillationSpend(context: TenantContext, deltaCents: number): Promise<void> { return this.settings.settleDistillationSpend(context, deltaCents); }
  listTenantIds(): Promise<string[]> { return this.settings.listTenantIds(); }
  applyRetention(context: TenantContext, cutoffIso: string, exemptCollected: boolean): Promise<{ deletedSessions: number; deletedArtifacts: number }> { return this.settings.applyRetention(context, cutoffIso, exemptCollected); }

  listMachines(context: TenantContext): Promise<MachineRecord[]> { return this.machines.listMachines(context); }
  getMachine(context: TenantContext, machineId: string): Promise<MachineRecord | null> { return this.machines.getMachine(context, machineId); }
  saveMachine(context: TenantContext, machine: MachineRecord): Promise<void> { return this.machines.saveMachine(context, machine); }
  createMachineCommand(context: TenantContext, input: { machineId: string; kind: string; payload: Record<string, unknown> }): Promise<MachineCommandRecord> { return this.machines.createMachineCommand(context, input); }
  listUnackedMachineCommands(context: TenantContext, machineId: string): Promise<MachineCommandRecord[]> { return this.machines.listUnackedMachineCommands(context, machineId); }
  markMachineCommandsDelivered(context: TenantContext, commandIds: readonly string[]): Promise<void> { return this.machines.markMachineCommandsDelivered(context, commandIds); }
  ackMachineCommand(context: TenantContext, machineId: string, commandId: string, outcome: { status: "completed" | "failed"; error?: string }): Promise<boolean> { return this.machines.ackMachineCommand(context, machineId, commandId, outcome); }
}
