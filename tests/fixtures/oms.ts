import { OmsAuth } from '../../packages/server-wallet-sdk/src/auth.js';

export const secretCredentials = {
  appId: 'sk_dev_live_00000000000000000000000001',
  apiSecret: 'test-only-api-secret',
  projectId: 'prj_0000000000002',
};

export function tokenResponse() {
  return {
    accessToken: 'test-only-project-jwt',
    tokenType: 'bearer',
    expiresIn: 3600,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    projectId: secretCredentials.projectId,
    projectMode: 'live',
  };
}

export function testAuth() {
  return new OmsAuth(secretCredentials, async () => Response.json(tokenResponse()));
}
