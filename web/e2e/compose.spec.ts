import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// The local stack's bootstrap account (deploy/docker-compose.dev.yml); override with MEMOAR_E2E_*.
const email = process.env.MEMOAR_E2E_EMAIL ?? 'owner@memoar.local';
const password = process.env.MEMOAR_E2E_PASSWORD ?? 'local-stack-password-change-me';
const apiBase = process.env.MEMOAR_E2E_API_URL ?? 'http://127.0.0.1:4000/v1';
// The archive names a session after its first prompt when the source gives no title.
const fixtureTitle = process.env.MEMOAR_E2E_FIXTURE_TITLE ?? 'Find the cause of the failing archive test.';
const fixturePath = fileURLToPath(new URL('../../contracts/fixtures/claude-code/v1/session-1/input/session.jsonl', import.meta.url));
const fixtureCount = 35;

interface SessionList {
  items: Array<{ id: string; source: string; title: string }>;
}

function fixtureVariant(raw: string, index: number): Buffer {
  const base = 0x1000 + index * 0x10;
  const uuid = (offset: number) => `0191cafe-0000-7000-8000-${(base + offset).toString(16).padStart(12, '0')}`;
  const replacements = [
    ['0191cafe-0000-7000-8000-00000000000b', uuid(0)],
    ['0191cafe-0000-7000-8000-00000000000c', uuid(1)],
    ['0191cafe-0000-7000-8000-00000000000d', uuid(2)],
    ['0191cafe-0000-7000-8000-00000000000e', uuid(3)],
    ['0191cafe-0000-7000-8000-00000000000f', uuid(4)],
    ['0191cafe-0000-7000-8000-000000000010', uuid(5)],
  ] as const;
  let variant = raw;
  for (const [original, replacement] of replacements) variant = variant.replaceAll(original, replacement);
  const records = variant.trim().split('\n').map((line) => JSON.parse(line) as {
    message: { content: string | Array<Record<string, unknown>> };
  });
  const assistant = records[1];
  if (assistant && Array.isArray(assistant.message.content)) {
    assistant.message.content.push(
      {
        id: uuid(6),
        kind: 'tool_result',
        callId: 'fixture-call-1',
        text: '{\"status\":\"preserved\",\"parentId\":\"native-parent\"}',
        data: { status: 'success' },
      },
      {
        id: uuid(7),
        kind: 'diff',
        data: {
          path: 'src/archive.ts',
          oldText: 'parentId: null',
          newText: 'parentId: nativeParentId',
        },
      },
    );
  }
  return Buffer.from(records.map((record) => JSON.stringify(record)).join('\n'));
}

