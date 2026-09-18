import { Info, LogOut, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import type { CurrentUser, Team } from '../../lib/types';
import { Button } from '../../components/ui';

/**
 * The teams this account has actually joined.
 *
 * `memberCount` is the server's own count of active members. The contract has
 * no route that lists who they are, so the count stands alone and the hint says
 * why rather than leaving a reader to assume the team is one person.
 */
export function TeamList({ teams, user, busy, onInvite, onLeave }: {
  teams: Team[];
  /** Who is signed in, when the archive has said. Leaving needs their id. */
  user: CurrentUser | null;
  busy: string | null;
  onInvite: (teamId: string, email: string) => void;
  onLeave: (teamId: string, userId: string) => void;
}) {
  return (
    <section className="data-panel" aria-labelledby="teams-joined-heading">
      <header>
        <div>
          <h2 id="teams-joined-heading">Teams you have joined</h2>
          <p>Members can read every session and collection anyone here widens to the team.</p>
        </div>
      </header>
      <div className="data-list">
        {teams.length === 0 ? <p className="empty-note">You are not a member of any team.</p> : null}
        {teams.map((team) => (
          <article className="team-row" key={team.id}>
            <span className="row-icon"><Users size={16} /></span>
            <div className="team-main">
              <strong>{team.name}</strong>
              <p>{team.memberCount} {team.memberCount === 1 ? 'member' : 'members'}</p>
            </div>
            <InviteField team={team} busy={busy === team.id} onInvite={onInvite} />
            {user ? (
              <Button size="sm" variant="ghost" disabled={busy === team.id} onClick={() => onLeave(team.id, user.id)}>
                <LogOut size={14} /> Leave
              </Button>
            ) : null}
          </article>
        ))}
      </div>
      {teams.length > 0 ? (
        <p className="field-hint team-roster-hint">
          <Info size={15} aria-hidden="true" />
          The archive counts members but serves no list of them, so no names are shown here.
        </p>
      ) : null}
    </section>
  );
}

/** An invitation is sent from the team it is for, so the field lives in its row. */
function InviteField({ team, busy, onInvite }: {
  team: Team;
  busy: boolean;
  onInvite: (teamId: string, email: string) => void;
}) {
  const [email, setEmail] = useState('');

  return (
    <form
      className="invite-form"
      onSubmit={(event) => {
        event.preventDefault();
        onInvite(team.id, email);
        setEmail('');
      }}
    >
      <input
        type="email"
        value={email}
        placeholder="teammate@example.com"
        aria-label={`Email to invite to ${team.name}`}
        onChange={(event) => setEmail(event.target.value)}
      />
      <Button size="sm" type="submit" disabled={busy || !email.includes('@')}>
        <UserPlus size={14} /> Invite
      </Button>
    </form>
  );
}
