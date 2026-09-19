import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CollectionsView } from './Collections';

/**
 * What happens to a half-written collection when the archive stops accepting
 * the browser's token.
 *
 * The name and the description lived in component state and nowhere else, so
 * the 401 that swapped this screen for the sign-in form took both with it —
 * silently, in the middle of typing, with nothing to recover them from.
 */
function view() {
  return <CollectionsView collections={[]} onOpen={vi.fn()} onCreate={vi.fn().mockResolvedValue(undefined)} />;
}

describe('an unfinished collection', () => {
  beforeEach(() => { window.sessionStorage.clear(); });

  it('survives the screen being taken away mid-edit', async () => {
    const user = userEvent.setup();
    const first = render(view());
    await user.click(screen.getByRole('button', { name: /New collection/u }));
    await user.type(screen.getByLabelText('Name'), 'Retrieval quality');
    await user.type(screen.getByLabelText('Description'), 'Everything about ranking');

    // What the unauthorized handler does to this view.
    first.unmount();
    render(view());

    expect(screen.getByLabelText('Name')).toHaveValue('Retrieval quality');
    expect(screen.getByLabelText('Description')).toHaveValue('Everything about ranking');
    expect(screen.getByText(/Restored from before you were asked to sign in again/u)).toBeInTheDocument();
  });

  it('is not restored after the reader cancelled it', async () => {
    const user = userEvent.setup();
    const first = render(view());
    await user.click(screen.getByRole('button', { name: /New collection/u }));
    await user.type(screen.getByLabelText('Name'), 'Abandoned');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));

    first.unmount();
    render(view());

    // Cancelling is a decision, not an interruption.
    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });

  it('is not restored after it was saved', async () => {
    const user = userEvent.setup();
    const first = render(view());
    await user.click(screen.getByRole('button', { name: /New collection/u }));
    await user.type(screen.getByLabelText('Name'), 'Saved');
    await user.click(screen.getByRole('button', { name: 'Create collection' }));

    first.unmount();
    render(view());

    expect(screen.queryByLabelText('Name')).not.toBeInTheDocument();
  });
});
