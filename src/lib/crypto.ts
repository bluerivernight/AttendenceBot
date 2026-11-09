/**
 * Ed25519 canonical signing / verification.
 * Canonical payload: session_id|user_id|channel_id|start_iso|end_iso|duration_sec
 * All timestamps MUST be ISO-8601 UTC (e.g. 2026-11-09T08:05:00.000Z).
 */

import { createVerify, createSign, generateKeyPairSync } from 'node:crypto';

export type SignableSession = {
  session_id: string;
  user_id: string;
  channel_id: string;
  start_iso: string;
  end_iso: string;
  duration_sec: number;
};

/**
 * Deterministic canonical string for a session record.
 * Fields separated by `|` (pipe). No whitespace, no trailing newline.
 */
export function canonicalString(s: SignableSession): string {
  return `${s.session_id}|${s.user_id}|${s.channel_id}|${s.start_iso}|${s.end_iso}|${s.duration_sec}`;
}

/**
 * Generate a fresh Ed25519 keypair (for one-time bootstrap).
 */
export function generateKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey };
}

/**
 * Sign a canonical string with the server's Ed25519 private key.
 * Returns a base64url-encoded signature.
 */
export function signPayload(payload: string, privateKeyPem: string): string {
  const sign = createSign('sha256');
  sign.update(payload);
  sign.end();
  return sign.sign(privateKeyPem, 'base64url');
}

/**
 * Verify a base64url-encoded signature against the canonical payload
 * using the server's Ed25519 public key.
 */
export function verifySignature(
  payload: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  const verify = createVerify('sha256');
  verify.update(payload);
  verify.end();
  return verify.verify(publicKeyPem, signatureB64, 'base64url');
}