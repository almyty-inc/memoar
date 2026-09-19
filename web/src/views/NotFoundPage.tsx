import { FileQuestion } from 'lucide-react';
import { Button } from '../components/ui';
import type { ViewId } from '../lib/types';

export function NotFoundPage({ navigate }: { navigate: (view: ViewId) => void }) {
  return (
    <section className="page not-found-page">
      <div className="empty-state">
        <FileQuestion size={24} aria-hidden="true" />
        <h1>No screen lives at this address</h1>
        <p><code>{window.location.pathname}</code> is not part of this archive. It may have been mistyped, or it may be a link from a version of Memoar that had it.</p>
        <Button variant="primary" onClick={() => navigate('timeline')}>Go to the timeline</Button>
      </div>
    </section>
  );
}
