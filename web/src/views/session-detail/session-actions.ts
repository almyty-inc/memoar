import type { ConversionJob } from '../../lib/types';

/** What the command palette can ask the open session to do. */
export type SessionAction = 'convert' | 'export' | 'share' | 'copy-id' | 'pin' | 'pack' | 'thinking';

export const SESSION_ACTION_EVENT = 'memoar:session-action';

/** Sent by the palette, heard by whichever session is open. */
export function requestSessionAction(action: SessionAction, target?: ConversionJob['target']): void {
  window.dispatchEvent(new CustomEvent(SESSION_ACTION_EVENT, { detail: { action, target } }));
}
