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

  /** Used by tests, and by nothing else. */
  reset(): void {
    this.groups.clear();
    this.overflow = 0;
  }
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
