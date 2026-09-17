import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import fixture from '../fixtures/attestation.json';
import { verifyAttestationDocument } from '../../packages/server-wallet-sdk/src/attestation.js';
import type { WalletCoordinator } from '../../apps/server/worker.js';
import { OidcIssuer } from '../../apps/server/issuer.js';
import { configFrom } from '../../apps/server/config.js';
import { WaasTransport } from '../../packages/server-wallet-sdk/src/transport.js';
import { omsFetch } from '../../apps/server/oms-fetch.js';
import {
  generateCredential,
  signatureHeader,
} from '../../packages/server-wallet-sdk/src/protocol.js';

it('issues backend OIDC tokens and signs P-256 RPC requests in Workers', async () => {
  const issuer = new OidcIssuer(configFrom(env));
  const issued = await issuer.issue('worker-crypto-check');
  expect(issued.token.split('.')).toHaveLength(3);
  expect((await issuer.jwks()).keys).toHaveLength(1);
  const credential = await generateCredential();
  expect(credential.credentialId).toMatch(/^0x[0-9a-f]{64}$/);
  expect(await signatureHeader(credential, '/v1/Waas/CommitVerifier', 'prj_test', '{}')).toContain(
    `cred="${credential.id}"`,
  );
});

it('constructs supported outbound requests and rejects gateway redirects in Workers', async () => {
  let request: Request | undefined;
  const transport = new WaasTransport(
    'pk_dev_live_test_key',
    ['0'.repeat(96)],
    omsFetch('https://issuer.example', async (url, init) => {
      request = new Request(url, init);
      return Response.redirect('https://unexpected.example', 302);
    }),
  );
  const credential = await generateCredential();
  await expect(transport.request('CommitVerifier', {}, credential)).rejects.toMatchObject({
    code: 'UPSTREAM_REDIRECT',
  });
  expect(request?.redirect).toBe('manual');
  expect(request?.headers.get('Origin')).toBe('https://issuer.example');
});

it('verifies a real Nitro attestation using Workers crypto and the bundled certificate library', async () => {
  await verifyAttestationDocument({
    ...fixture,
    trustedPcr0s: new Set([fixture.pcr0]),
    now: new Date(fixture.now),
  });
});

it('persists encrypted wallet state in a Durable Object and isolates wallet identities', async () => {
  const name = crypto.randomUUID();
  const stub = env.WALLETS.getByName(name);
  expect(await stub.execute('customer-1', { kind: 'disable' })).toMatchObject({
    ok: true,
    value: { snapshot: { disabled: true } },
  });
  const freshStub = env.WALLETS.getByName(name);
  expect(await freshStub.execute('customer-1', { kind: 'inspect' })).toMatchObject({
    ok: true,
    value: { snapshot: { disabled: true } },
  });
  expect(
    await env.WALLETS.getByName(crypto.randomUUID()).execute('customer-2', { kind: 'inspect' }),
  ).toMatchObject({ ok: true, value: { snapshot: { disabled: false } } });
  await runInDurableObject(stub, (_instance: WalletCoordinator, state) => {
    const value = state.storage.sql
      .exec<{ value: string }>('SELECT value FROM state WHERE key = ?', 'wallet')
      .one().value;
    expect(value).not.toContain('disabled');
    expect(JSON.parse(value)).toMatchObject({ v: 1 });
  });
});

it('reads and writes D1 using the authoritative session adapter', async () => {
  const session = env.DB.withSession('first-primary');
  await session
    .prepare('CREATE TABLE IF NOT EXISTS runtime_check(id TEXT PRIMARY KEY, value TEXT)')
    .run();
  const id = crypto.randomUUID();
  await session.prepare('INSERT INTO runtime_check VALUES(?, ?)').bind(id, 'persisted').run();
  expect(
    await session.prepare('SELECT value FROM runtime_check WHERE id = ?').bind(id).first('value'),
  ).toBe('persisted');
});
