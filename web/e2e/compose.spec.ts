import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

// These local/CI-only credentials match MEMOAR_SEED_DEMO; override them with MEMOAR_E2E_* when needed.
const email = process.env.MEMOAR_E2E_EMAIL ?? 'demo@memoar.dev';
const password = process.env.MEMOAR_E2E_PASSWORD ?? 'memoar-demo-password';
const apiBase = process.env.MEMOAR_E2E_API_URL ?? 'http://127.0.0.1:4000/v1';
const fixtureTitle = process.env.MEMOAR_E2E_FIXTURE_TITLE ?? 'claude-code imported session';
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
  const signIn = page.getByRole('heading', { name: 'Open your archive.' });
  if (await signIn.isVisible()) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /^Sign in/ }).click();
  }
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
  await expect(page.getByText('Demo archive', { exact: true })).toHaveCount(0);
}

async function openFixture(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Search', exact: true }).first().click();
  const search = page.getByRole('searchbox', { name: 'Search sessions' });
  await search.fill('parent reference');
  const card = page.locator('.search-result-card').first();
  await expect(card).toBeVisible();
  await card.locator('.search-result-button').click();
  await expect(page.getByRole('heading', { name: 'Session overview' })).toBeVisible();
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
  test('authenticates, exposes OAuth entry points, and never falls back to demo data', async ({ page }) => {
    await page.goto('/#/signin');
    await expect(page.getByRole('button', { name: 'Continue with GitHub' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Continue with Google' })).toBeVisible();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    const loginResponse = page.waitForResponse((response) => response.url().endsWith('/v1/auth/login') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /^Sign in/ }).click();
    await expect((await loginResponse).status()).toBe(200);
    await expect(page.getByText('Connected', { exact: true })).toBeVisible();
    await expect(page.getByText('Demo archive', { exact: true })).toHaveCount(0);
  });

  test('covers onboarding, fixture visibility, filters, and a second timeline page', async ({ page }) => {
    await signIn(page);
    // This step used to assert the mock-up: a "Connect source" button, an
    // `npx memoar connect` command the CLI does not have, and an "I ran the
    // command" button that only set a flag. It now checks that the page hands
    // over commands the agent accepts and lists the machines that exist.
    await page.getByRole('button', { name: 'Connect a machine' }).click();
    await expect(page.getByRole('heading', { name: 'Connect a machine.' })).toBeVisible();
    await expect(page.locator('.install-command').first()).toContainText('memoar login --endpoint');
    await expect(page.locator('.install-command').nth(1)).toContainText('memoar sync --watch');
    await expect(page.getByText('Machines on this account')).toBeVisible();
    // The fixture importer registered a machine, so the archive is reachable
    // from here rather than the button staying disabled forever.
    await page.getByRole('button', { name: /Browse the archive|Open the timeline/ }).click();
    await expect(page.getByText(fixtureTitle, { exact: true }).first()).toBeVisible();

    const source = page.getByLabel('Filter by source');
    await source.selectOption({ label: 'Claude Code' });
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
    await page.getByRole('button', { name: 'Search', exact: true }).first().click();
    const search = page.getByRole('searchbox', { name: 'Search sessions' });
    const responsePromise = page.waitForResponse((response) => response.url().includes('/v1/search?') && response.request().method() === 'GET');
    await search.fill('parent reference');
    const response = await responsePromise;
    expect(response.ok()).toBeTruthy();
    await expect(page.locator('.search-result-card').first()).toBeVisible();
    await expect(page.locator('.search-result-card mark').first()).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Search filters' })).toContainText('Claude Code');
    await expect(page.locator('.results-meta')).toContainText(/lexical|hybrid/);
  });

  test('renders live thinking, collapsible tool data, syntax tokens, diffs, tokens, and provenance', async ({ page }) => {
    await signIn(page);
    await openFixture(page);
    await expect(page.locator('.thinking-hidden').first()).toBeVisible();
    await page.getByLabel('Show thinking').check();
    await expect(page.locator('.thinking-block').first()).toBeVisible();
    const tool = page.locator('details.tool-block').first();
    await expect(tool).toBeVisible();
    await tool.locator('summary').click();
    await expect(tool.locator('.syntax-block')).toBeVisible();
    await expect(tool.locator('.syntax-key').first()).toBeVisible();
    await expect(page.getByRole('table', { name: /Diff for/ })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Session details' })).toContainText('Input');
    await expect(page.locator('.provenance-item').first()).toBeVisible();
  });

  test('creates a collection against the API', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Collections', exact: true }).first().click();
    await page.getByRole('button', { name: 'New collection' }).click();
    const name = `E2E evidence ${Date.now()}`;
    await page.getByLabel('Name').fill(name);
    await page.getByLabel('Description').fill('Created by the live Compose browser gate');
    const responsePromise = page.waitForResponse((response) => response.url().endsWith('/v1/collections') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Create collection' }).click();
    expect((await responsePromise).ok()).toBeTruthy();
    await expect(page.getByRole('heading', { name })).toBeVisible();
  });

  test('requires review before sharing and exposes transfer management', async ({ page }) => {
    await signIn(page);
    await openFixture(page);
    await page.getByRole('button', { name: 'Share' }).click();
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
    await page.getByRole('button', { name: 'Sharing', exact: true }).first().click();

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

  test('keeps a rearranged workspace across a reload', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Overview', exact: true }).first().click();
    const tile = page.getByRole('region', { name: /Machines tile/ });
    await expect(tile).toBeVisible();

    const before = await tile.boundingBox();
    // Keyboard rather than a synthetic drag: it exercises the same layout code
    // and does not depend on hit-testing a 26px corner in CI.
    await tile.focus();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Shift+ArrowDown');
    const after = await tile.boundingBox();
    expect(after!.x, 'the tile should have moved a column left').toBeLessThan(before!.x);
    expect(after!.height, 'shift and arrow should have made the tile taller').toBeGreaterThan(before!.height);

    // A layout that is not remembered is not a layout.
    await page.reload();
    await page.getByRole('button', { name: 'Overview', exact: true }).first().click();
    const restored = await page.getByRole('region', { name: /Machines tile/ }).boundingBox();
    expect(restored!.x).toBeCloseTo(after!.x, 0);
    expect(restored!.height).toBeCloseTo(after!.height, 0);
  });

  test('builds a cited pack preview and queues a live conversion', async ({ page }) => {
    await signIn(page);
    await openFixture(page);
    const packResponse = page.waitForResponse((response) => response.url().endsWith('/v1/pack') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Pack preview' }).click();
    expect((await packResponse).ok()).toBeTruthy();
    const packDialog = page.getByRole('dialog', { name: 'Pack preview' });
    await expect(packDialog).toContainText(/excerpts/);
    await expect(packDialog).toContainText(/turns \d+–\d+/);
    await page.getByRole('button', { name: 'Close dialog' }).click();

    await page.getByRole('button', { name: 'Convert' }).click();
    await page.getByRole('radio', { name: /Codex/ }).click();
    const conversionResponse = page.waitForResponse((response) => response.url().endsWith('/v1/convert') && response.request().method() === 'POST');
    await page.getByRole('button', { name: /Queue conversion/ }).click();
    expect((await conversionResponse).status()).toBe(202);
    await expect(page.getByRole('dialog', { name: 'Resume in another agent' })).toContainText(/Conversion ready|Conversion queued|Conversion running/);
  });

  test('shows registered machines, source state, API keys, and the live MCP endpoint', async ({ page }) => {
    await signIn(page);
    await page.getByRole('button', { name: 'Machines & sources' }).first().click();
    await expect(page.locator('.machine-card').first()).toBeVisible();
    await expect(page.locator('.source-row').first()).toBeVisible();

    await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
    await expect(page.getByRole('heading', { name: 'Remote MCP' })).toBeVisible();
    await expect(page.locator('.endpoint-row code')).toContainText('/mcp');
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
    await page.getByRole('button', { name: 'Import', exact: true }).first().click();
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
    await expect(page.getByRole('button', { name: /Open imported session/ })).toBeVisible();
  });
});
