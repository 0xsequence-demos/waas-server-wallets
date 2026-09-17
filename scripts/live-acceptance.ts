import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Balances, Operation, WalletSnapshot } from '@oms/server-wallet-sdk';

// Explicit opt-in command. Uses a dedicated identity and the deployed application's API.
const origin = 'https://oms-server-wallet-dashboard.0xsequence.workers.dev';
const identifier = process.env.LIVE_WALLET_IDENTIFIER ?? 'acceptance-2026-09-17';
assert.match(identifier, /^acceptance-[a-zA-Z0-9-]+$/);
assert(process.env.ADMIN_PASSWORD, 'Set ADMIN_PASSWORD in .env.');
interface Wallet {
  id: string;
  identifier: string;
  snapshot: WalletSnapshot;
}
interface Result {
  snapshot: WalletSnapshot;
  operation?: Operation;
}
const report: {
  checkedAt: string;
  origin: string;
  identifier: string;
  wallet?: Wallet;
  checks: { name: string; details?: unknown }[];
  error?: string;
} = {
  checkedAt: new Date().toISOString(),
  origin,
  identifier,
  checks: [],
};
mkdirSync('.data', { recursive: true });
const save = () => writeFileSync('.data/live-acceptance.json', JSON.stringify(report, null, 2));
function passed(name: string, details?: unknown) {
  report.checks.push({ name, details });
  save();
  console.log(JSON.stringify({ passed: name, ...(details === undefined ? {} : { details }) }));
}
let cookie = '';
async function request(path: string, body?: unknown) {
  return fetch(`${origin}/api${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: origin,
      'Content-Type': 'application/json',
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(120_000),
  });
}
async function api<T>(path: string, body?: unknown): Promise<T> {
  const response = await request(path, body);
  const result = (await response.json()) as T & { error?: string; message?: string };
  if (!response.ok)
    throw new Error(
      `${path}: HTTP ${response.status} ${result.error ?? ''} ${result.message ?? ''}`,
    );
  return result;
}
try {
  const login = await request('/login', { password: process.env.ADMIN_PASSWORD });
  assert.equal(login.status, 200, 'Administrator login failed.');
  cookie = login.headers.get('set-cookie')!.split(';')[0];
  const config = await api<{ missing: string[]; audience: string; issuer: string }>('/config');
  assert.deepEqual(config.missing, []);
  assert.equal(config.audience, 'api.dev.polygon-dev.technology');
  assert.equal(config.issuer, origin);
  passed('deployed configuration and administrator login');

  const wallet = await api<Wallet>('/wallets', { identifier, name: 'Live acceptance wallet' });
  assert(wallet.snapshot.wallet?.address);
  report.wallet = wallet;
  passed('OIDC authentication and wallet create/restore', {
    id: wallet.id,
    address: wallet.snapshot.wallet.address,
  });
  const root = `/wallets/${wallet.id}`;
  if (wallet.snapshot.disabled) await api(`${root}/enable`, {});
  const duplicate = await api<Wallet>('/wallets', { identifier, name: 'Live acceptance wallet' });
  assert.equal(duplicate.id, wallet.id);
  assert.equal(duplicate.snapshot.wallet?.address, wallet.snapshot.wallet.address);
  passed('identifier reuse preserves wallet');

  const balances = await api<Balances>(`${root}/balances`);
  assert.deepEqual(balances.errors, []);
  assert.deepEqual(
    balances.items
      .filter((item) => item.asset === 'native')
      .map((item) => item.chainId)
      .sort((a, b) => a - b),
    [1, 56, 137, 8453, 42161],
  );
  passed('indexer balance response', {
    items: balances.items,
    errors: balances.errors,
    nextPage: balances.nextPage,
  });
  const signId = crypto.randomUUID();
  const signBody = {
    id: signId,
    chainId: 137,
    message: `OMS server wallet acceptance: ${identifier}`,
  };
  const signed = await api<Result>(`${root}/sign`, signBody);
  assert.equal(signed.operation?.status, 'signed');
  assert.equal(signed.operation.verified, true);
  const retry = await api<Result>(`${root}/sign`, signBody);
  assert.equal(retry.operation?.signature, signed.operation.signature);
  passed('plain message signature verified and idempotent');
  for (const chainId of [1, 56, 8453, 42161]) {
    const result = await api<Result>(`${root}/sign`, {
      ...signBody,
      id: crypto.randomUUID(),
      chainId,
    });
    assert.equal(result.operation?.verified, true);
    passed('message signature verified', { chainId });
  }

  const before = (await api<Wallet>(root)).snapshot;
  const rotated = await api<Result>(`${root}/rotate`, {});
  assert.notEqual(rotated.snapshot.credentialId, before.credentialId);
  assert.equal(rotated.snapshot.wallet?.address, before.wallet?.address);
  passed('credential rotation preserves wallet');
  const disabled = await api<Result>(`${root}/disable`, {});
  assert.equal(disabled.snapshot.disabled, true);
  assert.equal(
    (await request(`${root}/sign`, { ...signBody, id: crypto.randomUUID() })).status,
    409,
  );
  const enabled = await api<Result>(`${root}/enable`, {});
  assert.equal(enabled.snapshot.disabled, false);
  assert.equal(enabled.snapshot.wallet?.address, before.wallet?.address);
  passed('disable blocks signing; re-enable restores same wallet');
  const finalSign = await api<Result>(`${root}/sign`, { ...signBody, id: crypto.randomUUID() });
  assert.equal(finalSign.operation?.verified, true);
  passed('signing succeeds after reauthentication');

  const activity = await api<{ operations: Operation[] }>(`${root}/operations`);
  assert(activity.operations.some((op) => op.id === signId && op.status === 'signed'));
  passed('persistent operation history');
  const native = balances.items.find((item) => item.chainId === 137 && item.asset === 'native');
  passed('transfer funding check', {
    address: wallet.snapshot.wallet.address,
    polygonWei: native?.balance ?? 'unavailable',
    execution: 'not submitted',
  });
  if (process.env.LIVE_PREPARE_SELF_TRANSFER === '1') {
    const transferId = crypto.randomUUID();
    const prepared = await api<Result>(`${root}/transfers`, {
      id: transferId,
      chainId: 137,
      to: wallet.snapshot.wallet.address,
      asset: 'native',
      amount: '1',
    });
    assert.equal(prepared.operation?.status, 'quoted');
    assert.equal(prepared.operation.quote?.sponsored, true);
    passed('sponsored Polygon self-transfer prepared', {
      id: transferId,
      quote: prepared.operation.quote,
      execution: 'not submitted',
    });
    if (process.env.LIVE_EXECUTE_SELF_TRANSFER === '1') {
      assert(
        BigInt(native?.balance ?? '0') >= 1n,
        'Fund the dedicated test wallet before execution.',
      );
      let result = await api<Result>(`${root}/operations/${transferId}/execute`, {});
      for (
        let attempt = 0;
        attempt < 20 && ['pending', 'unknown'].includes(result.operation?.status ?? '');
        attempt++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        result = await api<Result>(`${root}/operations/${transferId}`);
      }
      assert.equal(result.operation?.status, 'executed');
      passed('sponsored Polygon self-transfer executed', {
        id: transferId,
        txnHash: result.operation.txnHash,
      });
    }
  }
  console.log('API acceptance completed.');
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Unknown acceptance failure';
  save();
  console.error(report.error);
  process.exitCode = 1;
} finally {
  if (cookie) await request('/logout', {}).catch(() => undefined);
}
