import { Payload } from '@0xsequence/wallet-primitives';
import { bytesToHex, hexToBytes } from 'viem';

/** Canonical equivalents emitted by Go v0.64.6 and wallet-primitives 3.0.11. */
export function callEncodings(payload: Payload.Calls) {
  const js = Payload.encode(payload);
  const noEmptyData = Payload.encode({
    ...payload,
    calls: payload.calls.map((call) => ({
      ...call,
      data: call.data === '0x' ? ('' as `0x${string}`) : call.data,
    })),
  });
  let go = noEmptyData;
  if (payload.nonce === 0n) {
    const offset = payload.space === 0n ? 1 : 21;
    go = new Uint8Array(noEmptyData.length - 1);
    go.set(noEmptyData.subarray(0, offset));
    go[0] &= ~0x0e;
    go.set(noEmptyData.subarray(offset + 1), offset);
  }
  return [bytesToHex(go), bytesToHex(js)];
}
export function decodeCalls(encoded: string, self: `0x${string}`) {
  const payload = Payload.decode(hexToBytes(encoded as `0x${string}`), self);
  if (!callEncodings(payload).includes(encoded.toLowerCase() as `0x${string}`))
    throw new Error('Noncanonical payload');
  return payload;
}
