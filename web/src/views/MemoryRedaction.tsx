import { ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button, RedactionBadge } from '../components/ui';
import type { MemoryDocument } from '../lib/types';

/** How many of each kind the scanner matched, so "3 findings" can say which three. */
function countKinds(findings: string[]): { kind: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const kind of findings) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([kind, count]) => ({ kind, count }));
}

const KIND_LABELS: Record<string, string> = {
  api_key: 'API key',
  jwt: 'signed token',
  env: 'environment variable',
  private_key: 'private key',
  email: 'email address',
  path: 'home directory path',
  custom: 'one of your own patterns',
};

/**
 * What the scanner found in one memory file, and the act of reviewing it.
 *
 * Nothing here is asserted before it has been measured: every word comes from
 * the document the archive returned, and the status only changes when the
 * server hands back a document that says so. A review that fails leaves the
 * status exactly where it was and says why.
 */
export function MemoryRedactionPanel({ document, busy, error, onReview }: {
  document: MemoryDocument;
  busy: boolean;
  error: string | null;
  onReview: () => void;
}) {
  const kinds = countKinds(document.redactionFindings);
  const flagged = document.redactionStatus === 'findings';

  return (
    <div className={`memory-redaction redaction-${document.redactionStatus}`}>
      <h3>
        {flagged ? <ShieldAlert size={14} /> : <ShieldCheck size={14} />}
        <RedactionBadge status={document.redactionStatus} />
      </h3>

      {document.redactionFindings.length > 0 ? (
        <>
          <p>
            The scanner matched {document.redactionFindings.length}{' '}
            {document.redactionFindings.length === 1 ? 'thing' : 'things'} in this file.
          </p>
          <ul>
            {kinds.map(({ kind, count }) => (
              <li key={kind}>{KIND_LABELS[kind] ?? kind}{count > 1 ? ` ×${count}` : ''}</li>
            ))}
          </ul>
        </>
      ) : (
        <p>The scanner matched nothing in this file.</p>
      )}

      {flagged ? (
        <>
          <p>
            Until someone reviews it, this file&rsquo;s text is not served to agents over MCP or to
            anywhere outside this archive. Read the version below, then say it may go out as it stands.
          </p>
          {error ? <p role="alert" className="error-note">{error}</p> : null}
          <Button size="sm" onClick={onReview} disabled={busy}>
            {busy ? 'Recording…' : 'Mark reviewed'}
          </Button>
        </>
      ) : null}
    </div>
  );
}
