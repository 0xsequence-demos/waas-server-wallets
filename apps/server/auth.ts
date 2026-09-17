import { sha256, WalletError } from '@oms/server-wallet-sdk';
import type { Config } from './config.js';
import type { SqlDatabase } from './database.js';

export class AdminAuth {
  constructor(
    private readonly db: SqlDatabase,
    private readonly config: Config,
  ) {}
  private validateConfig() {
    if (this.config.ADMIN_PASSWORD.length < 12 || this.config.SESSION_SECRET.length < 32)
      throw new WalletError(
        'ADMIN_NOT_CONFIGURED',
        'Configure an admin password of at least 12 characters and a session secret of at least 32 characters.',
        503,
      );
  }
  private digest(token: string) {
    return sha256(JSON.stringify([this.config.SESSION_SECRET, this.config.ADMIN_PASSWORD, token]));
  }
  async login(password: string, ip: string): Promise<string> {
    this.validateConfig();
    const now = Date.now();
    const key = await sha256(ip);
    const attempts = await this.db.all<{ count: number }>(
      'INSERT INTO login_attempts(key, count, expires_at) VALUES(?, 1, ?) ON CONFLICT(key) DO UPDATE SET count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END, expires_at = CASE WHEN expires_at <= ? THEN excluded.expires_at ELSE expires_at END RETURNING count',
      [key, now + 900_000, now, now],
    );
    if (attempts[0].count > 10)
      throw new WalletError(
        'RATE_LIMITED',
        'Too many login attempts. Try again in 15 minutes.',
        429,
      );
    const encoder = new TextEncoder();
    const hmac = await crypto.subtle.importKey(
      'raw',
      encoder.encode(this.config.SESSION_SECRET),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify'],
    );
    const expected = await crypto.subtle.sign(
      'HMAC',
      hmac,
      encoder.encode(this.config.ADMIN_PASSWORD),
    );
    if (!(await crypto.subtle.verify('HMAC', hmac, expected, encoder.encode(password))))
      throw new WalletError('INVALID_LOGIN', 'Incorrect password.', 401);
    const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) =>
      b.toString(16).padStart(2, '0'),
    ).join('');
    await this.db.run('INSERT INTO admin_sessions VALUES(?, ?)', [
      await this.digest(token),
      now + 8 * 60 * 60 * 1000,
    ]);
    await this.db.run('DELETE FROM admin_sessions WHERE expires_at <= ?', [now]);
    await this.db.run('DELETE FROM login_attempts WHERE expires_at <= ?', [now]);
    return token;
  }
  async valid(token: string | undefined) {
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return false;
    return (
      (
        await this.db.all('SELECT digest FROM admin_sessions WHERE digest = ? AND expires_at > ?', [
          await this.digest(token),
          Date.now(),
        ])
      ).length === 1
    );
  }
  async logout(token: string | undefined) {
    if (token)
      await this.db.run('DELETE FROM admin_sessions WHERE digest = ?', [await this.digest(token)]);
  }
}
