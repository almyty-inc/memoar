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
  // No longer produced. Kept so a finding stored before the shared catalogue reads as words.
  env: 'environment variable',
  private_key: 'private key',
  credential: 'password or credential',
  connection_string: 'connection string',
  email: 'email address',
  path: 'home directory path',
  custom: 'one of your own patterns',
};

/**
 * What the scanner found in one memory file, and the act of reviewing it.
 * The status only changes when the server hands back a document that says so.
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
    <div className="memory-redaction">
      <p>
        <RedactionBadge status={document.redactionStatus} />{' '}
        {document.redactionFindings.length > 0
          ? <span>The scanner matched {document.redactionFindings.length} {document.redactionFindings.length === 1 ? 'thing' : 'things'} in this file.</span>
          : <span>The scanner matched nothing in this file.</span>}
      </p>
      {kinds.length > 0 ? (
        <ul className="inline-list">
          {kinds.map(({ kind, count }) => (
            <li key={kind}>{KIND_LABELS[kind] ?? kind}{count > 1 ? ` ×${count}` : ''}</li>
          ))}
        </ul>
      ) : null}
      {flagged ? (
        <>
          <p className="meta">
            Until someone reviews it, this file&rsquo;s text is not served to agents over MCP or anywhere outside this
            archive. Read the version below, then mark it reviewed to let it go out as it stands.
          </p>
          {error ? <p role="alert" className="error-note">{error}</p> : null}
          <div><Button size="sm" onClick={onReview} disabled={busy}>{busy ? 'Recording' : 'Mark reviewed'}</Button></div>
        </>
      ) : null}
    </div>
  );
}
