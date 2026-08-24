import {
  demoApiKeys,
  demoCollections,
  demoDashboard,
  demoGrants,
  demoMachines,
  demoSessions,
  demoTransfers,
  makeDemoDetail,
} from './demo';
import type {
  ApiKey,
  ApiKeyCreateResult,
  Collection,
  ContentBlock,
  ConversionJob,
  DashboardState,
  Machine,
  MachineSource,
  PackResponse,
  SearchAggregation,
  SearchResponse,
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
  workspace: string;
  model?: string;
  updatedAt: string;
  turnCount: number;
  redactionStatus: SessionSummary['redactionStatus'];
  score?: number;
  highlight?: string;
}

interface WireTimelineResponse {
  groups: Array<{ date: string; sessions: WireSessionSummary[] }>;
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

export type ImportSource = 'canonical' | 'cass' | 'claude-code' | 'codex' | 'antigravity-cli' | 'cursor' | 'chatgpt-export' | 'claude-ai-export' | 'gemini-export' | 'mistral-export' | 'perplexity-export';

export type ImportStage = 'hashing' | 'uploading' | 'queued' | 'processing' | 'ready';

export interface TenantSettings {
  redaction: { secretScan: boolean; pathScan: boolean; emailScan: boolean; customPatterns: string[] };
  retention: { policy: 'indefinite' | 'days'; days?: number; exemptCollected: boolean };
  updatedAt: string | null;
}

const DEFAULT_TENANT_SETTINGS: TenantSettings = {
  redaction: { secretScan: true, pathScan: false, emailScan: false, customPatterns: [] },
  retention: { policy: 'indefinite', exemptCollected: true },
  updatedAt: null,
};

export interface ImportProgress {
  stage: ImportStage;
  detail: string;
}

function sourceLabel(source: string): string {
  const known: Record<string, string> = {
    'claude-code': 'Claude Code',
    codex: 'Codex',
    'antigravity-cli': 'Antigravity',
    cursor: 'Cursor',
    goose: 'Goose',
  };
  return known[source] ?? source.split('-').map((part) => `${part.slice(0, 1).toLocaleUpperCase()}${part.slice(1)}`).join(' ');
}

function mapSession(session: WireSessionSummary): SessionSummary {
  return {
    id: session.id,
    title: session.title,
    summary: session.summary ?? 'Archived coding session',
    source: session.source,
    sourceLabel: sourceLabel(session.source),
    workspace: session.workspace,
    branch: 'unknown',
    machine: 'Archived machine',
    model: session.model ?? 'Unknown model',
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    turnCount: session.turnCount,
    tokenCount: 0,
    durationMinutes: 0,
    redactionStatus: session.redactionStatus,
    tags: [],
    ...(session.score === undefined ? {} : { score: session.score }),
    ...(session.highlight === undefined ? {} : { highlight: session.highlight }),
  };
}

function countBy(items: SessionSummary[], key: (item: SessionSummary) => string): SearchAggregation[] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const value = key(item);
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([value, count]) => ({ label: value, value, count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function mapAggregation(value: unknown, label: (key: string) => string = (key) => key): SearchAggregation[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value)
    .filter((entry): entry is [string, number] => typeof entry[1] === 'number')
    .map(([key, count]) => ({ label: label(key), value: label(key), count }))
    .sort((left, right) => right.count - left.count || left.label.localeCompare(right.label));
}

function localSearch(query: string): SearchResponse {
  const normalized = query.trim().toLocaleLowerCase();
  const items = demoSessions
    .filter((session) => {
      if (!normalized) return true;
      return [session.title, session.summary, session.workspace, session.tags.join(' ')]
        .join(' ')
        .toLocaleLowerCase()
        .includes(normalized);
    })
    .map((session, index) => ({
      ...session,
      score: Number((0.96 - index * 0.047).toFixed(3)),
      highlight: session.summary,
    }));

  return {
    items,
    nextCursor: null,
    aggregations: {
      agents: countBy(items, (session) => session.sourceLabel),
      workspaces: countBy(items, (session) => session.workspace),
      dates: countBy(items, (session) => session.updatedAt.slice(0, 10)),
    },
    meta: {
      requestedMode: 'hybrid',
      realizedMode: 'hybrid',
      tookMs: normalized ? 38 : 0,
      semanticFailure: null,
    },
  };
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
    provenance: [],
    tokenTotals,
  };
}

function mapCollection(collection: WireCollection): Collection {
  return {
    ...collection,
    description: collection.description ?? '',
    color: '#d6ff78',
    members: [],
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

  private async request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!this.configured) throw new Error('No Memoar API URL is configured');
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
      if (!response.ok) {
        const body = await response.text();
        if (response.status === 401) {
          this.clearSession();
          window.dispatchEvent(new CustomEvent('memoar:unauthorized'));
        }
        throw new MemoarApiError(response.status, body || `Memoar API returned ${response.status}`);
      }
      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } finally {
      window.clearTimeout(timer);
    }
  }

  async login(email: string, password: string): Promise<void> {
    const result = await this.request<{ accessToken: string; expiresAt: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    this.setAccessToken(result.accessToken, result.expiresAt);
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

  async loadTimelinePage(cursor: string | null = null, limit = 30): Promise<{ groups: TimelineGroup[]; nextCursor: string | null }> {
    if (!this.configured) return { groups: demoDashboard.timeline, nextCursor: null };
    const query = new URLSearchParams({ limit: String(limit) });
    if (cursor) query.set('cursor', cursor);
    const response = await this.request<WireTimelineResponse>(`/sessions/timeline?${query.toString()}`);
    return {
      groups: response.groups.map((group) => ({ date: group.date, sessions: group.sessions.map(mapSession) })),
      nextCursor: response.nextCursor,
    };
  }
  async loadDashboard(): Promise<DashboardState> {
    if (!this.configured) return { ...demoDashboard, mode: 'demo' };
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
      nextTimelineCursor: timeline.nextCursor,
      collections: collections.items.map(mapCollection),
      grants: grants.items.map((grant) => ({
        ...grant,
        sessionTitle: sessionTitles.get(grant.sessionId) ?? grant.sessionId,
        expiresAt: grant.expiresAt ?? null,
        views: 0,
      })),
      transfers: transfers.items.map((transfer) => ({
        ...transfer,
        sessionTitle: sessionTitles.get(transfer.sessionId) ?? transfer.sessionId,
        direction: transfer.recipientEmail.endsWith('@local.invalid') ? 'incoming' : 'outgoing',
      })),
      machines: machines.items.map(mapMachine),
      apiKeys: apiKeys.items,
      mode: 'connected',
    };
  }

  async search(query: string): Promise<SearchResponse> {
    if (!this.configured) return localSearch(query);
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
    if (!this.configured) return makeDemoDetail(session);
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
    if (!this.configured) return { id: `review-${Date.now()}`, maskCount: 0 };
    return this.request<{ id: string; maskCount: number }>(`/sessions/${sessionId}/redaction-reviews`, { method: 'POST' });
  }

  async updateSessionVisibility(
    sessionId: string,
    visibility: { scope: 'private' | 'team' | 'org' | 'link'; teamId?: string; orgId?: string },
    redactionReviewId?: string,
  ): Promise<{ id: string; visibility: { scope: string } }> {
    if (!this.configured) return { id: sessionId, visibility: { scope: visibility.scope } };
    return this.request(`/sessions/${sessionId}`, {
      method: 'PATCH',
      body: JSON.stringify(redactionReviewId ? { visibility, redactionReviewId } : { visibility }),
    });
  }

  async getSettings(): Promise<TenantSettings> {
    if (!this.configured) return DEFAULT_TENANT_SETTINGS;
    return this.request<TenantSettings>('/settings');
  }

  async updateSettings(update: {
    redaction?: Partial<TenantSettings['redaction']>;
    retention?: Partial<TenantSettings['retention']>;
  }): Promise<TenantSettings> {
    if (!this.configured) return DEFAULT_TENANT_SETTINGS;
    return this.request<TenantSettings>('/settings', { method: 'PUT', body: JSON.stringify(update) });
  }

  async createCollection(name: string, description: string): Promise<Collection> {
    if (!this.configured) {
      return {
        id: `collection-${Date.now()}`,
        name,
        description,
        sessionCount: 0,
        updatedAt: new Date().toISOString(),
        color: '#d6ff78',
        members: [],
      };
    }
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
      await new Promise<void>((resolve) => window.setTimeout(resolve, 1000));
    }
    throw new Error('Import was queued but no canonical session appeared within 30 seconds');
  }

  acceptTransfer(transferId: string): Promise<SessionSummary> {
    return this.request<WireSessionSummary>(`/sharing/transfers/${transferId}/accept`, { method: 'POST' }).then(mapSession);
  }
}

const configuredApiUrl: unknown = (import.meta.env as Record<string, unknown>).VITE_API_URL;
const apiUrl = typeof configuredApiUrl === 'string' ? configuredApiUrl : '';
export const memoarApi = new MemoarApiClient(apiUrl);
memoarApi.consumeOAuthCallback();

export const demoFallbacks = {
  collections: demoCollections,
  grants: demoGrants,
  transfers: demoTransfers,
  machines: demoMachines,
  apiKeys: demoApiKeys,
};

export type { TimelineGroup };
