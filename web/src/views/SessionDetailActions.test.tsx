import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { memoarApi } from '../lib/api';
import type { SessionDetailData } from '../lib/types';
import { SessionDetailView } from './SessionDetail';

function detail(): SessionDetailData {
  return {
    session: {
      id: 's-1', title: 'Fix the ingest pipeline', summary: 'Archived coding session',
      source: 'claude-code', sourceLabel: 'Claude Code', workspace: '/workspace/memoar',
      createdAt: '2026-09-01T09:00:00.000Z', updatedAt: '2026-09-01T09:30:00.000Z',
      turnCount: 1, tokenCount: 40, durationMinutes: 30, redactionStatus: 'clear',
    },
    turns: [{
      id: 't-1', ordinal: 1, parentId: null, role: 'assistant', createdAt: '2026-09-01T09:00:00.000Z',
      blocks: [{ id: 'b-1', kind: 'thinking', text: 'Weighing two parsers' }],
    }],
    provenance: [],
    tokenTotals: { input: 20, output: 20, cacheRead: 0 },
  };
}

function view() {
  return (
    <SessionDetailView
      detail={detail()}
      collections={[]}
      machines={[]}
      onBack={vi.fn()}
      onBuildPack={vi.fn()}
      onConvert={vi.fn()}
      onConversionStatus={vi.fn()}
      onDeleted={vi.fn()}
      onArchiveChanged={vi.fn()}
    />
  );
}

afterEach(() => { vi.restoreAllMocks(); });

describe('a session action that fails', () => {
  it('says so on the page, rather than into a dialog nobody has open', async () => {
    /*
      Pinning, unpinning and exporting all happen with every modal closed, and
      every one of them wrote its failure to a state rendered only inside the
      convert, pack and collection dialogs. The button stopped being busy, the
      label did not change, and the reader was told nothing at all.
    */
    vi.spyOn(memoarApi, 'listAnnotations').mockResolvedValue({ items: [] });
    vi.spyOn(memoarApi, 'createAnnotation').mockRejectedValue(new Error('Annotation store is read-only'));
    const user = userEvent.setup();
    render(view());

    await user.click(await screen.findByRole('button', { name: /Pin session/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Annotation store is read-only');
  });

  it('says so inside the share dialog, which covers the page', async () => {
    // Approving a redaction review wrote to the same page-level state, and this
    // dialog is drawn on top of it, so a refused review left the reader looking
    // at an unchanged dialog with nothing to read and nothing to do.
    vi.spyOn(memoarApi, 'listAnnotations').mockResolvedValue({ items: [] });
    vi.spyOn(memoarApi, 'completeRedactionReview').mockRejectedValue(new Error('This session has changed since the scan'));
    const user = userEvent.setup();
    render(view());

    await user.click(screen.getByRole('button', { name: /Share/u }));
    await user.click(await screen.findByRole('button', { name: /Approve redactions/u }));

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This session has changed since the scan');
  });
});

describe('a hidden thinking block', () => {
  it('reveals thinking when the button offering to is pressed', async () => {
    // This was a <button> with no handler that told the reader to go and press
    // something else. It was focusable, announced as a button, and did nothing.
    vi.spyOn(memoarApi, 'listAnnotations').mockResolvedValue({ items: [] });
    const user = userEvent.setup();
    render(view());

    expect(screen.queryByText('Weighing two parsers')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Thinking hidden/u }));

    expect(screen.getByText('Weighing two parsers')).toBeInTheDocument();
  });
});
