import { expect, test, type Page } from '@playwright/test';

/** Shortcut labels follow the platform: ⌘ on Apple devices, Ctrl elsewhere. */

async function shortcutsList(page: Page) {
  await page.goto('/app');
  await page.locator('.canvas-area canvas.live').waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('.settings-tab', { hasText: 'About' }).click();
  return page.locator('.shortcuts');
}

test.describe('on a Mac', () => {
  test.use({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36' });
  test('uses ⌘ and ⇧', async ({ page }) => {
    const list = await shortcutsList(page);
    await expect(list).toContainText('⌘Z');
    await expect(list).toContainText('⇧⌘Z');
    await expect(list).not.toContainText('Ctrl');
    await expect(page.getByRole('button', { name: /^Undo/ })).toHaveAttribute('title', 'Undo (⌘Z)');
    await expect(page.getByRole('button', { name: /^Redo/ })).toHaveAttribute('title', 'Redo (⇧⌘Z)');
  });
});

test('elsewhere uses Ctrl', async ({ page }) => {
  const list = await shortcutsList(page);
  await expect(list).toContainText('Ctrl+Z');
  await expect(list).toContainText('Ctrl+Y');
  await expect(list).not.toContainText('⌘');
  await expect(page.getByRole('button', { name: /^Undo/ })).toHaveAttribute('title', 'Undo (Ctrl+Z)');
});

test('tool buttons show their key in the tooltip', async ({ page }) => {
  await page.goto('/app');
  await page.locator('.canvas-area canvas.live').waitFor();
  await expect(page.getByRole('button', { name: 'Pen', exact: true })).toHaveAttribute('title', 'Pen (P)');
});
