import { test as base, expect } from '@playwright/test';

// Prevent test bytes or credentials from ever reaching an external provider.
// Aborted provider traffic is NOT counted as provider interoperability evidence.
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === 'http://127.0.0.1:8080' ? route.continue() : route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    await use(context);
  },
  page: async ({ page }, use) => {
    const failures = [];
    page.on('pageerror', error => failures.push(error.message));
    await use(page);
    expect(failures, 'uncaught browser JavaScript errors').toEqual([]);
  },
});
export { expect };

export async function harness(page) {
  await page.goto('/tests/browser/harness.html');
  return page;
}

export async function selectJourney(page, name) {
  await page.locator(`#operatorJourneyNav button[aria-controls="${name}Panel"]`).click();
  await expect(page.locator(`#${name}Panel`)).toBeVisible();
}
