import { render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsView } from './Settings';
import { memoarApi } from '../lib/api';

let settingsLoaded: ReturnType<typeof vi.spyOn>;
let mcpStatusAsked: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.restoreAllMocks();
  settingsLoaded = vi.spyOn(memoarApi, 'getSettings').mockResolvedValue({
    redaction: { secretScan: true, pathScan: true, emailScan: false, customPatterns: [] },
    retention: { policy: 'indefinite', exemptCollected: true },
    updatedAt: null,
  });
  vi.spyOn(memoarApi, 'getDistillationSettings').mockResolvedValue({
    provider: 'none', model: null, enabled: false, keySet: false, keyHint: null,
    monthlyBudgetCents: 0, monthlySpentCents: 0, remainingCents: 0,
    budgetWindowStartedAt: '2026-09-01T00:00:00.000Z',
  });

  mcpStatusAsked = vi.spyOn(memoarApi, 'getMcpStatus').mockResolvedValue({
    available: true,
    contractVersion: '0.3.0',
    tools: ['search_sessions', 'get_excerpt', 'pack'],
  });
});

function renderSettings() {
  return render(
    <SettingsView
      apiKeys={[]}
      mcpEndpoint="https://app.dev.memoar.test/mcp"
      user={null}
      onCreateKey={vi.fn()}
      onKeyRevoked={vi.fn()}
    />,
  );
}

describe('the remote MCP section', () => {
  it('claims no availability it has not measured', async () => {
    /*
      This carried <Badge className="status-active"><span /> Available</Badge>:
      a live green dot, no condition behind it, beside an endpoint string the
      browser never contacts. It read "Available" on a deployment that serves
      no MCP at all. The same defect was removed twice before — the topbar's
      literal "Connected", and the client list that marked whichever row came
      first as "Connected 8m ago".
    */
    const { container } = renderSettings();
    await waitFor(() => expect(settingsLoaded).toHaveBeenCalled());

    // The word itself is gone: a badge that says how many tools are served
    // cannot be produced without having asked. "Available" could.
    expect(screen.queryByText(/Available/u)).not.toBeInTheDocument();
    // And the live-green state is now reachable only through the archive's
    // answer, so it must have been asked for before it can appear.
    await waitFor(() =>
      expect(container.querySelector('.mcp-section .status-active')).not.toBeNull(),
    );
    // The spy is what records that the archive was asked at all.
    expect(mcpStatusAsked).toHaveBeenCalled();
  });

  it('still says what it does know: the endpoint, and how to add it', async () => {
    renderSettings();
    await waitFor(() => expect(settingsLoaded).toHaveBeenCalled());

    expect(screen.getByText('https://app.dev.memoar.test/mcp')).toBeInTheDocument();
    expect(screen.getByText(/claude mcp add --transport http memoar/u)).toBeInTheDocument();
  });
});

describe('the MCP badge', () => {
  it('says what the archive answered, not what the page assumed', async () => {
    renderSettings();
    // The tool count is the proof it was measured: a literal could claim
    // availability, but not how many tools this deployment serves.
    expect(await screen.findByText('3 tools')).toBeInTheDocument();
  });

  it('shows nothing at all while the answer is in flight', () => {
    renderSettings();
    expect(screen.queryByText(/tools|Not served/u)).not.toBeInTheDocument();
  });

  it('claims nothing when the archive cannot be asked', async () => {
    vi.spyOn(memoarApi, 'getMcpStatus').mockRejectedValue(new Error('offline'));
    renderSettings();
    await waitFor(() => expect(settingsLoaded).toHaveBeenCalled());
    expect(screen.queryByText(/tools|Not served/u)).not.toBeInTheDocument();
  });

  it('says so when the deployment serves no tools', async () => {
    vi.spyOn(memoarApi, 'getMcpStatus').mockResolvedValue({
      available: false, contractVersion: '0.3.0', tools: [],
    });
    renderSettings();
    expect(await screen.findByText('Not served')).toBeInTheDocument();
  });
});
