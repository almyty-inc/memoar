import { TeamsApi } from './client-teams';
import { mapCollection, mapSession } from './mappers';
import type { ListResponse, WireCollection, WireSessionSummary } from './wire';
import type {
  Annotation,
  Collection,
  MemoryDocument,
  MemoryRevision,
  SessionSummary,
} from '../types';

export class MemoarApiClient extends TeamsApi {
  listMemory(): Promise<{ items: MemoryDocument[] }> {
    return this.request<{ items: MemoryDocument[] }>('/memory');
  }

  getMemory(documentId: string): Promise<{ document: MemoryDocument; revisions: MemoryRevision[] }> {
    return this.request<{ document: MemoryDocument; revisions: MemoryRevision[] }>(`/memory/${documentId}`);
  }

  /**
   * Records that this person has read what the scanner found in this file.
   *
   * The hash of the version they read goes with it: the capture agent re-reads
   * these on a timer, and the server refuses a review of text that has since
   * changed rather than clearing something nobody looked at.
   */
  reviewMemory(documentId: string, contentHash: string): Promise<MemoryDocument> {
    return this.request<MemoryDocument>(`/memory/${documentId}/redaction-reviews`, {
      method: 'POST',
      body: JSON.stringify({ contentHash }),
    });
  }

  deleteMemory(documentId: string): Promise<void> {
    return this.request<void>(`/memory/${documentId}`, { method: 'DELETE' });
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

  async createCollection(name: string, description: string): Promise<Collection> {
    this.requireArchive();
    return mapCollection(await this.request<WireCollection>('/collections', {
      method: 'POST',
      body: JSON.stringify({ name, description }),
    }));
  }
}
