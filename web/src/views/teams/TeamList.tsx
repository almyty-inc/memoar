import { ChevronDown, ChevronRight, LogOut, UserPlus, Users } from 'lucide-react';
import { useState } from 'react';
import type { CurrentUser, Team } from '../../lib/types';
import { Button } from '../../components/ui';
import { CreateTeamForm } from './CreateTeamForm';
import { MemberRoster } from './MemberRoster';

/**
 * The teams this account has actually joined.
 *
 * `memberCount` is the server's own count of active members, shown as it
 * arrives. Who those members are is a second read, made only when the reader
 * asks for it, and never inferred from the count.
 */
export function TeamList({ teams, user, busy, openRoster, reloadKey, onToggleRoster, onCreate, onInvite, onLeave }: {
  teams: Team[];
  /** Who is signed in, when the archive has said. Leaving needs their id. */
  user: CurrentUser | null;
  busy: string | null;
  /** The team whose roster is open, if any. Lifted so an invite can open it. */
  openRoster: string | null;
  reloadKey: number;
  onToggleRoster: (teamId: string) => void;
  onCreate: (name: string) => void;
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
        <CreateTeamForm busy={busy === 'create'} onCreate={onCreate} />
      </header>
      <div className="data-list">
        {teams.length === 0 ? <p className="empty-note">You are not a member of any team. Create one above to start sharing an archive.</p> : null}
        {teams.map((team) => (
          <article className="team-row" key={team.id}>
            <span className="row-icon"><Users size={16} /></span>
            <div className="team-main">
              <strong>{team.name}</strong>
              <p>{team.memberCount} {team.memberCount === 1 ? 'member' : 'members'}</p>
            </div>
            <InviteField team={team} busy={busy === team.id} onInvite={onInvite} />
            <div className="team-actions">
              <Button
                size="sm"
                variant="ghost"
                aria-expanded={openRoster === team.id}
                onClick={() => onToggleRoster(team.id)}
              >
                {openRoster === team.id ? <ChevronDown size={14} /> : <ChevronRight size={14} />} Members
              </Button>
              {user ? (
                <Button size="sm" variant="ghost" disabled={busy === team.id} onClick={() => onLeave(team.id, user.id)}>
                  <LogOut size={14} /> Leave
                </Button>
              ) : null}
            </div>
            {/* The key remounts the roster after any action that may have moved
                it, so the re-read starts from no state rather than from the
                last answer. */}
            {openRoster === team.id
              ? <MemberRoster key={`${team.id}:${reloadKey}`} teamId={team.id} teamName={team.name} />
              : null}
          </article>
        ))}
      </div>
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
