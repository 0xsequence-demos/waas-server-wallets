import { test, expect, type Page } from '@playwright/test';
import type { SwapView } from '@polygonlabs/oms-server-wallet-sdk/trails';

const owner = '0x1111111111111111111111111111111111111111';
const usdc = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913';
const chains = [
  { id: 137, name: 'Polygon', symbol: 'POL', explorer: 'https://polygonscan.com' },
  { id: 8453, name: 'Base', symbol: 'ETH', explorer: 'https://basescan.org' },
];
const assets = [
  { chainId: 137, asset: 'native', decimals: 18, symbol: 'POL', name: 'Polygon' },
  { chainId: 8453, asset: usdc, decimals: 6, symbol: 'USDC', name: 'USDC' },
  { chainId: 8453, asset: 'native', decimals: 18, symbol: 'ETH', name: 'Ether' },
];
async function fixture(page: Page, authenticated = true) {
  const wallet = {
    id: 'wallet-one',
    identifier: 'customer-1',
    name: 'Treasury',
    createdAt: new Date().toISOString(),
    snapshot: {
      wallet: { id: 'remote', address: owner },
      disabled: false,
      creationUncertain: false,
    },
  };
  let swap: SwapView | undefined;
  const count = {
    quotes: 0,
    confirms: 0,
    recoveries: 0,
    expire: false,
    unavailable: false,
    sessionExpired: false,
    progress: false,
  };
  await page.context().route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api', '');
    const method = route.request().method();
    const reply = (json: unknown, status = 200) => route.fulfill({ json, status });
    if (path === '/session') return reply({ authenticated });
    if (path === '/login') {
      authenticated = true;
      return reply({ ok: true });
    }
    if (count.sessionExpired) {
      authenticated = false;
      count.sessionExpired = false;
    }
    if (!authenticated) return reply({ message: 'Sign in to continue.' }, 401);
    if (path === '/config') return reply({ missing: [], chains });
    if (path === '/swaps/config')
      return reply({
        enabled: true,
        ready: true,
        assets,
        chains,
        slippageBps: [10, 50, 100],
        feePolicy: 'Route fees apply.',
      });
    if (path === '/wallets') return reply({ wallets: [wallet], nextOffset: null });
    if (path === '/wallets/wallet-one') return reply(wallet);
    if (path.endsWith('/balances'))
      return reply({
        items: [
          {
            chainId: 137,
            asset: 'native',
            symbol: 'POL',
            decimals: 18,
            balance: '5000000000000000000',
            balanceUSD: '2.50',
          },
        ],
        errors: [],
        fetchedAt: new Date().toISOString(),
      });
    if (path.endsWith('/operations')) return reply({ operations: [] });
    if (path === '/wallets/wallet-one/swaps' && method === 'GET')
      return reply({ swaps: swap ? [swap] : [], nextOffset: null });
    if (path === '/wallets/wallet-one/swaps' && method === 'POST') {
      count.quotes++;
      if (count.unavailable)
        return reply({ message: 'No route is currently available for these assets.' }, 409);
      const { id, ...request } = route.request().postDataJSON();
      expect(request).not.toHaveProperty('owner');
      expect(request).not.toHaveProperty('destinationToAddress');
      expect(request.amount).toBe('1000000000000000001');
      swap = {
        id,
        version: 1,
        owner,
        request,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        phase: 'quoted',
        nextAt: null,
        quote: {
          revision: 'q'.repeat(43),
          expiresAt: new Date(Date.now() + 300000).toISOString(),
          intentId: `0x${'ab'.repeat(32)}`,
          inputAmount: request.amount,
          expectedOutput: '480000',
          minimumOutput: '477600',
          providers: ['CCTP'],
          priceImpact: 0.1,
          fees: { totalUsd: 0.01, gasUsd: 0.005, trailsUsd: 0.003, providerUsd: 0.002 },
        },
        transactions: [],
        recoveries: [],
        canRecover: false,
      };
      return reply({ swap });
    }
    if (swap && path === `/wallets/wallet-one/swaps/${swap.id}`) {
      if (count.expire) {
        swap.phase = 'expired';
        swap.version++;
      }
      if (count.progress && swap.confirmedAt) {
        swap.phase = 'succeeded';
        swap.version++;
        swap.nextAt = null;
        swap.outputAmount = '480000';
        swap.canRecover = true;
      }
      return reply({ swap });
    }
    if (swap && path === `/wallets/wallet-one/swaps/${swap.id}/confirm`) {
      count.confirms++;
      expect(route.request().postDataJSON()).toEqual({ revision: swap.quote.revision });
      swap.phase = 'funding';
      swap.version++;
      swap.confirmedAt = new Date().toISOString();
      swap.nextAt = Date.now() + 5000;
      swap.funding = {
        status: 'pending',
        chainId: 137,
        sponsored: true,
        hash: `0x${'12'.repeat(32)}`,
      };
      return reply({ swap }, 202);
    }
    if (swap && path.endsWith('/recoveries')) {
      const { id, source } = route.request().postDataJSON();
      swap.version++;
      swap.recoveries.push({
        id,
        source,
        chainId: 8453,
        intentAddress: `0x${'33'.repeat(20)}`,
        revision: 'r'.repeat(43),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
        assets: [{ asset: usdc, amount: '450000', symbol: 'USDC', decimals: 6 }],
        requiresOwnerDeployment: true,
        status: 'quoted',
      });
      return reply({ swap });
    }
    if (swap && /\/recoveries\/[^/]+\/confirm$/.test(path)) {
      count.recoveries++;
      swap.version++;
      swap.phase = 'refunded';
      swap.canRecover = false;
      swap.recoveries[0].status = 'recovered';
      swap.recoveries[0].transaction = {
        status: 'executed',
        chainId: 8453,
        sponsored: true,
        hash: `0x${'34'.repeat(32)}`,
      };
      return reply({ swap }, 202);
    }
    if (swap && path.endsWith('/reconcile')) return reply({ swap }, 202);
    return reply({ message: 'Unknown fixture route' }, 404);
  });
  return {
    count,
    get swap() {
      return swap;
    },
  };
}
async function review(page: Page) {
  await page.goto('/wallets/wallet-one');
  await page.getByRole('button', { name: 'Swap assets' }).click();
  await page.getByLabel('Amount to spend').fill('1.000000000000000001');
  await page.getByRole('button', { name: 'Review quote' }).click();
  await expect(page.getByRole('heading', { name: 'Swap details' })).toBeVisible();
}

