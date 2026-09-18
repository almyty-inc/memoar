import { SharingApi } from './client-sharing';
import type { ArchiveCapabilities, DistillationSettings, McpStatus, TenantSettings } from './contracts';
import type { ApiKeyCreateResult } from '../types';

export class SettingsApi extends SharingApi {
  revokeApiKey(keyId: string): Promise<void> {
    return this.request<void>(`/auth/api-keys/${keyId}`, { method: 'DELETE' });
  }

  async getSettings(): Promise<TenantSettings> {
    this.requireArchive();
    return this.request<TenantSettings>('/settings');
  }

  /**
   * Whether this deployment serves MCP, and what it serves.
   *
   * The settings page used to state availability without asking anything. It
   * could not ask: the handshake takes an API key and the browser holds a
   * session token. This is the route that closed that.
   */
  async getMcpStatus(): Promise<McpStatus> {
    this.requireArchive();
    return this.request<McpStatus>('/mcp/status');
  }

  /**
   * What the archive can read. Public, and deliberately so — the page that
   * shows it is read before anyone signs in.
   */
  async getCapabilities(): Promise<ArchiveCapabilities> {
    return this.request<ArchiveCapabilities>('/capabilities');
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

  createApiKey(name: string, scopes: string[]): Promise<ApiKeyCreateResult> {
    return this.request<ApiKeyCreateResult>('/auth/api-keys', {
      method: 'POST',
      body: JSON.stringify({ name, scopes }),
    });
  }
}
