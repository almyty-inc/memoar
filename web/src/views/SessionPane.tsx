import { memoarApi } from '../lib/api';
import type { Collection, Machine, SessionDetailData } from '../lib/types';
import { SessionDetailView } from './SessionDetail';

/** The transcript pane, wired to the archive. */
export function SessionPane({ detail, collections, machines, onBack, onChanged, onDeleted }: {
  detail: SessionDetailData;
  collections: Collection[];
  machines: Machine[];
  onBack: () => void;
  onChanged: () => void;
  onDeleted: () => void;
}) {
  return (
    <SessionDetailView
      key={detail.session.id}
      detail={detail}
      collections={collections}
      machines={machines}
      onArchiveChanged={onChanged}
      onBack={onBack}
      onBuildPack={(query, budget, freshness) => memoarApi.buildPack(query, budget, freshness)}
      onConvert={(target) => memoarApi.requestConversion(detail.session.id, target)}
      onConversionStatus={(jobId) => memoarApi.getConversion(jobId)}
      onDeleted={onDeleted}
    />
  );
}
