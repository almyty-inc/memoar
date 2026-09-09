import { sourceLabel } from './source-labels';
import type {
  MemoryDocument,
  MemoryRevision,
  Annotation,
  ApiKey,
  ApiKeyCreateResult,
  CurrentUser,
  Collection,
  ContentBlock,
  ConversionJob,
  DashboardState,
  Machine,
  MachineSource,
  PackResponse,
  SearchAggregation,
  SearchResponse,
  ProvenanceEntry,
  SessionDetailData,
  SessionSummary,
  SessionTurn,
  ShareGrant,
  TimelineGroup,
  Transfer,
} from './types';

interface WireSessionSummary {
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

interface WireTimelineResponse {
  groups: Array<{ date: string; sessions: WireSessionSummary[] }>;
  total: number;
  nextCursor: string | null;
}

interface WireSearchResponse {
  items: WireSessionSummary[];
  nextCursor: string | null;
  aggregations: Record<string, unknown>;
  meta: SearchResponse['meta'];
}

interface WireBlock {
  id: string;
  kind: string;
  text?: string;
  name?: string;
  callId?: string;
  mimeType?: string;
  artifactRef?: string;
  data?: Record<string, unknown>;
}

interface WireTurn {
  id: string;
  ordinal: number;
  parentId: string | null;
  role: SessionTurn['role'];
  createdAt: string;
  model?: string;
  tokens?: { input: number; output: number; cacheRead?: number };
  blocks: WireBlock[];
}

interface WireSessionChunk {
  session: WireSessionSummary;
  turns: WireTurn[];
  provenance?: ProvenanceEntry[];
  nextCursor: string | null;
}

interface WireCollection {
  id: string;
  name: string;
  description?: string;
  sessionCount: number;
  updatedAt: string;
}

interface WireShareGrant {
  id: string;
  sessionId: string;
  permission: ShareGrant['permission'];
  status: ShareGrant['status'];
  token?: string;
  createdAt: string;
  expiresAt?: string | null;
}

interface WireTransfer {
  id: string;
  sessionId: string;
  senderEmail: string;
  recipientEmail: string;
  status: Transfer['status'];
  createdAt: string;
}

interface WireMachineSource {
  id?: string;
  source?: string;
  label?: string;
  enabled?: boolean;
  state?: MachineSource['state'];
  sessionCount?: number;
  lastSyncAt?: string | null;
  settings?: { enabled?: boolean };
}

interface WireMachine {
  id: string;
  name: string;
  platform: string;
  status?: Machine['status'];
  lastSeenAt?: string | null;
  agentVersion?: string;
  sources?: WireMachineSource[];
}

interface ListResponse<T> {
  items: T[];
}

export class MemoarApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'MemoarApiError';
    this.status = status;
  }
}

export type ImportSource = 'canonical' | 'cass' | 'claude-code' | 'codex' | 'antigravity-cli' | 'cursor' | 'chatgpt-export';

export type ImportStage = 'hashing' | 'uploading' | 'queued' | 'processing' | 'ready';

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

/**
 * A summary as the app uses it. What the archive does not know stays absent
 * rather than being given a stand-in that reads like a fact.
 */
function mapSession(session: WireSessionSummary): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    summary: session.summary ?? '',
    source: session.source,
    sourceLabel: session.sourceLabel,
    workspace: session.workspace,
    ...(session.branch ? { branch: session.branch } : {}),
    ...(session.machineId ? { machineId: session.machineId } : {}),
    ...(session.model ? { model: session.model } : {}),
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    turnCount: session.turnCount,
    tokenCount: session.tokenCount,
    ...(session.durationMinutes === undefined ? {} : { durationMinutes: session.durationMinutes }),
    redactionStatus: session.redactionStatus,
    ...(session.score === undefined ? {} : { score: session.score }),
    ...(session.highlight === undefined ? {} : { highlight: session.highlight }),
  };
}


