import { PacksApi } from './client-packs';
import { mapSession } from './mappers';
import type { WireSessionSummary } from './wire';
import type { SessionSummary, ShareGrant, Transfer } from '../types';

export class SharingApi extends PacksApi {
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

  declineTransfer(transferId: string): Promise<void> {
    return this.request<void>(`/sharing/transfers/${transferId}/decline`, { method: 'POST' });
  }

  acceptTransfer(transferId: string): Promise<SessionSummary> {
    return this.request<WireSessionSummary>(`/sharing/transfers/${transferId}/accept`, { method: 'POST' }).then(mapSession);
  }
}