async function ensureFixtureArchive(request: APIRequestContext): Promise<void> {
  const loginResponse = await request.post(`${apiBase}/auth/login`, { data: { email, password } });
  expect(loginResponse.status(), 'Compose fixture login must use the documented non-production seed').toBe(200);
  const login = await loginResponse.json() as { accessToken: string };
  const browserHeaders = { Authorization: `Bearer ${login.accessToken}` };

  const currentResponse = await request.get(`${apiBase}/sessions?limit=100`, { headers: browserHeaders });
  expect(currentResponse.ok()).toBeTruthy();
  const current = await currentResponse.json() as SessionList;
  if (current.items.filter((session) => session.source === 'claude-code').length >= fixtureCount) return;

  const machineResponse = await request.post(`${apiBase}/machines`, {
    headers: browserHeaders,
    data: { name: 'Playwright fixture importer', platform: 'linux', agentVersion: 'e2e' },
  });
  expect(machineResponse.ok()).toBeTruthy();
  const machine = await machineResponse.json() as { id: string };
  const tokenResponse = await request.post(`${apiBase}/auth/machine-token`, {
    headers: browserHeaders,
    data: { machineId: machine.id },
  });
  expect(tokenResponse.ok()).toBeTruthy();
  const machineSession = await tokenResponse.json() as { token: string };
  const machineHeaders = { Authorization: `Bearer ${machineSession.token}` };

  const raw = await readFile(fixturePath, 'utf8');
  const artifacts = Array.from({ length: fixtureCount }, (_, index) => {
    const bytes = fixtureVariant(raw, index);
    return {
      bytes,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      sourcePath: `e2e/claude-code-${index}.jsonl`,
    };
  });
  const deltaResponse = await request.post(`${apiBase}/ingest/delta`, {
    headers: machineHeaders,
    data: { machineId: machine.id, hashes: artifacts.map((artifact) => artifact.sha256) },
  });
  expect(deltaResponse.ok()).toBeTruthy();
  const delta = await deltaResponse.json() as { missing: string[] };
  const missing = new Set(delta.missing);
  await Promise.all(artifacts.filter((artifact) => missing.has(artifact.sha256)).map(async (artifact) => {
    const response = await request.put(`${apiBase}/ingest/artifacts/${artifact.sha256}`, {
      headers: {
        ...machineHeaders,
        'content-type': 'application/octet-stream',
        'x-memoar-source': 'claude-code@v1',
        'x-memoar-source-path': artifact.sourcePath,
      },
      data: artifact.bytes,
    });
    const responseBody = (await response.text()).slice(0, 512);
    expect(
      response.ok(),
      `artifact PUT ${artifact.sha256} returned HTTP ${response.status()}: ${responseBody}`,
    ).toBeTruthy();
  }));
  const manifestResponse = await request.post(`${apiBase}/ingest/manifests`, {
    headers: machineHeaders,
    data: {
      machineId: machine.id,
      batchId: `playwright-${Date.now()}`,
      artifacts: artifacts.map((artifact) => ({
        sha256: artifact.sha256,
        size: artifact.bytes.byteLength,
        source: 'claude-code@v1',
        sourcePath: artifact.sourcePath,
        modifiedAt: '2026-08-18T00:00:00.000Z',
      })),
    },
  });
  expect(manifestResponse.status()).toBe(202);

  for (let attempt = 0; attempt < 60; attempt += 1) {
    const sessionsResponse = await request.get(`${apiBase}/sessions?limit=100`, { headers: browserHeaders });
    const sessions = await sessionsResponse.json() as SessionList;
    if (sessions.items.filter((session) => session.source === 'claude-code').length >= fixtureCount) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Fixture ingest did not materialize ${fixtureCount} Claude Code sessions`);
}

async function signIn(page: Page): Promise<void> {
  await page.goto('/#/timeline');
  const signIn = page.getByRole('heading', { name: 'Sign in' });
  if (await signIn.isVisible()) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /^Sign in/ }).click();
  }
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
  await expect(page.getByText('Demo archive', { exact: true })).toHaveCount(0);
}

async function openFixture(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Search', exact: true }).click();
  const search = page.getByRole('searchbox', { name: 'Search sessions' });
  await search.fill('parent reference');
  const result = page.locator('.result-row').first();
  await expect(result).toBeVisible();
  await result.click();
  await expect(page.getByRole('group', { name: 'Session actions' })).toBeVisible();
}

// Deliberately NOT serial. The config already pins workers to 1 so these run
// in order against one live stack, but serial mode also SKIPS every remaining
// test after the first failure — which meant a red run reported one defect and
// hid the rest, costing a full CI cycle per bug. Each test signs in and creates
// its own data, so they stand alone.
test.describe.configure({ mode: 'default' });

test.describe('Memoar live Compose browser acceptance', () => {
  test.beforeAll(async ({ request }) => {
    test.setTimeout(120_000);
    await ensureFixtureArchive(request);
  });
  test('authenticates, offers only the providers this deployment has, and never falls back to demo data', async ({ page }) => {
    await page.goto('/#/signin');
    // The compose stack configures no OAuth, so neither button belongs here. A
    // provider button on a server with no credentials for it answers 401 when
    // somebody presses it, and on this page it would be the only way in.
    await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toHaveCount(0);
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    const loginResponse = page.waitForResponse((response) => response.url().endsWith('/v1/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /^Sign in/ }).click();
    await expect((await loginResponse).status()).toBe(200);
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    await expect(page.getByText('Demo archive', { exact: true })).toHaveCount(0);
  });

  test('lets somebody who has no account create one', async ({ page }) => {
    // Until recently this was impossible: the only sign-up affordances were the
    // two provider buttons, which fail on a deployment without OAuth, and no
    // email registration existed at all.
    await page.goto('/#/signin');
    await page.getByRole('button', { name: 'Create an archive' }).click();
    await expect(page.getByRole('heading', { name: 'Create an archive' })).toBeVisible();

    const address = `e2e-${Date.now()}@memoar.test`;
    await page.getByLabel('Email').fill(address);
    await page.getByLabel('Password').fill('a-password-of-real-length');
    const registered = page.waitForResponse((response) => response.url().endsWith('/v1/auth/register') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /^Create archive/ }).click();
    expect((await registered).status()).toBe(201);

    // Signed straight in, and into an archive of their own rather than the one
    // the fixture account owns.
    await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
    // The address lives in the account menu, once.
    await page.getByRole('button', { name: 'Account' }).click();
    await expect(page.getByRole('menu', { name: 'Account' })).toContainText(address);
  });

  test('covers onboarding, fixture visibility, filters, and a second timeline page', async ({ page }) => {
    await signIn(page);
    // This step used to assert the mock-up: a "Connect source" button, an
    // `npx memoar connect` command the CLI does not have, and an "I ran the
    // command" button that only set a flag. It now checks that the page hands
    // over commands the agent accepts and lists the machines that exist.
    await page.getByRole('link', { name: 'Machines', exact: true }).click();
    await page.getByRole('button', { name: 'Connect a machine' }).click();
    await expect(page.getByRole('heading', { name: 'Connect a machine' })).toBeVisible();
    await expect(page.locator('.install-command').first()).toContainText('memoar login --endpoint');
    await expect(page.locator('.install-command').nth(1)).toContainText('memoar sync --watch');
    await expect(page.getByText('Machines on this account')).toBeVisible();
    // The fixture importer registered a machine, so the archive is reachable
    // from here rather than the button staying disabled forever.
    await page.getByRole('button', { name: 'Open sessions' }).click();
    await expect(page.getByText(fixtureTitle, { exact: true }).first()).toBeVisible();

    const source = page.getByRole('group', { name: 'Filter by source' });
    await source.getByRole('button', { name: 'Claude Code' }).click();
    await expect(page.getByText(fixtureTitle, { exact: true }).first()).toBeVisible();
    const loadMore = page.getByRole('button', { name: 'Load older sessions' });
    await expect(loadMore).toBeVisible();
    const secondPage = page.waitForResponse((response) =>
      response.url().includes('/v1/sessions/timeline?') && response.url().includes('cursor='));
    await loadMore.click();
    expect((await secondPage).ok()).toBeTruthy();
    await expect(loadMore).toHaveCount(0);
  });

  test('renders live search highlighting, aggregations, and realized retrieval mode', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Search', exact: true }).click();
    const search = page.getByRole('searchbox', { name: 'Search sessions' });
    const responsePromise = page.waitForResponse((response) => response.url().includes('/v1/search?') && response.request().method() === 'GET');
    await search.fill('parent reference');
    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();
    await expect(page.locator('.result-row').first()).toBeVisible();
    await expect(page.locator('.result-row mark').first()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Search filters' })).toContainText('Claude Code');
    await expect(page.locator('.results-meta')).toContainText(/lexical|hybrid/);
  });

  test('renders live thinking, collapsible tool data, syntax tokens, diffs, tokens, and provenance', async ({ page }) => {
    await signIn(page);
    await openFixture(page);
    await expect(page.locator('.thinking-hidden').first()).toBeVisible();
    await page.getByLabel('Show thinking').check();
    await expect(page.locator('.thinking-block').first()).toBeVisible();
    // Tool calls render by kind: a shell command as a terminal, an edit as a
    // diff, anything else as one line that opens onto its highlighted input.
    const tool = page.locator('details.tool-block, .terminal-block').first();
    await expect(tool).toBeVisible();
    const generic = page.locator('details.tool-block').first();
    if (await generic.count()) {
      await generic.locator('summary').click();
      await expect(generic.locator('.code-block').first()).toBeVisible();
    }
    await expect(page.getByRole('table', { name: /Diff for/ })).toBeVisible();
    const details = page.locator('details.session-details');
    await details.locator('summary').click();
    await expect(details).toContainText('Tokens');
    await expect(page.locator('.provenance-item').first()).toBeVisible();
  });

  test('creates a collection against the API', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Collections', exact: true }).click();
    await page.getByRole('button', { name: 'New collection' }).click();
    const name = `E2E evidence ${Date.now()}`;
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Description').fill('Created by the live Compose browser gate');
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/v1/collections') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create collection' }).click();
    expect((await responsePromise).ok()).toBeTruthy();
    await expect(page.getByRole('button', { name: `Open ${name}` })).toBeVisible();
  });

  test('requires review before sharing and exposes transfer management', async ({ page }) => {
    await signIn(page);
    await openFixture(page);
    await page.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Review what leaves your archive' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Create secure link/ })).toHaveCount(0);
    await page.getByRole('button', { name: /Approve redactions/ }).click();
    await expect(page.getByRole('dialog', { name: 'Create share link' })).toBeVisible();

    // Asserting the button is VISIBLE is what let this ship with no click
    // handler at all: the dialog rendered, the gate passed, and no link was
    // ever minted. Press it and require the round trip and the resulting token.
    const created = page.waitForResponse((response) =>
      response.url().endsWith('/v1/sharing/links') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Create secure link/ }).click();
    const grant = await created;
    expect(grant.status(), `share link POST returned ${grant.status()}`).toBe(201);
    const body = await grant.json() as { token?: string; status?: string };
    expect(body.status).toBe('active');
    expect(body.token, 'a share link without a token cannot be opened').toBeTruthy();
    await expect(page.getByText(String(body.token), { exact: false })).toBeVisible();

    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Shared', exact: true }).click();

    // The grant must reach the Sharing view without a reload — its list is
    // loaded with the dashboard, which predates the link. The token itself is
    // deliberately absent here: the API does not return it after creation.
    const active = page.locator('.share-row').filter({ has: page.getByRole('button', { name: 'Revoke' }) });
    await expect(active.first()).toBeVisible();
    const before = await active.count();

    // Revoking must change the grant server-side, not just drop a row locally.
    const revoked = page.waitForResponse((response) =>
      response.url().includes('/v1/sharing/grants/') && response.request().method() === 'DELETE');
    await active.first().getByRole('button', { name: 'Revoke' }).click();
    expect((await revoked).status()).toBe(204);
    await expect(active).toHaveCount(before - 1);

    await page.getByRole('tab', { name: /Transfers/ }).click();
    await expect(page.getByRole('heading', { name: 'Session transfers' })).toBeVisible();
  });

  test('jumps to a session from the command palette and moves with j and k', async ({ page }) => {
    await signIn(page);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Command palette' });
    await expect(palette).toBeVisible();
    await page.getByRole('combobox', { name: 'Command' }).fill(fixtureTitle.slice(0, 12));
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page).toHaveURL(/\/sessions\//);

    // The list and the transcript are both live: j moves the selection and
    // the transcript beside it follows without a page load.
    const before = page.url();
    await page.locator('body').focus();
    await page.keyboard.press('j');
    await expect.poll(() => page.url()).not.toBe(before);
    await expect(page.getByRole('group', { name: 'Session actions' })).toBeVisible();
  });

  test('builds a cited pack preview and queues a live conversion', async ({ page }) => {
    await signIn(page);
    await openFixture(page);
    const packResponse = page.waitForResponse((response) => response.url().endsWith('/v1/pack') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Pack preview' }).click();
    expect((await packResponse).ok()).toBeTruthy();
    const packDialog = page.getByRole('dialog', { name: 'Pack preview' });
    await expect(packDialog).toContainText(/excerpt/);
    await expect(packDialog).toContainText(/turns \d+ to \d+/);
    await page.getByRole('button', { name: 'Close dialog' }).click();

    await page.getByRole('button', { name: 'Convert', exact: true }).click();
    await page.getByRole('radio', { name: /Codex/ }).click();
    const conversionResponse = page.waitForResponse((response) => response.url().endsWith('/v1/convert') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Queue conversion/ }).click();
    expect((await conversionResponse).status()).toBe(202);
    await expect(page.getByRole('dialog', { name: 'Resume in another agent' })).toContainText(/Conversion ready|Conversion queued|Conversion running/);
  });

  test('shows registered machines, source state, API keys, and the live MCP endpoint', async ({ page }) => {
    await signIn(page);
    await page.getByRole('link', { name: 'Machines', exact: true }).click();
    await expect(page.locator('.machine').first()).toBeVisible();
    await expect(page.locator('.source-row').first()).toBeVisible();

    await page.getByRole('link', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'API keys and MCP' }).click();
    await expect(page.getByRole('heading', { name: 'Remote MCP' })).toBeVisible();
    await expect(page.locator('.mcp-section .command code').first()).toContainText('/mcp');
    await page.getByRole('button', { name: 'Create key' }).click();
    const keyName = `Playwright ${Date.now()}`;
    await page.getByLabel('Key name').fill(keyName);
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/v1/auth/api-keys') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create key', exact: true }).last().click();
    expect((await responsePromise).status()).toBe(201);
    await expect(page.getByRole('dialog', { name: 'Copy your new key' })).toContainText('memoar_');
  });

  test('imports a consumer ZIP through machine-token delta, raw upload, manifest, and worker visibility', async ({ page }) => {
    test.setTimeout(90_000);
    await signIn(page);
    await page.getByRole('button', { name: 'Import', exact: true }).click();
    await page.getByLabel('Format').selectOption('chatgpt-export');
    await page.getByLabel('Archive file').setInputFiles('../contracts/fixtures/chatgpt-export/2026-08/session-1/input/export.zip');
    const machineToken = page.waitForResponse((response) => response.url().endsWith('/v1/auth/machine-token') && response.request().method() === 'POST');
    const delta = page.waitForResponse((response) => response.url().endsWith('/v1/ingest/delta') && response.request().method() === 'POST');
    const artifact = page.waitForResponse((response) => response.url().includes('/v1/ingest/artifacts/') && response.request().method() === 'PUT');
    const manifest = page.waitForResponse((response) => response.url().endsWith('/v1/ingest/manifests') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Import archive' }).click();
    expect((await machineToken).ok()).toBeTruthy();
    expect((await delta).ok()).toBeTruthy();
    const artifactResponse = await artifact;
    const artifactBody = (await artifactResponse.text()).slice(0, 512);
    expect(
      artifactResponse.ok(),
      `archive artifact PUT returned HTTP ${artifactResponse.status()}: ${artifactBody}`,
    ).toBeTruthy();
    expect((await manifest).status()).toBe(202);
    await expect(page.getByRole('status', { name: 'Import progress' })).toContainText('ready', { timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Open session' })).toBeVisible();
  });
});
