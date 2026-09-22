import { AlertCircle, Check, CircleSlash, Code2, RefreshCw } from 'lucide-react';
import type { MachineSource, UnparsedSource } from '../../lib/types';
import { Badge, cn, formatRelative } from '../../components/ui';

type SourceState = NonNullable<MachineSource['state']>;

const stateCopy: Record<SourceState, string> = {
  synced: 'Synced',
  syncing: 'Syncing now',
  attention: 'Needs attention',
  disabled: 'Disabled',
};

/*
  An icon per state, named.

  This was a two-step ternary that fell through to the warning triangle for
  anything that was not synced or syncing — so a source the reader had
  deliberately switched off was flagged as needing attention, beside the word
  "Disabled". Turning something off is not a fault.
*/
const stateIcon: Record<SourceState, typeof Check> = {
  synced: Check,
  syncing: RefreshCw,
  attention: AlertCircle,
  disabled: CircleSlash,
};

export function SourceRow({ source, unparsed }: {
  source: MachineSource;
  /**
   * What this tool uploaded that never became a session, when the archive has
   * answered. Undefined means either nothing unreadable or nothing asked —
   * neither of which is something to print, so the line is simply absent.
   */
  unparsed?: UnparsedSource | undefined;
}) {
  const StateIcon = source.state ? stateIcon[source.state] : null;
  /*
    Collecting files and archiving none of them is the one way capture fails
    without failing. It is said here, beside the source, because the sync column
    two cells over will read "Synced" the whole time it is happening.
  */
  const readingNothing = unparsed !== undefined && unparsed.artifacts > 0 && source.sessionCount === 0;

  return (
    <div className="source-row">
      <div>
        <span className={`mini-source source-${source.id.replace('-cli', '').replace('-code', '')}`}><Code2 size={15} /></span>
        <div>
          <strong>{source.label}</strong>
          <small>Native local store</small>
          {unparsed && unparsed.artifacts > 0 ? (
            <small className={cn('source-unparsed', readingNothing && 'source-unparsed-blocked')}>
              {readingNothing
                ? `${unparsed.artifacts} ${unparsed.artifacts === 1 ? 'file' : 'files'} collected, no sessions — this source is reading the wrong files`
                : `${unparsed.artifacts} ${unparsed.artifacts === 1 ? 'file' : 'files'} the archive could not read`}
            </small>
          ) : null}
        </div>
      </div>
      <span><strong>{source.sessionCount}</strong> sessions</span>
      {/* "Never" is a claim. Nothing reports a per-source sync time, so an
          absent one is shown as absent. */}
      <span>{source.lastSyncAt ? formatRelative(source.lastSyncAt) : '—'}</span>
      <span className={cn('source-state', source.state && `source-state-${source.state}`)}>
        {StateIcon && source.state ? <><StateIcon size={13} aria-hidden="true" />{stateCopy[source.state]}</> : '—'}
      </span>

      {/*
        Read, not set. This was a switch wired to component state and nothing
        else: flipping it moved the thumb, sent nothing anywhere, and was gone
        the next time the page was drawn — so a reader who switched a source
        off had every reason to believe capture had stopped, and it had not.
        Which stores the agent reads is that machine's own configuration, so
        this reports it and the machine changes it.
      */}
      <Badge>{source.enabled ? 'Capture on' : 'Capture off'}</Badge>
    </div>
  );
}
