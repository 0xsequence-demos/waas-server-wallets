// Adapted from @polygonlabs/oms-wallet; see ../NOTICE and ../LICENSE-APACHE-2.0.
import 'reflect-metadata';
import type { X509Certificate } from '@peculiar/x509';
import type { Decoder, Tag as CborTag } from 'cbor-x';

import {
  base64DecodeBytes,
  base64EncodeBytes,
  bytesToHex,
  equalBytes,
  toArrayBuffer,
} from './encoding.js';

// SHA-256 fingerprint of the DER-encoded AWS Nitro Enclaves root certificate.
const awsNitroRootSha256 = '641a0321a3e244efe456463195d606317ed7cdcc3c1756e09893f3c68f79bb5b';
const coseSign1Tag = 18;
const coseEs384Algorithm = -35;
const maxAttestationAgeMs = 5 * 60 * 1_000;

interface AttestationDocument {
  timestamp: number;
  pcrs: Map<number, Uint8Array>;
  certificate: Uint8Array;
  cabundle: Uint8Array[];
  userData: Uint8Array;
  nonce: Uint8Array;
}

export async function verifyAttestationDocument(params: {
  encodedDocument: string;
  method: string;
  path: string;
  requestBody: string;
  responseBody: string;
  nonce: string;
  trustedPcr0s: ReadonlySet<string>;
  now?: Date;
}): Promise<void> {
  const { Decoder, Encoder, Tag } = await import('cbor-x');
  const decoder = new Decoder({ mapsAsObjects: false, copyBuffers: true });
  const encoder = new Encoder({ mapsAsObjects: false, tagUint8Array: false, useRecords: false });
  const signedDocument = decodeCoseSign1(base64DecodeBytes(params.encodedDocument), decoder, Tag);
  const document = decodeAttestationPayload(signedDocument.payload, decoder);
  const now = params.now ?? new Date();

  if (Math.abs(now.getTime() - document.timestamp) > maxAttestationAgeMs) {
    throw new Error('WaaS attestation timestamp is outside the accepted freshness window');
  }

  const pcr0 = document.pcrs.get(0);
  if (!pcr0 || !params.trustedPcr0s.has(bytesToHex(pcr0))) {
    throw new Error('WaaS attestation PCR0 is not trusted');
  }

  if (!equalBytes(document.nonce, new TextEncoder().encode(params.nonce))) {
    throw new Error('WaaS attestation nonce does not match the request');
  }

  const expectedUserData = await attestationUserData(params);
  if (!equalBytes(document.userData, expectedUserData)) {
    throw new Error('WaaS attestation is not bound to the request and response');
  }

  const certificate = await verifyCertificateChain(document, now);
  const publicKey = await certificate.publicKey.export({ name: 'ECDSA', namedCurve: 'P-384' }, [
    'verify',
  ]);
  const signatureInput = encoder.encode([
    'Signature1',
    signedDocument.protectedHeader,
    new Uint8Array(),
    signedDocument.payload,
  ]);
  const validSignature = await crypto.subtle.verify(
    { name: 'ECDSA', hash: 'SHA-384' },
    publicKey,
    toArrayBuffer(signedDocument.signature),
    toArrayBuffer(signatureInput),
  );
  if (!validSignature) throw new Error('WaaS attestation signature is invalid');
}

function decodeCoseSign1(
  encoded: Uint8Array,
  decoder: Decoder,
  Tag: typeof CborTag,
): {
  protectedHeader: Uint8Array;
  payload: Uint8Array;
  signature: Uint8Array;
} {
  const decoded = decoder.decode(encoded);
  const value = decoded instanceof Tag ? decoded.value : decoded;
  if ((decoded instanceof Tag && decoded.tag !== coseSign1Tag) || !Array.isArray(value)) {
    throw new Error('WaaS attestation is not a COSE_Sign1 document');
  }
  const [protectedHeader, unprotectedHeader, payload, signature] = value as unknown[];
  if (
    value.length !== 4 ||
    !(protectedHeader instanceof Uint8Array) ||
    !(unprotectedHeader instanceof Map) ||
    unprotectedHeader.size !== 0 ||
    !(payload instanceof Uint8Array) ||
    !(signature instanceof Uint8Array) ||
    signature.length !== 96
  ) {
    throw new Error('WaaS attestation has an invalid COSE_Sign1 structure');
  }
  const protectedValues = decoder.decode(protectedHeader);
  if (!(protectedValues instanceof Map) || protectedValues.get(1) !== coseEs384Algorithm) {
    throw new Error('WaaS attestation does not use COSE ES384');
  }
  return { protectedHeader, payload, signature };
}

