import { test, expect, type Page } from '@playwright/test';

async function fixture(page: Page, authenticated = true) {
  let expireOnRead = false;
  const wallets = ['one', 'two'].map((number) => ({
    id: `wallet-${number}`,
    identifier: `customer-${number}`,
    name: `Wallet ${number}`,
    createdAt: '2026-09-17T00:00:00Z',
    snapshot: {
      wallet: { id: `remote-${number}`, address: '0x1111111111111111111111111111111111111111' },
      disabled: false,
      creationUncertain: false,
    },
  }));
  await page.context().route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, '');
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === '/session') return reply({ authenticated });
    if (path === '/login' || path === '/logout') {
      authenticated = path === '/login';
      return reply({ ok: true });
    }
    if (expireOnRead && path === '/wallets/wallet-two') {
      authenticated = false;
      expireOnRead = false;
    }
    if (!authenticated) return reply({ message: 'Sign in to continue.' }, 401);
    if (path === '/config')
      return reply({ missing: [], chains: [{ id: 137, name: 'Polygon', symbol: 'POL' }] });
    if (path === '/wallets') return reply({ wallets, nextOffset: null });
    if (path.endsWith('/swaps')) return reply({ swaps: [], nextOffset: null });
    if (path.endsWith('/operations')) return reply({ operations: [] });
    if (path.endsWith('/balances'))
      return reply({ items: [], errors: [], fetchedAt: '2026-09-17T00:00:00Z' });
    const wallet = wallets.find((wallet) => path === `/wallets/${wallet.id}`);
    return wallet ? reply(wallet) : reply({ message: 'Wallet not found.' }, 404);
  });
  return {
    expireOnNextWalletRead: () => {
      expireOnRead = true;
    },
  };
}

test('wallet pages follow Back and Forward without duplicate list entries', async ({ page }) => {
  await fixture(page);
  await page.goto('/');
  await page.getByRole('row').filter({ hasText: 'Wallet one' }).getByRole('cell').last().click();
  await expect(page).toHaveURL(/\/wallets\/wallet-one$/);
  await expect(page.getByRole('heading', { name: 'Wallet one' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Your wallet workspace' })).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: 'Wallet one' })).toBeVisible();

  await page.getByRole('link', { name: 'All wallets' }).click();
  await page.getByRole('link', { name: 'Wallets', exact: false }).first().click();
  await page.getByRole('button', { name: 'Create wallet', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Wallet one' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.goForward();
  await page.getByRole('link', { name: /Wallet two/ }).click();
  await expect(page).toHaveURL(/\/wallets\/wallet-two$/);
  await page.goBack();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Wallet one' })).toBeVisible();
});

test('a direct wallet URL survives login, reload, and session expiry', async ({ page }) => {
  const session = await fixture(page, false);
  await page.goto('/wallets/wallet-two');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await expect(page).toHaveURL(/\/wallets\/wallet-two$/);
  await expect(page.getByRole('heading', { name: 'Wallet two' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Wallet two' })).toBeVisible();
  await expect(page.getByRole('button', { name: '↻ Refresh', exact: true })).toBeEnabled();
  session.expireOnNextWalletRead();
  await page.getByRole('button', { name: 'Refresh', exact: false }).click();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Wallet two' })).toBeVisible();
  await expect(page).toHaveURL(/\/wallets\/wallet-two$/);
});

test('wallet links can open in a new tab', async ({ page, context }) => {
  await fixture(page);
  await page.goto('/');
  const link = page.getByRole('link', { name: /Wallet one/ });
  await expect(link).toHaveAttribute('href', '/wallets/wallet-one');
  const [opened] = await Promise.all([
    context.waitForEvent('page'),
    link.click({ button: 'middle' }),
  ]);
  // Middle-click opens a background tab. Activate it and await its document,
  // rather than starting the UI assertion as soon as its URL is assigned.
  await opened.bringToFront();
  await opened.waitForURL(/\/wallets\/wallet-one$/, { waitUntil: 'domcontentloaded' });
  await expect(opened).toHaveURL(/\/wallets\/wallet-one$/);
  await expect(opened.getByRole('heading', { name: 'Wallet one' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Your wallet workspace' })).toBeVisible();
  await opened.close();
});

test('unknown paths and missing wallets have a route back to the list', async ({ page }) => {
  await fixture(page);
  await page.goto('/unknown-page');
  await expect(page.getByRole('heading', { name: 'Page not found' })).toBeVisible();
  await page.getByRole('link', { name: 'All wallets' }).click();
  await expect(page.getByRole('heading', { name: 'Your wallet workspace' })).toBeVisible();
  await page.goto('/wallets/missing-wallet');
  await expect(page.getByRole('heading', { name: 'Wallet unavailable' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveText('Wallet not found.');
  await page.getByRole('link', { name: 'All wallets' }).click();
  await expect(page.getByRole('heading', { name: 'Your wallet workspace' })).toBeVisible();
});
