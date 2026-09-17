import { test, expect } from '@playwright/test';
import type { Operation } from '@oms/server-wallet-sdk';

test('admin creates a wallet, reviews a sponsored transfer, and signs a message', async ({
  page,
}) => {
  let authenticated = false;
  let created = false;
  const ops: Operation[] = [];
  let submitted = 0;
  const snapshot = {
    wallet: { id: 'remote-1', address: '0x1111111111111111111111111111111111111111' },
    credentialId: 'public-key',
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    disabled: false,
    creationUncertain: false,
  };
  const wallet = {
    id: 'local-1',
    identifier: 'customer-1',
    name: 'Customer treasury',
    createdAt: new Date().toISOString(),
    snapshot,
  };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname.replace('/api', '');
    const method = route.request().method();
    const reply = (body: unknown) => route.fulfill({ json: body });
    if (path === '/session') return reply({ authenticated });
    if (path === '/login') {
      authenticated = true;
      return reply({ ok: true });
    }
    if (!authenticated) return route.fulfill({ status: 401, json: { message: 'Sign in' } });
    if (path === '/config')
      return reply({
        missing: [],
        chains: [{ id: 137, name: 'Polygon', symbol: 'POL', explorer: 'https://polygonscan.com' }],
        issuer: 'https://issuer.example',
        audience: 'oms-server-wallet',
        waasVersion: '1.1.0',
      });
    if (path === '/wallets' && method === 'GET')
      return reply({ wallets: created ? [wallet] : [], nextOffset: null });
    if (path === '/wallets' && method === 'POST') {
      created = true;
      return reply(wallet);
    }
    if (path === '/wallets/local-1') return reply(wallet);
    if (path.endsWith('/balances'))
      return reply({
        items: [
          {
            chainId: 137,
            asset: 'native',
            name: 'Polygon',
            symbol: 'POL',
            balance: '5000000000000000000',
            decimals: 18,
          },
        ],
        errors: [],
        fetchedAt: new Date().toISOString(),
      });
    if (path.endsWith('/transfers')) {
      const body = route.request().postDataJSON() as { id: string; amount: string };
      expect(body.amount).toBe('1000000000000000001');
      const op: Operation = {
        id: body.id,
        kind: 'transfer',
        inputHash: 'fixture',
        createdAt: new Date().toISOString(),
        chainId: 137,
        status: 'quoted',
        quote: {
          txnId: 'txn-1',
          sponsored: true,
          status: 'quoted',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      };
      ops.unshift(op);
      return reply({ operation: op, snapshot });
    }
    if (path.endsWith('/execute')) {
      submitted++;
      ops[0].status = 'executed';
      return reply({ operation: ops[0], snapshot });
    }
    if (path.endsWith('/sign')) {
      const body = route.request().postDataJSON() as { id: string; message: string };
      expect(body.message).toBe('Hello OMS');
      const op: Operation = {
        id: body.id,
        kind: 'sign',
        inputHash: 'fixture',
        createdAt: new Date().toISOString(),
        chainId: 137,
        status: 'signed',
        signature: '0x1234',
        verified: true,
      };
      ops.unshift(op);
      return reply({ operation: op, snapshot });
    }
    if (path.endsWith('/operations')) return reply({ operations: ops });
    return route.fulfill({ status: 404, json: { message: 'Unknown fixture route' } });
  });
  await page.goto('/');
  await page.getByLabel('Password', { exact: true }).fill('fixture-password');
  await page.getByRole('button', { name: 'Open dashboard' }).click();
  await expect(page.getByRole('heading', { name: 'Your wallet workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'Create wallet', exact: false }).click();
  await page.getByLabel('Display name').fill('Customer treasury');
  await page.getByLabel('Application identifier').fill('customer-1');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create wallet', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Customer treasury' })).toBeVisible();
  await page.getByRole('button', { name: 'Send transfer' }).click();
  await page.getByLabel('Recipient address').fill('0x2222222222222222222222222222222222222222');
  await page.getByRole('textbox', { name: /^Amount/ }).fill('1.000000000000000001');
  await page.getByRole('button', { name: 'Review transfer' }).click();
  await expect(page.getByRole('dialog').getByText('sponsored', { exact: true })).toBeVisible();
  expect(submitted).toBe(0);
  await page.getByRole('button', { name: 'Confirm & send' }).click();
  await expect(page.getByText('executed', { exact: true })).toBeVisible();
  expect(submitted).toBe(1);
  await page.getByRole('button', { name: 'Sign message', exact: true }).click();
  await page.getByLabel('Message', { exact: true }).fill('Hello OMS');
  await page.getByRole('dialog').getByRole('button', { name: 'Sign message', exact: true }).click();
  await expect(page.getByLabel('Verified signature')).toHaveValue('0x1234');
  await page.getByRole('dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await page.screenshot({ path: 'test-results/dashboard.png', fullPage: true });
});

test('shows setup requirements instead of allowing unconfigured wallet creation', async ({
  page,
}) => {
  await page.route('**/api/**', (route) => {
    const path = new URL(route.request().url()).pathname;
    return route.fulfill({
      json: path.endsWith('/session')
        ? { authenticated: true }
        : path.endsWith('/config')
          ? { missing: ['OMS_PUBLISHABLE_KEY', 'OIDC_ISSUER'], chains: [] }
          : { wallets: [], nextOffset: null },
    });
  });
  await page.goto('/');
  await expect(page.getByText('Connect your OMS environment')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Create wallet' })).toBeDisabled();
});
