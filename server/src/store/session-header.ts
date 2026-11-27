import type { ArchivedSession, SessionHeader } from "./context.js";

function dated(values: readonly string[]): number[] {
  return values.map((value) => new Date(value).valueOf()).filter((value) => Number.isFinite(value));
}

/** The list row of a session that is already loaded, turns and all. */
export function headerOf(session: ArchivedSession): SessionHeader {
  const { turns, ...rest } = session;
  const stamps = dated(turns.map((turn) => turn.createdAt));
  return {
    ...rest,
    turnCount: turns.length,
    firstTurnAt: stamps.length ? new Date(Math.min(...stamps)).toISOString() : null,
    lastTurnAt: stamps.length ? new Date(Math.max(...stamps)).toISOString() : null,
  };
}
