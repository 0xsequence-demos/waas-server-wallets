export const utf8 = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
export function bytesToHex(value: Uint8Array): string {
  return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join('');
}
export function base64EncodeBytes(value: Uint8Array): string {
  let result = '';
  for (const byte of value) result += String.fromCharCode(byte);
  return btoa(result);
}
export function base64DecodeBytes(value: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}
export const toArrayBuffer = (value: Uint8Array): ArrayBuffer => new Uint8Array(value).buffer;
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) result |= a[i] ^ b[i];
  return result === 0;
}
export async function sha256(value: string): Promise<string> {
  return base64EncodeBytes(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(value))))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
