import { expiryPhrase } from '../app/session-expiry';
import { Button } from './ui';

/**
 * Says the sign-in is about to lapse, while there is still time to act on it.
 * A browser token lives an hour and is never refreshed, so without this the
 * first sign was a 401 that dropped whatever was being typed.
 *
 * `role="status"` rather than `alert`: announced at the next opportunity
 * instead of interrupting.
 */
export function SessionExpiryBanner({ msLeft, onSignIn }: {
  msLeft: number;
  onSignIn: () => void;
}) {
  return (
    <section className="expiry-bar" role="status">
      <strong>This sign-in expires in {expiryPhrase(msLeft)}.</strong>
      <p>Save anything in progress. Signing in again brings you back here.</p>
      <Button size="sm" onClick={onSignIn}>Sign in again</Button>
    </section>
  );
}
