import type { Visibility } from "../../libs/canonical/src/generated.js";

/**
 * The one clause that keeps a teammate's private sessions private.
 *
 * Reading a team means looping over each member's tenant and opening a
 * transaction pinned to it. Inside that loop row-level security is *satisfied*
 * for every row that tenant owns, private ones included — the policy has done
 * its job, which is to stop tenant A's query reaching tenant B. What stops a
 * teammate seeing the member's private archive is this application predicate
 * and nothing else.
 *
 * So it lives in one place, used by every fan-out query, rather than being
 * retyped into each SQL string. Three call sites had to repeat it (team session
 * listing, lexical search, semantic search) and a fourth would have been added
 * with every new cross-tenant read; a refactor that dropped the clause from one
 * of them would leak one member's whole archive to their team, silently, with
 * Postgres reporting success.
 *
 * `test/team-fanout-isolation.test.ts` is the proof, over two real tenants.
 */
export function teamVisibilitySql(teamParameter: number): string {
  return `visibility->>'scope' = 'team' AND visibility->>'teamId' = $${teamParameter}`;
}

/** The same predicate for stores that hold sessions in memory rather than SQL. */
export function isTeamVisible(visibility: Visibility, teamId: string): boolean {
  return visibility.scope === "team" && visibility.teamId === teamId;
}
