import { SettingsApi } from './client-settings';
import type { ListResponse } from './wire';
import type { Team, TeamInvitation, TeamMember } from '../types';

/**
 * Teams, and the invitations that are the only way into one.
 *
 * Membership is granted by the invited account accepting, never by the account
 * that sent the invitation, because team membership is what decides who can
 * read a session somebody widened to a team. The two lists are fetched from two
 * routes and stay two lists here: an invitation is not a membership, and
 * merging them in the client would put that distinction back where it was.
 */
export class TeamsApi extends SettingsApi {
  async listTeams(): Promise<Team[]> {
    return (await this.request<ListResponse<Team>>('/teams')).items;
  }

  /**
   * Creates a team with this account as its first and only member.
   *
   * Omitting `orgId` has the archive create the owning organization too, which
   * is what an account with no team of its own needs: there was no way to reach
   * this route from the app at all, so a new account saw two empty lists and no
   * way out of them.
   */
  createTeam(name: string): Promise<Team> {
    return this.request<Team>('/teams', { method: 'POST', body: JSON.stringify({ name }) });
  }

  /**
   * The team's roster: members and outstanding invitations, each marked.
   *
   * The only place an invitation this account sent can be seen. `memberCount`
   * counts accepted members, and the invitations route answers for its caller,
   * so without this a sent invitation had nowhere at all to appear.
   */
  async listTeamMembers(teamId: string): Promise<TeamMember[]> {
    return (await this.request<ListResponse<TeamMember>>(`/teams/${encodeURIComponent(teamId)}/members`)).items;
  }

  /** Teams this account has been asked to join. Nobody sees anybody else's. */
  async listTeamInvitations(): Promise<TeamInvitation[]> {
    return (await this.request<ListResponse<TeamInvitation>>('/teams/invitations')).items;
  }

  acceptTeamInvitation(teamId: string): Promise<void> {
    return this.request<void>(`/teams/invitations/${encodeURIComponent(teamId)}/accept`, { method: 'POST' });
  }

  declineTeamInvitation(teamId: string): Promise<void> {
    return this.request<void>(`/teams/invitations/${encodeURIComponent(teamId)}`, { method: 'DELETE' });
  }

  /** Invites an address. It takes effect when that account accepts, not here. */
  inviteTeamMember(teamId: string, email: string): Promise<void> {
    return this.request<void>(`/teams/${encodeURIComponent(teamId)}/members`, {
      method: 'PUT',
      body: JSON.stringify({ email }),
    });
  }

  removeTeamMember(teamId: string, userId: string): Promise<void> {
    return this.request<void>(`/teams/${encodeURIComponent(teamId)}/members/${encodeURIComponent(userId)}`, { method: 'DELETE' });
  }
}
