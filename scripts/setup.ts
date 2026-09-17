import { writeFile, mkdir } from 'node:fs/promises';
import { generateKeyPair, exportJWK } from 'jose';
const randomBase64 = (length: number) =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(length))));

const { privateKey } = await generateKeyPair('ES256', { extractable: true });
const jwk = await exportJWK(privateKey);
const lines = [
  '# Local credentials. Keep this file private; it is ignored by git.',
  `ADMIN_PASSWORD=${randomBase64(24)}`,
  `SESSION_SECRET=${randomBase64(32)}`,
  `ENCRYPTION_KEY=${randomBase64(32)}`,
  `OIDC_PRIVATE_JWK='${JSON.stringify(jwk)}'`,
  'OIDC_ISSUER=',
  'OIDC_AUDIENCE=api.dev.polygon-dev.technology',
  'OMS_PUBLISHABLE_KEY=',
  'TRUSTED_PCR0S=',
  'APP_ORIGIN=http://127.0.0.1:5187',
  'DATABASE_PATH=.data/dashboard.sqlite',
  '',
];
await mkdir('.data', { recursive: true });
try {
  await writeFile('.env', lines.join('\n'), { flag: 'wx', mode: 0o600 });
  console.log(
    'Created .env with fresh local secrets. Use ADMIN_PASSWORD from that file to sign in. Configure OMS/OIDC values when the issuer is deployed.',
  );
} catch (error) {
  if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
    console.log('.env already exists and was left unchanged.');
  else throw error;
}
