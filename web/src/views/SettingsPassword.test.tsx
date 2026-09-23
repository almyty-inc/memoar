import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from './Settings';
import { memoarApi, MemoarApiError } from '../lib/api';
import type { CurrentUser } from '../lib/types';

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(memoarApi, 'getSettings').mockResolvedValue({
    redaction: { secretScan: true, pathScan: true, emailScan: false, customPatterns: [] },
    retention: { policy: 'indefinite', exemptCollected: true },
    updatedAt: null,
  });
  vi.spyOn(memoarApi, 'getDistillationSettings').mockResolvedValue({
    provider: 'none', model: null, enabled: false, keySet: false, keyHint: null,
    monthlyBudgetCents: 0, monthlySpentCents: 0, remainingCents: 0,
    budgetWindowStartedAt: '2026-09-01T00:00:00.000Z',
  });
  vi.spyOn(memoarApi, 'getMcpStatus').mockResolvedValue({ available: true, contractVersion: '0.3.0', tools: [] });
});

/** Made up here so no password-shaped string lives in a fixture. */
function typedPassword(): string {
  return `typed-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

async function openGeneral(user: CurrentUser): Promise<void> {
  render(<SettingsView apiKeys={[]} mcpEndpoint="https://app.dev.memoar.test/mcp" user={user} onCreateKey={vi.fn()} onKeyRevoked={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: /General/u }));
}

const PASSWORD_ACCOUNT: CurrentUser = { id: 'u-1', email: 'ada@example.test', displayName: 'Ada Lovelace', hasPassword: true };
const PROVIDER_ACCOUNT: CurrentUser = { id: 'u-2', email: 'grace@example.test', displayName: 'Grace Hopper', hasPassword: false };

describe('changing a password in Settings', () => {
  it('is offered to an account with a password', async () => {
    await openGeneral(PASSWORD_ACCOUNT);
    expect(screen.getByRole('heading', { name: 'Change password' })).toBeInTheDocument();
  });

  it('is not offered to an account that signs in with a provider', async () => {
    await openGeneral(PROVIDER_ACCOUNT);
    expect(screen.getByText('Grace Hopper')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Change password' })).toBeNull();
    expect(screen.queryByLabelText('Current password')).toBeNull();
  });

  it("shows the archive's refusal, and holds the button while it asks", async () => {
    let refuse: (error: Error) => void = () => undefined;
    const change = vi.spyOn(memoarApi, 'changePassword').mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }));
    await openGeneral(PASSWORD_ACCOUNT);
    const current = typedPassword();
    const next = typedPassword();

    await userEvent.type(screen.getByLabelText('Current password'), current);
    await userEvent.type(screen.getByLabelText(/^New password/u), next);
    await userEvent.type(screen.getByLabelText('Confirm new password'), next);
    await userEvent.click(screen.getByRole('button', { name: /Change password/u }));

    expect(change).toHaveBeenCalledWith(current, next);
    expect(screen.getByRole('button', { name: /Changing/u })).toBeDisabled();

    refuse(new MemoarApiError(403, 'The current password is not correct', { code: 'wrong_password' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('The current password is not correct'));
    expect(screen.getByRole('button', { name: /Change password/u })).not.toBeDisabled();
  });

  it('says so when it worked, and clears the fields', async () => {
    vi.spyOn(memoarApi, 'changePassword').mockResolvedValue(undefined);
    await openGeneral(PASSWORD_ACCOUNT);
    const next = typedPassword();

    await userEvent.type(screen.getByLabelText('Current password'), typedPassword());
    await userEvent.type(screen.getByLabelText(/^New password/u), next);
    await userEvent.type(screen.getByLabelText('Confirm new password'), next);
    await userEvent.click(screen.getByRole('button', { name: /Change password/u }));

    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Password changed'));
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not send a new password that does not match its confirmation', async () => {
    const change = vi.spyOn(memoarApi, 'changePassword').mockResolvedValue(undefined);
    await openGeneral(PASSWORD_ACCOUNT);

    await userEvent.type(screen.getByLabelText('Current password'), typedPassword());
    await userEvent.type(screen.getByLabelText(/^New password/u), typedPassword());
    await userEvent.type(screen.getByLabelText('Confirm new password'), typedPassword());
    await userEvent.click(screen.getByRole('button', { name: /Change password/u }));

    expect(screen.getByRole('alert')).toHaveTextContent('do not match');
    expect(change).not.toHaveBeenCalled();
  });
});
