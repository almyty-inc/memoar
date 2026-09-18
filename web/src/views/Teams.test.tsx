import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TeamsView } from './Teams';
import { memoarApi } from '../lib/api';
import type { CurrentUser, Team, TeamInvitation } from '../lib/types';

const ADA: CurrentUser = { id: 'user-1', email: 'ada@example.test', displayName: 'Ada Lovelace' };

function team(overrides: Partial<Team> = {}): Team {
  return { id: 'team-1', orgId: 'org-1', name: 'Archive crew', memberCount: 4, ...overrides };
}

function invitation(overrides: Partial<TeamInvitation> = {}): TeamInvitation {
  return { teamId: 'team-2', teamName: 'Platform', orgId: 'org-1', ...overrides };
}

/** Both lists answer by default; each test narrows the one it is about. */
function archive({ teams = [] as Team[], invitations = [] as TeamInvitation[] } = {}) {
  return {
    listTeams: vi.spyOn(memoarApi, 'listTeams').mockResolvedValue(teams),
    listTeamInvitations: vi.spyOn(memoarApi, 'listTeamInvitations').mockResolvedValue(invitations),
  };
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('team invitations', () => {
  it('shows a pending invitation with a way to accept and a way to decline', async () => {
    // Acceptance was added to the API because being put in a team changes who
    // can read your sessions. Nothing in the web app called any of it, so the
    // only way to answer an invitation was curl.
    archive({ invitations: [invitation()] });

    render(<TeamsView user={ADA} />);

    const panel = await screen.findByRole('region', { name: 'Invitations' });
    expect(within(panel).getByText('Platform')).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Accept/u })).toBeInTheDocument();
    expect(within(panel).getByRole('button', { name: /Decline/u })).toBeInTheDocument();
  });

  it('does not present an invitation as a membership', async () => {
    /*
      The point of the whole change: a team that has invited this account is not
      a team this account is in. The invited team must not appear among the
      teams joined, must not be counted there, and must say in its own row that
      joining has not happened yet.
    */
    archive({ teams: [team()], invitations: [invitation()] });

    render(<TeamsView user={ADA} />);

    const joined = await screen.findByRole('region', { name: 'Teams you have joined' });
    expect(within(joined).queryByText('Platform')).not.toBeInTheDocument();
    expect(within(joined).getByText('Archive crew')).toBeInTheDocument();

    const invited = screen.getByRole('region', { name: 'Invitations' });
    expect(within(invited).queryByText('Archive crew')).not.toBeInTheDocument();
    expect(within(invited).getByText(/Accepting is what makes you a member/u)).toBeInTheDocument();
    // And the row wears the word, so it cannot be skim-read as a membership.
    expect(within(invited).getByText('Invitation')).toBeInTheDocument();
  });

  it('accepts the invitation the reader answered, then re-reads both lists', async () => {
    const { listTeams } = archive({ invitations: [invitation({ teamId: 'team-9', teamName: 'Platform' })] });
    const accept = vi.spyOn(memoarApi, 'acceptTeamInvitation').mockResolvedValue(undefined);

    render(<TeamsView user={ADA} />);
    await userEvent.click(await screen.findByRole('button', { name: /Accept/u }));

    expect(accept).toHaveBeenCalledWith('team-9');
    // A team moves from one list to the other on acceptance, so both are re-read.
    await waitFor(() => { expect(listTeams).toHaveBeenCalledTimes(2); });
  });

  it('declines through the decline route rather than the accept one', async () => {
    archive({ invitations: [invitation({ teamId: 'team-9' })] });
    const decline = vi.spyOn(memoarApi, 'declineTeamInvitation').mockResolvedValue(undefined);
    const accept = vi.spyOn(memoarApi, 'acceptTeamInvitation').mockResolvedValue(undefined);

    render(<TeamsView user={ADA} />);
    await userEvent.click(await screen.findByRole('button', { name: /Decline/u }));

    expect(decline).toHaveBeenCalledWith('team-9');
    expect(accept).not.toHaveBeenCalled();
  });

  it('shows a refused acceptance where the reader pressed the button', async () => {
    // A failure written to state that nothing renders is a failure nobody sees.
    archive({ invitations: [invitation()] });
    vi.spyOn(memoarApi, 'acceptTeamInvitation').mockRejectedValue(new Error('No pending invitation to that team'));

    render(<TeamsView user={ADA} />);
    await userEvent.click(await screen.findByRole('button', { name: /Accept/u }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No pending invitation to that team');
  });
});

