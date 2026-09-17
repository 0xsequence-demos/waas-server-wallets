import { z } from 'zod';
import { bytesToHex, utf8 } from './encoding.js';

export const walletSchema = z.object({
  id: z.string().min(1),
  address: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  reference: z.string().optional(),
  networkFamily: z.string().optional(),
  implementation: z.string().optional(),
  type: z.string().optional(),
});
export type RemoteWallet = z.infer<typeof walletSchema>;
export const credentialSchema = z.object({
  credentialId: z.string(),
  expiresAt: z.string().datetime({ offset: true }),
});
export const pageSchema = z.object({ cursor: z.string().optional(), limit: z.number().optional() });
export const authSchema = z.object({
  identity: z.object({ type: z.literal('oidc'), iss: z.string(), sub: z.string() }),
  wallets: z.array(walletSchema),
  page: pageSchema.optional(),
  credential: credentialSchema,
});
export const listSchema = z.object({ wallets: z.array(walletSchema), page: pageSchema.optional() });
export const statusSchema = z.object({
  status: z.enum(['quoted', 'pending', 'executed', 'failed']),
  txnHash: z
    .string()
    .regex(/^0x[0-9a-fA-F]{64}$/)
    .optional(),
});
export const quoteSchema = z.object({
  txnId: z.string().min(1),
  status: z.literal('quoted'),
  sponsored: z.boolean(),
  expiresAt: z.string().datetime({ offset: true }),
});
export type Quote = z.infer<typeof quoteSchema>;
export interface Credential {
  privateJwk: JsonWebKey;
  /** Raw uncompressed public key used in the request signature header. */
  id: string;
  /** WaaS RPC identifier: SHA-256 of the key type and compressed public key. */
  credentialId: string;
  nonce: string;
  expiresAt?: string;
}

export async function credentialId(publicKey: string): Promise<string> {
  if (!/^0x04[0-9a-fA-F]{128}$/.test(publicKey)) throw new Error('Invalid P-256 public key');
  const raw = Uint8Array.from(publicKey.slice(2).match(/../g)!, (hex) => parseInt(hex, 16));
  const typedCompressed = new Uint8Array(34);
  typedCompressed[0] = 0; // WaaS KeyType_P256
  typedCompressed[1] = 2 + (raw[64] & 1);
  typedCompressed.set(raw.subarray(1, 33), 2);
  return `0x${bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', typedCompressed)))}`;
}

export async function generateCredential(): Promise<Credential> {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const id = `0x${bytesToHex(new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey)))}`;
  return {
    privateJwk: await crypto.subtle.exportKey('jwk', pair.privateKey),
    id,
    credentialId: await credentialId(id),
    nonce: '0',
  };
}
export async function signatureHeader(
  credential: Credential,
  path: string,
  scope: string,
  body: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    'jwk',
    credential.privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const preimage = `POST ${path}\nnonce: ${credential.nonce}\nscope: ${scope}\n\n${body}`;
  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    utf8(preimage),
  );
  return `alg="ecdsa-p256-sha256", scope="${scope}", cred="${credential.id}", nonce=${credential.nonce}, sig="0x${bytesToHex(new Uint8Array(signature))}"`;
}
