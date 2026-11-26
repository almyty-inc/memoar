import { Button } from '../components/ui';

export function ConnectionError({ connectionError, loadDashboard }: {
  connectionError: string;
  loadDashboard: () => Promise<void>;
}) {
  return (
    <section className="page" role="alert">
      <div className="empty-state">
        <h1>Archive connection failed</h1>
        <p>{connectionError}</p>
        <Button size="sm" onClick={() => void loadDashboard()}>Retry</Button>
      </div>
    </section>
  );
}