describe('teams', () => {
  it('reports the member count the archive measured', async () => {
    archive({ teams: [team({ memberCount: 4 })] });

    render(<TeamsView user={ADA} />);

    const joined = await screen.findByRole('region', { name: 'Teams you have joined' });
    expect(within(joined).getByText('4 members')).toBeInTheDocument();
  });

  it('invites by email through the team the field belongs to', async () => {
    archive({ teams: [team({ id: 'team-7', name: 'Archive crew' })] });
    const invite = vi.spyOn(memoarApi, 'inviteTeamMember').mockResolvedValue(undefined);

    render(<TeamsView user={ADA} />);
    await userEvent.type(await screen.findByLabelText('Email to invite to Archive crew'), 'grace@example.test');
    await userEvent.click(screen.getByRole('button', { name: /Invite/u }));

    expect(invite).toHaveBeenCalledWith('team-7', 'grace@example.test');
  });

  it('says so when an invitation is refused instead of failing silently', async () => {
    archive({ teams: [team({ name: 'Archive crew' })] });
    vi.spyOn(memoarApi, 'inviteTeamMember').mockRejectedValue(new Error('No account with that email'));

    render(<TeamsView user={ADA} />);
    await userEvent.type(await screen.findByLabelText('Email to invite to Archive crew'), 'nobody@example.test');
    await userEvent.click(screen.getByRole('button', { name: /Invite/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent('No account with that email');
  });

  it('renders no team and no count when the archive will not answer', async () => {
    // Not a zero, not a placeholder: a list that failed to load is nothing.
    vi.spyOn(memoarApi, 'listTeams').mockRejectedValue(new Error('Teams could not be loaded'));
    vi.spyOn(memoarApi, 'listTeamInvitations').mockResolvedValue([]);

    render(<TeamsView user={ADA} />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Teams could not be loaded');
    expect(screen.queryByRole('region', { name: 'Teams you have joined' })).not.toBeInTheDocument();
    expect(screen.queryByText(/^\d+ members?$/u), 'no member count without a team to count').not.toBeInTheDocument();
    // The list that did answer is still on screen rather than blanked with it.
    expect(screen.getByRole('region', { name: 'Invitations' })).toBeInTheDocument();
  });

  it('says a team is empty of invitations rather than showing nothing at all', async () => {
    archive();

    render(<TeamsView user={ADA} />);

    expect(await screen.findByText('No pending invitations.')).toBeInTheDocument();
    expect(screen.getByText('You are not a member of any team.')).toBeInTheDocument();
  });

  it('offers no way to leave until the archive has said who is signed in', async () => {
    // Leaving is DELETE /teams/:id/members/:userId, and there is no user id to
    // put in it. An unusable button is worse than no button.
    archive({ teams: [team()] });

    render(<TeamsView user={null} />);

    await screen.findByText('Archive crew');
    expect(screen.queryByRole('button', { name: /Leave/u })).not.toBeInTheDocument();
  });

  it('leaves a team as the signed-in account, not as somebody else', async () => {
    archive({ teams: [team({ id: 'team-7' })] });
    const remove = vi.spyOn(memoarApi, 'removeTeamMember').mockResolvedValue(undefined);

    render(<TeamsView user={ADA} />);
    await userEvent.click(await screen.findByRole('button', { name: /Leave/u }));

    expect(remove).toHaveBeenCalledWith('team-7', 'user-1');
  });
});
