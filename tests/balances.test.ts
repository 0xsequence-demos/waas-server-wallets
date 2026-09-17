import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Balance, Balances } from '@oms/server-wallet-sdk';
import { balanceValue, formatUsd, walletBalances } from '../apps/dashboard/src/balances';

const asset = (balanceUSD?: string, balance = '1'): Balance => ({
  chainId: 137,
  asset: 'native',
  name: 'POL',
  symbol: 'POL',
  balance,
  decimals: 18,
  balanceUSD,
});
const balances = (items: Balance[], rest: Partial<Balances> = {}): Balances => ({
  items,
  errors: [],
  fetchedAt: new Date().toISOString(),
  ...rest,
});
afterEach(() => vi.unstubAllGlobals());

describe('multi-chain USD values', () => {
  it('preserves decimal precision and rounds only the final total', () => {
    const total = balanceValue(balances([asset('9007199254740992.004'), asset('0.004')]));
    expect(total).toEqual({ usd: '9007199254740992.008', partial: false });
    expect(formatUsd(total.usd!)).toBe('$9,007,199,254,740,992.01');
    expect(formatUsd('999.999')).toBe('$1,000.00');
  });
  it('distinguishes a known zero from missing prices and incomplete results', () => {
    expect(balanceValue(balances([asset(undefined, '0')]))).toEqual({ usd: '0', partial: false });
    expect(balanceValue(balances([asset()]))).toEqual({ usd: null, partial: true });
    expect(balanceValue(balances([asset('10'), asset('NaN')]))).toEqual({
      usd: '10',
      partial: true,
    });
    expect(balanceValue(balances([asset('10')], { nextPage: 1 }))).toEqual({
      usd: '10',
      partial: true,
    });
    expect(
      balanceValue(balances([], { errors: [{ chainId: 1, message: 'Unavailable' }] })),
    ).toEqual({ usd: null, partial: true });
  });
  it('includes subsequent pages without double-counting repeated native balances', async () => {
    const page0 = balances([asset('1.50')], { nextPage: 1 });
    const page1 = balances([
      asset('1.50'),
      { ...asset('2.75'), chainId: 8453, asset: '0x2222222222222222222222222222222222222222' },
    ]);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(Response.json(page0))
      .mockResolvedValueOnce(Response.json(page1));
    vi.stubGlobal('fetch', fetcher);
    const result = await walletBalances('wallet-1');
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      '/api/wallets/wallet-1/balances',
      '/api/wallets/wallet-1/balances?page=1',
    ]);
    expect(result.items).toHaveLength(2);
    expect(balanceValue(result)).toEqual({ usd: '4.25', partial: false });
  });
  it('marks the retained value partial if a later page fails or repeats its cursor', async () => {
    const page = balances([asset('1.50')], { nextPage: 1 });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(page))
        .mockRejectedValueOnce(new Error('Network unavailable')),
    );
    expect(balanceValue(await walletBalances('wallet-1'))).toEqual({ usd: '1.50', partial: true });
    const fetcher = vi.fn().mockImplementation(async () => Response.json(page));
    vi.stubGlobal('fetch', fetcher);
    expect(balanceValue(await walletBalances('wallet-1'))).toEqual({ usd: '1.50', partial: true });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
