import { Hono } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import { bodyLimit } from 'hono/body-limit';
import { secureHeaders } from 'hono/secure-headers';
import { z } from 'zod';
import { CHAINS, IndexerClient, WalletError, type WalletSnapshot } from '@oms/server-wallet-sdk';
import { readiness, type Config } from './config.js';
import { Repository, type WalletRow } from './database.js';
import { AdminAuth } from './auth.js';
import { OidcIssuer } from './issuer.js';
import { omsFetch } from './oms-fetch.js';
import type { Command, CommandResult } from './service.js';

export interface Runtime {
  config: Config;
  repo: Repository;
  dispatch: (row: WalletRow, command: Command) => Promise<CommandResult>;
  clientIp?: (request: Request) => string;
}
const cookie = 'oms_admin';
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{8,100}$/);
const operationBody = z
  .object({ id: idSchema, chainId: z.number().int(), message: z.string().min(1).max(16_384) })
  .strict();
const transferBody = z
  .object({
    id: idSchema,
    chainId: z.number().int(),
    to: z.string(),
    asset: z.string(),
    amount: z.string().max(78),
  })
  .strict();
export const displayWallet = (row: WalletRow) => ({
  id: row.id,
  identifier: row.identifier,
  name: row.name,
  createdAt: row.created_at,
  snapshot: row.snapshot ? (JSON.parse(row.snapshot) as WalletSnapshot) : null,
});

