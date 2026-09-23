import { environmentFromAppId, OmsAuth } from '@polygonlabs/oms-server-wallet-sdk';
export interface Config {
  TRAILS_API_KEY?: string;
  TRAILS_API_URL?: string;
  TRAILS_PROJECT_ID?: string;
  SWAPS_ENABLED?: string;
  EVM_RPC_URLS?: string;
  ADMIN_PASSWORD: string;
  SESSION_SECRET: string;
  ENCRYPTION_KEY: string;
  OIDC_PRIVATE_JWK: string;
  OIDC_ISSUER: string;
  OIDC_AUDIENCE: string;
  OMS_APP_ID: string;
  OMS_API_SECRET: string;
  OMS_PROJECT_ID: string;
  TRUSTED_PCR0S: string;
  APP_ORIGIN: string;
  OIDC_ADDITIONAL_PUBLIC_JWKS?: string;
}
export function configFrom(values: Partial<Record<keyof Config, string>>): Config {
  return {
    TRAILS_API_KEY: values.TRAILS_API_KEY ?? '',
    TRAILS_API_URL: values.TRAILS_API_URL ?? 'https://trails-api.sequence.app',
    TRAILS_PROJECT_ID: values.TRAILS_PROJECT_ID ?? 'oms-dashboard',
    SWAPS_ENABLED: values.SWAPS_ENABLED ?? 'false',
    EVM_RPC_URLS: values.EVM_RPC_URLS ?? '{}',
    ADMIN_PASSWORD: values.ADMIN_PASSWORD ?? '',
    SESSION_SECRET: values.SESSION_SECRET ?? '',
    ENCRYPTION_KEY: values.ENCRYPTION_KEY ?? '',
    OIDC_PRIVATE_JWK: values.OIDC_PRIVATE_JWK ?? '',
    OIDC_ISSUER: (values.OIDC_ISSUER ?? '').replace(/\/$/, ''),
    OIDC_AUDIENCE: values.OIDC_AUDIENCE ?? 'api.dev.polygon-dev.technology',
    OMS_APP_ID: values.OMS_APP_ID ?? '',
    OMS_API_SECRET: values.OMS_API_SECRET ?? '',
    OMS_PROJECT_ID: values.OMS_PROJECT_ID ?? '',
    TRUSTED_PCR0S: values.TRUSTED_PCR0S ?? '',
    APP_ORIGIN: values.APP_ORIGIN ?? '',
    OIDC_ADDITIONAL_PUBLIC_JWKS: values.OIDC_ADDITIONAL_PUBLIC_JWKS ?? '',
  };
}
export function readiness(config: Config) {
  const missing = Object.entries(config)
    .filter(
      ([key, value]) =>
        ![
          'OIDC_ADDITIONAL_PUBLIC_JWKS',
          'TRAILS_API_KEY',
          'TRAILS_API_URL',
          'TRAILS_PROJECT_ID',
          'SWAPS_ENABLED',
          'EVM_RPC_URLS',
        ].includes(key) && !value,
    )
    .map(([key]) => key);
  if (config.OIDC_ISSUER && !config.OIDC_ISSUER.startsWith('https://'))
    missing.push('OIDC_ISSUER must use public HTTPS for live WaaS');
  if (config.OMS_APP_ID && config.OMS_API_SECRET && config.OMS_PROJECT_ID) {
    try {
      omsAuth(config);
    } catch {
      missing.push('OMS secret credentials or project ID are invalid');
    }
  }
  return missing;
}
export function scopeFor(config: Config): string {
  let env: ReturnType<typeof environmentFromAppId> | null = null;
  try {
    if (config.OMS_APP_ID) env = environmentFromAppId(config.OMS_APP_ID);
  } catch {
    /* Allow the setup dashboard to report invalid configuration. */
  }
  return JSON.stringify([
    env?.origin,
    config.OMS_PROJECT_ID || undefined,
    config.OIDC_ISSUER,
    config.OIDC_AUDIENCE,
  ]);
}

export function omsAuth(config: Config): OmsAuth {
  return new OmsAuth({
    appId: config.OMS_APP_ID,
    apiSecret: config.OMS_API_SECRET,
    projectId: config.OMS_PROJECT_ID,
  });
}
