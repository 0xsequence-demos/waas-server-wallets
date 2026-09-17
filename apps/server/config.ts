import { environmentFromKey } from '@polygonlabs/oms-server-wallet-sdk';
export interface Config {
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  ENCRYPTION_KEY: string;
  OIDC_PRIVATE_JWK: string;
  OIDC_ISSUER: string;
  OIDC_AUDIENCE: string;
  OMS_PUBLISHABLE_KEY: string;
  TRUSTED_PCR0S: string;
  APP_ORIGIN: string;
  OIDC_ADDITIONAL_PUBLIC_JWKS?: string;
}
export function configFrom(values: Partial<Record<keyof Config, string>>): Config {
  return {
    ADMIN_PASSWORD: values.ADMIN_PASSWORD ?? '',
    SESSION_SECRET: values.SESSION_SECRET ?? '',
    ENCRYPTION_KEY: values.ENCRYPTION_KEY ?? '',
    OIDC_PRIVATE_JWK: values.OIDC_PRIVATE_JWK ?? '',
    OIDC_ISSUER: (values.OIDC_ISSUER ?? '').replace(/\/$/, ''),
    OIDC_AUDIENCE: values.OIDC_AUDIENCE ?? 'api.dev.polygon-dev.technology',
    OMS_PUBLISHABLE_KEY: values.OMS_PUBLISHABLE_KEY ?? '',
    TRUSTED_PCR0S: values.TRUSTED_PCR0S ?? '',
    APP_ORIGIN: values.APP_ORIGIN ?? '',
    OIDC_ADDITIONAL_PUBLIC_JWKS: values.OIDC_ADDITIONAL_PUBLIC_JWKS ?? '',
  };
}
export function readiness(config: Config) {
  const missing = Object.entries(config)
    .filter(([key, value]) => key !== 'OIDC_ADDITIONAL_PUBLIC_JWKS' && !value)
    .map(([key]) => key);
  if (config.OIDC_ISSUER && !config.OIDC_ISSUER.startsWith('https://'))
    missing.push('OIDC_ISSUER must use public HTTPS for live WaaS');
  if (config.OMS_PUBLISHABLE_KEY) {
    try {
      environmentFromKey(config.OMS_PUBLISHABLE_KEY);
    } catch {
      missing.push('OMS_PUBLISHABLE_KEY is invalid');
    }
  }
  return missing;
}
export function scopeFor(config: Config): string {
  let env: ReturnType<typeof environmentFromKey> | null = null;
  try {
    if (config.OMS_PUBLISHABLE_KEY) env = environmentFromKey(config.OMS_PUBLISHABLE_KEY);
  } catch {
    /* Allow the setup dashboard to report invalid configuration. */
  }
  return JSON.stringify([env?.origin, env?.projectId, config.OIDC_ISSUER, config.OIDC_AUDIENCE]);
}
