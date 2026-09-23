import { expect, test, type Page } from '@playwright/test';

// Same bootstrap account as compose.spec.ts; override with MEMOAR_E2E_*.
const email = process.env.MEMOAR_E2E_EMAIL ?? 'owner@memoar.local';
const password = process.env.MEMOAR_E2E_PASSWORD ?? 'local-stack-password-change-me';

async function signIn(page: Page): Promise<void> {
  await page.goto('/#/timeline');
  const heading = page.getByRole('heading', { name: 'Open your archive.' });
  if (await heading.isVisible()) {
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Password').fill(password);
    await page.getByRole('button', { name: /^Sign in/ }).click();
  }
  await expect(page.getByText('Connected', { exact: true })).toBeVisible();
}

/**
 * Text that does not fit is text nobody can read.
 *
 * The capture column of the machines table was a fixed 40px track, sized for
 * the switch that used to sit in it. When that switch became a "Capture on" /
 * "Capture off" badge — because the switch set nothing — the badge overflowed
 * the card and the column rendered as "Captur".
 *
 * Nothing caught it, and the way it was missed is the point: the change was
 * checked by grepping the deployed JavaScript for the string "Capture on",
 * which proves the text shipped and says nothing about whether it is legible.
 * Every other gate here reads source or markup; none of them lays anything out.
 * This is the one that opens a browser.
 */
test.describe('what the layout actually renders', () => {
  test('never clips a cell, and never scrolls the page sideways', async ({ page }) => {
    await signIn(page);
    await page.goto('/#/machines');
    await expect(page.getByRole('heading', { name: 'Machines & sources' })).toBeVisible();

    // Only the first two cards open by default, so open the rest: the row this
    // checks lives inside one, and an archive with several machines would
    // otherwise hide every row this test is about.
    //
    // Waited for rather than collected in one go — the cards arrive from the
    // archive after the heading does, and reading the list too early returns
    // nothing and clicks nothing, which then looks like "this archive has no
    // sources" rather than "the page had not finished loading".
    const collapsed = page.getByRole('button', { name: /^Expand / });
    await expect(collapsed.first(), 'no machine cards rendered').toBeVisible();
    // One at a time, re-querying: each click re-renders the list, so handles
    // taken before it are stale.
    for (let remaining = await collapsed.count(); remaining > 0; remaining -= 1) {
      await collapsed.first().click();
    }

    // A row is only present when a machine has reported sources. Without one
    // this test would pass by checking nothing, which is the failure mode it
    // exists to prevent, so say so rather than go quiet.
    const badges = page.locator('.source-row .badge');
    await expect(badges.first(), 'no source rows rendered, so nothing was checked').toBeVisible();

    for (const badge of await badges.all()) {
      const clipped = await badge.evaluate((node) => {
        const cell = node as HTMLElement;
        // scrollWidth exceeding clientWidth is the browser saying the content
        // did not fit the box it was given.
        return { text: cell.textContent ?? '', overflow: cell.scrollWidth - cell.clientWidth };
      });
      expect(clipped.overflow, `"${clipped.text}" is cut off by ${clipped.overflow}px`).toBeLessThanOrEqual(1);
    }

    // And the table as a whole stays inside the page: a column that grows past
    // the viewport pushes the document sideways instead of clipping one cell.
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(sideways, 'the page scrolls horizontally, so a column is wider than the window').toBeLessThanOrEqual(1);
  });
});
