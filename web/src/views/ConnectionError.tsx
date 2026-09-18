import { AlertCircle, RefreshCw } from 'lucide-react';
import { Button } from '../components/ui';

export function ConnectionError({ connectionError, loadDashboard }: {
  connectionError: string;
  loadDashboard: () => Promise<void>;
}) {
  return (
    <section className="page connection-error" role="alert">
      <AlertCircle size={24} />
      <div><h1>Archive connection failed</h1><p>{connectionError}</p></div>
      <Button onClick={() => void loadDashboard()}><RefreshCw size={14} /> Retry</Button>
    </section>
  );
}