function decodeAttestationPayload(payload: Uint8Array, decoder: Decoder): AttestationDocument {
  const decoded = decoder.decode(payload);
  if (!(decoded instanceof Map)) throw new Error('WaaS attestation payload is not a CBOR map');
  if (decoded.get('digest') !== 'SHA384') throw new Error('WaaS attestation digest is not SHA384');

  const timestampValue = decoded.get('timestamp');
  const timestamp =
    typeof timestampValue === 'bigint' && timestampValue <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(timestampValue)
      : timestampValue;
  const pcrs = decoded.get('pcrs');
  const certificate = decoded.get('certificate');
  const cabundle = decoded.get('cabundle');
  const userData = decoded.get('user_data');
  const nonce = decoded.get('nonce');
  if (
    typeof timestamp !== 'number' ||
    !Number.isSafeInteger(timestamp) ||
    timestamp <= 0 ||
    !(pcrs instanceof Map) ||
    pcrs.size === 0 ||
    pcrs.size > 32 ||
    !(certificate instanceof Uint8Array) ||
    !Array.isArray(cabundle) ||
    cabundle.length === 0 ||
    !cabundle.every((entry) => entry instanceof Uint8Array) ||
    !(userData instanceof Uint8Array) ||
    !(nonce instanceof Uint8Array)
  ) {
    throw new Error('WaaS attestation payload is missing required fields');
  }
  for (const [index, measurement] of pcrs) {
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= 32 ||
      !(measurement instanceof Uint8Array) ||
      ![32, 48, 64].includes(measurement.length)
    ) {
      throw new Error('WaaS attestation contains an invalid PCR measurement');
    }
  }

  return {
    timestamp,
    pcrs: pcrs as Map<number, Uint8Array>,
    certificate,
    cabundle: cabundle as Uint8Array[],
    userData,
    nonce,
  };
}

async function verifyCertificateChain(
  document: AttestationDocument,
  now: Date,
): Promise<X509Certificate> {
  const {
    BasicConstraintsExtension,
    KeyUsageFlags,
    KeyUsagesExtension,
    X509Certificate,
    X509ChainBuilder,
  } = await import('@peculiar/x509');
  const target = new X509Certificate(toArrayBuffer(document.certificate));
  const authorities = document.cabundle.map((raw) => new X509Certificate(toArrayBuffer(raw)));
  const root = authorities[0];
  const rootThumbprint = bytesToHex(
    new Uint8Array(await crypto.subtle.digest('SHA-256', root.rawData)),
  );
  if (rootThumbprint !== awsNitroRootSha256) {
    throw new Error('WaaS attestation certificate chain does not use the AWS Nitro root');
  }

  const chain = await new X509ChainBuilder({ certificates: authorities }).build(target);
  if (
    chain.length !== authorities.length + 1 ||
    !equalBytes(rawCertificate(chain.at(-1)!), rawCertificate(root))
  ) {
    throw new Error('WaaS attestation certificate chain is incomplete');
  }

  for (let index = 0; index < chain.length; index += 1) {
    const certificate = chain[index];
    if (now < certificate.notBefore || now > certificate.notAfter) {
      throw new Error('WaaS attestation certificate is outside its validity period');
    }
    const basicConstraints = certificate.getExtension(BasicConstraintsExtension);
    const keyUsage = certificate.getExtension(KeyUsagesExtension);
    if (index === 0) {
      if (
        (basicConstraints && (basicConstraints.ca || basicConstraints.pathLength !== undefined)) ||
        !keyUsage ||
        (keyUsage.usages & KeyUsageFlags.digitalSignature) === 0
      ) {
        throw new Error('WaaS attestation leaf certificate has invalid constraints');
      }
      continue;
    }
    if (
      !basicConstraints?.critical ||
      !basicConstraints.ca ||
      (basicConstraints.pathLength !== undefined && basicConstraints.pathLength < index - 1) ||
      !keyUsage ||
      (keyUsage.usages & KeyUsageFlags.keyCertSign) === 0
    ) {
      throw new Error('WaaS attestation CA certificate has invalid constraints');
    }
  }

  return target;
}

async function attestationUserData(params: {
  method: string;
  path: string;
  requestBody: string;
  responseBody: string;
}): Promise<Uint8Array> {
  const preimage = `${params.method.toUpperCase()} ${params.path}\n${params.requestBody}\n${params.responseBody}`;
  const hash = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(preimage)),
  );
  return new TextEncoder().encode(`Sequence/1:${base64EncodeBytes(hash)}`);
}

function rawCertificate(certificate: X509Certificate): Uint8Array {
  return new Uint8Array(certificate.rawData);
}
