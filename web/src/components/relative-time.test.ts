import { describe, expect, it } from 'vitest';
import { formatRelative } from './ui';

/**
 * How long ago.
 *
 * This measured against `new Date('2026-08-17T16:20:00.000Z')` — a literal in
 * the source. Everything captured after that instant produced a negative
 * difference, clamped to one by a `Math.max(1, …)`, so every session, machine
 * and API key in the archive read "1m ago" for as long as the build lived. A
 * session six days old sat under a date heading that said Wednesday and a
 * timestamp that said it had just happened.
 */
const NOW = Date.parse('2026-09-15T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('a timestamp in the archive', () => {
  it('measures against now, not against a date written into the source', () => {
    // The frozen literal was 2026-08-17. Anything after it read "1m ago"; this
    // is the case that was wrong on every screen.
    expect(formatRelative(ago(6 * DAY), NOW)).toBe('6d ago');
    expect(formatRelative(ago(20 * HOUR), NOW)).toBe('20h ago');
    expect(formatRelative(ago(45 * MINUTE), NOW)).toBe('45m ago');
  });

  it('only says something just happened when it just happened', () => {
    expect(formatRelative(ago(10_000), NOW)).toBe('just now');
    expect(formatRelative(ago(3 * MINUTE), NOW)).toBe('3m ago');
  });

  it('gives a date once "days ago" stops being a useful way to say it', () => {
    expect(formatRelative(ago(400 * DAY), NOW)).toMatch(/\d{4}/u);
  });

  it('does not claim a clock skewed ahead of ours is decades of history', () => {
    expect(formatRelative(new Date(NOW + 30_000).toISOString(), NOW)).toBe('just now');
  });

  it('says so when there is no timestamp, and when it cannot be read', () => {
    expect(formatRelative(null, NOW)).toBe('Never');
    expect(formatRelative('not a date', NOW)).toBe('Unknown');
  });

  it('moves as the clock does', () => {
    // The defining property the frozen literal removed: the same instant reads
    // differently an hour later.
    const captured = ago(30 * MINUTE);
    expect(formatRelative(captured, NOW)).toBe('30m ago');
    expect(formatRelative(captured, NOW + HOUR)).toBe('2h ago');
  });
});
