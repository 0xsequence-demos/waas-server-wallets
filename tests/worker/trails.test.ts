import { expect, it } from 'vitest';
import { TrailsClient } from '@polygonlabs/oms-server-wallet-sdk/trails';
import { validateSwapQuote } from '../../packages/server-wallet-sdk/src/trails/quote.js';
import { validateRecoveryPayload } from '../../packages/server-wallet-sdk/src/trails/recovery.js';
import {
  contractsSchema,
  intentSchema,
} from '../../packages/server-wallet-sdk/src/trails/protocol.js';
import {
  contracts,
  now,
  owner,
  quoteFixture,
  recoveryCall,
  recoveryFixture,
  token,
} from '../fixtures/trails.js';

it('runs direct Trails fetch, bounded parsing, quote hashing and Sequence codecs in workerd', async () => {
  const { intent, request } = quoteFixture();
  const client = new TrailsClient({
    apiKey: 'test-key',
    origin: 'https://issuer.example',
    fetch: async (url, init) => {
      const req = new Request(url, init);
      expect(req.redirect).toBe('manual');
      expect(req.headers.get('X-Access-Key')).toBe('test-key');
      expect(req.headers.get('Origin')).toBe('https://issuer.example');
      return Response.json({ intent });
    },
  });
  const result = await client.quoteIntent(request);
  expect(
    (await validateSwapQuote(result.intent, request, contractsSchema.parse(contracts), now)).funding
      .amount,
  ).toBe('10000000');
  for (const calls of [
    [recoveryCall()],
    [recoveryCall({ to: owner, data: '0x', value: '1000' })],
  ]) {
    const prepared = recoveryFixture(calls);
    expect(
      validateRecoveryPayload(prepared, intentSchema.parse(intent), owner, [
        { asset: token, amount: '1000' },
        { asset: 'native', amount: '1000' },
      ]).digest,
    ).toBe(prepared.payloadHash);
  }
});
