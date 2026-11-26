import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import type { CurrentUser, Team } from '../../lib/types';
import { Button, cn, plural } from '../../components/ui';
import { CreateTeamForm } from './CreateTeamForm';
import { MemberRoster } from './MemberRoster';

/**
 * The teams this account has joined. `memberCount` is the server's count of
 * active members. Who they are is a second read, made when asked for.
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
    <section className="section" aria-labelledby="teams-joined-heading">
      <div className="section-head">
        <h2 id="teams-joined-heading" className="section-title">Teams you have joined</h2>
        <CreateTeamForm busy={busy === 'create'} onCreate={onCreate} />
      </div>
      <p className="section-note">Members can read every session and collection anyone here widens to the team.</p>
      <div className="row-list">
        {teams.length === 0 ? <p className="empty-note">You are not a member of any team. Create one above to start sharing an archive.</p> : null}
        {teams.map((team) => (
          <div key={team.id}>
            <div className="row">
              <button
                type="button"
                className="machine-toggle"
                aria-expanded={openRoster === team.id}
                aria-label={`Members of ${team.name}`}
                onClick={() => onToggleRoster(team.id)}
              >
                <ChevronRight size={13} aria-hidden="true" className={cn('chevron', openRoster === team.id && 'open')} />
              </button>
              <strong className="row-name">{team.name}</strong>
              <span className="row-main meta">{plural(team.memberCount, 'member')}</span>
              <InviteField team={team} busy={busy === team.id} onInvite={onInvite} />
              {user ? (
                <Button size="sm" variant="ghost" disabled={busy === team.id} onClick={() => onLeave(team.id, user.id)}>Leave</Button>
              ) : null}
            </div>
            {/* The key remounts the roster after any action that may have moved
                it, so the re-read starts from no state. */}
            {openRoster === team.id
              ? <MemberRoster key={`${team.id}:${reloadKey}`} teamId={team.id} teamName={team.name} />
              : null}
          </div>
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
      className="inline-form"
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
      <Button size="sm" type="submit" disabled={busy || !email.includes('@')}>Invite</Button>
    </form>
  );
}