function mapAggregation(value: unknown, label: (key: string) => string = (key) => key): SearchAggregation[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([key, count]) => ({ label: label(key), value: label(key), count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}


function stringField(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function mapBlock(block: WireBlock): ContentBlock {
  if (block.kind === 'text' || block.kind === 'thinking' || block.kind === 'system' || block.kind === 'error') {
    return { id: block.id, kind: block.kind, text: block.text ?? '' };
  }
  if (block.kind === 'tool_call') {
    return {
      id: block.id,
      kind: 'tool_call',
      name: block.name ?? 'tool',
      callId: block.callId ?? block.id,
      data: block.data ?? {},
    };
  }
  if (block.kind === 'tool_result') {
    return {
      id: block.id,
      kind: 'tool_result',
      callId: block.callId ?? block.id,
      text: block.text ?? JSON.stringify(block.data ?? {}, null, 2),
      status: block.data?.status === 'error' ? 'error' : 'success',
    };
  }
  if (block.kind === 'diff') {
    return {
      id: block.id,
      kind: 'diff',
      path: stringField(block.data?.path, block.name ?? 'diff'),
      oldText: stringField(block.data?.oldText, stringField(block.data?.before)),
      newText: stringField(block.data?.newText, stringField(block.data?.after, block.text ?? '')),
    };
  }
  return {
    id: block.id,
    kind: 'artifact',
    name: block.name ?? block.artifactRef ?? block.kind,
    mediaType: block.mimeType ?? 'application/octet-stream',
  };
}

function mapSessionDetail(summary: SessionSummary, chunks: WireSessionChunk[]): SessionDetailData {
  const turns = chunks.flatMap((chunk) => chunk.turns).map((turn): SessionTurn => ({
    id: turn.id,
    ordinal: turn.ordinal,
    parentId: turn.parentId,
    role: turn.role,
    createdAt: turn.createdAt,
    ...(turn.model ? { model: turn.model } : {}),
    ...(turn.tokens ? { tokens: { input: turn.tokens.input, output: turn.tokens.output } } : {}),
    blocks: turn.blocks.map(mapBlock),
  }));
  const tokenTotals = turns.reduce((totals, turn) => ({
    input: totals.input + (turn.tokens?.input ?? 0),
    output: totals.output + (turn.tokens?.output ?? 0),
    cacheRead: totals.cacheRead + (chunks.flatMap((chunk) => chunk.turns).find((wire) => wire.id === turn.id)?.tokens?.cacheRead ?? 0),
  }), { input: 0, output: 0, cacheRead: 0 });
  const createdAt = turns[0]?.createdAt ?? summary.createdAt;
  const durationMinutes = turns.length > 1
    ? Math.max(0, Math.round((new Date(turns.at(-1)!.createdAt).valueOf() - new Date(createdAt).valueOf()) / 60_000))
    : 0;
  return {
    session: {
      ...summary,
      createdAt,
      durationMinutes,
      tokenCount: tokenTotals.input + tokenTotals.output,
      turnCount: turns.length,
    },
    turns,
    provenance: chunks[0]?.provenance ?? [],
    tokenTotals,
  };
}

function mapCollection(collection: WireCollection): Collection {
  return {
    ...collection,
    description: collection.description ?? '',
    color: '#3d7a1f',
  };
}

function mapMachine(machine: WireMachine): Machine {
  return {
    id: machine.id,
    name: machine.name,
    platform: machine.platform,
    status: machine.status ?? (machine.lastSeenAt ? 'online' : 'never_connected'),
    lastSeenAt: machine.lastSeenAt ?? null,
    agentVersion: machine.agentVersion ?? 'unknown',
    sources: (machine.sources ?? []).flatMap((source) => {
      const sourceId = source.id ?? source.source;
      if (!sourceId) return [];
      const enabled = source.enabled ?? source.settings?.enabled ?? true;
      return [{
        id: sourceId,
        label: source.label ?? sourceLabel(sourceId),
        enabled,
        state: source.state ?? (enabled ? 'synced' : 'disabled'),
        sessionCount: source.sessionCount ?? 0,
        lastSyncAt: source.lastSyncAt ?? null,
      }];
    }),
  };
}

interface StoredSession {
  token: string;
  expiresAt: string | null;
}

export class MemoarApiClient {
  private readonly baseUrl: string;
  private session: StoredSession | null;

  constructor(baseUrl: string, token: string | null = null) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.session = token ? { token, expiresAt: null } : null;
  }

  get configured(): boolean {
    return this.baseUrl.length > 0;
  }

  /**
   * Refuses to answer without an archive to ask. There is no substitute for it:
   * an unconfigured endpoint is an error, never sample data.
   */
  private requireArchive(): void {
    if (!this.configured) throw new MemoarApiError(0, 'No archive endpoint is configured for this build (VITE_API_URL).');
  }

  /** The endpoint an agent on a machine has to be pointed at. */
  get endpoint(): string {
    return this.baseUrl;
  }

  get authenticated(): boolean {
    return this.accessToken() !== null;
  }

  get mcpEndpoint(): string {
    return `${this.baseUrl.replace(/\/v1$/, '')}/mcp`;
  }

  setAccessToken(token: string, expiresAt: string): void {
    this.session = { token, expiresAt };
    window.sessionStorage.setItem('memoar.session', JSON.stringify(this.session));
  }

  clearSession(): void {
    this.session = null;
    window.sessionStorage.removeItem('memoar.session');
  }

  private accessToken(): string | null {
    if (!this.session) {
      const encoded = window.sessionStorage.getItem('memoar.session');
      if (encoded) {
        try {
          const value = JSON.parse(encoded) as StoredSession;
          if (typeof value.token === 'string') this.session = value;
        } catch {
          window.sessionStorage.removeItem('memoar.session');
        }
      }
    }
    if (this.session?.expiresAt && new Date(this.session.expiresAt).valueOf() <= Date.now()) {
      this.clearSession();
      return null;
    }
    return this.session?.token ?? null;
  }

  /**
   * One authenticated fetch. Kept separate from request() so responses that are
   * not JSON — an export download, for one — can be read without pretending to
   * be, while still sharing the token, timeout and 401 handling.
   */
  private async fetchWithAuth(path: string, init?: RequestInit): Promise<Response> {
    this.requireArchive();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 10_000);
    try {
      const token = this.accessToken();
      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          Accept: 'application/json',
          ...(typeof init?.body === 'string' ? { 'Content-Type': 'application/json' } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...init?.headers,
        },
      });
      if (response.status === 401) {
        this.clearSession();
        window.dispatchEvent(new CustomEvent('memoar:unauthorized'));
      }
      return response;
    } finally {
      window.clearTimeout(timer);
    }
  }

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    {
      const response = await this.fetchWithAuth(path, init);
      if (!response.ok) {
        const body = await response.text();
        throw new MemoarApiError(response.status, body || `Memoar API returned ${response.status}`);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    }
  }

  async login(email: string, password: string): Promise<CurrentUser> {
    const result = await this.request<{ accessToken: string; expiresAt: string; user: CurrentUser }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.setAccessToken(result.accessToken, result.expiresAt);
    return result.user;
  }

  /**
   * Who is signed in, according to the server. A reload keeps the token but not
   * the login response, so the identity is re-fetched rather than cached and
   * re-displayed without any way to verify it is still true.
   */
  currentUser(): Promise<CurrentUser> {
    return this.request<CurrentUser>('/auth/me');
  }

  beginOAuth(provider: 'github' | 'google'): void {
    window.location.assign(`${this.baseUrl}/auth/oauth/${provider}`);
  }

  consumeOAuthCallback(): boolean {
    if (!window.location.hash.startsWith('#access_token=')) return false;
    const parameters = new URLSearchParams(window.location.hash.slice(1));
    const token = parameters.get('access_token');
    const expiresAt = parameters.get('expires_at');
    if (!token || !expiresAt || !Number.isFinite(new Date(expiresAt).valueOf())) return false;
    this.setAccessToken(token, expiresAt);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#/timeline`,
    );
    return true;
  }

  async loadTimelinePage(cursor: string | null = null, limit = 30): Promise<{ groups: TimelineGroup[]; total: number; nextCursor: string | null }> {
    this.requireArchive();
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const response = await this.request<WireTimelineResponse>(`/sessions/timeline?${query.toString()}`);
    return {
      groups: response.groups.map((group) => ({ date: group.date, sessions: group.sessions.map(mapSession) })),
      total: response.total,
      nextCursor: response.nextCursor,
    };
  }
  async loadDashboard(): Promise<DashboardState> {
    this.requireArchive();
    const timeline = await this.loadTimelinePage();
    const sessions = timeline.groups.flatMap((group) => group.sessions);
    const sessionTitles = new Map(sessions.map((session) => [session.id, session.title]));
    const [collections, grants, transfers, machines, apiKeys] = await Promise.all([
      this.request<ListResponse<WireCollection>>('/collections'),
      this.request<ListResponse<WireShareGrant>>('/sharing/links'),
      this.request<ListResponse<WireTransfer>>('/sharing/transfers'),
      this.request<ListResponse<WireMachine>>('/machines'),
      this.request<ListResponse<ApiKey>>('/auth/api-keys'),
    ]);
    return {
      timeline: timeline.groups,
      archivedSessions: timeline.total,
      nextTimelineCursor: timeline.nextCursor,
      collections: collections.items.map(mapCollection),
      grants: grants.items.map((grant) => ({
        ...grant,
        sessionTitle: sessionTitles.get(grant.sessionId) ?? grant.sessionId,
        expiresAt: grant.expiresAt ?? null,
      })),
      transfers: transfers.items.map((transfer) => ({
        ...transfer,
        sessionTitle: sessionTitles.get(transfer.sessionId) ?? transfer.sessionId,
        direction: transfer.recipientEmail.endsWith('@local.invalid') ? 'incoming' : 'outgoing',
      })),
      machines: machines.items.map(mapMachine),
      apiKeys: apiKeys.items,
    };
  }

  async search(query: string): Promise<SearchResponse> {
    this.requireArchive();
    const response = await this.request<WireSearchResponse>(
      `/search?q=${encodeURIComponent(query || 'session')}&mode=hybrid&limit=50`,
    );
    const items = response.items.map(mapSession);
    return {
      items,
      nextCursor: response.nextCursor,
      aggregations: {
        agents: mapAggregation(response.aggregations.agents, sourceLabel),
        workspaces: mapAggregation(response.aggregations.workspaces),
        dates: mapAggregation(response.aggregations.dates),
      },
      meta: response.meta,
    };
  }

  async getSession(session: SessionSummary): Promise<SessionDetailData> {
    this.requireArchive();
    const chunks: WireSessionChunk[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor ? `?chunkSize=200&cursor=${encodeURIComponent(cursor)}` : '?chunkSize=200';
      const chunk: WireSessionChunk = await this.request<WireSessionChunk>(`/sessions/${session.id}${query}`);
      chunks.push(chunk);
      cursor = chunk.nextCursor;
    } while (cursor);
    return mapSessionDetail(mapSession(chunks[0]!.session), chunks);
  }

  async completeRedactionReview(sessionId: string): Promise<{ id: string; maskCount: number }> {
    this.requireArchive();
    return this.request<{ id: string; maskCount: number }>(`/sessions/${sessionId}/redaction-reviews`, { method: 'POST' });
  }

  /**
   * Mints a share link. The redaction review id is required by the contract, so
   * a link can only exist for a session whose mask someone approved.
   */
  createShareLink(input: { sessionId: string; permission: ShareGrant['permission']; redactionReviewId: string; expiresAt: string | null }): Promise<ShareGrant> {
    return this.request<ShareGrant>('/sharing/links', { method: 'POST', body: JSON.stringify(input) });
  }

  revokeShareLink(grantId: string): Promise<void> {
    return this.request<void>(`/sharing/grants/${grantId}`, { method: 'DELETE' });
  }

  requestTransfer(input: { sessionId: string; recipientEmail: string; redactionReviewId: string }): Promise<Transfer> {
    return this.request<Transfer>('/sharing/transfers', { method: 'POST', body: JSON.stringify(input) });
  }

  listMemory(): Promise<{ items: MemoryDocument[] }> {
    return this.request<{ items: MemoryDocument[] }>('/memory');
  }

  getMemory(documentId: string): Promise<{ document: MemoryDocument; revisions: MemoryRevision[] }> {
    return this.request<{ document: MemoryDocument; revisions: MemoryRevision[] }>(`/memory/${documentId}`);
  }

  deleteMemory(documentId: string): Promise<void> {
    return this.request<void>(`/memory/${documentId}`, { method: 'DELETE' });
  }

  deleteSession(sessionId: string): Promise<void> {
    return this.request<void>(`/sessions/${sessionId}`, { method: 'DELETE' });
  }

  revokeApiKey(keyId: string): Promise<void> {
    return this.request<void>(`/auth/api-keys/${keyId}`, { method: 'DELETE' });
  }

  declineTransfer(transferId: string): Promise<void> {
    return this.request<void>(`/sharing/transfers/${transferId}/decline`, { method: 'POST' });
  }

  listAnnotations(sessionId: string): Promise<ListResponse<Annotation>> {
    return this.request<ListResponse<Annotation>>(`/annotations?sessionId=${encodeURIComponent(sessionId)}`);
  }

  createAnnotation(input: { sessionId: string; kind: Annotation['kind']; value: Record<string, unknown> }): Promise<Annotation> {
    return this.request<Annotation>('/annotations', { method: 'POST', body: JSON.stringify(input) });
  }

  deleteAnnotation(annotationId: string): Promise<void> {
    return this.request<void>(`/annotations/${annotationId}`, { method: 'DELETE' });
  }

  addSessionToCollection(collectionId: string, sessionId: string): Promise<void> {
    return this.request<void>(`/collections/${collectionId}/sessions/${sessionId}`, { method: 'PUT' });
  }

  removeSessionFromCollection(collectionId: string, sessionId: string): Promise<void> {
    return this.request<void>(`/collections/${collectionId}/sessions/${sessionId}`, { method: 'DELETE' });
  }

  async listCollectionSessions(collectionId: string): Promise<SessionSummary[]> {
    const page = await this.request<ListResponse<WireSessionSummary>>(`/collections/${collectionId}/sessions`);
    return page.items.map(mapSession);
  }

  /**
   * Exports a session as a file. The response carries the filename the server
   * chose, so the download is named by the archive rather than by the browser
   * guessing from a URL.
   */
  async exportSession(sessionId: string, format: 'canonical' | 'markdown' = 'canonical'): Promise<{ filename: string; body: string; contentType: string }> {
    const response = await this.fetchWithAuth(`/sessions/${sessionId}/export?format=${format}`);
    if (!response.ok) throw new MemoarApiError(response.status, `Export failed with HTTP ${response.status}`);
    const disposition = response.headers.get('content-disposition') ?? '';
    const match = /filename="([^"]+)"/.exec(disposition);
    return {
      filename: match?.[1] ?? `${sessionId}.json`,
      body: await response.text(),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  async updateSessionVisibility(
    sessionId: string,
    visibility: { scope: 'private' | 'team' | 'org' | 'link'; teamId?: string; orgId?: string },
    redactionReviewId?: string,
  ): Promise<{ id: string; visibility: { scope: string } }> {
    this.requireArchive();
    return this.request(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(redactionReviewId ? { visibility, redactionReviewId } : { visibility }),
    });
  }

  async getSettings(): Promise<TenantSettings> {
    this.requireArchive();
    return this.request<TenantSettings>('/settings');
  }

  async updateSettings(update: {
    redaction?: Partial<TenantSettings['redaction']>;
    retention?: Partial<TenantSettings['retention']>;
  }): Promise<TenantSettings> {
    this.requireArchive();
    return this.request<TenantSettings>('/settings', { method: 'PUT', body: JSON.stringify(update) });
  }

  async getDistillationSettings(): Promise<DistillationSettings> {
    this.requireArchive();
    return this.request<DistillationSettings>('/distillation/settings');
  }

  /**
   * Distillation is the only feature that sends archived content to a third
   * party, so the account brings its own provider key and pays for its own use.
   *
   * `apiKey` is omitted to leave the stored credential untouched and sent as
   * null to clear it — the two are different, and collapsing them would delete
   * the key every time somebody changed their monthly budget. The key is never
   * returned by the server; what comes back is `keySet` and the last four
   * characters.
   */
  async updateDistillationSettings(update: {
    enabled?: boolean;
    provider?: DistillationSettings['provider'];
    model?: string | null;
    apiKey?: string | null;
    monthlyBudgetCents?: number;
  }): Promise<DistillationSettings> {
    this.requireArchive();
    return this.request<DistillationSettings>('/distillation/settings', { method: 'PUT', body: JSON.stringify(update) });
  }

  async createCollection(name: string, description: string): Promise<Collection> {
    this.requireArchive();
    return mapCollection(await this.request<WireCollection>('/collections', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }));
  }

  createApiKey(name: string, scopes: string[]): Promise<ApiKeyCreateResult> {
    return this.request<ApiKeyCreateResult>('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name, scopes }),
    });
  }

  buildPack(query: string, maxTokens: number, freshnessPolicy: 'strict' | 'mixed'): Promise<PackResponse> {
    return this.request<PackResponse>('/pack', {
      method: 'POST',
      body: JSON.stringify({
        query,
        maxTokens,
        maxEvidence: 6,
        maxSessions: 3,
        maxExcerptChars: 1600,
        freshnessPolicy,
      }),
    });
  }

  requestConversion(sessionId: string, target: ConversionJob['target']): Promise<ConversionJob> {
    return this.request<ConversionJob>('/convert', {
      method: 'POST',
      body: JSON.stringify({ sessionId, target, fallback: 'injection' }),
    });
  }

  /** A conversion is queued, not performed, when the request returns. */
  getConversion(jobId: string): Promise<ConversionJob> {
    return this.request<ConversionJob>(`/convert/${jobId}`);
  }

  async importArtifact(file: File, source: ImportSource, machineId: string, onProgress: (progress: ImportProgress) => void): Promise<SessionSummary> {
    const before = await this.request<ListResponse<WireSessionSummary>>('/sessions?limit=100');
    const existing = new Set(before.items.map((session) => session.id));
    onProgress({ stage: 'hashing', detail: 'Computing SHA-256 locally' });
    const bytes = await file.arrayBuffer();
    const digest = await window.crypto.subtle.digest('SHA-256', bytes);
    const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
    const machineSession = await this.request<{ token: string; expiresAt: string }>('/auth/machine-token', {
      method: 'POST',
      body: JSON.stringify({ machineId }),
    });
    const machineHeaders = { Authorization: `Bearer ${machineSession.token}` };
    onProgress({ stage: 'uploading', detail: 'Negotiating artifact delta' });
    const delta = await this.request<{ missing: string[] }>('/ingest/delta', {
      method: 'POST',
      headers: machineHeaders,
      body: JSON.stringify({ machineId, hashes: [sha256] }),
    });
    if (delta.missing.includes(sha256)) {
      onProgress({ stage: 'uploading', detail: `Uploading ${file.name}` });
      await this.request<Record<string, unknown>>(`/ingest/artifacts/${sha256}`, {
        method: 'PUT',
        headers: {
          ...machineHeaders,
          'Content-Type': 'application/octet-stream',
          'x-memoar-source': source,
          'x-memoar-source-path': file.name,
        },
        body: new Blob([bytes], { type: 'application/octet-stream' }),
      });
    }
    onProgress({ stage: 'queued', detail: 'Submitting ingest manifest' });
    await this.request<Record<string, unknown>>('/ingest/manifests', {
      method: 'POST',
      headers: machineHeaders,
      body: JSON.stringify({
        machineId,
        batchId: window.crypto.randomUUID(),
        artifacts: [{
          sha256,
          size: file.size,
          source,
          sourcePath: file.name,
          modifiedAt: new Date(file.lastModified).toISOString(),
        }],
      }),
    });
    for (let attempt = 1; attempt <= 30; attempt += 1) {
      onProgress({ stage: 'processing', detail: `Waiting for canonical session (${attempt}/30)` });
      const page = await this.request<ListResponse<WireSessionSummary>>('/sessions?limit=100');
      const imported = page.items.find((session) => !existing.has(session.id) && session.source === source);
      if (imported) {
        onProgress({ stage: 'ready', detail: imported.title });
        return mapSession(imported);
      }

      // The server records why an artifact will never produce a session, so
      // stop rather than polling on to a timeout that explains nothing.
      const status = await this.artifactStatus(sha256);
      if (status && (status.status === 'unknown_format' || status.status === 'failed')) {
        throw new Error(status.diagnostic ?? `The archive could not be parsed (${status.status}).`);
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error('Import was queued but no canonical session appeared within 30 seconds');
  }

  /**
   * Ingest outcome for an uploaded artifact, or null when it cannot be read.
   * A missing status must not fail an import that is otherwise progressing, so
   * this reports absence rather than throwing.
   */
  private async artifactStatus(sha256: string): Promise<RawArtifactStatus | null> {
    try {
      return await this.request<RawArtifactStatus>(`/ingest/artifacts/${sha256}/status`);
    } catch {
      return null;
    }
  }

  acceptTransfer(transferId: string): Promise<SessionSummary> {
    return this.request<WireSessionSummary>(`/sharing/transfers/${transferId}/accept`, { method: 'POST' }).then(mapSession);
  }
}

const environment = import.meta.env as Record<string, unknown>;
const configuredApiUrl: unknown = environment.VITE_API_URL;
const apiUrl = typeof configuredApiUrl === 'string' ? configuredApiUrl : '';


export const memoarApi = new MemoarApiClient(apiUrl);
memoarApi.consumeOAuthCallback();


export type { TimelineGroup };
