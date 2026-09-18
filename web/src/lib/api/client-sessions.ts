import { ApiClientCore } from './client-core';
import { sourceLabel } from '../source-labels';
import { problemError } from './errors';
import { mapAggregation, mapCollection, mapMachine, mapSession, mapSessionDetail } from './mappers';
import type {
  ListResponse,
  WireCollection,
  WireMachine,
  WireSearchResponse,
  WireSessionChunk,
  WireShareGrant,
  WireTimelineResponse,
  WireTransfer,
} from './wire';
import type {
  ApiKey,
  DashboardState,
  SearchResponse,
  SessionDetailData,
  SessionSummary,
  TimelineGroup,
} from '../types';

export class SessionsApi extends ApiClientCore {
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
    // An empty query used to be sent as the literal word "session", so asking
    // for nothing returned results for something — the same shape as the page
    // that opened with a developer's test query already executed. The caller
    // guards against this too; a client that quietly substitutes a phrase
    // nobody typed should not need one.
    //
    // Checked before the endpoint, because whether the argument makes sense
    // does not depend on where it would have been sent.
    const phrase = query.trim();
    if (phrase === '') throw new Error('A search needs a phrase.');
    this.requireArchive();
    const response = await this.request<WireSearchResponse>(
      `/search?q=${encodeURIComponent(phrase)}&mode=hybrid&limit=50`,
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

  /** By id: a session opened from its own URL has no summary to start from. */
  async getSession(session: Pick<SessionSummary, 'id'>): Promise<SessionDetailData> {
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

  deleteSession(sessionId: string): Promise<void> {
    return this.request<void>(`/sessions/${sessionId}`, { method: 'DELETE' });
  }

  /**
   * Exports a session as a file. The response carries the filename the server
   * chose, so the download is named by the archive rather than by the browser
   * guessing from a URL.
   */
  async exportSession(sessionId: string, format: 'canonical' | 'markdown' = 'canonical'): Promise<{ filename: string; body: string; contentType: string }> {
    const response = await this.fetchWithAuth(`/sessions/${sessionId}/export?format=${format}`);
    if (!response.ok) throw await problemError(response);
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
}