export function createApp(runtime: Runtime) {
  const { config, repo } = runtime;
  const app = new Hono();
  const auth = new AdminAuth(repo.db, config);
  const issuer = new OidcIssuer(config);
  app.use('*', secureHeaders());
  app.use(
    '*',
    bodyLimit({
      maxSize: 65_536,
      onError: (c) => c.json({ error: 'REQUEST_TOO_LARGE', message: 'Request is too large.' }, 413),
    }),
  );
  app.use('/api/*', async (c, next) => {
    c.header('Cache-Control', 'no-store');
    if (!['GET', 'HEAD'].includes(c.req.method) && c.req.header('Origin') !== config.APP_ORIGIN)
      return c.json({ error: 'INVALID_ORIGIN', message: 'Request origin was rejected.' }, 403);
    if (
      !['/api/login', '/api/session'].includes(c.req.path) &&
      !(await auth.valid(getCookie(c, cookie)))
    )
      return c.json({ error: 'UNAUTHORIZED', message: 'Sign in to continue.' }, 401);
    await next();
  });
  app.get('/.well-known/openid-configuration', (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(issuer.discovery());
  });
  app.get('/oidc/jwks', async (c) => {
    c.header('Cache-Control', 'public, max-age=300');
    return c.json(await issuer.jwks());
  });
  app.get('/api/session', async (c) =>
    c.json({ authenticated: await auth.valid(getCookie(c, cookie)) }),
  );
  app.post('/api/login', async (c) => {
    const { password } = z
      .object({ password: z.string().max(1024) })
      .strict()
      .parse(await c.req.json());
    const token = await auth.login(password, runtime.clientIp?.(c.req.raw) ?? 'local');
    setCookie(c, cookie, token, {
      httpOnly: true,
      sameSite: 'Strict',
      secure: config.APP_ORIGIN.startsWith('https://'),
      path: '/',
      maxAge: 28_800,
    });
    await repo.audit(null, 'admin.login', 'success');
    return c.json({ ok: true });
  });
  app.post('/api/logout', async (c) => {
    await auth.logout(getCookie(c, cookie));
    deleteCookie(c, cookie, { path: '/' });
    return c.json({ ok: true });
  });
  app.get('/api/config', (c) =>
    c.json({
      chains: CHAINS,
      missing: readiness(config),
      issuer: config.OIDC_ISSUER,
      audience: config.OIDC_AUDIENCE,
      waasVersion: '1.1.0',
    }),
  );
  async function wallet(id: string) {
    const row = await repo.get(id);
    if (!row) throw new WalletError('NOT_FOUND', 'Wallet not found.', 404);
    return row;
  }
  async function dispatch(row: WalletRow, command: Command) {
    const result = await runtime.dispatch(row, command);
    if (!result.ok && result.diagnostic)
      console.error({
        event: 'wallet_operation_failed',
        command: command.kind,
        ...result.diagnostic,
      });
    if (!['inspect', 'operation'].includes(command.kind))
      await repo.audit(row.id, command.kind, result.ok ? 'success' : result.code);
    if (!result.ok) throw new WalletError(result.code, result.message, result.status);
    await repo.snapshot(row.id, result.value.snapshot);
    if (result.value.operation) await repo.operation(row.id, result.value.operation);
    return result.value;
  }
  app.get('/api/wallets', async (c) => {
    const offset = z.coerce
      .number()
      .int()
      .min(0)
      .max(100000)
      .parse(c.req.query('offset') ?? '0');
    const search = z
      .string()
      .max(128)
      .parse(c.req.query('search') ?? '');
    const rows = await repo.list(search, offset);
    return c.json({
      wallets: rows.map(displayWallet),
      nextOffset: rows.length === 50 ? offset + 50 : null,
    });
  });
  app.post('/api/wallets', async (c) => {
    const body = z
      .object({
        identifier: z
          .string()
          .trim()
          .min(1)
          .max(128)
          .refine((value) =>
            [...value].every((char) => char.charCodeAt(0) > 31 && char.charCodeAt(0) !== 127),
          ),
        name: z.string().trim().min(1).max(120),
      })
      .strict()
      .parse(await c.req.json());
    if (readiness(config).length)
      throw new WalletError(
        'CONFIGURATION',
        'Complete OMS and OIDC configuration before creating wallets.',
        503,
      );
    const row = await repo.reserve(body.identifier, body.name);
    const result = await dispatch(row, { kind: 'restore' });
    return c.json({ ...displayWallet(row), snapshot: result.snapshot });
  });
  app.get('/api/wallets/:id', async (c) => {
    const row = await wallet(c.req.param('id'));
    const { snapshot } = await dispatch(row, { kind: 'inspect' });
    return c.json({ ...displayWallet(row), snapshot });
  });
  for (const kind of ['restore', 'rotate', 'disable', 'enable'] as const)
    app.post(`/api/wallets/:id/${kind}`, async (c) =>
      c.json(await dispatch(await wallet(c.req.param('id')), { kind })),
    );
  app.get('/api/wallets/:id/balances', async (c) => {
    const row = await wallet(c.req.param('id'));
    const { snapshot } = await dispatch(row, { kind: 'inspect' });
    if (!snapshot.wallet)
      throw new WalletError('WALLET_PENDING', 'Restore this wallet to finish creation.', 409);
    return c.json(
      await new IndexerClient(config.OMS_PUBLISHABLE_KEY, omsFetch(config.APP_ORIGIN)).getBalances(
        snapshot.wallet.address,
        z.coerce
          .number()
          .int()
          .min(0)
          .max(1000)
          .parse(c.req.query('page') ?? 0),
      ),
    );
  });
  app.post('/api/wallets/:id/sign', async (c) => {
    const row = await wallet(c.req.param('id'));
    const body = operationBody.parse(await c.req.json());
    await repo.reserveOperation(row.id, body.id, 'sign');
    return c.json(await dispatch(row, { kind: 'sign', ...body }));
  });
  app.post('/api/wallets/:id/transfers', async (c) => {
    const row = await wallet(c.req.param('id'));
    const { id, ...transfer } = transferBody.parse(await c.req.json());
    await repo.reserveOperation(row.id, id, 'transfer');
    return c.json(await dispatch(row, { kind: 'prepare', id, transfer }));
  });
  app.post('/api/wallets/:id/operations/:operation/execute', async (c) =>
    c.json(
      await dispatch(await wallet(c.req.param('id')), {
        kind: 'execute',
        id: idSchema.parse(c.req.param('operation')),
      }),
    ),
  );
  app.get('/api/wallets/:id/operations/:operation', async (c) =>
    c.json(
      await dispatch(await wallet(c.req.param('id')), {
        kind: 'operation',
        id: idSchema.parse(c.req.param('operation')),
      }),
    ),
  );
  app.get('/api/wallets/:id/operations', async (c) => {
    const row = await wallet(c.req.param('id'));
    return c.json({
      operations: (await repo.operations(row.id)).map((op) =>
        op.result
          ? JSON.parse(op.result)
          : { id: op.id, kind: op.kind, status: 'unknown', createdAt: op.created_at },
      ),
    });
  });
  app.onError((error, c) => {
    if (error instanceof z.ZodError || error instanceof SyntaxError)
      return c.json(
        { error: 'INVALID_REQUEST', message: 'The request contains invalid fields.' },
        400,
      );
    const status = error instanceof WalletError ? error.status : 500;
    const code = error instanceof WalletError ? error.code : 'INTERNAL_ERROR';
    console.error(JSON.stringify({ event: 'request.error', code, path: c.req.path }));
    return new Response(
      JSON.stringify({
        error: code,
        message:
          error instanceof WalletError ? error.message : 'The request could not be completed.',
      }),
      { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } },
    );
  });
  app.notFound((c) => c.json({ error: 'NOT_FOUND', message: 'Route not found.' }, 404));
  return app;
}
