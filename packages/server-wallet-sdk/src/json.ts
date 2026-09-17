import { WalletError } from './errors.js';

/** Canonical JSON for authorization digests; never round a monetary integer. */
export function canonicalJson(value: unknown, maxBytes = 262_144): string {
  let nodes = 0;
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 24) throw new Error('JSON complexity');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return value.toString();
    if (typeof value === 'number') {
      if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value)))
        throw new Error('Unsafe number');
      return value;
    }
    if (Array.isArray(value)) return value.map((entry) => visit(entry, depth + 1));
    if (typeof value !== 'object' || !value || Object.getPrototypeOf(value) !== Object.prototype)
      throw new Error('Expected JSON object');
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, entry]) => {
          if (['__proto__', 'constructor', 'prototype'].includes(key))
            throw new Error('Reserved key');
          return [key, visit(entry, depth + 1)];
        }),
    );
  };
  try {
    const json = JSON.stringify(visit(value, 0));
    if (new TextEncoder().encode(json).length > maxBytes) throw new Error('JSON size');
    return json;
  } catch {
    throw new WalletError('INVALID_JSON', 'Expected bounded JSON with lossless numeric values.');
  }
}
