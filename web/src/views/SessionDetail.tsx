import { useEffect, useState } from 'react';
import { memoarApi } from '../lib/api';
import { DEFAULT_PACK_TOKEN_BUDGET } from '../lib/limits';
import type { Collection as CollectionRecord, ConversionJob, Machine, PackResponse, SessionDetailData } from '../lib/types';
import { CollectionModal } from './session-detail/CollectionModal';
import { ConversationColumn } from './session-detail/ConversationColumn';
import { ConvertModal } from './session-detail/ConvertModal';
import { DeleteSessionModal } from './session-detail/DeleteSessionModal';
import { PackModal } from './session-detail/PackModal';
import { SessionHeader } from './session-detail/SessionHeader';
import { SessionInspector } from './session-detail/SessionInspector';
import { ShareReviewModal } from './session-detail/ShareReviewModal';

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
  // The pack controls drive the request. They were a readOnly number and a
  // disabled select, so the budget and freshness shown were never the ones used.
  const [packBudget, setPackBudget] = useState(DEFAULT_PACK_TOKEN_BUDGET);

  const [packFreshness, setPackFreshness] = useState<'strict' | 'mixed'>('mixed');
  const [machineId, setMachineId] = useState('');
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [pinId, setPinId] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const session = detail.session;
  // The archive knows machines by id; the name comes from the machine list the
  // app already holds, and is simply absent when this session came from one
  // that is no longer registered. Declared after the session it reads: above
  // it, the lookup only ran when there was a machine to compare against, so it
  // worked with none and threw with any — passing every test and blanking the
  // page for anyone with a machine connected.
  const machineName = machines.find((machine) => machine.id === session.machineId)?.name ?? null;

  // Pins live as annotations, so the current state is read rather than assumed.
  useEffect(() => {
    let active = true;
    void memoarApi.listAnnotations(session.id)
      .then((page) => {
        if (!active) return;
        setPinId(page.items.find((annotation) => annotation.kind === 'pin')?.id ?? null);
        // Tags are annotations too. The session summary carries an empty array
        // the server never fills, so the tag row rendered nothing whatever had
        // been tagged.
        setTags(page.items
          .filter((annotation) => annotation.kind === 'tag')
          .map((annotation) => (typeof annotation.value.label === 'string' ? annotation.value.label : ''))
          .filter((label) => label.length > 0));
      })
      .catch(() => {
        // Absence of a pin is the safe default: showing "Pin session" for an
        // already-pinned session is recoverable, the reverse is confusing.
        if (active) setPinId(null);
      });
    return () => { active = false; };
  }, [session.id]);

  const togglePin = async () => {
    setBusyAction('pin');
    setActionError(null);
    try {
      if (pinId) {
        await memoarApi.deleteAnnotation(pinId);
        setPinId(null);
      } else {
        const created = await memoarApi.createAnnotation({ sessionId: session.id, kind: 'pin', value: {} });
        setPinId(created.id);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Pin could not be updated');
    } finally {
      setBusyAction(null);
    }
  };

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

  // The conversion happens in the worker, so the request returns a queued job
  // rather than a finished one. Follow it until it settles: converting inside
  // the request starved everything else the API had to answer.
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

  return (
    <div className="session-detail-page">
      <SessionHeader
        session={session}
        machineName={machineName}
        busyAction={busyAction}
        onBack={onBack}
        setShareOpen={setShareOpen}
        exportSession={exportSession}
        setConvertOpen={setConvertOpen}
        openPack={openPack}
      />

      <div className="session-layout">
        <ConversationColumn
          detail={detail}
          session={session}
          showThinking={showThinking}
          setShowThinking={setShowThinking}
        />

        <SessionInspector
          detail={detail}
          session={session}
          tags={tags}
          collections={collections}
          busyAction={busyAction}
          pinId={pinId}
          togglePin={togglePin}
          setCollectionOpen={setCollectionOpen}
          setDeleteOpen={setDeleteOpen}
        />
      </div>

      <ShareReviewModal
        open={shareOpen}
        sessionId={session.id}
        approved={reviewId !== null}
        link={shareLink}
        busy={sharing}
        onApprove={() => {
          void memoarApi.completeRedactionReview(session.id)
            .then((review) => setReviewId(review.id))
            .catch(() => setActionError('Redaction review failed'));
        }}
        onCreate={(permission, expiresAt) => {
          if (!reviewId) return;
          setSharing(true);
          setActionError(null);
          void memoarApi.createShareLink({ sessionId: session.id, permission, redactionReviewId: reviewId, expiresAt })
            .then((grant) => {
              // Surface the link rather than closing: a token shown once and
              // discarded is a link the user cannot actually use.
              setShareLink(grant.token ? `${window.location.origin}/s/${grant.token}` : null);
              // The Sharing view reads grants from the dashboard, which was
              // loaded before this link existed. Without this the link is
              // simply absent there until the page is reloaded.
              onArchiveChanged();
            })
            .catch((error: unknown) => setActionError(error instanceof Error ? error.message : 'Share link could not be created'))
            .finally(() => setSharing(false));
        }}
        onClose={() => { setShareOpen(false); setReviewId(null); setShareLink(null); }}
      />

      <ConvertModal
        convertOpen={convertOpen}
        setConvertOpen={setConvertOpen}
        target={target}
        setTarget={setTarget}
        machines={machines}
        machineId={machineId}
        setMachineId={setMachineId}
        conversion={conversion}
        actionError={actionError}
        queueConversion={queueConversion}
      />

      <PackModal
        packOpen={packOpen}
        setPackOpen={setPackOpen}
        setConvertOpen={setConvertOpen}
        packBudget={packBudget}
        setPackBudget={setPackBudget}
        packFreshness={packFreshness}
        setPackFreshness={setPackFreshness}
        packLoading={packLoading}
        openPack={openPack}
        pack={pack}
        actionError={actionError}
      />

      <CollectionModal
        collectionOpen={collectionOpen}
        setCollectionOpen={setCollectionOpen}
        collections={collections}
        busyAction={busyAction}
        addToCollection={addToCollection}
        actionError={actionError}
      />

      <DeleteSessionModal
        deleteOpen={deleteOpen}
        setDeleteOpen={setDeleteOpen}
        deleting={deleting}
        setDeleting={setDeleting}
        setActionError={setActionError}
        session={session}
        onDeleted={onDeleted}
      />

    </div>
  );
}
