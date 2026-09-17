import { describe, expect, it } from 'vitest';
import {
  credentialId,
  generateCredential,
  signatureHeader,
} from '../packages/server-wallet-sdk/src/protocol.js';
import { WaasTransport, boundedText } from '../packages/server-wallet-sdk/src/transport.js';
import { IndexerClient } from '@oms/server-wallet-sdk';
import { formatAmount, toUnits } from '../apps/dashboard/src/amount.js';
import { omsFetch } from '../apps/server/oms-fetch.js';

const requestOrigin = 'https://oms-server-wallet-dashboard.0xsequence.workers.dev';

describe('WaaS request protocol', () => {
  it('derives the WaaS credential hash from the typed compressed P-256 key', async () => {
    // P-256 generator point; expected hash independently computed with Node/OpenSSL.
    const publicKey =
      '0x046b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c2964fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5';
    expect(await credentialId(publicKey)).toBe(
      '0x8a39ba49dea5b8ba1c59639a9de05f60a0728ef27218003a2495ad39da62d8d0',
    );
    await expect(credentialId('0x1234')).rejects.toThrow('Invalid P-256');
  });
  it('signs the exact v1.1.0 request preimage with a verifiable P-256 credential', async () => {
    const credential = await generateCredential();
    credential.nonce = '1700000000001';
    const body = '{"network":"137","walletId":"wallet-1","message":"hello"}';
    const header = await signatureHeader(credential, '/v1/Waas/SignMessage', 'prj_test', body);
    expect(header).toContain('alg="ecdsa-p256-sha256", scope="prj_test"');
    expect(header).toContain('nonce=1700000000001');
    expect(header).toContain(`cred="${credential.id}"`);
    expect(credential.credentialId).toMatch(/^0x[0-9a-f]{64}$/);
    const sig = /sig="0x([0-9a-f]+)"/.exec(header)![1];
    const bytes = Uint8Array.from(sig.match(/../g)!, (hex) => Number.parseInt(hex, 16));
    const publicJwk = { ...credential.privateJwk };
    delete publicJwk.d;
    publicJwk.key_ops = ['verify'];
    const publicKey = await crypto.subtle.importKey(
      'jwk',
      publicJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['verify'],
    );
    const expected = 'POST /v1/Waas/SignMessage\nnonce: 1700000000001\nscope: prj_test\n\n' + body;
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        bytes,
        new TextEncoder().encode(expected),
      ),
    ).toBe(true);
    expect(
      await crypto.subtle.verify(
        { name: 'ECDSA', hash: 'SHA-256' },
        publicKey,
        bytes,
        new TextEncoder().encode(expected.replace('137', '1')),
      ),
    ).toBe(false);
  });
  it('includes the project key and signature and fails closed when attestation is missing', async () => {
    let requestHeaders: Headers | undefined;
    const fetcher: typeof fetch = async (_url, init) => {
      requestHeaders = new Headers(init?.headers);
      return Response.json({ signature: '0x1234' });
    };
    const client = new WaasTransport(
      'pk_dev_live_test_key',
      ['0'.repeat(96)],
      omsFetch(`${requestOrigin}/`, fetcher),
    );
    const credential = await generateCredential();
    credential.nonce = '1';
    await expect(client.request('SignMessage', {}, credential)).rejects.toMatchObject({
      code: 'ATTESTATION_FAILED',
    });
    expect(requestHeaders?.get('Api-Key')).toBe('pk_dev_live_test_key');
    expect(requestHeaders?.get('Origin')).toBe(requestOrigin);
    expect(requestHeaders?.get('OMS-Wallet-Signature')).toContain('scope="prj_test"');
    expect(requestHeaders?.get('X-Attestation-Nonce')).toHaveLength(24);
    expect(() => new WaasTransport('pk_live_test_key', ['0'.repeat(96)])).toThrow('Debug enclaves');
  });
  it('bounds responses while streaming', async () => {
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(30));
        controller.enqueue(new Uint8Array(30));
        controller.close();
      },
    });
    await expect(boundedText(new Response(stream), 50)).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    });
  });
});
describe('indexer gateway', () => {
  it('maps exact balances and metadata, reports network errors, and paginates', async () => {
    const address = '0x1111111111111111111111111111111111111111';
    let sent: Record<string, unknown> = {};
    let requestHeaders: Headers | undefined;
    const client = new IndexerClient(
      'pk_dev_live_test_key',
      omsFetch(`${requestOrigin}/`, async (_url, init) => {
        requestHeaders = new Headers(init?.headers);
        sent = JSON.parse(String(init?.body));
        return Response.json({
          nativeBalances: [
            {
              chainId: 137,
              results: [
                {
                  chainId: 137,
                  accountAddress: address,
                  balanceWei: '1000000000000000001',
                  name: 'Polygon',
                  symbol: 'POL',
                },
              ],
            },
            { chainId: 1, errorReason: 'Indexer unavailable' },
          ],
          balances: [
            {
              chainId: 137,
              results: [
                {
                  chainId: 137,
                  accountAddress: address,
                  contractAddress: '0x2222222222222222222222222222222222222222',
                  contractType: 'ERC20',
                  balance: '1234567890123456789012345',
                  contractInfo: { name: 'USD Coin', symbol: 'USDC', decimals: 6 },
                },
              ],
            },
          ],
          page: { page: 0, pageSize: 40, more: true },
        });
      }),
    );
    const result = await client.getBalances(address);
    expect(requestHeaders?.get('Origin')).toBe(requestOrigin);
    expect(requestHeaders?.get('Api-Key')).toBe('pk_dev_live_test_key');
    expect(result.items[0].balance).toBe('1000000000000000001');
    expect(result.items[1].decimals).toBe(6);
    expect(result.errors.find((e) => e.chainId === 1)?.message).toBe('Indexer unavailable');
    expect(result.nextPage).toBe(1);
    expect(sent.chainIds).toEqual([137, 42161, 8453, 56, 1]);
  });
  it('rejects balances belonging to another wallet', async () => {
    const client = new IndexerClient('pk_dev_live_test_key', async () =>
      Response.json({
        nativeBalances: [
          {
            chainId: 137,
            results: [
              {
                chainId: 137,
                accountAddress: '0x2222222222222222222222222222222222222222',
                balance: '0',
              },
            ],
          },
        ],
        balances: [],
      }),
    );
    await expect(
      client.getBalances('0x1111111111111111111111111111111111111111'),
    ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
  });
});
describe('dashboard amounts', () => {
  it('formats and parses balances without losing precision', () => {
    expect(formatAmount('1000000000000000001', 18)).toBe('1.000000000000000001');
    expect(toUnits('1.000000000000000001', 18)).toBe('1000000000000000001');
    expect(formatAmount('123', 0)).toBe('123');
    expect(formatAmount('123')).toBe('123 base units');
    expect(() => toUnits('1.2345678', 6)).toThrow();
    expect(() => toUnits('0', 18)).toThrow();
  });
});
