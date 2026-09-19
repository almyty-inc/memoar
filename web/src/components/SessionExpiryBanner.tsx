import { Clock3 } from 'lucide-react';
import { expiryPhrase } from '../app/session-expiry';
import { Button } from './ui';

/**
 * Says the sign-in is about to lapse, while there is still time to act on it.
 *
 * A browser token lives an hour and is never refreshed. Until this existed the
 * first sign of that was a 401 on the next request, which cleared the session
 * and swapped the screen for the sign-in form — so somebody who had opened a
 * form at minute 58 and pressed Save at minute 61 lost what they had typed and
 * was never told why.
 *
 * `role="status"` rather than `alert`: it is announced at the next opportunity
 * instead of interrupting whatever is being read or typed.
 */
export function SessionExpiryBanner({ msLeft, onSignIn }: {
  msLeft: number;
  onSignIn: () => void;
}) {
  return (
    <section className="privacy-banner banner-warning" role="status">
      <span><Clock3 size={20} aria-hidden="true" /></span>
      <div>
        <strong>This sign-in expires in {expiryPhrase(msLeft)}.</strong>
        <p>Save anything in progress. Signing in again brings you back to this screen.</p>
      </div>
      <Button size="sm" onClick={onSignIn}>Sign in again</Button>
    </section>
  );
}
