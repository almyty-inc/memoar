import { useEffect, useState } from 'react';
import { memoarApi } from '../../lib/api';

/**
 * The session's pin and tags, which live as annotations, so the current state
 * is read rather than assumed. The summary's own tag array is never filled by
 * the server.
 */
export function useSessionAnnotations(
  sessionId: string,
  setBusyAction: (action: string | null) => void,
  setActionError: (error: string | null) => void,
) {
  const [pinId, setPinId] = useState<string | null>(null);
  const [tags, setTags] = useState<string[]>([]);

  useEffect(() => {
    let active = true;
    void memoarApi.listAnnotations(sessionId)
      .then((page) => {
        if (!active) return;
        setPinId(page.items.find((annotation) => annotation.kind === 'pin')?.id ?? null);
        setTags(page.items
          .filter((annotation) => annotation.kind === 'tag')
          .map((annotation) => (typeof annotation.value.label === 'string' ? annotation.value.label : ''))
          .filter((label) => label.length > 0));
      })
      .catch(() => {
        // No pin is the safe default: offering "Pin" for a pinned session is
        // recoverable, the reverse is confusing.
        if (active) setPinId(null);
      });
    return () => { active = false; };
  }, [sessionId]);

  const togglePin = async () => {
    setBusyAction('pin');
    setActionError(null);
    try {
      if (pinId) {
        await memoarApi.deleteAnnotation(pinId);
        setPinId(null);
      } else {
        const created = await memoarApi.createAnnotation({ sessionId, kind: 'pin', value: {} });
        setPinId(created.id);
      }
    } catch (error) {
      setActionError(error instanceof Error ? error.message : 'Pin could not be updated');
    } finally {
      setBusyAction(null);
    }
  };

  return { pinId, tags, togglePin };
}