test('reviews precise amounts, confirms once and resumes progress after reload and browser navigation', async ({
  page,
}) => {
  const f = await fixture(page);
  await review(page);
  await expect(page.getByText('0.10%', { exact: true })).toBeVisible();
  const url = page.url();
  expect(f.count.quotes).toBe(1);
  await expect(page.getByText('1.000000000000000001 POL', { exact: true })).toBeVisible();
  await expect(page.getByText('0.4776 USDC', { exact: true })).toBeVisible();
  await expect(page.getByText(owner, { exact: true })).toBeVisible();
  await expect(page.getByText('Sponsored', { exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Swap assets' })).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(url);
  await page.reload();
  await page.getByRole('button', { name: 'Confirm swap' }).dblclick();
  expect(f.count.confirms).toBe(1);
  await expect(page.getByRole('heading', { name: 'Funding in progress' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Wallet funding on Polygon' })).toHaveAttribute(
    'href',
    `https://polygonscan.com/tx/0x${'12'.repeat(32)}`,
  );
  f.count.progress = true;
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Completed', exact: true })).toBeVisible();
  expect(f.count.confirms).toBe(1);
  await page.screenshot({ path: 'test-results/swap-completed.png', fullPage: true });
  await page.getByRole('link', { name: 'Treasury', exact: false }).first().click();
  await expect(page.getByRole('link', { name: /Polygon → Base/ })).toBeVisible();
});
test('shows unavailable routes and invalidates an expired review', async ({ page }) => {
  const f = await fixture(page);
  f.count.unavailable = true;
  await page.goto('/wallets/wallet-one/swap');
  await page.getByLabel('Amount to spend').fill('1.000000000000000001');
  await page.getByRole('button', { name: 'Review quote' }).click();
  await expect(page.getByRole('alert')).toContainText('No route');
  f.count.unavailable = false;
  await page.getByRole('button', { name: 'Review quote' }).click();
  await expect(page.getByRole('heading', { name: 'Swap details' })).toBeVisible();
  f.count.expire = true;
  await page.reload();
  await expect(page.getByRole('link', { name: 'Get a new quote' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Confirm swap' })).toHaveCount(0);
  expect(f.count.confirms).toBe(0);
});
test('reviews actual destination recovery and its owner activation step before separate authorization', async ({
  page,
}) => {
  const f = await fixture(page);
  await review(page);
  await page.getByRole('button', { name: 'Confirm swap' }).click();
  f.swap!.phase = 'attention';
  f.swap!.canRecover = true;
  f.swap!.version++;
  await page.reload();
  await page.getByRole('button', { name: 'Check destination funds' }).click();
  await expect(page.getByRole('heading', { name: 'Destination · Base' })).toBeVisible();
  await expect(page.getByText(/0.45 USDC/)).toBeVisible();
  await expect(page.getByText(/Confirming authorizes a sponsored activation/)).toBeVisible();
  expect(f.count.recoveries).toBe(0);
  await page.screenshot({ path: 'test-results/swap-recovery.png', fullPage: true });
  await page.getByRole('button', { name: 'Confirm recovery' }).click();
  expect(f.count.recoveries).toBe(1);
  await expect(page.getByRole('link', { name: 'Recovery on Base' })).toBeVisible();
  await page.reload();
  await expect(page.getByText('Status: recovered.', { exact: false })).toBeVisible();
});
test('keeps swap deep links through session expiry and login', async ({ page }) => {
  const f = await fixture(page);
  await review(page);
  const url = page.url();
  f.count.sessionExpired = true;
  await page.reload();
  await expect(page.getByLabel('Password', { exact: true })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('test-password');
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await expect(page).toHaveURL(url);
  await expect(page.getByRole('button', { name: 'Confirm swap' })).toBeEnabled();
});
