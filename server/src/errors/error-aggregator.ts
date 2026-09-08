/**
 * Keeps a count per kind of failure, so a person can ask what is broken.
 *
 * In memory and per process, deliberately. The alternative — a table in the
 * archive — puts writes on the failure path, which is the worst moment to need
 * the database, and makes an outage that started in Postgres unrecordable
 * exactly when it matters. What is here survives long enough to answer "what
 * has been failing this hour", and the log lines carry the same fingerprint for
 * anyone who needs further back than that.
 */

import { Injectable } from "@nestjs/common";
import { errorsRecorded } from "../metrics/metrics.registry.js";
import { logLine } from "../observability.js";
import { readErrorState, writeErrorState, type PersistedErrors } from "./error-store.js";
import { fingerprint, type Fingerprint } from "./fingerprint.js";

export interface ErrorGroup extends Fingerprint {
  count: number;
  firstSeen: string;
  lastSeen: string;
  /**
   * One request id for this group, from the most recent occurrence. Enough to
   * find the full line, with its stack, in the log.
   */
  lastRequestId?: string;
  lastRoute?: string;
}

export interface ErrorContext {
  requestId?: string;
  route?: string;
}

/**
 * How many distinct failures are tracked.
 *
 * A cap, because a fingerprint is derived from a message and a bad enough
 * message defeats any normalisation. Without one, the thing that reports
 * failures becomes a memory leak driven by whatever is failing — and it would
 * grow fastest during the incident it is meant to explain.
 */
const MAX_GROUPS = 200;

@Injectable()
export class ErrorAggregator {
  private readonly groups = new Map<string, ErrorGroup>();
  /** Occurrences dropped because the cap was reached, so the total stays honest. */
  private overflow = 0;

  record(error: unknown, context: ErrorContext = {}, now = new Date()): ErrorGroup | null {
    const print = fingerprint(error);
    errorsRecorded.inc({ type: print.type });
    const at = now.toISOString();
    const existing = this.groups.get(print.id);
    if (existing) {
      existing.count += 1;
      existing.lastSeen = at;
      if (context.requestId) existing.lastRequestId = context.requestId;
      if (context.route) existing.lastRoute = context.route;
      return existing;
    }
    if (this.groups.size >= MAX_GROUPS) {
      this.overflow += 1;
      return null;
    }
    const group: ErrorGroup = {
      ...print,
      count: 1,
      firstSeen: at,
      lastSeen: at,
      ...(context.requestId ? { lastRequestId: context.requestId } : {}),
      ...(context.route ? { lastRoute: context.route } : {}),
    };
    this.groups.set(print.id, group);
    return group;
  }

  /** The failures worth looking at, most frequent first. */
  snapshot(limit = 50): { groups: ErrorGroup[]; distinct: number; dropped: number } {
    const groups = [...this.groups.values()]
      .sort((a, b) => b.count - a.count || b.lastSeen.localeCompare(a.lastSeen))
      .slice(0, limit);
    return { groups, distinct: this.groups.size, dropped: this.overflow };
  }

  /**
   * Takes back the groups from before a restart.
   *
   * Counts are carried over rather than started again, because "this has
   * happened 4,000 times since Tuesday" is the sentence that distinguishes a
   * real problem from a one-off, and a deploy in the middle of the week would
   * otherwise erase it.
   */
  restore(state: PersistedErrors): void {
    for (const group of state.groups.slice(0, MAX_GROUPS)) {
      const existing = this.groups.get(group.id);
      if (existing) {
        // Merged rather than replaced: the process may already have recorded
        // this failure between starting and reading the file.
        existing.count += group.count;
        existing.firstSeen = existing.firstSeen < group.firstSeen ? existing.firstSeen : group.firstSeen;
        existing.lastSeen = existing.lastSeen > group.lastSeen ? existing.lastSeen : group.lastSeen;
      } else {
        this.groups.set(group.id, { ...group });
      }
    }
    this.overflow += state.dropped;
  }

  /** Everything worth keeping, in the shape the file holds. */
  persistable(now = new Date()): PersistedErrors {
    return { groups: [...this.groups.values()], dropped: this.overflow, savedAt: now.toISOString() };
  }

  /** Used by tests, and by nothing else. */
  reset(): void {
    this.groups.clear();
    this.overflow = 0;
  }
}

/**
 * Loads the previous state and keeps writing it.
 *
 * Off unless `MEMOAR_ERROR_STATE_PATH` says where, and the path has to differ
 * per process: the API and the worker each group their own failures, and two
 * processes writing one file would each overwrite what the other had.
 *
 * @returns a function that flushes and stops, for shutdown.
 */
export function persistErrors(
  aggregator: ErrorAggregator,
  path = process.env.MEMOAR_ERROR_STATE_PATH?.trim(),
  intervalMs = Number(process.env.MEMOAR_ERROR_STATE_INTERVAL_MS ?? 30_000),
): () => void {
  if (!path) return () => undefined;

  const previous = readErrorState(path);
  if (previous) aggregator.restore(previous);

  const flush = (): void => {
    try {
      writeErrorState(path, aggregator.persistable());
    } catch (error) {
      // Never fatal. A process that cannot write its error file is still a
      // process that should keep serving the archive.
      logLine({ level: "warn", event: "error_state_unwritable", path, message: error instanceof Error ? error.message : String(error) });
    }
  };

  const timer = setInterval(flush, intervalMs);
  // Does not hold the process open: this is bookkeeping, and a service that
  // will not exit because it is waiting to write a statistics file is worse
  // than one that loses thirty seconds of counts.
  timer.unref();
  return () => {
    clearInterval(timer);
    flush();
  };
}

/**
 * The one instance.
 *
 * Errors are recorded from places Nest does not inject into — the exception
 * filter runs before a request context exists, and the worker's job handler is
 * a plain function shared with tests — so this is reached directly rather than
 * threaded through constructors that would only exist to carry it.
 */
export const errorAggregator = new ErrorAggregator();
