import { SignJWT, importJWK, exportJWK, calculateJwkThumbprint, type JWK } from 'jose';
import { WalletError } from '@oms/server-wallet-sdk';
import type { Config } from './config.js';

export class OidcIssuer {
  constructor(private readonly config: Config) {}
  private async material() {
    if (!this.config.OIDC_PRIVATE_JWK || !this.config.OIDC_ISSUER || !this.config.OIDC_AUDIENCE)
      throw new WalletError(
        'OIDC_NOT_CONFIGURED',
        'Configure the OIDC issuer before connecting wallets.',
        503,
      );
    const jwk: JWK = JSON.parse(this.config.OIDC_PRIVATE_JWK);
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d)
      throw new WalletError(
        'OIDC_NOT_CONFIGURED',
        'OIDC_PRIVATE_JWK must be a private P-256 JWK.',
        503,
      );
    const key = await importJWK(jwk, 'ES256');
    const kid = await calculateJwkThumbprint(jwk);
    const publicKey = await exportJWK(
      await crypto.subtle.importKey(
        'jwk',
        { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, ext: true },
        { name: 'ECDSA', namedCurve: 'P-256' },
        true,
        ['verify'],
      ),
    );
    return { key, publicKey: { ...publicKey, kid, use: 'sig', alg: 'ES256' }, kid };
  }
  async jwks() {
    const keys = [(await this.material()).publicKey];
    if (this.config.OIDC_ADDITIONAL_PUBLIC_JWKS) {
      const additional: unknown = JSON.parse(this.config.OIDC_ADDITIONAL_PUBLIC_JWKS);
      if (
        !additional ||
        typeof additional !== 'object' ||
        !('keys' in additional) ||
        !Array.isArray(additional.keys) ||
        additional.keys.length > 5
      )
        throw new WalletError(
          'OIDC_NOT_CONFIGURED',
          'Additional JWKS must contain up to five public P-256 keys.',
          503,
        );
      for (const entry of additional.keys as JWK[]) {
        if (
          !entry ||
          entry.kty !== 'EC' ||
          entry.crv !== 'P-256' ||
          !entry.x ||
          !entry.y ||
          entry.d
        )
          throw new WalletError(
            'OIDC_NOT_CONFIGURED',
            'Additional JWKS must contain only public P-256 keys.',
            503,
          );
        const publicKey = { kty: entry.kty, crv: entry.crv, x: entry.x, y: entry.y };
        await importJWK(publicKey, 'ES256');
        const kid = await calculateJwkThumbprint(publicKey);
        if (!keys.some((key) => key.kid === kid))
          keys.push({ ...publicKey, kid, use: 'sig', alg: 'ES256' });
      }
    }
    return { keys };
  }
  discovery() {
    const issuer = this.config.OIDC_ISSUER.replace(/\/$/, '');
    if (!issuer)
      throw new WalletError(
        'OIDC_NOT_CONFIGURED',
        'Set OIDC_ISSUER to the public issuer URL.',
        503,
      );
    return {
      issuer,
      jwks_uri: `${issuer}/oidc/jwks`,
      id_token_signing_alg_values_supported: ['ES256'],
      subject_types_supported: ['public'],
      claims_supported: ['iss', 'aud', 'sub', 'iat', 'exp', 'jti'],
    };
  }
  async issue(subject: string) {
    const { key, kid } = await this.material();
    const now = Math.floor(Date.now() / 1000);
    const expiresAt = now + 300;
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', kid, typ: 'JWT' })
      .setIssuer(this.config.OIDC_ISSUER.replace(/\/$/, ''))
      .setAudience(this.config.OIDC_AUDIENCE)
      .setSubject(subject)
      .setIssuedAt(now)
      .setExpirationTime(expiresAt)
      .setJti(crypto.randomUUID())
      .sign(key);
    return { token, expiresAt };
  }
}
