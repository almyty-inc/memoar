import { Check, MailPlus, X } from 'lucide-react';
import type { TeamInvitation } from '../../lib/types';
import { Badge, Button } from '../../components/ui';

/**
 * Teams this account has been asked to join.
 *
 * Kept in its own panel, above the teams it belongs to and never mixed into
 * them. Membership used to begin the moment somebody typed an address, which
 * changed who could read this account's sessions without anything to agree to;
 * the row therefore says in words that nothing has happened yet, and the only
 * way out of this list is Accept or Decline.
 */
export function InvitationList({ invitations, busy, onAccept, onDecline }: {
  invitations: TeamInvitation[];
  busy: string | null;
  onAccept: (teamId: string) => void;
  onDecline: (teamId: string) => void;
}) {
  return (
    <section className="data-panel" aria-labelledby="team-invitations-heading">
      <header>
        <div>
          <h2 id="team-invitations-heading">Invitations</h2>
          <p>Teams that have asked you to join. You are not a member of any of them.</p>
        </div>
      </header>
      <div className="data-list">
        {invitations.length === 0 ? <p className="empty-note">No pending invitations.</p> : null}
        {invitations.map((invitation) => (
          <article className="invitation-row" key={invitation.teamId}>
            <span className="row-icon"><MailPlus size={16} /></span>
            <div className="invitation-main">
              <strong>{invitation.teamName}</strong>
              <p>Accepting is what makes you a member, and what lets the other members read anything you widen to this team.</p>
            </div>
            <Badge className="invitation-badge">Invitation</Badge>
            <div className="transfer-actions">
              <Button
                size="sm"
                variant="primary"
                disabled={busy === invitation.teamId}
                onClick={() => onAccept(invitation.teamId)}
              >
                <Check size={14} /> Accept
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy === invitation.teamId}
                onClick={() => onDecline(invitation.teamId)}
              >
                <X size={14} /> Decline
              </Button>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
