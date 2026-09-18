import { SessionsApi } from './client-sessions';
import type { ImportProgress, ImportSource, RawArtifactStatus } from './contracts';
import { mapSession } from './mappers';
import type { ListResponse, WireSessionSummary } from './wire';
import type { ConversionJob, PackResponse, SessionSummary, UnparsedSource } from '../types';

export class PacksApi extends SessionsApi {
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
    // Reported as elapsed time rather than as a guess. This said "within 30
    // seconds" after thirty rounds of two requests and a one-second sleep,
    // which is never thirty seconds and is longer the slower the archive is —
    // so the one number the message gave you was the one thing it could not
    // know.
    const startedAt = Date.now();
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
    const waited = Math.round((Date.now() - startedAt) / 1000);
    throw new Error(`Import was queued but no canonical session appeared in ${waited} seconds`);
  }

  /**
   * Files this account collected that never became a session, counted per tool.
   *
   * `memoar doctor` has reported this since the second time a capture pattern
   * was pointed at the wrong directory; the archive synced happily for weeks
   * both times while reading nothing. Anything that renders it has to survive
   * the archive not answering, so callers hold null and show nothing.
   */
  async listUnparsedArtifacts(): Promise<UnparsedSource[]> {
    return (await this.request<ListResponse<UnparsedSource>>('/ingest/unparsed')).items;
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
}
