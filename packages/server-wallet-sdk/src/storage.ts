import { base64DecodeBytes, base64EncodeBytes, utf8 } from './encoding.js';
import { WalletError } from './errors.js';

/** Each wallet gets its own namespace. Implementations must make writes durable before returning. */
export interface StateStore {
  read(key: string): Promise<string | null>;
  write(key: string, value: string): Promise<void>;
}
/** The SDK invokes all stateful operations inside this cross-instance exclusive executor. */
export interface ExclusiveExecutor {
  run<T>(task: () => Promise<T>): Promise<T>;
}

/** Suitable for a single Node process or one Durable Object instance, not a Worker global. */
export class SerialExecutor implements ExclusiveExecutor {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

export class EncryptedStore implements StateStore {
  private readonly key: Promise<CryptoKey>;
  constructor(
    private readonly inner: StateStore,
    secret: string,
    private readonly context: string,
  ) {
    const bytes = base64DecodeBytes(secret);
    if (bytes.length !== 32)
      throw new WalletError(
        'CONFIGURATION',
        'ENCRYPTION_KEY must contain 32 base64-encoded bytes.',
        503,
      );
    this.key = crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  }
  async read(key: string): Promise<string | null> {
    const raw = await this.inner.read(key);
    if (raw === null) return null;
    try {
      const envelope: { v: number; iv: string; data: string } = JSON.parse(raw);
      if (envelope.v !== 1) throw new Error('Unsupported encryption version');
      const plain = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: base64DecodeBytes(envelope.iv),
          additionalData: utf8(`${this.context}:${key}:v1`),
        },
        await this.key,
        base64DecodeBytes(envelope.data),
      );
      return new TextDecoder().decode(plain);
    } catch {
      throw new WalletError(
        'STORAGE_INTEGRITY',
        'Encrypted wallet state could not be authenticated.',
        500,
      );
    }
  }
  async write(key: string, value: string): Promise<void> {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const data = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(`${this.context}:${key}:v1`) },
      await this.key,
      utf8(value),
    );
    await this.inner.write(
      key,
      JSON.stringify({
        v: 1,
        iv: base64EncodeBytes(iv),
        data: base64EncodeBytes(new Uint8Array(data)),
      }),
    );
  }
}
