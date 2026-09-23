import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from './Settings';
import { memoarApi, type DistillationSettings, type TenantSettings } from '../lib/api';

const SETTINGS: TenantSettings = {
  redaction: { secretScan: true, pathScan: false, emailScan: false, customPatterns: [] },
  retention: { policy: 'indefinite', exemptCollected: true },
  updatedAt: null,
};

function distillation(overrides: Partial<DistillationSettings> = {}): DistillationSettings {
  return {
    enabled: false,
    provider: 'none',
    model: null,
    keySet: false,
    keyHint: null,
    monthlyBudgetCents: 0,
    monthlySpentCents: 0,
    remainingCents: 0,
    budgetWindowStartedAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

function view() {
  return render(
    <SettingsView
      apiKeys={[]}
      mcpEndpoint="http://localhost:4000/mcp"
      user={{ id: 'u1', email: 'owner@memoar.local', displayName: 'Owner', hasPassword: true }}
      onCreateKey={() => Promise.resolve('secret')}
      onKeyRevoked={() => undefined}
    />,
  );
}

beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(memoarApi, 'getSettings').mockResolvedValue(SETTINGS);
});

/**
 * Distillation was a server-wide environment variable and one operator API key.
 * That meant the operator paid for every account and every account's sessions
 * went through the operator's provider — so it is now the account's own choice,
 * its own key, and its own bill, which makes it a screen rather than a config
 * file.
 */
describe('choosing a distillation provider', () => {
  it('says plainly that this is the one feature that sends sessions elsewhere', async () => {
    vi.spyOn(memoarApi, 'getDistillationSettings').mockResolvedValue(distillation());
    view();

    await userEvent.click(await screen.findByRole('button', { name: /Distillation/u }));

    expect(await screen.findByText(/only part of Memoar that sends your sessions to a third party/iu)).toBeInTheDocument();
  });

  it('never sends an empty key, which would delete the stored one', async () => {
    // The distinction the whole design rests on: absent leaves the credential
    // alone, null clears it. A blank string sent on every unrelated change
    // would quietly delete somebody's key.
    vi.spyOn(memoarApi, 'getDistillationSettings').mockResolvedValue(distillation({ keySet: true, keyHint: '1234', provider: 'anthropic', enabled: true }));
    const update = vi.spyOn(memoarApi, 'updateDistillationSettings')
      .mockResolvedValue(distillation({ keySet: true, keyHint: '1234', provider: 'anthropic' }));
    view();

    await userEvent.click(await screen.findByRole('button', { name: /Distillation/u }));
    await userEvent.click(await screen.findByRole('switch', { name: /Distil sessions/u }));

    await waitFor(() => { expect(update).toHaveBeenCalled(); });
    for (const [body] of update.mock.calls) {
      expect(Object.hasOwn(body, 'apiKey'), 'an unrelated change must not touch the key').toBe(false);
    }
  });

  it('shows which key is stored without ever showing the key', async () => {
    vi.spyOn(memoarApi, 'getDistillationSettings').mockResolvedValue(
      distillation({ keySet: true, keyHint: 'cd12', provider: 'anthropic', model: 'claude-opus-5' }),
    );
    view();

    await userEvent.click(await screen.findByRole('button', { name: /Distillation/u }));

    expect(await screen.findByText(/a key ending cd12 is stored/iu)).toBeInTheDocument();
    // The field is for entering a replacement, and starts empty: a password
    // input pre-filled with anything is a credential waiting to be autofilled
    // somewhere else.
    const field = screen.getByPlaceholderText(/Enter a new key to replace it/iu);
    expect((field as HTMLInputElement).value).toBe('');
    expect((field as HTMLInputElement).type).toBe('password');
  });

  it('clears the credential when the provider is set back to none', async () => {
    vi.spyOn(memoarApi, 'getDistillationSettings').mockResolvedValue(distillation({ keySet: true, keyHint: 'cd12', provider: 'anthropic' }));
    const update = vi.spyOn(memoarApi, 'updateDistillationSettings').mockResolvedValue(distillation());
    view();

    await userEvent.click(await screen.findByRole('button', { name: /Distillation/u }));
    await userEvent.selectOptions(await screen.findByLabelText(/Provider/u), 'none');

    // Keeping a key after the feature is switched off is holding a secret with
    // no reason to hold it.
    await waitFor(() => { expect(update).toHaveBeenCalledWith({ provider: 'none', apiKey: null }); });
  });

  it('reports what has been spent against the limit', async () => {
    vi.spyOn(memoarApi, 'getDistillationSettings').mockResolvedValue(
      distillation({ provider: 'anthropic', keySet: true, enabled: true, monthlyBudgetCents: 1000, monthlySpentCents: 250 }),
    );
    view();

    await userEvent.click(await screen.findByRole('button', { name: /Distillation/u }));

    expect(await screen.findByText(/\$2\.50 of \$10\.00 used this month/u)).toBeInTheDocument();
  });
});
