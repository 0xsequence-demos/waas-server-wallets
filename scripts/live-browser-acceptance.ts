import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { chromium, expect } from '@playwright/test';

// Run after test:live has created the dedicated acceptance wallet. No API fixtures.
assert(process.env.ADMIN_PASSWORD, 'Set ADMIN_PASSWORD in .env.');
const origin = 'https://oms-server-wallet-dashboard.0xsequence.workers.dev';
const identifier = process.env.LIVE_WALLET_IDENTIFIER ?? 'acceptance-2026-09-17';
assert.match(identifier, /^acceptance-[a-zA-Z0-9-]+$/);
const browser = await chromium.launch({
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
});
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const errors: string[] = [];
page.on('pageerror', (error) => errors.push(error.name));
try {
  await page.goto(origin);
  await page.getByLabel('Password', { exact: true }).fill(process.env.ADMIN_PASSWORD);
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Your wallet workspace' })).toBeVisible();
  await page
    .getByRole('link', { name: new RegExp(`Live acceptance wallet.*${identifier}`) })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Live acceptance wallet', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Sign message', exact: true }).click();
  await page
    .getByLabel('Message', { exact: true })
    .fill(`OMS live browser acceptance: ${identifier}`);
  await page.getByRole('dialog').getByRole('button', { name: 'Sign message', exact: true }).click();
  await expect(page.getByLabel('Verified signature')).toHaveValue(/^0x[0-9a-f]+$/i, {
    timeout: 60_000,
  });
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('button', { name: '↻ Refresh', exact: true })).toBeEnabled({
    timeout: 60_000,
  });
  assert.deepEqual(errors, []);
  mkdirSync('test-results', { recursive: true });
  await page.screenshot({ path: 'test-results/live-dashboard.png', fullPage: true });
  console.log(
    JSON.stringify({
      passed:
        'hosted browser login, wallet detail, live signing, verified signature; no page errors',
    }),
  );
} finally {
  await context.request
    .post(`${origin}/api/logout`, { headers: { Origin: origin }, data: {} })
    .catch(() => undefined);
  await browser.close();
}
