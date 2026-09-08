/**
 * Encrypts the provider credentials an account brings.
 *
 * A tenant's API key is not memoar's secret to hold casually: it can be spent,
 * it belongs to someone else, and it sits in a database that gets dumped for
 * backups and restored onto other machines. Stored as written, one leaked dump
 * is every customer's provider account. So it is sealed here and the database
 * only ever sees ciphertext.
 *
 * AES-256-GCM: authenticated, so a row edited in the database fails to open
 * rather than decrypting to something else. A fresh random nonce per write,
 * because reusing one with GCM leaks the plaintext relationship between two
 * values, and the same key is used for every tenant.
 *
 * The key itself is `MEMOAR_CREDENTIAL_KEY`, and there is no fallback. Deriving
 * one from a hostname, or reusing the token secret, would mean a credential
 * quietly readable by anything that already knows those — and an operator who
 * has not decided where this key lives has not yet decided to hold other
 * people's credentials.
 */

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

export class CredentialsUnavailable extends Error {
  constructor() {
    super("MEMOAR_CREDENTIAL_KEY is not configured, so provider credentials cannot be stored");
    this.name = "CredentialsUnavailable";
  }
}

/**
 * The key, or null when none is configured.
 *
 * 32 bytes, as hex or base64. A shorter value is refused rather than padded:
 * silently accepting a weak key is how a system ends up encrypted in name only.
 */
export function credentialKey(environment: NodeJS.ProcessEnv = process.env): Buffer | null {
  const configured = environment.MEMOAR_CREDENTIAL_KEY?.trim();
  if (!configured) return null;
  const decoded = /^[0-9a-f]{64}$/iu.test(configured)
    ? Buffer.from(configured, "hex")
    : Buffer.from(configured, "base64");
  if (decoded.length !== 32) {
    throw new Error("MEMOAR_CREDENTIAL_KEY must be 32 bytes, as 64 hex characters or base64");
  }
  return decoded;
}

/** Whether this process can hold credentials at all. */
export function credentialsAvailable(environment: NodeJS.ProcessEnv = process.env): boolean {
  return credentialKey(environment) !== null;
}

/** Sealed form: nonce, tag and ciphertext in one base64 string. */
export function sealCredential(plaintext: string, environment: NodeJS.ProcessEnv = process.env): string {
  const key = credentialKey(environment);
  if (!key) throw new CredentialsUnavailable();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, nonce);
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64");
}

/**
 * Opens a sealed credential.
 *
 * @returns null when it cannot be opened — a key that has been rotated, or a
 *   row that was tampered with. Null rather than a throw, because the caller's
 *   answer is the same either way: this tenant has no usable credential, and
 *   distillation is unavailable until they set one again.
 */
export function openCredential(sealed: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  const key = credentialKey(environment);
  if (!key) return null;
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length <= NONCE_BYTES + TAG_BYTES) return null;
    const decipher = createDecipheriv(ALGORITHM, key, raw.subarray(0, NONCE_BYTES));
    decipher.setAuthTag(raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES));
    return Buffer.concat([decipher.update(raw.subarray(NONCE_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
  } catch {
    return null;
  }
}

/**
 * The last four characters, so a person can tell which key is stored.
 *
 * Four, and only from a credential long enough that four characters are a
 * negligible fraction of it.
 */
export function credentialHint(plaintext: string): string | null {
  return plaintext.length >= 12 ? plaintext.slice(-4) : null;
}

/** Whether two credentials are the same, without leaking where they differ. */
export function sameCredential(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
