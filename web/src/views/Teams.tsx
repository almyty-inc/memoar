import { AlertCircle, Users, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { memoarApi } from '../lib/api';
import type { CurrentUser, Team, TeamInvitation } from '../lib/types';
import { InvitationList } from './teams/InvitationList';
import { TeamList } from './teams/TeamList';

/**
 * Invitations, and the teams they lead to.
 *
 * The two lists come from two routes and are never merged. Being invited to a
 * team is not being in one — that is the whole reason acceptance exists — so a
 * team that has only invited this account appears under Invitations and nowhere
 * else, and moves only when the reader accepts.
 *
 * Each list is fetched on its own. One route failing leaves the other visible
 * rather than blanking both, and a list that has not arrived renders nothing at
 * all: no count, no row, no placeholder that could be mistaken for an answer.
 */
export function TeamsView({ user }: { user: CurrentUser | null }) {
  const [invitations, setInvitations] = useState<TeamInvitation[] | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void memoarApi.listTeamInvitations()
      .then((items) => { if (!cancelled) setInvitations(items); })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setInvitations(null);
        setLoadError(cause instanceof Error ? cause.message : 'Invitations could not be loaded');
      });
    void memoarApi.listTeams()
      .then((items) => { if (!cancelled) setTeams(items); })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setTeams(null);
        setLoadError(cause instanceof Error ? cause.message : 'Teams could not be loaded');
      });
    return () => { cancelled = true; };
  }, [reloads]);

  /*
    Every action reloads both lists, because every one of them moves a team from
    one list to the other or changes what is in them. The failure is written
    where the reader is looking: the banner is rendered unconditionally from
    this state, so a message can never be set and shown to nobody.
  */
  const run = async (key: string, action: () => Promise<void>) => {
    setBusy(key);
    setActionError(null);
    // The reload this ends with is the next chance either list has to load, so
    // a stale failure from the last attempt is cleared here rather than in the
    // effect, where clearing it would be a render the effect caused itself.
    setLoadError(null);
    try {
      await action();
      setReloads((count) => count + 1);
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'The request failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page teams-page">
      <section className="page-heading row-heading">
        <div>
          <div className="eyebrow"><Users size={13} /> Shared archives</div>
          <h1>Teams</h1>
          <p>A team is who else can read the sessions and collections its members widen to it. Nobody is added to one: they are invited, and they join by accepting.</p>
        </div>
      </section>

      {loadError ? <p role="alert" className="error-note"><AlertCircle size={15} /> {loadError}</p> : null}

      {actionError ? (
        <section className="privacy-banner banner-error" role="alert">
          <span><X size={20} /></span>
          <div><strong>That did not go through</strong><p>{actionError}</p></div>
        </section>
      ) : null}

      {invitations ? (
        <InvitationList
          invitations={invitations}
          busy={busy}
          onAccept={(teamId) => void run(teamId, () => memoarApi.acceptTeamInvitation(teamId))}
          onDecline={(teamId) => void run(teamId, () => memoarApi.declineTeamInvitation(teamId))}
        />
      ) : null}

      {teams ? (
        <TeamList
          teams={teams}
          user={user}
          busy={busy}
          onInvite={(teamId, email) => void run(teamId, () => memoarApi.inviteTeamMember(teamId, email))}
          onLeave={(teamId, userId) => void run(teamId, () => memoarApi.removeTeamMember(teamId, userId))}
        />
      ) : null}
    </div>
  );
}
