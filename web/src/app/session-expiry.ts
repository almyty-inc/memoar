import { useEffect, useState } from 'react';

/**
 * How long before a browser session lapses the warning appears.
 *
 * Long enough to finish a sentence and press Save, short enough that it is not
 * standing on screen for most of the hour a token lives.
 */
export const EXPIRY_WARNING_MS = 5 * 60 * 1000;

const MINUTE = 60_000;

/** "4 minutes", "1 minute", "under a minute" — never a bare number of seconds. */
export function expiryPhrase(msLeft: number): string {
  if (msLeft < MINUTE) return 'under a minute';
  const minutes = Math.round(msLeft / MINUTE);
  return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
}

/**
 * Milliseconds left on the signed-in session once it is close enough to matter,
 * and null the rest of the time.
 *
 * The clock is read on a timer rather than during render, so the value is a
 * fact about a moment that has passed rather than one the renderer invented.
 */
export function useExpiryWarning(expiresAt: number | null, now: () => number = Date.now): number | null {
  // The moment last observed. The clock is read on a timer and kept in state,
  // so the countdown is measured against a moment that has happened rather than
  // read during render.
  const [observedAt, setObservedAt] = useState(now);

  useEffect(() => {
    const timer = window.setInterval(() => { setObservedAt(now()); }, 10_000);
    return () => { window.clearInterval(timer); };
  }, [now]);

  if (expiresAt === null) return null;
  const left = expiresAt - observedAt;
  return left > 0 && left <= EXPIRY_WARNING_MS ? left : null;
}
