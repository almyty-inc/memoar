import type { MachineSource, UnparsedSource } from '../../lib/types';
import { Badge, cn, formatRelative, plural } from '../../components/ui';

type SourceState = NonNullable<MachineSource['state']>;

const stateCopy: Record<SourceState, string> = {
  synced: 'Synced',
  syncing: 'Syncing now',
  attention: 'Needs attention',
  disabled: 'Disabled',
};

/*
  A dot per state, named in words beside it. Turning a source off is not a
  fault, so disabled gets no colour; only attention is drawn as one.
*/
const stateDot: Record<SourceState, string> = {
  synced: 'dot-ok',
  syncing: 'dot-ok',
  attention: 'dot-warning dot-alert',
  disabled: '',
};

export function SourceRow({ source, unparsed }: {
  source: MachineSource;
  /** What this tool uploaded that never became a session, once the archive has said. */
  unparsed?: UnparsedSource | undefined;
}) {
  /*
    Collecting files and archiving none of them is the one way capture fails
    without failing. It is said beside the source, because the status cell
    reads "Synced" the whole time it happens.
  */
  const readingNothing = unparsed !== undefined && unparsed.artifacts > 0 && source.sessionCount === 0;

  return (
    <div className="source-row">
      <span className="source-name">
        <strong>{source.label}</strong>
        {unparsed && unparsed.artifacts > 0 ? (
          <small className={cn('source-unparsed', readingNothing && 'text-warning')}>
            {readingNothing
              ? `${plural(unparsed.artifacts, 'file')} collected, no sessions. This source is reading the wrong files.`
              : `${plural(unparsed.artifacts, 'file')} the archive could not read`}
          </small>
        ) : null}
      </span>
      <span className="num">{plural(source.sessionCount, 'session')}</span>
      {/* No per-source sync time is reported yet, so an absent one is blank. */}
      <span>{source.lastSyncAt ? formatRelative(source.lastSyncAt) : ''}</span>
      <span className={cn('source-state', source.state && `source-state-${source.state}`)}>
        {source.state ? <><span className={cn('dot', stateDot[source.state])} aria-hidden="true" />{stateCopy[source.state]}</> : ''}
      </span>
      {/*
        Read, not set. Which stores the agent reads is that machine's own
        configuration, so this reports it and the machine changes it.
      */}
      <Badge>{source.enabled ? 'Capture on' : 'Capture off'}</Badge>
    </div>
  );
}
