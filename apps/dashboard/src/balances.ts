import type { Balances } from '@polygonlabs/oms-server-wallet-sdk';
import { api } from './api';

/** Follow gateway pagination so the portfolio value includes every indexed asset. */
export async function walletBalances(id: string): Promise<Balances> {
  let result = await api<Balances>(`/wallets/${id}/balances`);
  const items = new Map(
    result.items.map((item) => [`${item.chainId}:${item.asset.toLowerCase()}`, item]),
  );
  const errors = [...result.errors];
  const seen = new Set([0]);
  while (result.nextPage !== undefined && seen.size < 100) {
    const page = result.nextPage;
    if (seen.has(page)) break;
    seen.add(page);
    try {
      const next = await api<Balances>(`/wallets/${id}/balances?page=${page}`);
      // Native balances can be repeated on every page; count each asset once.
      for (const item of next.items) items.set(`${item.chainId}:${item.asset.toLowerCase()}`, item);
      errors.push(...next.errors);
      result = next;
    } catch {
      // Keep the known balances and cursor; the displayed valuation stays partial.
      break;
    }
  }
  return { ...result, items: [...items.values()], errors };
}

/** Sum decimal USD strings exactly, rounding only when the total is displayed. */
export function balanceValue(balances: Balances): { usd: string | null; partial: boolean } {
  let sum = 0n;
  let scale = 0;
  let priced = 0;
  let partial = balances.errors.length > 0 || balances.nextPage !== undefined;
  for (const item of balances.items) {
    const usd = item.balanceUSD ?? (/^0+$/.test(item.balance) ? '0' : undefined);
    if (!usd || !/^\d+(\.\d+)?$/.test(usd) || usd.length > 256) {
      partial = true;
      continue;
    }
    const [whole, fraction = ''] = usd.split('.');
    const nextScale = Math.max(scale, fraction.length);
    sum =
      sum * 10n ** BigInt(nextScale - scale) +
      BigInt(whole + fraction) * 10n ** BigInt(nextScale - fraction.length);
    scale = nextScale;
    priced++;
  }
  if (!priced && partial) return { usd: null, partial };
  const digits = sum.toString().padStart(scale + 1, '0');
  return { usd: scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits, partial };
}

export function formatUsd(value: string): string {
  if (!/^\d+(\.\d+)?$/.test(value)) return 'Unavailable';
  const [whole, fraction = ''] = value.split('.');
  const cents =
    BigInt(whole) * 100n +
    BigInt(fraction.slice(0, 2).padEnd(2, '0')) +
    (Number(fraction[2] ?? '0') >= 5 ? 1n : 0n);
  return `$${(cents / 100n).toLocaleString('en-US')}.${(cents % 100n).toString().padStart(2, '0')}`;
}
