const DRAFT_KEY = 'memoar.collections.draft';

export interface Draft { name: string; description: string }

/**
 * What was typed into the create form and not yet saved.
 *
 * A browser token lives an hour and is not refreshed, so a form opened at
 * minute 58 and submitted at minute 61 used to unmount on the 401 with both
 * fields gone. The draft is kept for the tab, so signing in again brings the
 * reader back to the form with their words in it. Saving or cancelling clears
 * it: only an interruption preserves it.
 */
export function readDraft(): Draft | null {
  try {
    const raw = window.sessionStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { name, description } = parsed as Partial<Draft>;
    if (typeof name !== 'string' || typeof description !== 'string') return null;
    return name || description ? { name, description } : null;
  } catch {
    return null;
  }
}

export function writeDraft(draft: Draft | null): void {
  try {
    if (draft && (draft.name || draft.description)) window.sessionStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    else window.sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // A blocked or full store costs the draft, not the form.
  }
}
