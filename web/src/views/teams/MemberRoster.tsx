import { AlertCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { memoarApi } from '../../lib/api';
import type { TeamMember } from '../../lib/types';
import { Badge } from '../../components/ui';

/**
 * Who is on one team, and who has been asked and not answered.
 *
 * This is the only place an invitation this account sent can be seen. The
 * invite route answers 204, `memberCount` counts accepted members and so does
 * not move, and the invitations route answers for whoever calls it — so before
 * this the sender's page could honestly say nothing beyond "the request
 * succeeded", which is not the same as "Grace has been asked".
 *
 * Nothing is rendered until the archive has answered: no count, no row, no
 * placeholder that could be read as a roster. A refusal is rendered here, in
 * the region the reader opened, rather than written to state nothing shows.
 */
export function MemberRoster({ teamId, teamName }: {
  teamId: string;
  teamName: string;
}) {
  const [members, setMembers] = useState<TeamMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // No state is cleared here. The caller gives this component a key that
  // changes whenever the roster may have moved, so a re-read arrives as a fresh
  // mount with empty state rather than as a render this effect caused.
  useEffect(() => {
    let cancelled = false;
    void memoarApi.listTeamMembers(teamId)
      .then((items) => { if (!cancelled) setMembers(items); })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setMembers(null);
        setError(cause instanceof Error ? cause.message : 'The roster could not be loaded');
      });
    return () => { cancelled = true; };
  }, [teamId]);

  return (
    <section className="member-roster" aria-label={`Members of ${teamName}`}>
      {error ? <p role="alert" className="error-note"><AlertCircle size={15} /> {error}</p> : null}
      {members && members.length === 0 ? <p className="empty-note">The archive returned nobody for this team.</p> : null}
      {members?.map((member) => (
        <div className="member-row" key={member.userId}>
          <span className="member-email">{member.email}</span>
          {member.status === 'active'
            ? <Badge className="member-active">Member</Badge>
            : <Badge className="member-invited">Invited</Badge>}
        </div>
      ))}
      {members ? (
        <p className="field-hint member-note">
          Invited accounts have been asked and have joined nothing yet. They can read nothing widened to this team until they accept.
        </p>
      ) : null}
    </section>
  );
}
