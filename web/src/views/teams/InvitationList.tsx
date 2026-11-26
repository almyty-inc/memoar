import type { TeamInvitation } from '../../lib/types';
import { Button } from '../../components/ui';

/**
 * Teams this account has been asked to join, kept apart from the ones it is
 * in. The only way out of this list is Accept or Decline, and the row says
 * that nothing has happened yet.
 */
export function InvitationList({ invitations, busy, onAccept, onDecline }: {
  invitations: TeamInvitation[];
  busy: string | null;
  onAccept: (teamId: string) => void;
  onDecline: (teamId: string) => void;
}) {
  return (
    <section className="section" aria-labelledby="team-invitations-heading">
      <div className="section-head">
        <h2 id="team-invitations-heading" className="section-title">Invitations</h2>
        <p>You are not a member of these teams until you accept.</p>
      </div>
      <div className="row-list">
        {invitations.length === 0 ? <p className="empty-note">No pending invitations.</p> : null}
        {invitations.map((invitation) => (
          <div className="row" key={invitation.teamId}>
            <strong className="row-name">{invitation.teamName}</strong>
            <span className="row-meta text-warning">Invitation</span>
            <span className="row-text meta">Accepting is what makes you a member, and what lets the other members read anything you widen to this team.</span>
            <span className="row-actions">
              <Button size="sm" variant="primary" disabled={busy === invitation.teamId} onClick={() => onAccept(invitation.teamId)}>Accept</Button>
              <Button size="sm" variant="ghost" disabled={busy === invitation.teamId} onClick={() => onDecline(invitation.teamId)}>Decline</Button>
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
