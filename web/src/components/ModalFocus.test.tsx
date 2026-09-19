import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { Button, Modal } from './ui';

/**
 * Where the caret is while a dialog is up.
 *
 * Every dialog in the product is this component. It set `aria-modal` and then
 * did none of what that promises: focus stayed on the button behind the
 * backdrop, Tab walked the page underneath, and closing dropped focus on the
 * body — so a keyboard or screen-reader user was told a dialog had appeared and
 * then given no way to reach it and nowhere to come back to.
 */
function Harness({ autoFocusField = false }: { autoFocusField?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Open the dialog</Button>
      <Button onClick={() => undefined}>Something behind it</Button>
      <Modal open={open} title="Create key" onClose={() => setOpen(false)}>
        <label>Key name<input autoFocus={autoFocusField} /></label>
        <Button onClick={() => setOpen(false)}>Done</Button>
      </Modal>
    </>
  );
}

describe('an open dialog', () => {
  it('takes focus, and gives it back to what opened it', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    const opener = screen.getByRole('button', { name: 'Open the dialog' });

    await user.click(opener);
    expect(screen.getByRole('dialog')).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(opener).toHaveFocus();
  });

  it('leaves a field that asked for focus alone', async () => {
    const user = userEvent.setup();
    render(<Harness autoFocusField />);

    await user.click(screen.getByRole('button', { name: 'Open the dialog' }));

    expect(screen.getByLabelText('Key name')).toHaveFocus();
  });

  it('keeps Tab inside itself rather than walking the page underneath', async () => {
    const user = userEvent.setup();
    render(<Harness />);
    await user.click(screen.getByRole('button', { name: 'Open the dialog' }));
    const dialog = screen.getByRole('dialog');

    for (let press = 0; press < 6; press += 1) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    expect(screen.getByRole('button', { name: 'Something behind it' })).not.toHaveFocus();
  });
});
