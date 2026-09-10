import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SignInView } from './Onboarding';
import { MemoarApiError, memoarApi, type AuthMethods } from '../lib/api';

function methods(overrides: Partial<AuthMethods> = {}): AuthMethods {
  return { password: true, signup: 'open', oauth: [], ...overrides };
}

function view(handlers: Partial<{ onSignIn: () => Promise<void>; onCreateAccount: () => Promise<void>; onOAuth: () => void }> = {}) {
  return render(
    <SignInView
      onSignIn={handlers.onSignIn ?? (() => Promise.resolve())}
      onCreateAccount={handlers.onCreateAccount ?? (() => Promise.resolve())}
      onOAuth={handlers.onOAuth ?? (() => undefined)}
    />,
  );
}

beforeEach(() => { vi.restoreAllMocks(); });

/**
 * The page offered two provider buttons and an email form that could only sign
 * in. On a deployment without OAuth credentials both buttons fail with 401, and
 * there was no way to create an account at all — so it promised something it
 * could not do, to everyone who was not already in the archive.
 */
describe('the way in', () => {
  it('offers no provider button the deployment cannot honour', async () => {
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue(methods({ oauth: [] }));
    view();

    await waitFor(() => { expect(screen.getByRole('button', { name: /Sign in/u })).toBeInTheDocument(); });
    expect(screen.queryByRole('button', { name: /Continue with GitHub/u })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue with Google/u })).not.toBeInTheDocument();
  });

  it('offers only the providers that are configured', async () => {
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue(methods({ oauth: ['github'] }));
    view();

    expect(await screen.findByRole('button', { name: /Continue with GitHub/u })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Continue with Google/u })).not.toBeInTheDocument();
  });

  it('creates an account with an email address', async () => {
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue(methods());
    const onCreateAccount = vi.fn().mockResolvedValue(undefined);
    view({ onCreateAccount });

    await userEvent.click(await screen.findByRole('button', { name: /Create an archive/u }));
    await userEvent.type(screen.getByLabelText(/Email/u), 'newcomer@example.com');
    await userEvent.type(screen.getByLabelText(/Password/u), 'a-password-of-real-length');
    await userEvent.click(screen.getByRole('button', { name: /Create archive/u }));

    await waitFor(() => { expect(onCreateAccount).toHaveBeenCalledWith('newcomer@example.com', 'a-password-of-real-length'); });
  });

  it('does not invite a sign-up the archive will refuse', async () => {
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue(methods({ signup: 'closed' }));
    view();

    expect(await screen.findByText(/not open for new accounts/iu)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Create an archive/u })).not.toBeInTheDocument();
  });

  it('states the password rule only where it is applied', async () => {
    // On sign-in you type the password you already have, whatever its length.
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue(methods());
    view();

    const signingIn = await screen.findByLabelText(/Password/u);
    expect(signingIn).not.toHaveAttribute('minLength');
    expect((signingIn as HTMLInputElement).placeholder).toBe('');

    await userEvent.click(screen.getByRole('button', { name: /Create an archive/u }));
    expect(screen.getByLabelText(/Password/u)).toHaveAttribute('minLength', '10');
  });

  it('says what went wrong, not what the server said', async () => {
    // The message a person reads after mistyping a password. It used to be the
    // whole problem document, printed into the form.
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue(methods());
    const onSignIn = vi.fn().mockRejectedValue(new MemoarApiError(401, 'Invalid credentials', { code: 'invalid_credentials' }));
    view({ onSignIn });

    await userEvent.type(await screen.findByLabelText(/Email/u), 'someone@example.com');
    await userEvent.type(screen.getByLabelText(/Password/u), 'not-the-right-one');
    await userEvent.click(screen.getByRole('button', { name: /Sign in/u }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('That email and password do not match an archive.');
    expect(alert.textContent).not.toContain('{');
  });

  it('points a duplicate registration at signing in', async () => {
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue(methods());
    const onCreateAccount = vi.fn().mockRejectedValue(new MemoarApiError(409, 'Email already registered'));
    view({ onCreateAccount });

    await userEvent.click(await screen.findByRole('button', { name: /Create an archive/u }));
    await userEvent.type(screen.getByLabelText(/Email/u), 'taken@example.com');
    await userEvent.type(screen.getByLabelText(/Password/u), 'a-password-of-real-length');
    await userEvent.click(screen.getByRole('button', { name: /Create archive/u }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already exists.*Sign in instead/iu);
  });

  it('keeps the email and drops the password when the mode changes', async () => {
    // Same person, different intent: the password typed to sign in is not the
    // one they mean to register with, and the browser is being told so.
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue(methods());
    view();

    await userEvent.type(await screen.findByLabelText(/Email/u), 'someone@example.com');
    await userEvent.type(screen.getByLabelText(/Password/u), 'an-existing-password');
    await userEvent.click(screen.getByRole('button', { name: /Create an archive/u }));

    expect(screen.getByLabelText(/Email/u)).toHaveValue('someone@example.com');
    expect(screen.getByLabelText(/Password/u)).toHaveValue('');
  });

  it('claims nothing about sign-up until the archive has answered', async () => {
    // Reading the answer before it arrived stated the archive was closed to new
    // accounts for as long as the request took, then contradicted itself.
    let answer: (value: AuthMethods) => void = () => undefined;
    vi.spyOn(memoarApi, 'authMethods').mockReturnValue(new Promise<AuthMethods>((resolve) => { answer = resolve; }));
    view();

    expect(screen.queryByText(/not open for new accounts/iu)).not.toBeInTheDocument();

    answer(methods());
    expect(await screen.findByRole('button', { name: /Create an archive/u })).toBeInTheDocument();
  });

  it('says nothing about fixtures', async () => {
    // "Credentials are never stored in session fixtures" was test jargon on a
    // login page: meaningless to a reader, and it raised a worry rather than
    // settling one.
    vi.spyOn(memoarApi, 'authMethods').mockResolvedValue(methods());
    view();

    await waitFor(() => { expect(screen.getByRole('button', { name: /Sign in/u })).toBeInTheDocument(); });
    expect(screen.queryByText(/fixture/iu)).not.toBeInTheDocument();
  });
});
