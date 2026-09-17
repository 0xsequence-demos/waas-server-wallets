import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { SerialExecutor, WaasTransport } from '@polygonlabs/oms-server-wallet-sdk';
import { generateKeyPair, exportJWK, importJWK, jwtVerify, decodeProtectedHeader } from 'jose';
import { createApp } from '../apps/server/app.js';
import { configFrom, scopeFor } from '../apps/server/config.js';
import { Repository, SqlStateStore } from '../apps/server/database.js';
import { processCommand } from '../apps/server/service.js';
import { OidcIssuer } from '../apps/server/issuer.js';
import { testDatabase, FakeWaas } from './helpers.js';

describe('admin API and OIDC issuer', () => {
  let database: ReturnType<typeof testDatabase>;
  let app: ReturnType<typeof createApp>;
  let issuer: OidcIssuer;
  let calls: number;
  let remote: FakeWaas;
  const password = 'test-only-admin-password';
  const origin = 'http://127.0.0.1:5187';
  beforeEach(async () => {
    database = testDatabase();
    calls = 0;
    const pair = await generateKeyPair('ES256', { extractable: true });
    const config = configFrom({
      ADMIN_PASSWORD: password,
      SESSION_SECRET: 'test-session-secret-'.repeat(3),
      ENCRYPTION_KEY: btoa('k'.repeat(32)),
      OIDC_PRIVATE_JWK: JSON.stringify(await exportJWK(pair.privateKey)),
      OIDC_ISSUER: 'https://issuer.example',
      OIDC_AUDIENCE: 'test-audience',
      OMS_PUBLISHABLE_KEY: 'pk_dev_live_test_key',
      TRUSTED_PCR0S: '0'.repeat(96),
      APP_ORIGIN: origin,
    });
    issuer = new OidcIssuer(config);
    remote = new FakeWaas();
    vi.spyOn(WaasTransport.prototype, 'request').mockImplementation((...args) =>
      remote.request(...args),
    );
    const executors = new Map<string, SerialExecutor>();
    app = createApp({
      config,
      repo: new Repository(database.db, scopeFor(config)),
      dispatch: async (row, command) => {
        calls++;
        let executor = executors.get(row.id);
        if (!executor) {
          executor = new SerialExecutor();
          executors.set(row.id, executor);
        }
        return processCommand(
          config,
          row.identifier,
          new SqlStateStore(database.db, row.id),
          executor,
          command,
        );
      },
    });
  });
  afterEach(() => {
    database.sqlite.close();
    vi.restoreAllMocks();
  });
  async function login() {
    const response = await app.request('/api/login', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    expect(response.status).toBe(200);
    const cookie = response.headers.get('Set-Cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    return cookie.split(';')[0];
  }
  it('protects every wallet route before any wallet command runs', async () => {
    expect((await app.request('/api/wallets')).status).toBe(401);
    expect(
      (
        await app.request('/api/wallets', {
          method: 'POST',
          headers: { Origin: origin },
          body: '{}',
        })
      ).status,
    ).toBe(401);
    expect(calls).toBe(0);
  });
  it('rejects forged origins on login and authenticated mutations', async () => {
    expect(
      (
        await app.request('/api/login', {
          method: 'POST',
          headers: { Origin: 'https://evil.example' },
          body: JSON.stringify({ password }),
        })
      ).status,
    ).toBe(403);
    const cookie = await login();
    expect(
      (
        await app.request('/api/wallets', {
          method: 'POST',
          headers: { Cookie: cookie, Origin: 'https://evil.example' },
          body: '{}',
        })
      ).status,
    ).toBe(403);
  });
  it('limits password guessing and invalidates server sessions on logout', async () => {
    const cookie = await login();
    expect((await app.request('/api/wallets', { headers: { Cookie: cookie } })).status).toBe(200);
    await app.request('/api/logout', {
      method: 'POST',
      headers: { Cookie: cookie, Origin: origin },
    });
    expect((await app.request('/api/wallets', { headers: { Cookie: cookie } })).status).toBe(401);
    for (let i = 0; i < 10; i++)
      await app.request('/api/login', {
        method: 'POST',
        headers: { Origin: origin },
        body: JSON.stringify({ password: 'wrong' }),
      });
    expect(
      (
        await app.request('/api/login', {
          method: 'POST',
          headers: { Origin: origin },
          body: JSON.stringify({ password }),
        })
      ).status,
    ).toBe(429);
  });
  it('deduplicates wallet identifiers, hides credentials, and enforces scoped lookup', async () => {
    const cookie = await login();
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    const first = await app.request('/api/wallets', {
      method: 'POST',
      headers,
      body: JSON.stringify({ identifier: 'customer-1', name: 'Treasury' }),
    });
    const value = (await first.json()) as { id: string };
    const second = await app.request('/api/wallets', {
      method: 'POST',
      headers,
      body: JSON.stringify({ identifier: 'customer-1', name: 'Treasury' }),
    });
    expect(((await second.json()) as { id: string }).id).toBe(value.id);
    const list = await app.request('/api/wallets', { headers });
    const text = await list.text();
    expect(text).not.toContain('privateJwk');
    expect(text).not.toContain(password);
    expect(await new Repository(database.db, 'another-scope').get(value.id)).toBeNull();
  });
  it('runs the wallet API through encrypted SQLite, lifecycle controls, and uncertain submission recovery', async () => {
    const cookie = await login();
    const headers = { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' };
    const post = (path: string, body: unknown = {}) =>
      app.request(path, { method: 'POST', headers, body: JSON.stringify(body) });
    const created = await post('/api/wallets', { identifier: 'customer-1', name: 'Treasury' });
    expect(created.status).toBe(200);
    const wallet = (await created.json()) as { id: string };
    const root = `/api/wallets/${wallet.id}`;
    expect((await app.request(root, { headers })).status).toBe(200);
    const sign = await post(`${root}/sign`, {
      id: 'message-1',
      chainId: 137,
      message: 'API integration',
    });
    expect(await sign.json()).toMatchObject({ operation: { status: 'signed', verified: true } });
    expect(
      (
        await post(`${root}/transfers`, {
          id: 'invalid-1',
          chainId: 137,
          to: 'invalid',
          asset: 'native',
          amount: '1',
        })
      ).status,
    ).toBe(400);
    const prepared = await post(`${root}/transfers`, {
      id: 'transfer-1',
      chainId: 137,
      to: '0x2222222222222222222222222222222222222222',
      asset: 'native',
      amount: '1',
    });
    expect(await prepared.json()).toMatchObject({ operation: { status: 'quoted' } });
    remote.failExecute = true;
    const executed = await post(`${root}/operations/transfer-1/execute`);
    expect(await executed.json()).toMatchObject({ operation: { status: 'unknown' } });
    remote.txnStatus = 'executed';
    const reconciled = await app.request(`${root}/operations/transfer-1`, { headers });
    expect(await reconciled.json()).toMatchObject({ operation: { status: 'executed' } });
    expect((await app.request(`${root}/operations`, { headers })).status).toBe(200);
    expect(remote.calls.filter((c) => c.method === 'Execute')).toHaveLength(1);
    expect((await post(`${root}/rotate`)).status).toBe(200);
    expect((await post(`${root}/disable`)).status).toBe(200);
    expect(
      (await post(`${root}/sign`, { id: 'message-2', chainId: 137, message: 'blocked' })).status,
    ).toBe(409);
    expect((await post(`${root}/enable`)).status).toBe(200);
    const encrypted = database.sqlite.prepare('SELECT value FROM local_wallet_state').all();
    expect(JSON.stringify(encrypted)).not.toContain('privateJwk');
    expect(database.sqlite.prepare('SELECT * FROM audit_events').all().length).toBeGreaterThan(5);
    const search = await app.request('/api/wallets?search=0x1111', { headers });
    expect(((await search.json()) as { wallets: unknown[] }).wallets).toHaveLength(1);
  });
  it('serves only public issuer keys and mints bounded identity JWTs internally', async () => {
    const response = await app.request('/oidc/jwks');
    expect(response.status).toBe(200);
    const jwks = (await response.json()) as { keys: JsonWebKey[] };
    expect(jwks.keys[0].d).toBeUndefined();
    const first = await issuer.issue('customer-1');
    const second = await issuer.issue('customer-1');
    const publicKey = await importJWK(jwks.keys[0], 'ES256');
    const verified = await jwtVerify(first.token, publicKey, {
      issuer: 'https://issuer.example',
      audience: 'test-audience',
      algorithms: ['ES256'],
    });
    expect(verified.payload.sub).toBe('customer-1');
    expect(verified.payload.exp! - verified.payload.iat!).toBe(300);
    expect(decodeProtectedHeader(first.token).kid).toBe(decodeProtectedHeader(second.token).kid);
    expect(first.token).not.toBe(second.token);
    await expect(jwtVerify(first.token, publicKey, { audience: 'wrong' })).rejects.toThrow();
    await expect(
      jwtVerify(first.token, publicKey, { issuer: 'https://wrong.example' }),
    ).rejects.toThrow();
    await expect(
      jwtVerify(first.token, (await generateKeyPair('ES256')).publicKey),
    ).rejects.toThrow();
    await expect(
      jwtVerify(first.token, publicKey, { currentDate: new Date(Date.now() + 360_000) }),
    ).rejects.toThrow();
    expect((await app.request('/oidc/token', { method: 'POST' })).status).toBe(404);
    const discovery = await app.request('/.well-known/openid-configuration');
    expect(await discovery.json()).toMatchObject({
      issuer: 'https://issuer.example',
      jwks_uri: 'https://issuer.example/oidc/jwks',
    });
  });
  it('overlaps public signing keys during rotation and rejects private material in additional JWKS', async () => {
    const oldToken = await issuer.issue('customer-1');
    const oldKeys = await issuer.jwks();
    const pair = await generateKeyPair('ES256', { extractable: true });
    const config = configFrom({
      OIDC_ISSUER: 'https://issuer.example',
      OIDC_AUDIENCE: 'test-audience',
      OIDC_PRIVATE_JWK: JSON.stringify(await exportJWK(pair.privateKey)),
      OIDC_ADDITIONAL_PUBLIC_JWKS: JSON.stringify(oldKeys),
    });
    const rotated = new OidcIssuer(config);
    const keys = (await rotated.jwks()).keys;
    const newToken = await rotated.issue('customer-1');
    expect(keys).toHaveLength(2);
    for (const token of [oldToken.token, newToken.token]) {
      const kid = decodeProtectedHeader(token).kid;
      const key = keys.find((entry) => entry.kid === kid)!;
      expect(key.d).toBeUndefined();
      expect((await jwtVerify(token, await importJWK(key, 'ES256'))).payload.sub).toBe(
        'customer-1',
      );
    }
    config.OIDC_ADDITIONAL_PUBLIC_JWKS = JSON.stringify({
      keys: [await exportJWK(pair.privateKey)],
    });
    await expect(rotated.jwks()).rejects.toMatchObject({ code: 'OIDC_NOT_CONFIGURED' });
  });
});
