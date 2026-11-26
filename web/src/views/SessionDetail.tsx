import { useEffect, useRef, useState } from 'react';
import { isTyping } from '../components/Shell';
import { memoarApi } from '../lib/api';
import { DEFAULT_PACK_TOKEN_BUDGET } from '../lib/limits';
import type { Collection as CollectionRecord, ConversionJob, Machine, PackResponse, SessionDetailData } from '../lib/types';
import { CollectionModal } from './session-detail/CollectionModal';
import { ConvertModal } from './session-detail/ConvertModal';
import { DeleteSessionModal } from './session-detail/DeleteSessionModal';
import { PackModal } from './session-detail/PackModal';
import { SessionDetails } from './session-detail/SessionDetails';
import { SessionHeader } from './session-detail/SessionHeader';
import { ShareReviewModal } from './session-detail/ShareReviewModal';
import { Transcript } from './session-detail/Transcript';
import { SESSION_ACTION_EVENT, type SessionAction } from './session-detail/session-actions';
import { useSessionAnnotations } from './session-detail/use-annotations';

export function SessionDetailView({ detail, collections, machines, onBack, onBuildPack, onConvert, onConversionStatus, onDeleted, onArchiveChanged }: {
  detail: SessionDetailData;
  collections: CollectionRecord[];
  machines: Machine[];
  onBack: () => void;
  onBuildPack: (query: string, budget: number, freshness: 'strict' | 'mixed') => Promise<PackResponse>;
  onConvert: (target: ConversionJob['target']) => Promise<ConversionJob>;
  onConversionStatus: (jobId: string) => Promise<ConversionJob>;
  onDeleted: () => void;
  /** Something durable changed; the dashboard's copy is now stale. */
  onArchiveChanged: () => void;
}) {
  const [showThinking, setShowThinking] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [convertOpen, setConvertOpen] = useState(false);
  const [packOpen, setPackOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  // The review id, not just the fact of approval: the contract requires it to
  // create a link, so a link can only exist for an approved mask.
  const [reviewId, setReviewId] = useState<string | null>(null);
  const [shareLink, setShareLink] = useState<string | null>(null);
  const [sharing, setSharing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [target, setTarget] = useState<ConversionJob['target']>('codex');
  const [pack, setPack] = useState<PackResponse | null>(null);
  const [packLoading, setPackLoading] = useState(false);
  const [conversion, setConversion] = useState<ConversionJob | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [packBudget, setPackBudget] = useState(DEFAULT_PACK_TOKEN_BUDGET);
  const [packFreshness, setPackFreshness] = useState<'strict' | 'mixed'>('mixed');
  const [machineId, setMachineId] = useState('');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const session = detail.session;
  const machineName = machines.find((machine) => machine.id === session.machineId)?.name ?? null;
  const { pinId, tags, togglePin } = useSessionAnnotations(session.id, setBusyAction, setActionError);

  const exportSession = async () => {
    setBusyAction('export');
    setActionError(null);
    try {
      const exported = await memoarApi.exportSession(session.id);
      const url = URL.createObjectURL(new Blob([exported.body], { type: exported.contentType }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = exported.filename;
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Export failed');
    } finally {
      setBusyAction(null);
    }
  };

  const copyId = () => {
    void navigator.clipboard?.writeText(session.id).then(() => setNotice('Session id copied.')).catch(() => setNotice(null));
  };

  const addToCollection = async (collectionId: string) => {
    setBusyAction('collection');
    setActionError(null);
    try {
      await memoarApi.addSessionToCollection(collectionId, session.id);
      setCollectionOpen(false);
      onArchiveChanged();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Session could not be added');
    } finally {
      setBusyAction(null);
    }
  };

  const openPack = async () => {
    setPackOpen(true);
    setPackLoading(true);
    setActionError(null);
    try {
      setPack(await onBuildPack(session.title, packBudget, packFreshness));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Pack request failed');
    } finally {
      setPackLoading(false);
    }
  };

  const queueConversion = async () => {
    setActionError(null);
    try {
      setConversion(await onConvert(target));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Conversion request failed');
    }
  };

  // The worker converts, so the request returns a queued job. Follow it until
  // it settles.
  useEffect(() => {
    if (!conversion || (conversion.status !== 'queued' && conversion.status !== 'running')) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void onConversionStatus(conversion.id)
        .then((next) => { if (!cancelled) setConversion(next); })
        .catch((error: unknown) => { if (!cancelled) setActionError(error instanceof Error ? error.message : 'Conversion status failed'); });
    }, 700);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [conversion, onConversionStatus]);

  // Single keys act on the open session, and the command palette sends the
  // same actions as an event. Both are ignored while a dialog is up.
  const run = (action: SessionAction, convertTo?: ConversionJob['target']) => {
    if (action === 'convert') { if (convertTo) setTarget(convertTo); setConvertOpen(true); }
    if (action === 'export') void exportSession();
    if (action === 'share') setShareOpen(true);
    if (action === 'copy-id') copyId();
    if (action === 'pin') void togglePin();
    if (action === 'pack') void openPack();
    if (action === 'thinking') setShowThinking((current) => !current);
  };
  const runRef = useRef(run);
  useEffect(() => { runRef.current = run; });
  useEffect(() => {
    const keys: Record<string, SessionAction> = { c: 'convert', e: 'export', s: 'share', y: 'copy-id', t: 'thinking' };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector('[aria-modal="true"], [role="menu"]')) return;
      if (event.key === 'Escape') { onBack(); return; }
      const action = keys[event.key];
      if (!action) return;
      event.preventDefault();
      runRef.current(action);
    };
    const onAction = (event: Event) => {
      const { action, target: convertTo } = (event as CustomEvent<{ action: SessionAction; target?: ConversionJob['target'] }>).detail;
      runRef.current(action, convertTo);
    };
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener(SESSION_ACTION_EVENT, onAction);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener(SESSION_ACTION_EVENT, onAction);
    };
  }, [onBack]);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = window.setTimeout(() => setNotice(null), 1600);
    return () => window.clearTimeout(timer);
  }, [notice]);

  return (
    <div className="session-pane">
      <SessionHeader
        session={session}
        machineName={machineName}
        busyAction={busyAction}
        pinned={pinId !== null}
        collectionsAvailable={collections.length > 0}
        showThinking={showThinking}
        onShowThinking={setShowThinking}
        onBack={onBack}
        onShare={() => setShareOpen(true)}
        onExport={() => void exportSession()}
        onConvert={() => setConvertOpen(true)}
        onPack={() => void openPack()}
        onCollection={() => setCollectionOpen(true)}
        onPin={() => void togglePin()}
        onCopyId={copyId}
        onDelete={() => setDeleteOpen(true)}
      />

      <div className="session-body">
        <SessionDetails detail={detail} tags={tags} />

        {/* Pinning and exporting happen with every dialog closed, so their
            failures are said here, on the page. */}
        {actionError && !shareOpen && !convertOpen && !packOpen && !collectionOpen && !deleteOpen ? (
          <div className="notice notice-error" role="alert"><p><strong>That did not go through.</strong> {actionError}</p></div>
        ) : null}
        {notice ? <p className="toast" role="status">{notice}</p> : null}

        <Transcript detail={detail} showThinking={showThinking} setShowThinking={setShowThinking} />
      </div>

      <ShareReviewModal
        open={shareOpen}
        sessionId={session.id}
        approved={reviewId !== null}
        link={shareLink}
        busy={sharing}
        error={actionError}
        onApprove={() => {
          setActionError(null);
          void memoarApi.completeRedactionReview(session.id)
            .then((review) => setReviewId(review.id))
            .catch((error: unknown) => setActionError(error instanceof Error ? error.message : 'Redaction review failed'));
        }}
        onCreate={(permission, expiresAt) => {
          if (!reviewId) return;
          setSharing(true);
          setActionError(null);
          void memoarApi.createShareLink({ sessionId: session.id, permission, redactionReviewId: reviewId, expiresAt })
            .then((grant) => {
              // Shown rather than closed: a token shown once is the only chance to copy it.
              setShareLink(grant.token ? `${window.location.origin}/s/${grant.token}` : null);
              onArchiveChanged();
            })
            .catch((error: unknown) => setActionError(error instanceof Error ? error.message : 'Share link could not be created'))
            .finally(() => setSharing(false));
        }}
        onClose={() => { setShareOpen(false); setReviewId(null); setShareLink(null); }}
      />
      <ConvertModal convertOpen={convertOpen} setConvertOpen={setConvertOpen} target={target} setTarget={setTarget} machines={machines} machineId={machineId} setMachineId={setMachineId} conversion={conversion} actionError={actionError} queueConversion={queueConversion} />
      <PackModal packOpen={packOpen} setPackOpen={setPackOpen} setConvertOpen={setConvertOpen} packBudget={packBudget} setPackBudget={setPackBudget} packFreshness={packFreshness} setPackFreshness={setPackFreshness} packLoading={packLoading} openPack={openPack} pack={pack} actionError={actionError} />
      <CollectionModal collectionOpen={collectionOpen} setCollectionOpen={setCollectionOpen} collections={collections} busyAction={busyAction} addToCollection={addToCollection} actionError={actionError} />
      <DeleteSessionModal deleteOpen={deleteOpen} setDeleteOpen={setDeleteOpen} deleting={deleting} setDeleting={setDeleting} setActionError={setActionError} session={session} onDeleted={onDeleted} />
    </div>
  );
}
