import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import {
  EncryptedStore,
  SerialExecutor,
  ServerWallet,
  WaasTransport,
  type StateStore,
} from '@polygonlabs/oms-server-wallet-sdk';
import type { Credential } from '../packages/server-wallet-sdk/src/protocol.js';
import { configFrom, scopeFor } from '../apps/server/config.js';
import { OidcIssuer } from '../apps/server/issuer.js';
import { omsFetch } from '../apps/server/oms-fetch.js';

// Explicit live test of the independently built Node SDK. Never sends a transaction.
const subject = 'acceptance-sdk-2026-09-17';
const config = configFrom(process.env);
const origin = 'https://oms-server-wallet-dashboard.0xsequence.workers.dev';
assert.equal(config.OIDC_ISSUER, origin);
assert.equal(config.OIDC_AUDIENCE, 'api.dev.polygon-dev.technology');
mkdirSync('.data', { recursive: true });
const path = '.data/live-sdk-encrypted.json';
const data: Record<string, string> = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
const disk: StateStore = {
  async read(key) {
    return data[key] ?? null;
  },
  async write(key, value) {
    data[key] = value;
    writeFileSync(path, JSON.stringify(data), { mode: 0o600 });
  },
};
const store = new EncryptedStore(disk, config.ENCRYPTION_KEY, `${scopeFor(config)}:${subject}`);
const issuer = new OidcIssuer(config);
const transport = new WaasTransport(
  config.OMS_PUBLISHABLE_KEY,
  config.TRUSTED_PCR0S.split(','),
  omsFetch(origin),
);
const executor = new SerialExecutor();
const calls: string[] = [];
const create = () =>
  new ServerWallet({
    subject,
    issuer: config.OIDC_ISSUER,
    audience: config.OIDC_AUDIENCE,
    tokenProvider: () => issuer.issue(subject),
    store,
    executor,
    transport: {
      request: async (method, body, credential) => {
        calls.push(method);
        return transport.request(method, body, credential);
      },
    },
  });
const client = create();
try {
  if ((await client.inspect()).disabled) await client.setDisabled(false);
  const initial = await client.createOrRestore();
  assert(initial.wallet);
  assert.deepEqual(await create().createOrRestore(), initial);
  console.log(
    JSON.stringify({
      passed: 'standalone Node SDK restores encrypted credentials',
      address: initial.wallet.address,
    }),
  );

  // Simulate remote revocation without changing the SDK's cached expiry metadata.
  const state = JSON.parse((await store.read('wallet'))!) as { credential: Credential };
  state.credential.nonce = (BigInt(state.credential.nonce) + 1n).toString();
  await store.write('wallet', JSON.stringify(state));
  await transport.request(
    'RevokeCredential',
    { credentialId: state.credential.credentialId },
    state.credential,
  );
  const beforeAuth = calls.filter((call) => call === 'CompleteAuth').length;
  const operation = await create().signMessage(
    crypto.randomUUID(),
    137,
    'OMS SDK automatic reauthentication acceptance',
  );
  assert.equal(operation.verified, true);
  const recovered = await client.inspect();
  assert.notEqual(recovered.credentialId, initial.credentialId);
  assert.equal(recovered.wallet?.address, initial.wallet.address);
  assert.equal(calls.filter((call) => call === 'CompleteAuth').length, beforeAuth + 1);
  console.log(
    JSON.stringify({
      passed: 'automatic recovery from remote revocation preserves wallet and signs',
    }),
  );
  for (const chainId of [137, 8453]) {
    // An inert probe, with no transfer, permit or recovery authorization.
    const probe = await client.signTypedData(crypto.randomUUID(), chainId, {
      domain: {
        name: 'OMS SDK compatibility probe',
        version: '1',
        chainId,
        verifyingContract: initial.wallet.address,
      },
      types: { Probe: [{ name: 'message', type: 'string' }] },
      primaryType: 'Probe',
      message: { message: `SDK typed-data verification ${crypto.randomUUID()}` },
    });
    assert.equal(probe.verified, true);
    console.log(
      JSON.stringify({
        passed: 'attested typed-data signing and wallet-aware verification',
        chainId,
        signatureEnvelope: probe.signature!.endsWith('6492'.repeat(16)) ? 'eip6492' : 'wallet',
      }),
    );
  }
} finally {
  await client.setDisabled(true);
  console.log(JSON.stringify({ passed: 'standalone test credential revoked and wallet disabled' }));
}
