import { afterEach, describe, expect, it, vi } from 'vitest';
import { OmsAuth } from '../packages/server-wallet-sdk/src/auth.js';
import { WaasTransport } from '../packages/server-wallet-sdk/src/transport.js';
import { secretCredentials, tokenResponse } from './fixtures/oms.js';
import { configFrom, scopeFor } from '../apps/server/config.js';

afterEach(() => vi.useRealTimers());

describe('OMS secret credential authentication', () => {
  it('exchanges only at the token endpoint and shares concurrent refreshes', async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      expect(input).toBe('https://api.dev.polygon-dev.technology/v0.13/auth/token');
      expect(init?.redirect).toBe('manual');
      expect(JSON.parse(String(init?.body))).toEqual({
        apiKey: secretCredentials.appId,
        apiSecret: secretCredentials.apiSecret,
      });
      expect(new Headers(init?.headers).get('Api-Key')).toBeNull();
      return Response.json(tokenResponse());
    });
    const auth = new OmsAuth(secretCredentials, fetcher);
    expect(await Promise.all([auth.accessToken(), auth.accessToken()])).toEqual([
      'test-only-project-jwt',
      'test-only-project-jwt',
    ]);
    await auth.accessToken();
    expect(fetcher).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3_571_000);
    await Promise.all([auth.accessToken(), auth.accessToken()]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(auth)).not.toContain(secretCredentials.apiSecret);
    expect(JSON.stringify(auth)).not.toContain('test-only-project-jwt');
  });

  it.each([
    { projectId: 'prj_0000000000003' },
    { projectMode: 'sandbox' },
    { expiresAt: '2000-01-01T00:00:00Z' },
    { accessToken: '' },
    { projectId: undefined },
  ])('rejects an invalid or mismatched response: %j', async (overrides) => {
    const auth = new OmsAuth(secretCredentials, async () =>
      Response.json({ ...tokenResponse(), ...overrides }),
    );
    await expect(auth.accessToken()).rejects.toThrow();
  });

  it('recovers after a failed exchange without exposing response secrets', async () => {
    let calls = 0;
    const auth = new OmsAuth(secretCredentials, async () =>
      ++calls === 1
        ? new Response('sensitive upstream diagnostics', { status: 401 })
        : Response.json(tokenResponse()),
    );
    await expect(auth.accessToken()).rejects.toMatchObject({
      code: 'OMS_AUTH_FAILED',
      message: 'OMS secret credential exchange failed.',
    });
    await expect(auth.accessToken()).resolves.toBe('test-only-project-jwt');
    expect(calls).toBe(2);
  });

  it('rejects redirects without following them', async () => {
    const auth = new OmsAuth(secretCredentials, async (_input, init) => {
      expect(init?.redirect).toBe('manual');
      return Response.redirect('https://untrusted.example', 307);
    });
    await expect(auth.accessToken()).rejects.toMatchObject({ code: 'UPSTREAM_REDIRECT' });
  });

  it('rejects publishable credentials and keeps public WaaS requests credential-free', async () => {
    expect(() => new OmsAuth({ ...secretCredentials, appId: 'pk_dev_live_test_key' })).toThrow();
    expect(() => new OmsAuth({ ...secretCredentials, apiSecret: '' })).toThrow();
    const exchange = vi.fn<typeof fetch>();
    const auth = new OmsAuth(secretCredentials, exchange);
    const transport = new WaasTransport(auth, ['0'.repeat(96)], async (_url, init) => {
      const headers = new Headers(init?.headers);
      expect(headers.get('Authorization')).toBeNull();
      expect(headers.get('Api-Key')).toBeNull();
      return Response.json({ status: true });
    });
    await expect(transport.request('Status', {})).rejects.toMatchObject({
      code: 'ATTESTATION_FAILED',
    });
    expect(exchange).not.toHaveBeenCalled();
  });

  it('keeps storage scope stable across secret rotation and isolates projects', () => {
    const config = configFrom({
      OMS_APP_ID: secretCredentials.appId,
      OMS_API_SECRET: secretCredentials.apiSecret,
      OMS_PROJECT_ID: secretCredentials.projectId,
    });
    expect(
      scopeFor({
        ...config,
        OMS_APP_ID: config.OMS_APP_ID.replace(/1$/, '3'),
        OMS_API_SECRET: 'rotated',
      }),
    ).toBe(scopeFor(config));
    expect(scopeFor({ ...config, OMS_PROJECT_ID: 'prj_0000000000004' })).not.toBe(scopeFor(config));
  });
});
