import type { Visibility } from "../../libs/canonical/src/generated.js";
import type { ArchivedSession, TeamOptinStore, TenantContext } from "../archive-store.js";

/**
 * Turns a standing team enrolment into the visibility a newly captured session
 * is written with.
 *
 * This is the whole of "shared by default": the opt-in is materialised into
 * `sessions.visibility` here, at write time, and never evaluated at read time.
 * That one choice is why every read path — team listing, team search, a single
 * teammate's session — stays a plain single-tenant query and why none of them
 * had to learn about this table.
 *
 * Two gates, both deliberate:
 *
 *  - Only `redactionStatus: "clear"` is stamped. Every other way of widening a
 *    session past private goes through a completed human redaction review
 *    (`SharingService.requireCurrentReview`). Auto-stamping cannot ask a human
 *    anything, so a capture the secret scanner found something in stays private
 *    until somebody reviews it, rather than punching a hole in that invariant.
 *    This is the detector's verdict standing in for a human's, which is weaker,
 *    and is why the gate is the conservative direction.
 *  - Only a session the parser left private is stamped. A parser that has
 *    already said something about visibility is not second-guessed.
 */
export class IngestTeamStamp {
  private readonly resolved = new Map<string, string | null>();

  constructor(private readonly store: TeamOptinStore, private readonly context: TenantContext) {}

  async visibilityFor(session: ArchivedSession): Promise<Visibility> {
    if (session.redactionStatus !== "clear" || session.visibility.scope !== "private") return session.visibility;
    const machineId = session.source.machineId;
    if (!this.resolved.has(machineId)) {
      this.resolved.set(machineId, await this.store.resolveIngestTeam(this.context.tenantId, machineId));
    }
    const teamId = this.resolved.get(machineId) ?? null;
    return teamId ? { ...session.visibility, scope: "team", teamId } : session.visibility;
  }
}
