import { Button } from '../components/ui';
import type { ViewId } from '../lib/types';

/** The address stays as typed, so it can be corrected or reported. */
export function NotFoundPage({ navigate }: { navigate: (view: ViewId) => void }) {
  return (
    <section className="page">
      <div className="empty-state">
        <h1>Nothing lives at this address</h1>
        <p><code>{window.location.pathname}</code> is not a page in Memoar. It may be mistyped, or a link from an older version.</p>
        <Button size="sm" onClick={() => navigate('timeline')}>Go to sessions</Button>
      </div>
    </section>
  );
}
