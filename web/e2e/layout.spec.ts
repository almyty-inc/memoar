import { expect, test, type Page } from '@playwright/test';

// Same bootstrap account as compose.spec.ts; override with MEMOAR_E2E_*.
const email = process.env.MEMOAR_E2E_EMAIL ?? 'owner@memoar.local';
const password = process.env.MEMOAR_E2E_PASSWORD ?? 'local-stack-password-change-me';

async function signIn(page: Page): Promise<void> {
  await page.goto('/timeline');
  const heading = page.getByRole('heading', { name: 'Sign in' });
  if (await heading.isVisible()) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /^Sign in/ }).click();
  }
  await expect(page.getByRole('navigation', { name: 'Sections' })).toBeVisible();
}

/**
 * Text that does not fit is text nobody can read.
 *
 * The capture column of the machines table was once a fixed 40px track, and
 * the "Capture on" label in it rendered as "Captur". Every other gate here
 * reads source or markup; this is the one that lays anything out.
 */
test.describe('what the layout actually renders', () => {
  test('never clips a cell, and never scrolls the page sideways', async ({ page }) => {
    await signIn(page);
    await page.goto('/machines');
    await expect(page.getByRole('heading', { name: 'Machines', level: 1 })).toBeVisible();

    // Machines open by default. Open any the reader may have closed, waiting
    // for them to arrive rather than reading an empty list too early.
    await expect(page.locator('.machine').first(), 'no machines rendered').toBeVisible();
    const collapsed = page.getByRole('button', { name: /^Expand / });
    for (let remaining = await collapsed.count(); remaining > 0; remaining -= 1) {
      await collapsed.first().click();
    }

    // Without a source row this test would pass by checking nothing.
    const badges = page.locator('.source-row:not(.source-head) .badge');
    await expect(badges.first(), 'no source rows rendered, so nothing was checked').toBeVisible();

    for (const badge of await badges.all()) {
      const clipped = await badge.evaluate((node) => {
        const cell = node as HTMLElement;
        return { text: cell.textContent ?? '', overflow: cell.scrollWidth - cell.clientWidth };
      });
      expect(clipped.overflow, `"${clipped.text}" is cut off by ${clipped.overflow}px`).toBeLessThanOrEqual(1);
    }

    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways, 'the page scrolls horizontally, so a column is wider than the window').toBeLessThanOrEqual(1);
  });

  test('fits a phone without sideways scrolling', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await signIn(page);
    for (const path of ['/timeline', '/search', '/machines', '/settings']) {
      await page.goto(path);
      await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
      const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(sideways, `${path} scrolls sideways at phone width`).toBeLessThanOrEqual(1);
    }
  });
});
